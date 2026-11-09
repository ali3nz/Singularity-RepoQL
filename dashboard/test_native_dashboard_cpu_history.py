"""Never serve Linux CPU history or quota semantics as native Windows data."""
import os
from contextlib import closing
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from repoql_bridge import Config
from server import App

class DashboardCpuHistory(unittest.TestCase):
    def test_native_windows_does_not_reuse_even_existing_linux_cpu_db(self):
        with tempfile.TemporaryDirectory() as d:
            cfg=Config(workspace=Path(d),rql=Path('/missing'),state_dir=Path(d)/'state',bind='127.0.0.1',port=0)
            with patch.dict(os.environ,{'SINGULARITY_WINDOWS_NATIVE':'1','SINGULARITY_INSTALL_VARIANT':'1'}):
                app=App(cfg)
                try:
                    # An old Linux fixture must not appear on the native UI.
                    with closing(app.cpu_conn()) as db:
                        db.execute('CREATE TABLE IF NOT EXISTS cpu_samples (ts INTEGER, cpu_pct REAL, host_pct REAL, state TEXT, pid INTEGER)')
                        db.execute('INSERT INTO cpu_samples VALUES (2000000000,400,40,"ok",42)')
                    result=app.cpu_series('24h')
                    self.assertFalse(result['available'])
                    self.assertEqual(result['series'],[])
                    self.assertIsNone(result['stats']['avg'])
                    self.assertEqual(result['reason'],'native_windows_cpu_history_collector_not_installed')
                finally:pass
    def test_linux_path_not_changed(self):
        with tempfile.TemporaryDirectory() as d:
            cfg=Config(workspace=Path(d),rql=Path('/missing'),state_dir=Path(d)/'state',bind='127.0.0.1',port=0)
            with patch.dict(os.environ,{'SINGULARITY_WINDOWS_NATIVE':'0'}):
                app=App(cfg)
                try:
                    result=app.cpu_series('24h')
                    self.assertNotIn('reason',result)
                    self.assertEqual(result['series'],[])
                finally:pass
if __name__=='__main__':unittest.main()
