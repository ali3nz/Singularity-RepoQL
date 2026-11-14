"""Compiled ledger publication with throwaway Python and Node writer state."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
SCRIPTS = ROOT / 'scripts'
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location('doc_ingester', SCRIPTS / 'memory-doc-ingest.py')
python_ingest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(python_ingest)

TOKEN = '1234567890abcdef1234567890abcdef'
SCHEMA = 'singularity-doc-ledger-commit/v1'


def rejected(binary, payload, code):
    proc = subprocess.run([str(binary)], input=json.dumps(payload), text=True, capture_output=True,
                          timeout=5, check=False)
    assert proc.returncode == 2 and json.loads(proc.stdout) == {'ok': False, 'code': code}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--rust-cli', required=True, type=Path)
    args = parser.parse_args()
    binary = args.rust_cli.resolve(strict=True)
    with tempfile.TemporaryDirectory() as td:
        # Resolve the disposable root for CI images that expose temp via an alias.
        root = Path(td).resolve()
        env = {**os.environ, 'SINGULARITY_DOC_DATA': str(root),
               'SINGULARITY_DOC_LEDGER_COMMIT_RUST_BIN': str(binary)}
        with patch.dict(os.environ, env):
            python_ingest.with_ledger(lambda ledger: ledger['docs'].update({'python': {}}))
        js = """import {withLedger} from './doc-ingest-node.mjs';
await withLedger(ledger=>{ledger.docs.node={};});
"""
        node = subprocess.run(['node', '--input-type=module', '--eval', js], cwd=SCRIPTS, env=env,
                              capture_output=True, text=True, timeout=10, check=False)
        assert node.returncode == 0, node.stderr
        base = root / 'doc-index'
        ledger = base / 'ledger.json'
        original = ledger.read_bytes()
        assert json.loads(original) == {'version': 1, 'docs': {'python': {}, 'node': {}}}
        assert not list(base.glob('.ledger-*.tmp'))
        temp = base / '.ledger-fixture.tmp'
        temp.write_text('replacement', encoding='utf-8')
        lock = base / '.ledger.lock.d'
        lock.mkdir()
        (lock / 'owner').write_text(TOKEN, encoding='utf-8')
        payload = {'schema': SCHEMA, 'temp': str(temp), 'owner': TOKEN}
        rejected(binary, {**payload, 'owner': '0' * 32}, 'LEDGER_OWNER_CHANGED')
        rejected(binary, {**payload, 'temp': str(base / 'ledger.json')}, 'INVALID_TEMP_PATH')
        rejected(binary, {**payload, 'arbitrary': True}, 'INVALID_REQUEST')
        assert ledger.read_bytes() == original and temp.read_text(encoding='utf-8') == 'replacement'
        assert (lock / 'owner').read_text(encoding='utf-8') == TOKEN
    print('DOC_LEDGER_COMMIT_COMPILED: Python and Node publish, three negative cases')


if __name__ == '__main__':
    main()
