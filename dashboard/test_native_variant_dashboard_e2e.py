"""Actual dashboard listener checks for the four native installation options.

No synthetic usage is ever labelled provider-verified or as a full-period total.
Other installed GUIs' events, global provider usage and Freebuff never leak.
"""
from __future__ import annotations
import contextlib
import http.client
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from repoql_bridge import Config
from server import build_server

MOCK_USAGE = {'available':True,'collected_at':'2026-10-29T00:00:00Z',
 'input_tokens_recorded':900000, 'output_tokens_recorded':800000,
 'sources':[{'id':'freebuff','events':99},{'id':'claude-desktop-code','events':3},
            {'id':'openchamber-desktop-subscription','events':4}],
 'recent':[{'source':'freebuff','input_tokens':900000},
           {'source':'claude-desktop-code','input_tokens':35,'output_tokens':11},
           {'source':'openchamber-desktop-subscription','input_tokens':48,'output_tokens':12}],
 'daily':[{'day':'2026-10-28','input_tokens':900000}], 'freebuff':{'secret':'forbidden'}}

class NativeDashboardProfiles(unittest.TestCase):
    def test_actual_server_per_profile_and_usage_route(self):
        for option in range(1,5):
            with self.subTest(option=option),tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ, {
              'SINGULARITY_WINDOWS_NATIVE':'1', 'SINGULARITY_INSTALL_VARIANT':str(option)}):
                cfg=Config(workspace=Path(tmp),rql=Path('/absent/rql'),state_dir=Path(tmp)/'state',bind='127.0.0.1',port=0)
                server=build_server(cfg)
                loop=threading.Thread(target=server.serve_forever,daemon=True)
                loop.start()
                try:
                    token=server.RequestHandlerClass.app.token
                    def request(path, *, authenticated=True):
                        conn=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=3)
                        try:
                            conn.request('GET',path,headers={'Authorization':'Bearer '+token} if authenticated else {})
                            response=conn.getresponse()
                            return response.status,response.read()
                        finally:conn.close()
                    with patch('unified_bridge._fetch_upstream',return_value=MOCK_USAGE), \
                            patch('unified_bridge._native_gateway_owner',return_value=True):
                        code,data=request('/api/unified/usage?days=30')
                        self.assertEqual(code,200,data[:300])
                        payload=json.loads(data)
                        expected='claude-desktop-code' if option in (1,2) else 'openchamber-desktop-subscription'
                        self.assertEqual(payload['expected_source'],expected)
                        self.assertEqual([x['source'] for x in payload['recent']],[expected])
                        self.assertIsNone(payload['input_tokens_recorded'])
                        self.assertEqual(payload['daily'],[])
                        self.assertNotIn('forbidden',str(payload))
                    for forbidden in ('/api/freebuff/allowance','/api/openchamber/telemetry'):
                        code,data=request(forbidden)
                        self.assertEqual(code,200)
                        self.assertFalse(json.loads(data)['available'])
                    code,data=request('/')
                    self.assertEqual(code,200)
                    self.assertIn(('"variant":'+str(option)).encode(),data)
                    code,data=request('/api/native/windows/readiness')
                    self.assertEqual(code,200)
                    self.assertEqual(json.loads(data)['variant'],option)
                    with patch('native_openmausbot.operations', return_value={'source': 'native_test'}) as operations:
                        code,data=request('/api/openmausbot/ops?from=1000&to=2000', authenticated=False)
                        self.assertEqual(code,401)
                        operations.assert_not_called()
                        code,data=request('/api/openmausbot/ops?from=1000&to=2000')
                        self.assertEqual(code,200)
                        self.assertEqual(json.loads(data),{'source':'native_test'})
                        self.assertEqual(operations.call_args.args[1:],(1000,2000))
                        operations.reset_mock()
                        code,data=request('/api/openmausbot/ops?from=invalid&to=2000')
                        self.assertEqual(code,200)
                        self.assertEqual(json.loads(data)['error'],'bad_request')
                        operations.assert_not_called()
                    with patch('native_openmausbot.role_names', return_value={
                        'omb-0123456789abcdef0123456789abcdef': 'Builder',
                    }) as role_names:
                        code,data=request('/api/agentchat/avatars', authenticated=False)
                        self.assertEqual(code,401)
                        role_names.assert_not_called()
                        code,data=request('/api/agentchat/avatars')
                        self.assertEqual(code,200)
                        self.assertEqual(json.loads(data), {
                            'names': {'omb-0123456789abcdef0123456789abcdef': 'Builder'},
                            'agents': {}, 'avatars': [], 'palette': [],
                        })
                        role_names.assert_called_once_with(cfg.state_dir)
                    code,data=request('/api/harness/office')
                    self.assertEqual(code,404 if option in (1,3) else 200)
                finally:
                    server.shutdown();server.server_close();loop.join(timeout=3)

if __name__=='__main__':unittest.main()
