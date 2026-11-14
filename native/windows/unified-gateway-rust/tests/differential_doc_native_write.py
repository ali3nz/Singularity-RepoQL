"""Compiled single-send documentation writes and cross-runtime recovery."""
import argparse
import hashlib
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[4]


@contextmanager
def fixture():
    class State:
        records = []
        adds = 0
        tombstone_adds = 0
        lose_tombstone = False
        visible = True
        response = 'success'
        partial = False
        wrong_task = False
        correct_headers = True
        intent_before_add = True
        ledger = None
        queries = 0
        query_shape_ok = True
        searches = 0
        search_shape_ok = True
        add_received = threading.Event()
        wait_after_add = False
        release_add = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            if self.path == '/v3/conversation/search':
                State.searches += 1
                State.search_shape_ok &= (set(body) == {'team_id','user_id','agent_id','query','limit'}
                                          and body['agent_id'] == 'docs-keeper')
                rows = [m for m in State.records if body['query'] in m['content']] if State.visible else []
                reply = {'code': 0, 'data': {'messages': rows}}
            elif self.path == '/v3/conversation/query':
                State.queries += 1
                State.query_shape_ok &= (set(body) == {'team_id','user_id','agent_id','session_id','task_id','offset','limit'}
                                         and body['offset'] == 0 and body['limit'] == 100)
                rows = [m for m in State.records if body['task_id'] == m.get('task_id')]
                if State.partial:
                    rows = rows[-1:]
                if State.wrong_task:
                    rows = [{**m, 'task_id': 'foreign'} for m in rows]
                reply = {'code': 0, 'data': {'messages': rows}}
            elif self.path == '/v3/conversation/add':
                State.correct_headers &= (self.headers.get('Authorization') == 'Bearer test-gateway'
                                          and self.headers.get('x-tdai-service-id') == 'test-service'
                                          and self.headers.get('x-tdai-user-key') == 'test-user')
                if body['task_id'].startswith('docs-superseded:'):
                    State.tombstone_adds += 1
                    doc = next(iter(json.loads(State.ledger.read_text())['docs'].values()))
                    State.intent_before_add &= any(rev.get('supersession_intent') == body['task_id']
                                                   for rev in doc['revs'].values())
                if body['task_id'].startswith('docs-') and State.ledger and not body['task_id'].startswith('docs-superseded:'):
                    doc = next(iter(json.loads(State.ledger.read_text())['docs'].values()))
                    State.intent_before_add &= any(body['task_id'] in rev.get('write_intents', [])
                                                   and len(rev.get('write_target', '')) == 64
                                                   for rev in doc['revs'].values())
                State.adds += 1
                if State.response == 'lost' or (State.lose_tombstone and body['task_id'].startswith('docs-superseded:')):
                    State.records.extend({**m, 'task_id': body['task_id']} for m in body['messages'])
                    self.connection.shutdown(socket.SHUT_RDWR)
                    return
                if State.response == 'rejected':
                    reply = {'code': 99, 'data': {}}
                else:
                    State.records.extend({**m, 'task_id': body['task_id']} for m in body['messages'])
                    if State.wait_after_add:
                        State.add_received.set()
                        State.release_add.wait(10)
                        self.connection.shutdown(socket.SHUT_RDWR)
                        return
                    reply = {'code': 0, 'data': {}}
            else:
                self.send_error(404)
                return
            raw = json.dumps(reply).encode()
            self.send_response(200)
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, *args):
            pass

    with ThreadingHTTPServer(('127.0.0.1', 0), Handler) as server:
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            yield State, f'http://127.0.0.1:{server.server_port}'
        finally:
            server.shutdown()
            worker.join(timeout=3)


def command(engine, root, mode):
    cmd = [sys.executable, str(ROOT / 'scripts/memory-doc-ingest.py')] if engine == 'python' else [
        'node', str(ROOT / 'scripts/doc-ingest-node.mjs')]
    return [*cmd, mode, '--root', str(root), '--file', str(root/'recovery.md')]


def run(engine, root, env, mode='ingest'):
    p = subprocess.run(command(engine, root, mode), env=env, text=True, capture_output=True,
                       timeout=38, check=False)
    reply = json.loads(p.stdout)
    if mode == 'retry' and 'results' in reply:
        assert len(reply['results']) == 1
        reply = reply['results'][0]
    return reply


