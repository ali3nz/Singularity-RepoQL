"""Offline contract for Windows-native Tencent panel auto sign-in.

A generated MemoryCore owner identity must be reused, never minted separately
or sent to the browser. Tests are fixtures, not a live Tencent acceptance claim.
"""
from __future__ import annotations
import importlib
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from claude_complete_dashboard_host import environment

# Path.home() needs these on Windows/POSIX even when a test clears the environment.
_HOME={k:os.environ[k] for k in ('USERPROFILE','HOME','HOMEDRIVE','HOMEPATH') if k in os.environ}


class TencentAutoSignInContract(unittest.TestCase):
    def _setup(self, root):
        base = Path(root) / 'Singularity'
        source = base / 'WindowsNative' / 'current' / 'source'
        for item in ('dashboard/server.py','connectors/kanzo/manifest.yaml','connectors/memorycore/manifest.yaml'):
            dest = source / item
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text('fixture')
        binary = source.parent / 'bin' / 'singularity-desktop-bridge.exe'
        binary.parent.mkdir(parents=True,exist_ok=True)
        binary.write_bytes(b'EXE')
        repoql = base / 'rql.exe'; repoql.write_bytes(b'EXE')
        state = base / 'Dashboard'; state.mkdir(parents=True,exist_ok=True)
        workspace = base / 'workspace'; workspace.mkdir()
        ghost = base / 'GhostScheduler' / 'native-bridge-client.json'
        ghost.parent.mkdir(parents=True,exist_ok=True)
        import base64,json
        ghost.write_text(json.dumps({'endpoint':'http://127.0.0.1:18473','controlKey':base64.b64encode(bytes(range(48))).decode()}))
        owner=base / 'WindowsNative' / 'memory' / 'state' / 'secrets' / 'admin-user-key'
        return (source,repoql,workspace,state,binary,ghost,owner)

    def test_owner_key_reused_only_when_present_and_port_is_local(self):
        with tempfile.TemporaryDirectory() as root:
            src,rql,work,state,bridge,ghost,key=self._setup(root)
            kw=dict(variant=2,windows=True,native_bridge_exe=bridge,ghost_control_config=ghost)
            first=environment(src,rql,work,state,18100,**kw)
            self.assertNotIn('SINGULARITY_TENCENT_OWNER_KEY_FILE',first)
            self.assertEqual(first['SINGULARITY_TENCENT_PORT'],'18126')
            self.assertEqual(first['SINGULARITY_TENCENT_HOST'],'127.0.0.1')
            self.assertEqual(first['SINGULARITY_TENCENT_SERVICE_ID'],'default')
            key.parent.mkdir(parents=True)
            key.write_text('synthetic-key',encoding='utf-8')
            second=environment(src,rql,work,state,18100,**kw)
            self.assertEqual(second['SINGULARITY_TENCENT_OWNER_KEY_FILE'],str(key))
            self.assertNotIn('synthetic-key',repr(second))

    def test_only_real_existing_file_advertises_panel(self):
        import sys
        sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'dashboard'))
        from embed_config import panel_config
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'owner.key'
            with patch.dict(os.environ,{**_HOME,'SINGULARITY_TENCENT_OWNER_KEY_FILE':str(path)},clear=True):
                self.assertFalse(panel_config()['tencent']['configured'])
                path.write_text('synthetic-owner')
                self.assertTrue(panel_config()['tencent']['configured'])
                self.assertEqual(panel_config()['tencent']['url'],'/embed/tencent/')

    def test_windows_proxy_uses_native_panel_port(self):
        import sys
        sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'dashboard'))
        with patch.dict(os.environ,{**_HOME,'SINGULARITY_WINDOWS_NATIVE':'1'},clear=True):
            import native_panel_proxy
            proxy=importlib.reload(native_panel_proxy)
            self.assertEqual(proxy.UPSTREAM['tencent'],('127.0.0.1',18126))
            self.assertEqual(proxy.tencent_service_id(),'default')
        with patch.dict(os.environ,{**_HOME,'SINGULARITY_TENCENT_SERVICE_ID':'configured-instance'},clear=True):
            self.assertEqual(proxy.tencent_service_id(),'configured-instance')
        with patch.dict(os.environ,dict(_HOME),clear=True):
            self.assertEqual(proxy.tencent_service_id(),'default')
        importlib.reload(proxy)


if __name__=='__main__': unittest.main()
