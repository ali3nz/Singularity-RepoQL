#!/usr/bin/env python3
"""Single-write MemoryCore local HTTP contract, no live service or stored data.

Reference-only mode checks JavaScript behavior. --rust-cli adds compiled Rust
checks, proving exactly one write request per invocation. No retries on network
failure, no redirect target visitation, no credential exposure in stdout.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[4]
ORACLE = Path(__file__).with_name('memorycore-write-oracle.mjs')
class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        self.server.calls.append(self.path)
        length = int(self.headers.get('Content-Length', 0))
        if length <= 0 or length > 128 * 1024:
            self.send_response(413); self.end_headers(); return
        try:
            req = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeError):
            self.send_response(400); self.end_headers(); return
        if self.path != '/v3/conversation/add':
            self.send_response(404); self.end_headers(); return
        if (self.headers.get('Authorization') != 'Bearer fixture-gateway-key'
                or self.headers.get('x-tdai-user-key') != 'fixture-reader-key'
                or self.headers.get('x-tdai-service-id') != 'default'):
            self.send_response(403); self.end_headers(); return
        self.server.last_body=req
        if self.server.mode=='redirect':
            self.send_response(302)
            self.send_header('Location','http://127.0.0.1.attacker.invalid:9999/steal')
            self.end_headers()
            return
        if self.server.mode=='upstream_error':
            self.send_response(500); self.end_headers(); return
        if self.server.mode=='malformed':
            content=b'not-json'
        elif self.server.mode=='application_denied':
            content=json.dumps({'code':403,'message':'unauthorized'}).encode('utf8')
        else:
            content=json.dumps({'code':0,'data':{'accepted_ids':['fixture-1']}}).encode('utf8')
        self.send_response(200)
        self.send_header('Content-Type','application/json')
        self.send_header('Content-Length',str(len(content)))
        self.end_headers()
        self.wfile.write(content)
    def log_message(self,*_args): pass

def run(binary, body, env):
    proc=subprocess.run(binary, input=json.dumps({'operation':'v3Write','path':'/v3/conversation/add','body':body}),
        text=True,capture_output=True,cwd=ROOT,env=env,timeout=30)
    if proc.returncode!=0:
        raise AssertionError(f'executable returned status {proc.returncode}')
    if 'fixture-gateway-key' in proc.stdout+proc.stderr or 'fixture-reader-key' in proc.stdout+proc.stderr:
        raise AssertionError('credential leaked in process output')
    return json.loads(proc.stdout)

IDENTITY={'team_id':'team-test','user_id':'user-test','agent_id':'agent-test',
          'session_id':'sess-test','task_id':'task-test'}
BODY={**IDENTITY,'messages':[{'role':'assistant','content':'remember measured fact'}]}
CASES=[('normal','normal',BODY,True),
       ('unicode','normal',{**IDENTITY,'messages':[{'role':'user','content':'Māori 🐈'},
                                                   {'role':'assistant','content':'verified'}]},True),
       ('application-denied','application_denied',BODY,True),
       ('redirect-rejected','redirect',BODY,False),
       ('upstream-error','upstream_error',BODY,False),
       ('non-json-response','malformed',BODY,True)]

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--rust-cli',type=Path)
    args=parser.parse_args()
    if args.rust_cli and not args.rust_cli.is_file():parser.error('Rust binary not found')
    with tempfile.TemporaryDirectory(prefix='singularity-memory-write-') as tmp:
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        server.calls=[];server.mode='normal';server.last_body=None
        thread=threading.Thread(target=server.serve_forever,daemon=True)
        thread.start()
        try:
            cfg=Path(tmp,'memory.json')
            cfg.write_text(json.dumps({'hostBaseUrl':f'http://127.0.0.1:{server.server_port}',
                'gatewayKey':'fixture-gateway-key','userKey':'fixture-reader-key',
                'authPrefix':'Bearer ','serviceId':'default'}))
            env={**os.environ,'SINGULARITY_MEMORY_CONFIG':str(cfg),
                 'MEMORYCORE_V3_CONFIG_FILE':str(cfg)}
            for name in ('GHOST_MC_URL','GHOST_MC_SERVICE_KEY','GHOST_MC_USER_KEY',
                         'GHOST_MC_SERVICE_ID','SINGULARITY_RUST_MEMORYCORE_WRITER_BIN'):
                env.pop(name,None)
            count=0
            for label,mode,body,expect_ok in CASES:
                server.mode=mode
                server.calls=[]
                reference=subprocess.run(['node',str(ORACLE)],input=json.dumps({'body':body}),
                    text=True,capture_output=True,cwd=ROOT,env=env,timeout=30)
                if reference.returncode!=0:raise AssertionError(f'{label}: oracle failed')
                js=json.loads(reference.stdout)
                if js.get('ok')!=expect_ok:raise AssertionError(f'{label}: unexpected reference {js}')
                if server.calls!=['/v3/conversation/add']:raise AssertionError(f'{label}: bad reference call count {server.calls}')
                if server.last_body!=body:raise AssertionError(f'{label}: JS changed request body')
                if args.rust_cli:
                    server.calls=[]
                    native=run([str(args.rust_cli)],body,env)
                    if server.calls!=['/v3/conversation/add']:
                        raise AssertionError(f'{label}: Rust repeated or redirected a write: {server.calls}')
                    if native.get('ok') != (mode in ('normal','application_denied')):
                        raise AssertionError(f'{label}: Rust status disagrees {native}')
                    if native.get('ok') and native.get('payload')!=js.get('payload'):
                        raise AssertionError(f'{label}: Rust changed response {native}')
                count+=1
            if args.rust_cli:
                for label,body in [('empty-messages',{**IDENTITY,'messages':[]}),
                     ('missing-scope',{'messages':[{'role':'assistant','content':'x'}]}),
                     ('no-task',{**{k:v for k,v in IDENTITY.items() if k!='task_id'},
                                 'messages':[{'role':'assistant','content':'x'}]}),
                     ('invalid-message',{**IDENTITY,'messages':[{'role':'assistant'}]})]:
                    server.calls=[]
                    result=run([str(args.rust_cli)],body,env)
                    if result.get('ok') is not False or server.calls:
                        raise AssertionError(f'{label}: Rust did not block unsafe write {result}')
                    count+=1
                # No endpoint is selectable beyond conversation/add.
                proc=subprocess.run([str(args.rust_cli)],input=json.dumps({'operation':'v3Write',
                    'path':'/v3/atomic/delete','body':BODY}),text=True,capture_output=True,env=env,timeout=30)
                if proc.returncode or json.loads(proc.stdout).get('ok') is not False:
                    raise AssertionError('disallowed mutation accepted')
                count+=1
            print(f'{"NATIVE_RUST_WRITE_PARITY_PASSED" if args.rust_cli else "WRITE_REFERENCE_ONLY_PASSED"}: {count} scenarios')
        finally:
            server.shutdown();server.server_close();thread.join(timeout=3)

if __name__=='__main__':main()
