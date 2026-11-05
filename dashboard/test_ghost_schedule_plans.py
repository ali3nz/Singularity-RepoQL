"""Focused safety/CRUD checks for Ghost's non-executable calendar drafts."""
import tempfile
import unittest
from pathlib import Path
from ghost_schedule_plans import control

class DraftPlanTests(unittest.TestCase):
    def setUp(self):
        self.t=tempfile.TemporaryDirectory()
        self.addCleanup(self.t.cleanup)
        self.path=Path(self.t.name)/'plans.json'
        self.request=dict(action='save-draft',title='Research update',prompt='Review changes safely',date='2026-10-30',time='09:30',recurrence='weekly',confirm=True,requestId='sample_req_123')
    def test_create_is_draft_not_executable_and_survives_restart(self):
        status,b=control('POST',self.request,path=self.path)
        self.assertEqual(status,200)
        self.assertFalse(b['plan']['active'])
        self.assertFalse(b['executionAvailable'])
        self.assertEqual(control('GET',path=self.path)[1]['plans'][0]['prompt'],'Review changes safely')
    def test_duplicate_create_request_does_not_create_second_draft(self):
        status, first = control('POST', self.request, path=self.path)
        self.assertEqual(status, 200)
        status, replay = control('POST', self.request, path=self.path)
        self.assertEqual(status, 200)
        self.assertEqual(first['plan']['id'], replay['plan']['id'])
        self.assertEqual(len(control('GET', path=self.path)[1]['plans']), 1)
        self.assertFalse(replay['executionAvailable'])

    def test_request_id_replay_with_different_payload_is_rejected(self):
        old=control('POST',self.request,path=self.path)[1]['plan']
        status,data=control('POST',{**self.request,'prompt':'An unrelated request'},path=self.path)
        self.assertEqual((status,data['error']),(409,'request_id_payload_conflict'))
        self.assertEqual(control('GET',path=self.path)[1]['plans'][0]['prompt'],old['prompt'])
        update={**self.request,'id':old['id'],'expectedRevision':1,'requestId':'update_123456','prompt':'New prompt'}
        self.assertEqual(control('POST',update,path=self.path)[0],200)
        status,data=control('POST',{**update,'prompt':'Unexpected edit'},path=self.path)
        self.assertEqual((status,data['error']),(409,'request_id_payload_conflict'))

    def test_older_create_request_cannot_duplicate_draft_after_edit(self):
        first=control('POST',self.request,path=self.path)[1]['plan']
        update={**self.request,'id':first['id'],'expectedRevision':1,
                'requestId':'edit_request_99','prompt':'Updated prompt'}
        self.assertEqual(control('POST',update,path=self.path)[0],200)
        status,replay=control('POST',self.request,path=self.path)
        self.assertEqual((status,replay['error']),(409,'request_id_payload_conflict'))
        plans=control('GET',path=self.path)[1]['plans']
        self.assertEqual(len(plans),1)
        self.assertEqual(plans[0]['prompt'],'Updated prompt')
        self.assertEqual(plans[0]['requestIds'],['sample_req_123','edit_request_99'])

    def test_older_edit_request_cannot_be_replayed_on_new_revision(self):
        first=control('POST',self.request,path=self.path)[1]['plan']
        update={**self.request,'id':first['id'],'expectedRevision':1,
                'requestId':'edit_request_88','prompt':'Updated prompt'}
        self.assertEqual(control('POST',update,path=self.path)[0],200)
        latest={**update,'expectedRevision':2,'requestId':'edit_request_99','prompt':'Latest prompt'}
        self.assertEqual(control('POST',latest,path=self.path)[0],200)
        status,replay=control('POST',update,path=self.path)
        self.assertEqual((status,replay['error']),(409,'request_id_payload_conflict'))
        self.assertEqual(control('GET',path=self.path)[1]['plans'][0]['revision'],3)

    def test_reusing_another_drafts_request_id_is_refused(self):
        first=control('POST',self.request,path=self.path)[1]['plan']
        second_request={**self.request,'requestId':'second_req_123','title':'Other draft'}
        other=control('POST',second_request,path=self.path)[1]['plan']
        reused={**self.request,'id':other['id'],'expectedRevision':1,
                'requestId':'sample_req_123','title':'Tampered draft'}
        status,replay=control('POST',reused,path=self.path)
        self.assertEqual((status,replay['error']),(409,'request_id_payload_conflict'))
        self.assertEqual(len(control('GET',path=self.path)[1]['plans']),2)
        self.assertNotEqual(first['id'],other['id'])

    def test_legacy_row_without_request_history_can_be_edited(self):
        import json
        first=control('POST',self.request,path=self.path)[1]['plan']
        data=json.loads(self.path.read_text())
        data['plans'][0].pop('requestIds')
        self.path.write_text(json.dumps(data))
        update={**self.request,'id':first['id'],'expectedRevision':1,
                'requestId':'migrate_req_123','prompt':'Edited legacy draft'}
        self.assertEqual(control('POST',update,path=self.path)[0],200)
        saved=control('GET',path=self.path)[1]['plans'][0]
        self.assertEqual(saved['requestIds'],['sample_req_123','migrate_req_123'])

    def test_activation_preview_is_revision_bound_read_only_and_hashes_payload(self):
        import hashlib, json
        plan=control('POST',self.request,path=self.path)[1]['plan']
        original=self.path.read_bytes()
        body={'action':'activation-preview','id':plan['id'],'expectedRevision':1,
              'confirm':True,'requestId':'preview_request_123'}
        status,result=control('POST',body,path=self.path)
        self.assertEqual(status,200)
        self.assertFalse(result['executionAvailable'])
        preview=result['preview']
        self.assertFalse(preview['schedulerRegistered'])
        self.assertFalse(preview['executionAuthorized'])
        self.assertEqual(preview['task']['prompt'],self.request['prompt'])
        checksum=preview.pop('sha256')
        canonical=json.dumps(preview,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()
        self.assertEqual(checksum,hashlib.sha256(canonical).hexdigest())
        self.assertEqual(self.path.read_bytes(),original)
        status,changed=control('POST',{**body,'expectedRevision':2},path=self.path)
        self.assertEqual((status,changed['error']),(409,'draft_changed_refresh_required'))
        self.assertEqual(self.path.read_bytes(),original)

    def test_ambiguous_and_nonexistent_nz_times_refuse_activation_only(self):
        cases = [
            ('2027-04-04', '02:30', 'once', 'nz_local_time_ambiguous_or_nonexistent'),
            ('2027-09-26', '02:30', 'once', 'nz_local_time_ambiguous_or_nonexistent'),
            ('2027-09-27', '02:15', 'daily', 'dst_policy_required_for_recurring_02_hour'),
            ('2027-09-26', '02:15', 'weekly', 'dst_policy_required_for_recurring_02_hour'),
        ]
        for index, (day, clock, recurrence, issue) in enumerate(cases):
            with self.subTest(day=day, recurrence=recurrence):
                request={**self.request, 'date':day,'time':clock,'recurrence':recurrence,'requestId':'request_'+day.replace('-','')+'_'+str(index)}
                draft=control('POST',request,path=self.path)[1]['plan']
                original=self.path.read_bytes()
                status,result=control('POST',dict(action='activation-preview',id=draft['id'],
                    expectedRevision=draft['revision'],confirm=True,requestId='preview_request_123'),path=self.path)
                self.assertEqual((status,result['error']),(400,issue))
                self.assertEqual(self.path.read_bytes(),original)

    def test_missing_nz_timezone_database_fails_closed(self):
        from unittest.mock import patch
        from zoneinfo import ZoneInfoNotFoundError
        request={**self.request,'date':'2027-09-26','time':'10:30','recurrence':'once'}
        plan=control('POST',request,path=self.path)[1]['plan']
        with patch('ghost_schedule_plans.ZoneInfo',side_effect=ZoneInfoNotFoundError('Pacific/Auckland')):
            status,result=control('POST',dict(action='activation-preview',id=plan['id'],
                expectedRevision=1,confirm=True,requestId='preview_request_123'),path=self.path)
        self.assertEqual((status,result['error']),(400,'nz_timezone_database_unavailable'))

    def test_valid_future_nz_time_can_generate_non_executable_preview(self):
        request={**self.request,'date':'2027-09-26','time':'10:30','recurrence':'once'}
        draft=control('POST',request,path=self.path)[1]['plan']
        status,result=control('POST',dict(action='activation-preview',id=draft['id'],
            expectedRevision=1,confirm=True,requestId='preview_request_123'),path=self.path)
        self.assertEqual(status,200)
        self.assertFalse(result['preview']['schedulerRegistered'])

    def test_optimistic_revision_and_prompt_edit(self):
        old=control('POST',self.request,path=self.path)[1]['plan']
        r={**self.request,'id':old['id'],'expectedRevision':1,'requestId':'new_request_123','prompt':'A changed prompt'}
        self.assertEqual(control('POST',r,path=self.path)[1]['plan']['revision'],2)
        self.assertEqual(control('POST',{**r,'requestId':'retry_req_123'},path=self.path)[0],409)
        self.assertEqual(control('DELETE',dict(action='delete-draft',id=old['id'],expectedRevision=2,requestId='delete_request_123',confirm=True),path=self.path)[0],200)
        self.assertEqual(control('GET',path=self.path)[1]['plans'],[])
    def test_untrusted_metadata_refused_and_ledger_preserved(self):
        self.assertEqual(control('POST',{**self.request,'time':'25:88'},path=self.path)[0],400)
        self.path.write_text('{bad')
        self.assertEqual(control('POST',self.request,path=self.path)[1]['error'],'plans_invalid')
        self.assertEqual(self.path.read_text(),'{bad')
    def test_forged_active_draft_and_corrupted_fields_fail_closed(self):
        import json
        saved=control('POST',self.request,path=self.path)[1]['plan']
        for corrupted in ({**saved,'active':True}, {**saved,'time':'25:99'}, {**saved,'revision':False}):
            raw=json.dumps({'schema':1,'plans':[corrupted]})
            self.path.write_text(raw)
            status,result=control('POST',self.request,path=self.path)
            self.assertEqual(status,400)
            self.assertEqual(result['error'],'plans_invalid')
            self.assertEqual(self.path.read_text(),raw)

    def test_symlinked_ledger_refused(self):
        target=Path(self.t.name)/'elsewhere'; target.write_text('private')
        self.path.symlink_to(target)
        self.assertEqual(control('GET',path=self.path)[1]['error'],'plans_symlink_refused')
        self.assertEqual(target.read_text(),'private')
    def test_lock_contention_returns_retryable_response_without_mutation(self):
        from unittest.mock import patch
        import errno
        with patch('ghost_schedule_plans.fcntl.flock',side_effect=BlockingIOError(errno.EAGAIN,'busy')):
            with patch('ghost_schedule_plans.LOCK_WAIT_SECONDS',0):
                status,result=control('POST',self.request,path=self.path)
        self.assertEqual(status,503)
        self.assertEqual(result['error'],'plans_lock_busy')
        self.assertFalse(self.path.exists())

    def test_non_contention_lock_error_fails_closed(self):
        from unittest.mock import patch
        import errno
        with patch('ghost_schedule_plans.fcntl.flock',side_effect=OSError(errno.EPERM,'forbidden')):
            status,result=control('POST',self.request,path=self.path)
        self.assertEqual(status,400)
        self.assertEqual(result['error'],'plans_lock_unavailable')
        self.assertFalse(self.path.exists())

    def test_no_unconfirmed_mutations_or_invalid_methods(self):
        self.assertEqual(control('POST',{**self.request,'confirm':False},path=self.path)[0],400)
        self.assertEqual(control('PUT',self.request,path=self.path)[0],405)
        self.assertFalse(self.path.exists())
if __name__=='__main__': unittest.main()

class RequestRetirementTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.t = tempfile.TemporaryDirectory()
        self.addCleanup(self.t.cleanup)
        self.path = Path(self.t.name) / 'plans.json'
        self.request = dict(action='save-draft', title='Scheduled proposal', prompt='Review results',
                            date='2027-11-01', time='13:15', recurrence='once',
                            confirm=True, requestId='creation_req_2027')

    def create(self):
        status, result = control('POST', self.request, path=self.path)
        self.assertEqual(status, 200)
        return result['plan']

    def remove(self, draft, request_id='deletion_req_2027'):
        return control('DELETE', dict(action='delete-draft', id=draft['id'],
            expectedRevision=draft['revision'], confirm=True, requestId=request_id), path=self.path)

    def test_deleted_creation_and_edit_request_ids_cannot_be_reused(self):
        draft = self.create()
        updated = control('POST', {**self.request, 'id':draft['id'], 'expectedRevision':1,
            'requestId':'update_req_2027', 'prompt':'Updated'}, path=self.path)[1]['plan']
        self.assertEqual(self.remove(updated)[0], 200)
        for stale in (self.request['requestId'], 'update_req_2027', 'deletion_req_2027'):
            status, data = control('POST', {**self.request, 'requestId':stale}, path=self.path)
            self.assertEqual((status, data['error']), (409,'request_id_payload_conflict'))
        self.assertEqual(control('GET',path=self.path)[1]['plans'],[])
        self.assertEqual(control('POST', {**self.request,'requestId':'truly_new_req_27'},path=self.path)[0],200)

    def test_delete_replay_is_refused_and_does_not_change_disk(self):
        draft = self.create()
        request = dict(action='delete-draft', id=draft['id'], expectedRevision=1,
            confirm=True,requestId='deletion_req_2027')
        self.assertEqual(control('DELETE',request,path=self.path)[0],200)
        original = self.path.read_bytes()
        status, data = control('DELETE',request,path=self.path)
        self.assertEqual((status,data['error']),(409,'request_id_payload_conflict'))
        self.assertEqual(self.path.read_bytes(),original)

    def test_delete_with_existing_live_request_id_refused(self):
        draft=self.create()
        status,data=self.remove(draft,request_id='creation_req_2027')
        self.assertEqual((status,data['error']),(409,'request_id_payload_conflict'))
        self.assertEqual(len(control('GET',path=self.path)[1]['plans']),1)

    def test_legacy_state_without_retirement_array_still_loads(self):
        draft=self.create()
        self.assertEqual(control('GET',path=self.path)[0],200)
        self.assertEqual(self.remove(draft)[0],200)

    def test_invalid_retired_ids_and_intersection_refused_without_mutation(self):
        import json
        draft=self.create()
        baseline=json.loads(self.path.read_text())
        cases = ([1],['creation_req_2027'],['same_req_123','same_req_123'],
                 ['short'],[True],{'id':'invalid'})
        for retired in cases:
            with self.subTest(retired=retired):
                raw=json.dumps({**baseline,'retiredRequestIds':retired})
                self.path.write_text(raw)
                status,data=control('POST',{**self.request,'requestId':'new_request_27'},path=self.path)
                self.assertEqual((status,data['error']),(400,'plans_invalid'))
                self.assertEqual(self.path.read_text(),raw)

    def test_duplicate_live_history_between_drafts_refused(self):
        import json
        first=self.create()
        second=control('POST',{**self.request,'requestId':'second_req_2027','title':'Other'},path=self.path)[1]['plan']
        data=json.loads(self.path.read_text())
        data['plans'][1]['requestIds']=['creation_req_2027']
        data['plans'][1]['lastRequestId']='creation_req_2027'
        raw=json.dumps(data)
        self.path.write_text(raw)
        status,result=control('GET',path=self.path)
        self.assertEqual((status,result['error']),(400,'plans_invalid'))
        self.assertEqual(self.path.read_text(),raw)

    def test_retirement_capacity_refuses_without_deletion(self):
        import json
        from unittest.mock import patch
        draft=self.create()
        state=json.loads(self.path.read_text())
        state['retiredRequestIds']=['retired_request_123']
        self.path.write_text(json.dumps(state))
        original=self.path.read_bytes()
        with patch('ghost_schedule_plans.MAX_RETIRED_REQUEST_IDS',2):
            status,data=self.remove(draft)
        self.assertEqual((status,data['error']),(400,'retired_request_ids_limit_reached'))
        self.assertEqual(self.path.read_bytes(),original)
