"""Live agent seat bridge tests; native process mocked, not compiled Rust parity."""
import datetime as dt
import json
import os
from pathlib import Path
import random
import subprocess
import tempfile
import unittest
from unittest.mock import Mock,patch
from agent_seat_projection import project_agent_seats, _reference, _safe_events
from harness_telemetry import Harness


def event(kind, agent='alpha', status=None, model=None, ts='2026-11-13T00:00:00Z', **kw):
    return dict(kind=kind,agent=agent,status=status,model=model,provider=kw.get('provider'),
                stage=kw.get('stage'),ts=ts)


def legacy(events):
    seats={}
    for ev in reversed(events):
        agent=ev['agent'] or 'coordinator'
        if ev['kind'] in ('agent_assigned','agent_started','agent_waiting','agent_error'):
            cur=seats.setdefault(agent,{'agent':agent,'model':None,'provider':None,
                         'stage':None,'status':'assigned','started_at':None,
                         'last_event':None,'duration_ms':None})
            cur['model']=cur['model'] or ev['model']
            cur['provider']=cur['provider'] or ev['provider']
            cur['stage']=ev['stage'] or cur['stage']
            cur['status']='error' if ev['kind']=='agent_error' else ev['status'] or cur['status']
            cur['started_at']=cur['started_at'] or ev['ts']
            cur['last_event']=ev['ts']
    return seats


class AgentSeatBridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.binary=Path(self.tmp.name)/'seats.exe';self.binary.write_bytes(b'fixture')
        self.events=[
            event('agent_started',model='model-two',status='active',stage='final',ts='2026-11-13T00:00:08Z'),
            event('agent_error',model='model-one',status=None,ts='2026-11-13T00:00:05Z'),
            event('agent_assigned',model=None,stage='plan',ts='2026-11-13T00:00:00Z'),
        ]
        _,names,self.safe=_safe_events(self.events)
        self.expected=_reference(self.safe)
        self.assertEqual(names,['alpha'])

    def test_reference_matches_prior_state_machine(self):
        self.assertEqual(project_agent_seats(self.events,rust_bin=''),legacy(self.events))
        self.assertEqual(project_agent_seats([],rust_bin=''),{})
        rng=random.Random(4939)
        for _ in range(300):
            n=rng.randrange(0,100)
            events=[event(kind=rng.choice(['agent_assigned','agent_started','agent_waiting',
                                           'agent_error','model_called']),
                          agent=rng.choice([None,'alpha','beta','coordinator']),
                          status=rng.choice([None,'active','waiting','error','']),
                          model=rng.choice([None,'model1','model2','']),
                          provider=rng.choice([None,'p1','p2','']),
                          stage=rng.choice([None,'plan','review','']),
                          ts=rng.choice([None,'2026-11-13T00:00:00Z',
                                         '2026-11-13T00:00:10Z'])) for _ in range(n)]
            self.assertEqual(project_agent_seats(events,rust_bin=''),legacy(events))

    def test_privacy_preserving_exact_native_parity(self):
        fake=Mock(return_value=subprocess.CompletedProcess([],0,json.dumps(self.expected),''))
        with patch.dict(os.environ,{'SINGULARITY_HARNESS_AGENT_SEATS_RUST_BINARY':str(self.binary),
                                    'PRIVATE_PASSWORD':'SECRET'}):
            got=project_agent_seats(self.events,runner=fake)
        self.assertEqual(got,legacy(self.events))
        args,kwargs=fake.call_args
        self.assertEqual(args,([str(self.binary)],))
        self.assertFalse(kwargs['shell']);self.assertEqual(kwargs['timeout'],8)
        self.assertNotIn('PRIVATE_PASSWORD',kwargs['env'])
        r=json.loads(kwargs['input'])
        self.assertEqual(r['agent_count'],1)
        self.assertEqual(len(r['events']),3)
        for private in ('alpha','model-one','plan','SECRET','run_id','private'):
            self.assertNotIn(private,kwargs['input'])

    def test_forged_state_and_child_failure_rejected(self):
        for out,exit_code in ((json.dumps(self.expected[:-1]),0),
                              (json.dumps([dict(self.expected[0],status_error=True)]),0),
                              ('invalid json',0),('',2)):
            with self.subTest(out=out),self.assertRaisesRegex(RuntimeError,'agent_seats_native_'):
                fake=Mock(return_value=subprocess.CompletedProcess([],exit_code,out,''))
                project_agent_seats(self.events,rust_bin=self.binary,runner=fake)

    def test_binary_guard_and_bounds(self):
        with self.assertRaisesRegex(RuntimeError,'binary_invalid'):
            project_agent_seats([],rust_bin='relative.exe')
        with self.assertRaisesRegex(RuntimeError,'input_too_large'):
            project_agent_seats(self.events*100,rust_bin=self.binary)
        link=self.binary.parent/'link.exe'
        try:link.symlink_to(self.binary)
        except OSError:return
        with self.assertRaisesRegex(RuntimeError,'binary_invalid'):
            project_agent_seats([],rust_bin=link)

    def test_harness_active_agents_and_sessions_still_render(self):
        h=Harness(self.tmp.name)
        now=dt.datetime.now(dt.timezone.utc)
        stamp=now.strftime('%Y-%m-%dT%H:%M:%SZ')
        run={'run_id':'r1','title':'private','mode':'dual','stage':'review',
             'state':'active','roster':'alpha','started_at':stamp,'updated_at':stamp,'ended_at':None}
        events=[dict(v) for v in self.events]
        for ev in events: ev['ts']=stamp
        def query(sql,args=()):
            if 'FROM runs' in sql:return [run]
            if 'FROM events' in sql:return events
            if 'FROM sessions' in sql:return []
            raise AssertionError(sql)
        h._q=query
        with patch.dict(os.environ,{'SINGULARITY_HARNESS_AGENT_SEATS_RUST_BINARY':''}):
            got=h.agents()
        self.assertFalse(got['runs'][0]['stale'])
        seat=got['runs'][0]['agents'][0]
        self.assertEqual(seat['agent'],'alpha')
        self.assertEqual(seat['model'],'model-one')
        self.assertEqual(seat['status'],'active')
        self.assertEqual(seat['stage'],'final')
        self.assertIsInstance(seat['duration_ms'],int)
        self.assertEqual(got['sessions'],[])
        h.close()

if __name__=='__main__':unittest.main()
