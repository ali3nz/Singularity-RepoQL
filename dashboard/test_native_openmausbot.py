import datetime as dt
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from native_openmausbot import operations, overview, role_names


class MockOMB(BaseHTTPRequestHandler):
    requested = []
    def log_message(self, *_): pass
    def do_GET(self):
        self.requested.append(self.path)
        data = ({'app':'openmausbot'} if self.path == '/api/health'
                else {'routines': [], 'runs': []} if self.path == '/api/routines'
                else {'bots':[{'id':'bot_A','name':'Alpha','busy':True,'threadId':'thread_A'},
                              {'id':'bad/id','name':'Unsafe'}]})
        raw=json.dumps(data).encode()
        self.send_response(200)
        self.send_header('Content-Type','application/json')
        self.send_header('Content-Length',str(len(raw)))
        self.end_headers(); self.wfile.write(raw)


class NativeOpenMausBotTest(unittest.TestCase):
    def test_role_names_use_uuid_roles_and_trimmed_bounded_names(self):
        inventory = {'available': True, 'bots': [
            {'id': '01234567-89ab-cdef-0123-456789abcdef', 'name': '  Builder <bot>  '},
            {'id': 'fedcba9876543210fedcba9876543210', 'name': 'x' * 80},
            {'id': 'bot_A', 'name': 'Invalid identity'},
            {'name': 'Missing identity'},
            {'id': '11111111-1111-1111-1111-111111111111'},
            {'id': '22222222-2222-2222-2222-222222222222', 'name': '  '},
        ]}
        with patch('native_openmausbot.overview', return_value=inventory) as read:
            state = Path('local-state')
            self.assertEqual(role_names(state), {
                'omb-0123456789abcdef0123456789abcdef': 'Builder <bot>',
                'omb-fedcba9876543210fedcba9876543210': 'x' * 60,
            })
            read.assert_called_once_with(state)

    def test_role_names_are_empty_when_local_service_is_unavailable(self):
        with patch('native_openmausbot.overview', return_value={
            'available': False, 'reason': 'service_unavailable', 'bots': [],
        }):
            self.assertEqual(role_names(Path('local-state')), {})

    def test_local_only_read_and_truthful_external_states(self):
        MockOMB.requested=[]
        srv=ThreadingHTTPServer(('127.0.0.1',0),MockOMB)
        th=threading.Thread(target=srv.serve_forever,daemon=True);th.start()
        try:
            with tempfile.TemporaryDirectory() as td, patch.dict(os.environ,{
                'SINGULARITY_WINDOWS_NATIVE':'1','SINGULARITY_WINDOWS_OMB_PORT':str(srv.server_address[1])}):
                result=overview(Path(td))
                self.assertTrue(result['available'])
                self.assertEqual(result['total'],2)
                self.assertEqual(len(result['bots']),1)
                self.assertTrue(result['bots'][0]['working'])
                self.assertEqual(result['bots'][0]['duo'],'not_verified')
                self.assertEqual(MockOMB.requested,['/api/health','/api/bots?messages=0'])
        finally:
            srv.shutdown();srv.server_close();th.join(timeout=2)

    def test_no_remote_fallback(self):
        with tempfile.TemporaryDirectory() as td, patch.dict(os.environ,{
            'SINGULARITY_WINDOWS_NATIVE':'1','SINGULARITY_WINDOWS_OMB_PORT':'0'}):
            self.assertEqual(overview(Path(td))['reason'],'invalid_local_port')
        with tempfile.TemporaryDirectory() as td, patch.dict(os.environ,{'SINGULARITY_WINDOWS_NATIVE':'0'}):
            self.assertEqual(overview(Path(td))['reason'],'windows_native_only')

    def test_operations_uses_the_bounded_network_reader(self):
        MockOMB.requested=[]
        srv=ThreadingHTTPServer(('127.0.0.1',0),MockOMB)
        th=threading.Thread(target=srv.serve_forever,daemon=True);th.start()
        try:
            with tempfile.TemporaryDirectory() as td, patch.dict(os.environ,{
                'SINGULARITY_WINDOWS_NATIVE':'1','SINGULARITY_WINDOWS_OMB_PORT':str(srv.server_address[1])}):
                result=operations(Path(td),1000,2000,now_ms=1500)
                self.assertEqual(result['sources']['routines']['state'],'ok')
                self.assertEqual(result['sources']['bots']['state'],'ok')
                self.assertEqual(MockOMB.requested,['/api/health','/api/routines','/api/bots?messages=0'])
        finally:
            srv.shutdown();srv.server_close();th.join(timeout=2)


