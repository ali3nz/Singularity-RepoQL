"""Real local HTTP tests; no fake native runtime passes."""
import contextlib
import http.server
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parent))
from native_runtime_acceptance import (SCHEMA,validate,observe,observe_health,_local_windows_path,main)


def cfg(variant=2):
    return {'schema':SCHEMA,'variant':variant,'repoql_version':'1.7.18',
            'files':{'repoql':r'C:\Singularity\rql.exe', 'bridge':r'C:\Singularity\singularity-desktop-bridge.exe',
                     'supervisor':r'C:\Singularity\singularity-windows-supervisor.exe', 'gui':r'C:\Applications\OpenChamber.exe'},
            'health':[{'id':'dashboard','port':7777}]}


class HealthHandler(http.server.BaseHTTPRequestHandler):
    status=200
    identity='dashboard'
    duplicate=False
    def do_GET(self):
        self.send_response(self.status)
        self.send_header('X-Singularity-Component',self.identity)
        if self.duplicate:self.send_header('X-Singularity-Component',self.identity)
        self.send_header('Content-Length','0')
        self.end_headers()
    def log_message(self,*a):pass


@contextlib.contextmanager
def server(status=200, identity='dashboard', duplicate=False):
    handler=type('CaseHandler',(HealthHandler,),{'status':status,'identity':identity,'duplicate':duplicate})
    host=http.server.ThreadingHTTPServer(('127.0.0.1',0),handler)
    t=threading.Thread(target=host.serve_forever,daemon=True);t.start()
    try:yield host.server_port
    finally:host.shutdown();host.server_close();t.join(timeout=2)


class NativeAcceptanceTests(unittest.TestCase):
    def test_local_absolute_windows_path_not_unc_or_wsl(self):
        self.assertTrue(_local_windows_path(r'C:\Singularity\repoql.exe'))
        for invalid in ('/usr/bin/rql','../rql.exe',r'\\wsl$\Ubuntu\rql.exe',r'\\server\bin\rql.exe',
                        r'C:\foo\..\rql.exe',r'C:repoql.exe',r'\\?\C:\repoql.exe'):
            self.assertFalse(_local_windows_path(invalid),invalid)
    def test_config_rejects_unknown_commands_and_credentials(self):
        for key,value in [('extra','token'),('token','secret'),('commands',['cmd.exe'])]:
            x=cfg();x[key]=value
            with self.assertRaises(ValueError):validate(x)
    def test_lean_option_rejects_office(self):
        x=cfg(1);x['health'].append({'id':'claude-office','port':9999})
        with self.assertRaises(ValueError):validate(x)
    def test_rejects_ntfs_ads_reserved_names_and_wrapper_exes(self):
        for invalid in (r'C:\app\foo:ads.exe',r'C:\app\CON.exe',r'C:\app\foo.\x.exe',
                        r'C:\app\COM1.exe',r'C:\app\bad?.exe'):
            self.assertFalse(_local_windows_path(invalid),invalid)
        x=cfg();x['files']['gui']=r'C:\Windows\System32\wsl.exe'
        with self.assertRaises(ValueError):validate(x)
    def test_duplicate_ports_and_bool_port_rejected(self):
        x=cfg();x['health'].append({'id':'kanzo','port':7777})
        with self.assertRaises(ValueError):validate(x)
        x=cfg();x['health'][0]['port']=True
        with self.assertRaises(ValueError):validate(x)
    def test_real_loopback_identity_accepts_only_reachability(self):
        with server() as port:
            self.assertEqual(observe_health('dashboard',port)['status'],'OBSERVED_IDENTITY_SHAPED_HTTP')
            self.assertEqual(observe_health('kanzo',port)['status'],'BLOCKED')
    def test_real_loopback_redirect_and_duplicate_rejected(self):
        for opts in ({'status':302},{'duplicate':True},{'identity':'wrong'}):
            with server(**opts) as port:
                self.assertEqual(observe_health('dashboard',port)['status'],'BLOCKED')
    def test_non_windows_does_not_claim_any_runtime_proof(self):
        report=observe(cfg(),windows_host=False)
        self.assertFalse(report['public_release_ready'])
        self.assertFalse(report['behavioral_parity_verified'])
        self.assertFalse(report['installer_verified'])
        self.assertEqual(report['service_observations']['dashboard']['status'],'BLOCKED')
        self.assertEqual(report['binary_observations']['repoql']['status'],'BLOCKED')
    def test_even_all_probes_observed_does_not_claim_functional_parity(self):
        report=observe(cfg(),windows_host=True,
            binary_checker=lambda *a,**k:{'status':'OBSERVED_VERSION_MATCH'},
            health_checker=lambda *a,**k:{'status':'OBSERVED_IDENTITY_SHAPED_HTTP'})
        self.assertFalse(report['public_release_ready'])
        self.assertFalse(report['behavioral_parity_verified'])
        self.assertEqual(report['feature_receipts_generated'],[])
    def test_linux_cli_refuses_to_mint_windows_receipt(self):
        if sys.platform=='win32': self.skipTest('native Windows runner')
        with tempfile.TemporaryDirectory() as d:
            config=Path(d)/'config.json'; config.write_text(json.dumps(cfg()))
            proc=subprocess.run([sys.executable,str(Path(__file__).parent/'native_runtime_acceptance.py'),
                                 '--config',str(config)],capture_output=True,text=True)
            self.assertNotEqual(proc.returncode,0)
            self.assertIn('NATIVE_WINDOWS_REQUIRED',proc.stderr)

if __name__=='__main__':unittest.main()
