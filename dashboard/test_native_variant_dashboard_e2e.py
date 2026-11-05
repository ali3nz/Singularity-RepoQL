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
                    def request(path):
                        conn=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=3)
                        try:
                            conn.request('GET',path,headers={'Authorization':'Bearer '+token})
                            response=conn.getresponse()
                            return response.status,response.read()
                        finally:conn.close()
                    with patch('unified_bridge._fetch_upstream',return_value=MOCK_USAGE):
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
                    code,data=request('/api/ghost/status')
                    self.assertEqual(code,404 if option in (1,3) else 503)
                    code,data=request('/api/harness/office')
                    self.assertEqual(code,404 if option in (1,3) else 200)
                finally:
                    server.shutdown();server.server_close();loop.join(timeout=3)

if __name__=='__main__':unittest.main()
