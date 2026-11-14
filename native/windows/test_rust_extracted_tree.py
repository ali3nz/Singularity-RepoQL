#!/usr/bin/env python3
"""Synthetic Windows source staging fixtures for the compiled Rust integrity gate.

Source mode generates independent expected-accept/refuse cases. Only --rust-cli
runs the real Rust implementation. Does not inspect or modify an installation.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def create(root: Path):
    root.mkdir(parents=True, exist_ok=True)
    source = b'synthetic-source\n'
    (root/'sample.txt').write_bytes(source)
    checksums = f'{digest(source)}  sample.txt\n'.encode()
    (root/'SHA256SUMS').write_bytes(checksums)
    manifest = {
        'schema': 1, 'variant': 2,
        'release_status': 'SOURCE_ONLY_UNCOMPILED_NOT_INSTALLER',
        'production_feature_parity': 'UNVERIFIED',
        'acceptance': 'NOT_RUN_ON_NATIVE_WINDOWS',
        'repoql': {'requiredVersion': '1.7.18', 'connectorContract': 'fetch-render'},
        'features': {'office': True, 'ghost': False, 'repoql_dashboard': True,
                     'tencent_connector': True, 'kanzo': True, 'openmausbot': True,
                     'memory': True, 'repoql_mcp': True},
        'rustOfficeFeature': True, 'rustGhostFeature': False,
        'files': [
            {'path': 'sample.txt', 'sha256': digest(source), 'bytes': len(source)},
            {'path': 'SHA256SUMS', 'sha256': digest(checksums), 'bytes': len(checksums)},
        ],
    }
    (root/'NATIVE_WINDOWS_SOURCE_MANIFEST.json').write_text(json.dumps(manifest), encoding='utf-8')
    return manifest


def save(root: Path, manifest: dict):
    (root/'NATIVE_WINDOWS_SOURCE_MANIFEST.json').write_text(json.dumps(manifest), encoding='utf-8')


def mutate(case: str, root: Path, manifest: dict):
    if case == 'valid':
        return
    if case == 'drift':
        (root/'sample.txt').write_text('tampered', encoding='utf-8')
    elif case == 'missing':
        (root/'sample.txt').unlink()
    elif case == 'bad-json':
        (root/'NATIVE_WINDOWS_SOURCE_MANIFEST.json').write_text('{incomplete', encoding='utf-8')
        return
    elif case == 'bad-variant':
        manifest['variant'] = 9
    elif case == 'bad-contract':
        manifest['repoql']['connectorContract'] = 'legacy-abi'
    elif case == 'bad-version':
        manifest['repoql']['requiredVersion'] = '1.0.0'
    elif case == 'false-acceptance':
        manifest['acceptance'] = 'PASSED_NATIVE_WINDOWS'
    elif case == 'false-native-wsl':
        manifest['no_wsl_required_for_intended_runtime'] = True
    elif case == 'ghost-enabled':
        manifest['features']['ghost'] = True
    elif case == 'office-disabled':
        manifest['features']['office'] = False
    elif case == 'traversal':
        manifest['files'][0]['path'] = '../outside.txt'
    elif case == 'windows-reserved':
        manifest['files'][0]['path'] = 'CON.txt'
    elif case == 'duplicate-case':
        manifest['files'].append({**manifest['files'][0], 'path': 'SAMPLE.txt'})
    elif case == 'incorrect-checksums':
        (root/'SHA256SUMS').write_text('0'*64+'  sample.txt\n', encoding='utf-8')
    elif case == 'unsupported-file-size':
        manifest['files'][0]['bytes'] = 17*1024*1024
    elif case == 'unlisted-checksum':
        manifest['files'] = manifest['files'][:1]
    elif case == 'untracked-file':
        (root/'unlisted.js').write_text('untracked source', encoding='utf-8')
    else:
        raise AssertionError(case)
    save(root, manifest)



def reference_accepts(root: Path) -> bool:
    """Independent Python readback of synthetic receipts, not Rust execution."""
    try:
        doc=json.loads((root/'NATIVE_WINDOWS_SOURCE_MANIFEST.json').read_text(encoding='utf-8'))
        if doc.get('schema')!=1 or doc.get('variant') != 2:return False
        if (doc.get('release_status')!='SOURCE_ONLY_UNCOMPILED_NOT_INSTALLER'
            or doc.get('production_feature_parity')!='UNVERIFIED'
            or doc.get('acceptance')!='NOT_RUN_ON_NATIVE_WINDOWS'
            or doc.get('no_wsl_required_for_intended_runtime') is True):return False
        repoql=doc.get('repoql',{})
        if (repoql.get('requiredVersion')!='1.7.18'
            or repoql.get('connectorContract')!='fetch-render'
            or 'connectorAbi' in repoql):return False
        flags = doc.get('features', {})
        if (any(flags.get(key) is not True for key in ('office', 'repoql_dashboard', 'tencent_connector',
                    'kanzo', 'openmausbot', 'memory', 'repoql_mcp'))
            or doc.get('features',{}).get('ghost') is not False
            or doc.get('rustOfficeFeature') is not True
            or doc.get('rustGhostFeature') is not False):return False
        rows=doc.get('files',[])
        if not isinstance(rows,list) or not (1<=len(rows)<=5000):return False
        seen=set();names={}; total=0
        for row in rows:
            name=row.get('path','')
            if not isinstance(name,str) or not name.isascii() or not (1<=len(name)<=240):return False
            pieces=name.split('/')
            if any(not x or x in ('.','..') or x.endswith(('.', ' '))
                   or x.split('.')[0].upper() in ('CON','PRN','AUX','NUL') for x in pieces):return False
            if any(ch in name for ch in ('\\','<','>',':','"','|','?','*')):return False
            if name.casefold() in seen or name=='NATIVE_WINDOWS_SOURCE_MANIFEST.json':return False
            seen.add(name.casefold())
            target=root/name
            if not target.is_file() or target.is_symlink():return False
            blob=target.read_bytes()
            expected=row.get('sha256')
            if not isinstance(expected,str) or len(expected)!=64 or len(blob)!=row.get('bytes') or digest(blob)!=expected.lower():return False
            total+=len(blob)
            if len(blob)>16*1024*1024 or total>96*1024*1024:return False
            names[name]=expected.lower()
        if 'SHA256SUMS' not in names:return False
        lines=(root/'SHA256SUMS').read_text(encoding='utf-8').splitlines()
        got={}
        for line in lines:
            pair=line.split('  ',1)
            if len(pair)!=2 or pair[1] in got:return False
            got[pair[1]]=pair[0]
        names.pop('SHA256SUMS')
        if names!=got:return False
        expected_files={row['path'].casefold() for row in rows} | {'native_windows_source_manifest.json'}
        actual_files=set()
        for file in root.rglob('*'):
            if file.is_symlink():return False
            if file.is_file():actual_files.add(file.relative_to(root).as_posix().casefold())
        return actual_files==expected_files
    except (OSError,ValueError,TypeError,KeyError,AttributeError):
        return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--rust-cli', type=Path)
    args = parser.parse_args()
    if args.rust_cli and not args.rust_cli.is_file():
        raise SystemExit('Compiled Rust packager unavailable')
    cases = ['valid','drift','missing','bad-json','bad-variant','bad-contract',
             'bad-version','false-acceptance','false-native-wsl','ghost-enabled','office-disabled',
             'traversal','windows-reserved','duplicate-case','incorrect-checksums',
             'unsupported-file-size','unlisted-checksum','untracked-file']
    with tempfile.TemporaryDirectory(prefix='singularity-extracted-tree-') as temp:
        for idx, case in enumerate(cases):
            root = Path(temp)/str(idx)
            manifest = create(root)
            mutate(case, root, manifest)
            expected = case == 'valid'
            if reference_accepts(root) is not expected:
                raise AssertionError(f'Python staged source receipt reference disagreement: {case}')
            if args.rust_cli:
                result = subprocess.run([str(args.rust_cli),'verify-extracted',str(root.resolve())],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
                try:
                    report = json.loads(result.stdout)
                except (ValueError, UnicodeDecodeError) as exc:
                    raise AssertionError(f'Invalid Rust staged-tree response case {case}') from exc
                accepted = case == 'valid'
                if report.get('ok') is not accepted or (result.returncode == 0) is not accepted:
                    raise AssertionError(f'Rust staged-tree acceptance disagreement: {case}')
                if report.get('releaseReady') is not False or report.get('acceptance') != 'NOT_RUN_NATIVE_WINDOWS':
                    raise AssertionError(f'Rust staged-tree claimed unsupported release readiness: {case}')
    print('STAGED_SOURCE_REFERENCE_FIXTURES_OK', len(cases))
    print('NATIVE_RUST_DIFFERENTIAL_PASS' if args.rust_cli else 'NATIVE_RUST_DIFFERENTIAL_NOT_RUN')


if __name__ == '__main__':
    main()