def supersession_case(writer, digest, first, second):
    with fixture() as (state, origin), tempfile.TemporaryDirectory() as td:
        root = Path(td).resolve()
        doc = root / 'recovery.md'
        doc.write_text('# First synthetic revision\n\nInitial state.\n')
        cfg = root / 'memory.json'
        config = {'gatewayKey': 'test-gateway', 'userKey': 'test-user',
                  'serviceId': 'test-service', 'authPrefix': 'Bearer '}
        cfg.write_text(json.dumps(config))
        state.ledger = root / 'data/doc-index/ledger.json'
        env = {**os.environ, 'SINGULARITY_DOC_DATA': str(root / 'data'), 'MEMORY_SECRETS': str(cfg),
               'SINGULARITY_MEMORY_CONFIG': str(cfg), 'KNOWLEDGE_INDEX_BASE_URL': origin,
               'SINGULARITY_DOC_WRITE_RUST_BIN': str(writer),
               'SINGULARITY_DOC_WRITE_RUST_SHA256': digest}
        original = run(first, root, env)
        assert original['status'] == 'DOC_INGEST_INDEXED', original
        state.lose_tombstone = True
        second_text = '# Second synthetic revision\n\nThe changed state.\n'
        doc.write_text(second_text)
        pending = run(first, root, env)
        assert pending['status'] == 'DOC_INGEST_PENDING', pending
        assert 'SUPERSESSION_UNCONFIRMED' in pending['reason']
        entry = next(iter(json.loads(state.ledger.read_text())['docs'].values()))
        assert entry['active_rev'] == original['rev']
        assert state.tombstone_adds == 1 and state.intent_before_add
        env.pop('SINGULARITY_DOC_WRITE_RUST_BIN')
        doc.write_text('# Third synthetic revision\n\nMust wait for second.\n')
        blocked = run(second, root, env)
        assert blocked['status'] == 'DOC_INGEST_BLOCKED' and 'PRIOR_SUPERSESSION' in blocked['reason']
        assert state.adds == 3 and state.tombstone_adds == 1
        doc.write_text(second_text)
        with fixture() as (other, other_origin):
            blocked = run(second, root, {**env, 'KNOWLEDGE_INDEX_BASE_URL': other_origin}, 'retry')
            assert blocked['status'] == 'DOC_INGEST_BLOCKED' and 'TARGET_CHANGED' in blocked['reason']
            assert other.adds == 0
        state.wrong_task = True
        assert run(second, root, env, 'retry')['status'] == 'DOC_INGEST_PENDING'
        state.wrong_task = False
        finished = run(second, root, env, 'retry')
        assert finished['status'] == 'DOC_INGEST_INDEXED', finished
        assert finished['rev'] == pending['rev']
        assert state.tombstone_adds == 1 and state.adds == 3
        entry = next(iter(json.loads(state.ledger.read_text())['docs'].values()))
        assert entry['active_rev'] == pending['rev']
        assert 'supersession_intent' not in entry['revs'][pending['rev']]


def process_restart_case(writer, digest, first, second):
    with fixture() as (state, origin), tempfile.TemporaryDirectory() as td:
        root = Path(td).resolve()
        (root/'recovery.md').write_text('# Synthetic interrupted revision\n\nMust send only once.\n')
        cfg = root/'memory.json'
        cfg.write_text(json.dumps({'gatewayKey':'test-gateway', 'userKey':'test-user',
                                   'serviceId':'test-service', 'authPrefix':'Bearer '}))
        data = root/'data'
        state.ledger = data/'doc-index/ledger.json'
        state.wait_after_add = True
        env = {**os.environ, 'SINGULARITY_DOC_DATA': str(data), 'MEMORY_SECRETS': str(cfg),
               'SINGULARITY_MEMORY_CONFIG': str(cfg), 'KNOWLEDGE_INDEX_BASE_URL': origin,
               'SINGULARITY_DOC_WRITE_RUST_BIN': str(writer), 'SINGULARITY_DOC_WRITE_RUST_SHA256': digest}
        # Terminate the real client after the test service has committed, but
        # before it returns a response. Wait for the fixture writer to finish
        # before manually recovering the stale disposable lock.
        with subprocess.Popen(command(first, root, 'ingest'), env=env,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) as proc:
            try:
                assert state.add_received.wait(12)
                proc.kill()
                proc.wait(timeout=5)
            finally:
                state.release_add.set()
                if proc.poll() is None:
                    proc.kill()
        record = next(iter(json.loads(state.ledger.read_text())['docs'].values()))
        assert record['active_rev'] is None and state.intent_before_add
        assert state.adds == 1 and state.queries == 0
        lock = data/'doc-index/.ledger.lock.d'
        assert lock.is_dir() and (lock/'owner').read_text().strip()
        # Both client engines are stopped and only this fixture owns the lock.
        (lock/'owner').unlink()
        lock.rmdir()
        state.wait_after_add = False
        outcome = run(second, root, env, 'retry')
        assert outcome['status'] == 'DOC_INGEST_INDEXED', outcome
        assert state.adds == 1 and state.queries == 1 and state.query_shape_ok


