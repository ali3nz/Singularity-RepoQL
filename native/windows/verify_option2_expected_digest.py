#!/usr/bin/env python3
"""Compare Option 2 candidate with an INDEPENDENTLY supplied expected digest.

This only checks artifact identity, NOT publisher authentication, CI trust,
compiled Rust correctness, service installation or actual Claude Code behavior.
"""
from __future__ import annotations
import argparse, hashlib, json, re
from pathlib import Path
import zipfile
from build_option2_acceptance_bundle import check_acceptance_bundle, BUNDLE_FILES, SOURCE

SCHEMA = 'singularity-option2-external-digest-comparison/v1'
HEX64 = re.compile(r'^[0-9a-fA-F]{64}$')
HEX40 = re.compile(r'^[0-9a-fA-F]{40}$')

def verify_expected(candidate: Path, *, expected_sha256: str,
                    expected_commit: str, expected_source_sha256: str | None = None) -> dict:
    if not isinstance(expected_sha256, str) or not HEX64.fullmatch(expected_sha256):
        raise ValueError('EXPECTED_BUNDLE_DIGEST_REQUIRED')
    if not isinstance(expected_commit, str) or not HEX40.fullmatch(expected_commit):
        raise ValueError('EXPECTED_COMMIT_REQUIRED')
    if expected_source_sha256 is not None and (not isinstance(expected_source_sha256,str)
            or not HEX64.fullmatch(expected_source_sha256)):
        raise ValueError('EXPECTED_SOURCE_DIGEST_INVALID')
    check_acceptance_bundle(candidate)
    digest = hashlib.sha256()
    with candidate.open('rb') as f:
        while chunk := f.read(1024*1024):digest.update(chunk)
    if digest.hexdigest() != expected_sha256.lower():
        raise ValueError('INDEPENDENT_BUNDLE_DIGEST_MISMATCH')
    with zipfile.ZipFile(candidate) as z:
        manifest = json.loads(z.read('ACCEPTANCE_BUNDLE_MANIFEST.json'))
        if manifest.get('git_commit') != expected_commit.lower():
            raise ValueError('CANDIDATE_GIT_COMMIT_MISMATCH')
        source_digest = hashlib.sha256(z.read(BUNDLE_FILES[SOURCE])).hexdigest()
    if expected_source_sha256 is not None and source_digest != expected_source_sha256.lower():
        raise ValueError('INDEPENDENT_SOURCE_DIGEST_MISMATCH')
    return {
        'schema': SCHEMA, 'option':2, 'bundle_sha256':digest.hexdigest(),
        'expected_commit_matched':True,'expected_source_sha256_matched':
             expected_source_sha256 is not None,
        'external_expected_hash_was_operator_authenticated':False,
        'publisher_signature_verified':False,
        'artifact_content_verified':True,
        'windows_binary_runtime_verified':False,
        'production_release_ready':False,
    }

def main(argv=None):
    p=argparse.ArgumentParser(description='Fail-closed Option 2 digest comparison (not a signature)')
    p.add_argument('--bundle',type=Path,required=True)
    p.add_argument('--expected-sha256',required=True)
    p.add_argument('--expected-commit',required=True)
    p.add_argument('--expected-source-sha256')
    p.add_argument('--output',type=Path)
    args=p.parse_args(argv)
    try:
        receipt=verify_expected(args.bundle,expected_sha256=args.expected_sha256,
            expected_commit=args.expected_commit,expected_source_sha256=args.expected_source_sha256)
        content=json.dumps(receipt,indent=2,sort_keys=True)+'\n'
        if args.output:
            with args.output.open('x',encoding='utf8') as f:f.write(content)
        else:print(content,end='')
        return 0
    except (ValueError,OSError,zipfile.BadZipFile,KeyError) as exc:
        import sys
        message=str(exc)
        if not message.isascii() or not message.replace('_','').isalnum():message=type(exc).__name__.upper()
        print('OPTION2_EXPECTED_DIGEST_REFUSED:'+message,file=sys.stderr)
        return 2
if __name__=='__main__':raise SystemExit(main())