class NativeOperationsTest(unittest.TestCase):
    def setUp(self):
        self.now = 1_800_000_000_000
        self.documents = {
            '/api/health': {'app': 'openmausbot'},
            '/api/bots?messages=0': {'bots': [{'id': 'bot_A', 'name': 'Alpha', 'instructions': 'PRIVATE_SOURCE_TEXT'}]},
            '/api/routines': {'routines': [], 'runs': []},
        }
        self.paths = []

    def read(self, path):
        self.paths.append(path)
        value = self.documents[path]
        if isinstance(value, Exception):
            raise value
        return value

    def result(self):
        with patch('native_openmausbot._reader', return_value=self.read):
            result = operations(Path('.'), self.now - 60_000, self.now + 86_400_000, now_ms=self.now)
            return result

    def routine(self, schedule, **extra):
        return {'id': 'routine_A', 'name': 'Routine A', 'botId': 'bot_A', 'enabled': True,
                'createdAt': self.now, 'schedule': schedule, 'prompt': 'PRIVATE_SOURCE_TEXT', **extra}

    def test_exact_read_paths_and_private_fields_are_not_projected(self):
        self.documents['/api/routines'] = {
            'routines': [self.routine({'type': 'once', 'at': self.now})],
            'runs': [{'id': 'run_A', 'routineId': 'routine_A', 'botId': 'bot_A', 'status': 'completed',
                      'createdAt': self.now, 'prompt': 'PRIVATE_SOURCE_TEXT', 'output': 'PRIVATE_SOURCE_TEXT',
                      'messages': ['PRIVATE_SOURCE_TEXT'], 'instructions': 'PRIVATE_SOURCE_TEXT'}],
        }
        result = self.result()
        self.assertEqual(self.paths, ['/api/health', '/api/routines', '/api/bots?messages=0'])
        self.assertNotIn('ghost_bot_id', result)
        self.assertNotIn('PRIVATE_SOURCE_TEXT', json.dumps(result))
        self.assertEqual(result['runs'][0]['status'], 'completed')
        self.assertEqual(result['sources']['routines']['state'], 'ok')
        self.assertNotIn('age_seconds', result['sources']['routines'])

    def test_supported_schedule_types_and_explicit_daily_timezone(self):
        schedules = [
            {'type': 'once', 'at': self.now},
            {'type': 'interval', 'everyMinutes': 30, 'anchorAt': self.now},
            {'type': 'cron', 'expression': '* * * * *', 'timeZone': 'UTC'},
            {'type': 'daily', 'time': '12:00', 'weekdays': list(range(7)), 'timeZone': 'Pacific/Auckland'},
        ]
        for schedule in schedules:
            with self.subTest(schedule=schedule):
                self.documents['/api/routines']['routines'] = [self.routine(schedule)]
                result = self.result()
                self.assertTrue(result['occurrences'])
                self.assertFalse(result['schedule_warnings'])

    def test_unknown_timezone_and_restrictions_have_no_invented_occurrences(self):
        schedules = [
            {'type': 'daily', 'time': '12:00', 'weekdays': [1]},
            {'type': 'cron', 'expression': '* * * * *'},
            {'type': 'cron', 'expression': '* * * * *', 'timeZone': 'Unknown/Zone'},
            *({'type': 'interval', 'everyMinutes': 30, 'anchorAt': self.now, key: value}
              for key, value in [('weekdays', [1]), ('window', {'start': '08:00', 'end': '17:00'}), ('endsAt', self.now)]),
        ]
        for schedule in schedules:
            with self.subTest(schedule=schedule):
                self.documents['/api/routines']['routines'] = [self.routine(schedule)]
                result = self.result()
                self.assertEqual(result['occurrences'], [])
                self.assertTrue(result['schedule_warnings'])

    def test_only_running_records_are_currently_running(self):
        statuses = ['queued', 'waiting', 'cancelled', 'missed', 'running', 'completed', 'failed', 'future_status']
        self.documents['/api/routines']['runs'] = [
            {'id': status, 'status': status, 'botId': 'bot_A', 'createdAt': self.now} for status in statuses]
        result = self.result()
        self.assertEqual([run['status'] for run in result['now']['running']], ['running'])
        self.assertEqual({run['status'] for run in result['runs']}, set(statuses))
        self.assertTrue(any(item['kind'] == 'missed_run' for item in result['attention']))

    def test_iso_interval_anchor_and_run_match_native_provisioning_shape(self):
        self.now = int(dt.datetime(2026, 11, 8, 12, tzinfo=dt.timezone.utc).timestamp() * 1000)
        stamp = '2026-11-08T12:00:00.000Z'
        self.documents['/api/routines'] = {
            'routines': [self.routine({'type': 'interval', 'everyMinutes': 360, 'anchorAt': stamp},
                createdAt=stamp, nextRunAt='2026-11-08T18:00:00+00:00')],
            'runs': [{'id': 'iso_run', 'routineId': 'routine_A', 'botId': 'bot_A', 'status': 'completed',
                      'triggerSource': 'schedule', 'scheduledFor': stamp, 'createdAt': stamp,
                      'startedAt': '2026-11-08T12:00:01.000Z', 'finishedAt': '2026-11-08T12:00:02.000Z'}],
        }
        result = self.result()
        self.assertFalse(result['schedule_warnings'])
        occurrence = next(item for item in result['occurrences'] if item['at'] == self.now)
        self.assertEqual((occurrence['state'], occurrence['run_id']), ('ran', 'iso_run'))
        self.assertEqual(result['runs'][0]['created_at'], self.now)
        self.assertEqual(result['routines'][0]['next_run_at'], self.now + 360 * 60_000)
        self.documents['/api/routines']['routines'] = [self.routine({'type': 'once', 'at': stamp})]
        self.assertEqual(self.result()['occurrences'][0]['at'], self.now)

    def test_invalid_or_naive_timestamp_marks_source_unavailable(self):
        for value in ['2026-11-08T12:00:00', 'invalid', True, 0.5, -1]:
            with self.subTest(value=value):
                self.documents['/api/routines']['routines'] = [self.routine({'type': 'once', 'at': value})]
                result = self.result()
                self.assertEqual(result['sources']['routines']['state'], 'unavailable')
                self.assertFalse(result['occurrences'])

    def test_zero_epoch_anchor_keeps_its_interval_phase(self):
        self.documents['/api/routines']['routines'] = [self.routine(
            {'type': 'interval', 'everyMinutes': 7, 'anchorAt': 0})]
        result = self.result()
        self.assertTrue(result['occurrences'])
        self.assertTrue(all(item['at'] % (7 * 60_000) == 0 for item in result['occurrences']))

    def test_daily_single_weekday_uses_native_sunday_zero_numbering(self):
        # Native routine-schedules.js uses Date.getDay(), so Monday is 1.
        self.now = int(dt.datetime(2026, 11, 8, 22, tzinfo=dt.timezone.utc).timestamp() * 1000)
        self.documents['/api/routines']['routines'] = [self.routine(
            {'type': 'daily', 'time': '12:00', 'weekdays': [1], 'timeZone': 'Pacific/Auckland'})]
        result = self.result()
        self.assertEqual([item['at'] for item in result['occurrences']], [self.now + 3_600_000])

    def test_unavailable_or_invalid_source_does_not_claim_empty_healthy_data(self):
        for value in [RuntimeError('service_not_authorised'), {'routines': []}, []]:
            with self.subTest(value_type=type(value).__name__):
                self.documents['/api/routines'] = value
                result = self.result()
                self.assertEqual(result['sources']['routines']['state'], 'unavailable')
                self.assertEqual(result['sources']['bots']['state'], 'ok')

    def test_health_identity_and_invalid_windows_stop_before_other_requests(self):
        self.documents['/api/health'] = {'app': 'other'}
        result = self.result()
        self.assertEqual(self.paths, ['/api/health'])
        self.assertEqual(result['sources']['routines']['state'], 'unavailable')
        with patch('native_openmausbot._reader') as reader:
            for start, end in [(self.now, self.now), (self.now, self.now - 1), (self.now, self.now + 46 * 86_400_000)]:
                with self.assertRaises(ValueError):
                    operations(Path('.'), start, end)
            reader.assert_not_called()


if __name__=='__main__': unittest.main()