def replaced_service_config_case(writer):
    with fixture() as (state, origin), tempfile.TemporaryDirectory() as td:
        config = Path(td).resolve()/'memory.json'
        config.write_text(json.dumps({'gatewayKey':'test-gateway', 'userKey':'test-user',
                                      'serviceId':'changed-service', 'authPrefix':'Bearer '}))
        body = {'team_id':'singularity-docs','user_id':'shared','agent_id':'docs-keeper',
                'session_id':'singularity-documentation','task_id':'docs-aabbccdd-r12345678-c01',
                'messages':[{'role':'user','content':'fixture'},{'role':'assistant','content':'ack'}]}
        env = {**os.environ,'SINGULARITY_DOC_WRITE_CONFIG':str(config),
               'SINGULARITY_DOC_WRITE_ORIGIN':origin}
        marker = {'team_id':'singularity-docs','user_id':'shared','agent_id':'docs-keeper',
                  'query':'[doc-ref:fixture]', 'limit':5}
        for operation, path, payload in (('docWrite','/v3/conversation/add',body),
                                        ('docVerify','/v3/conversation/query',body),
                                        ('docFindMarker','/v3/conversation/search',marker)):
            frame = {'operation':operation,'path':path,'body':payload,'expected_service':'previous-service'}
            p = subprocess.run([str(writer)],input=json.dumps(frame),env=env,text=True,
                               capture_output=True,timeout=5,check=True)
            assert json.loads(p.stdout) == {'ok':False,'code':'DOCUMENT_TARGET_CHANGED'}
        assert state.adds == 0 and state.queries == 0 and state.searches == 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--rust-cli', type=Path, required=True)
    writer = parser.parse_args().rust_cli.resolve(strict=True)
    digest = hashlib.sha256(writer.read_bytes()).hexdigest()
    for first, second in (('node', 'python'), ('python', 'node')):
        for response in ('success', 'lost', 'rejected', 'binary-drift', 'accepted-partial'):
            with fixture() as (state, origin), tempfile.TemporaryDirectory() as td:
                root = Path(td).resolve()
                (root/'recovery.md').write_text('# Synthetic documentation\n\nEvidence for recovery.\n')
                cfg = root/'memory.json'
                cfg.write_text(json.dumps({'gatewayKey':'test-gateway', 'userKey':'test-user',
                                           'serviceId':'test-service', 'authPrefix':'Bearer '}))
                state.ledger = root/'data/doc-index/ledger.json'
                state.response = response
                state.visible = response in ('success', 'accepted-partial')
                state.partial = response == 'accepted-partial'
                env = {**os.environ, 'SINGULARITY_DOC_DATA': str(root/'data'), 'MEMORY_SECRETS': str(cfg),
                       'SINGULARITY_MEMORY_CONFIG': str(cfg), 'KNOWLEDGE_INDEX_BASE_URL': origin,
                       'SINGULARITY_DOC_WRITE_RUST_BIN': str(writer),
                       'SINGULARITY_DOC_WRITE_RUST_SHA256': '0' * 64 if response == 'binary-drift' else digest}
                outcome = run(first, root, env)
                expected_adds = 0 if response == 'binary-drift' else 1
                assert state.adds == expected_adds and state.correct_headers and state.intent_before_add
                if response == 'success':
                    assert outcome['status'] == 'DOC_INGEST_INDEXED', outcome
                    assert state.queries == 1 and state.query_shape_ok
                    assert state.searches == 2 and state.search_shape_ok
                else:
                    assert outcome['status'] == 'DOC_INGEST_PENDING', outcome
                    assert 'DOC_NATIVE_WRITE_UNCONFIRMED' in outcome['reason']
                    if response == 'binary-drift':
                        # Invalid binary stopped at the preflight read, so
                        # no write was attempted and no intent was reserved.
                        assert state.searches == 0 and state.queries == 0
                        record = next(iter(json.loads(state.ledger.read_text())['docs'].values()))
                        assert all(not row.get('write_intents') for row in record['revs'].values())
                        continue
                    # The other runtime, with the feature disabled, must not
                    # resend a still unresolved write.
                    env.pop('SINGULARITY_DOC_WRITE_RUST_BIN')
                    assert run(second, root, env, 'retry')['status'] == 'DOC_INGEST_PENDING'
                    assert state.adds == expected_adds
                    if response in ('lost', 'accepted-partial'):
                        state.visible = True
                        state.partial = True
                        assert run(second, root, env, 'retry')['status'] == 'DOC_INGEST_PENDING'
                        state.partial = False
                        state.wrong_task = True
                        assert run(second, root, env, 'retry')['status'] == 'DOC_INGEST_PENDING'
                        state.wrong_task = False
                        assert run(second, root, env, 'retry')['status'] == 'DOC_INGEST_INDEXED'
                        assert state.adds == expected_adds
    supersession_case(writer, digest, 'python', 'node')
    supersession_case(writer, digest, 'node', 'python')
    process_restart_case(writer, digest, 'python', 'node')
    process_restart_case(writer, digest, 'node', 'python')
    replaced_service_config_case(writer)
    print('DOC_NATIVE_WRITE_COMPILED: 15 cases; scoped native readback, crash recovery across runtimes, changed service and duplicate sends refused')



if __name__ == '__main__':
    main()
