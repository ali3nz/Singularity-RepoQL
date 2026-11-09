"""Exercise the continuous collector's actual SQLite writes and restart behaviour.

Uses a deterministic fake RepoQL status and Rust probe; no Win32 claims.
"""
import os
import sqlite3
from contextlib import closing
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from repoql_bridge import Config
from native_cpu_history import collect_once, run_collector, series, db_path, WIN_EPOCH_TICKS
from server import PERIODS

NOW=1793253600
START=NOW-100

def reply(pid, started=START, cpu=16.0):
    return {'host':{'pid':pid,'startedAt':datetime.fromtimestamp(started,timezone.utc).isoformat()}}

def probe(created=START, cpu=16.0, pid=123):
    return {'available':True,'source':'rust-win32','pid':pid,'process_created_filetime':WIN_EPOCH_TICKS+created*10000000,
            'cpu_pct':cpu,'host_pct':cpu/8,'system_cpu_pct':20,'cores':8}

class CollectorLifecycle(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.config=Config(workspace=Path(self.temp.name),rql=Path('/missing'),state_dir=Path(self.temp.name)/'state',bind='127.0.0.1',port=0)
        env=patch.dict(os.environ,{'SINGULARITY_WINDOWS_NATIVE':'1','SINGULARITY_INSTALL_VARIANT':'1'})
        env.start();self.addCleanup(env.stop)
    def test_one_shot_success_writes_verified_cpu(self):
        row=collect_once(self.config,lambda **k:reply(123),sampler=lambda _:probe(),now=NOW)
        self.assertEqual(row['state'],'ok')
        self.assertEqual(series(self.config,'1h',PERIODS,now=NOW)['stats']['avg'],16)
    def test_rust_source_and_exact_pid_are_required(self):
        for changed in ({'pid': 456}, {'source': 'linux-proc'}, {'source': None}, {'pid': True}):
            with self.subTest(changed=changed):
                sample = {**probe(), **changed}
                row = collect_once(self.config, lambda **kw: reply(123),
                                   sampler=lambda _: sample, now=NOW)
                self.assertEqual(row['state'], 'identity_mismatch')
                self.assertIsNone(row['cpu_pct'])

    def test_missing_repoql_becomes_gap_not_zero(self):
        def fail(**kwargs):raise TimeoutError('upstream unavailable')
        row=collect_once(self.config,fail,sampler=lambda _:self.fail('unexpected cpu probe'),now=NOW)
        self.assertEqual(row['state'],'unavailable')
        self.assertIsNone(row['cpu_pct'])
    def test_unexpected_storage_failure_must_exit_and_not_claim_success(self):
        self.config.state_dir.mkdir(parents=True)
        db_path(self.config).mkdir() # SQLite cannot write to a directory
        with self.assertRaises(sqlite3.OperationalError):
            run_collector(self.config,lambda **kw:reply(123),once=True,
                          sampler=lambda _:probe(),clock=lambda:NOW)
    def test_restart_changed_pid_records_gap_then_recovers(self):
        positions=[NOW,NOW+30,NOW+60,NOW+90]
        statuses=[reply(123), reply(124), reply(125,started=START+60), reply(126,started=START+60)]
        samples=[probe(),probe(),probe(created=START+60),probe(created=START+60)]
        for i in range(len(positions)):
            status=statuses[i]
            row=collect_once(self.config,lambda **kw:status,
                             sampler=lambda _: {**samples[i],'pid': (123 if i == 1 else status['host']['pid'])},now=positions[i])
            self.assertEqual(row['state'],'ok' if i in (0,2,3) else 'identity_mismatch')
        data=series(self.config,'1h',PERIODS,now=NOW+90)
        self.assertEqual(data['stats']['samples'],3)
        self.assertGreaterEqual(data['stats']['gaps'],1)
    def test_supervisor_style_loop_runs_and_stops_without_relaunch(self):
        ticks=iter((NOW,NOW+30))
        sleeps=[]
        def sleep(seconds):
            self.assertEqual(seconds,30)
            sleeps.append(seconds)
            if len(sleeps)==2:raise StopIteration('simulate externally owned stop')
        with self.assertRaises(StopIteration):
            run_collector(self.config,lambda **kw:reply(123),sampler=lambda _:probe(),
                          clock=lambda:next(ticks), sleep=sleep)
        with closing(sqlite3.connect(db_path(self.config))) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM win_cpu_samples').fetchone()[0],2)
        self.assertEqual(sleeps,[30,30])
    def test_four_variants_never_share_history(self):
        for n in (1,2,3,4):
            with patch.dict(os.environ,{'SINGULARITY_INSTALL_VARIANT':str(n)}):
                collect_once(self.config,lambda **kw:reply(123),sampler=lambda _:probe(cpu=10+n),now=NOW)
        for n in (1,2,3,4):
            with patch.dict(os.environ,{'SINGULARITY_INSTALL_VARIANT':str(n)}):
                self.assertEqual(series(self.config,'1h',PERIODS,now=NOW)['stats']['avg'],10+n)

if __name__=='__main__':unittest.main()
