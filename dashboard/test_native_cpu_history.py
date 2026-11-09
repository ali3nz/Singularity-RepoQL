"""Real SQLite history and identity tests using deterministic simulated Rust replies.

These are NOT live Win32 process-identity tests.
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
from native_cpu_history import record, series, db_path, WIN_EPOCH_TICKS
from server import App, PERIODS

NOW = 1793253600
CREATED = NOW - 100
START = datetime.fromtimestamp(CREATED, timezone.utc).isoformat().replace('+00:00','Z')
FILETIME = WIN_EPOCH_TICKS + CREATED * 10000000

def sample(pid=123, created=FILETIME, cpu=57.2):
    return {'available': True, 'pid': pid, 'source': 'rust-win32',
            'process_created_filetime': created, 'cpu_pct': cpu,
            'host_pct': cpu / 8, 'system_cpu_pct': 32.1, 'cores': 8}

class NativeWindowsCpuHistory(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.config=Config(workspace=Path(self.temp.name),rql=Path('/missing'),
                           state_dir=Path(self.temp.name)/'state', bind='127.0.0.1',port=0)
        patcher=patch.dict(os.environ, {'SINGULARITY_WINDOWS_NATIVE':'1','SINGULARITY_INSTALL_VARIANT':'1'})
        patcher.start();self.addCleanup(patcher.stop)

    def test_verified_sample_persists_and_chart_is_genuine(self):
        status={'host': {'pid':123,'startedAt':START}}
        row=record(self.config,status,sampler=lambda pid:sample(pid),now=NOW)
        self.assertEqual(row['state'],'ok')
        data=series(self.config,'1h',PERIODS,now=NOW)
        self.assertTrue(data['available'])
        self.assertEqual(data['stats']['samples'],1)
        self.assertEqual(data['stats']['avg'],57.2)
        self.assertEqual(data['series'][0]['avg'],57.2)
        self.assertEqual(data['process_scale'],'percent-of-one-core')
        self.assertFalse((self.config.state_dir/'cpu.db').exists())

    def test_stale_or_reused_pid_is_never_attributed(self):
        state={'host': {'pid':123, 'startedAt':START}}
        changed=FILETIME+3600*10000000
        row=record(self.config,state,sampler=lambda _:sample(created=changed),now=NOW)
        self.assertEqual(row['state'],'identity_mismatch')
        self.assertIsNone(row['cpu_pct'])
        with closing(sqlite3.connect(db_path(self.config))) as db:
            value=db.execute('SELECT cpu_pct FROM win_cpu_samples').fetchone()[0]
        self.assertIsNone(value)
        data=series(self.config,'1h',PERIODS,now=NOW)
        self.assertFalse(data['available'])
        self.assertGreater(data['stats']['gaps'],0)
        self.assertIsNone(data['stats']['avg'])

    def test_unknown_process_and_missing_binary_are_not_zero(self):
        seen=[]
        def forbidden(_):
            seen.append(True)
            raise AssertionError('must not try unverified PID')
        row=record(self.config,{'host':{'pid':123}},sampler=forbidden,now=NOW)
        self.assertEqual(row['state'],'unavailable')
        self.assertEqual(seen,[])
        self.assertIsNone(row['cpu_pct'])

    def test_variants_isolated_and_old_linux_db_ignored(self):
        record(self.config,{'host':{'pid':123,'startedAt':START}},sampler=lambda _:sample(),now=NOW)
        with closing(sqlite3.connect(self.config.state_dir/'cpu.db')) as db:
            db.execute('CREATE TABLE cpu_samples(ts INTEGER,cpu_pct REAL)')
            db.execute('INSERT INTO cpu_samples VALUES (?,?)',(NOW,9999))
        with patch.dict(os.environ,{'SINGULARITY_INSTALL_VARIANT':'3'}):
            self.assertFalse(series(self.config,'1h',PERIODS,now=NOW)['available'])
            record(self.config,{'host':{'pid':123,'startedAt':START}},sampler=lambda _:sample(cpu=30),now=NOW)
            data=series(self.config,'1h',PERIODS,now=NOW)
            self.assertEqual(data['stats']['avg'],30)
        self.assertEqual(series(self.config,'1h',PERIODS,now=NOW)['stats']['avg'],57.2)

    def test_bad_profile_fails_closed(self):
        with patch.dict(os.environ,{'SINGULARITY_INSTALL_VARIANT':'7'}):
            self.assertEqual(series(self.config,'1h',PERIODS,now=NOW)['reason'],'native_windows_install_variant_unconfigured')
            with self.assertRaises(ValueError):
                record(self.config,{},now=NOW)

    def test_retention_and_missing_sample_gaps(self):
        record(self.config,{'host':{'pid':123,'startedAt':START}},sampler=lambda _:sample(),now=NOW-86400*31)
        record(self.config,{'host':{'pid':123,'startedAt':START}},sampler=lambda _:sample(),now=NOW)
        with closing(sqlite3.connect(db_path(self.config))) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM win_cpu_samples').fetchone()[0],1)
        record(self.config,{},now=NOW+30)
        data=series(self.config,'1h',PERIODS,now=NOW+30)
        self.assertEqual(data['stats']['samples'],1)
        self.assertGreater(data['stats']['gaps'],0)

    def test_live_http_api_isolated_under_all_four_install_options(self):
        import http.client
        import threading
        import time
        import json
        from server import build_server
        now=int(time.time())
        created=now-50
        started=datetime.fromtimestamp(created,timezone.utc).isoformat()
        for option in ('1','2','3','4'):
            with self.subTest(option=option), patch.dict(os.environ, {'SINGULARITY_INSTALL_VARIANT':option}):
                record(self.config, {'host':{'pid':123,'startedAt':started}},
                       sampler=lambda _:sample(created=WIN_EPOCH_TICKS+created*10000000,cpu=20+int(option)),now=now)
                server=build_server(self.config)
                worker=threading.Thread(target=server.serve_forever,daemon=True)
                worker.start()
                try:
                    conn=http.client.HTTPConnection('127.0.0.1', server.server_port,timeout=3)
                    conn.request('GET','/api/cpu?period=1h',headers={'Authorization':'Bearer '+server.RequestHandlerClass.app.token})
                    response=conn.getresponse()
                    self.assertEqual(response.status,200)
                    data=json.loads(response.read())
                    conn.close()
                    self.assertEqual(data['stats']['avg'],20+int(option))
                    self.assertTrue(data['available'])
                finally:
                    server.shutdown();server.server_close();worker.join(timeout=3)

    def test_dashboard_route_uses_native_db_not_linux_db(self):
        self.assertFalse(App(self.config).cpu_series('1h')['available'])
        # App.cpu_series uses current real time; place an observation now.
        import time
        now=int(time.time())
        created=now-50
        started=datetime.fromtimestamp(created,timezone.utc).isoformat()
        record(self.config,{'host':{'pid':123,'startedAt':started}},
               sampler=lambda _: sample(created=WIN_EPOCH_TICKS+created*10000000),now=now)
        app=App(self.config)
        self.assertEqual(app.cpu_series('1h')['stats']['samples'],1)

if __name__=='__main__': unittest.main()
