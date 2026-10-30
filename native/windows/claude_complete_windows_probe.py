#!/usr/bin/env python3
"""Option 2 read-only Windows observation orchestrator; never a release approval.

Combines independent, existing narrowly-scoped source, prepared bundle, runtime
and evidence-inventory checks. It intentionally does NOT write gate receipts:
file provenance and HTTP health do not prove Claude UI, memory or service parity.
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import sys

from claude_complete_acceptance_matrix import matrix
from native_runtime_acceptance import validate as validate_runtime, observe as observe_runtime
from prepare_option2_candidate import inspect as inspect_bundle
from verify_prepared_option2_candidate import verify_prepared

SCHEMA = 'singularity-claude-complete-windows-observation/v1'
MAX_CONFIG_BYTES = 65536


def _config(path: Path) -> dict:
    raw = path.read_bytes()
    if not raw or len(raw) > MAX_CONFIG_BYTES:
        raise ValueError('RUNTIME_CONFIG_SIZE_INVALID')
    try:
        config = json.loads(raw)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError('RUNTIME_CONFIG_JSON_INVALID') from exc
    validate_runtime(config)
    if config['variant'] != 2:
        raise ValueError('CLAUDE_CODE_COMPLETE_ONLY')
    return config


def inspect_inputs(*, bundle: Path, runtime_config: Path, prepared: Path | None = None,
                   evidence_dir: Path | None = None, live: bool = False,
                   windows_host: bool | None = None, bundle_inspector=inspect_bundle,
                   prepared_verifier=verify_prepared, runtime_observer=observe_runtime,
                   evidence_matrix=matrix) -> dict:
    """Explicitly separated static inspection and Windows-only live observations.

    All path parameters are operator-local. Output never contains them, credentials,
    memory contents, agent identities, service payloads or tool raw stdout.
    """
    config = _config(runtime_config)
    host = (os.name == 'nt') if windows_host is None else windows_host
    if live and not host:
        raise ValueError('NATIVE_WINDOWS_REQUIRED_FOR_LIVE_PROBES')
    if live and prepared is None:
        raise ValueError('PREPARED_CANDIDATE_REQUIRED_FOR_LIVE_PROBES')
    observed_bundle = bundle_inspector(bundle)
    if not isinstance(observed_bundle, dict) or observed_bundle.get('option') != 2:
        raise ValueError('OPTION2_ACCEPTANCE_BUNDLE_REQUIRED')

    report = {
        'schema': SCHEMA,
        'product': 'Claude Code Complete',
        'variant': 2,
        'mode': 'read-only-live' if live else 'offline-plan',
        'bundle_inspection': {
            'status': 'INSPECTED_UNTRUSTED_ARTIFACT',
            'sha256': observed_bundle.get('bundle_sha256'),
        },
        'prepared_verification': {'status': 'NOT_RUN'},
        'runtime_observation': {'status': 'NOT_RUN'},
        'acceptance_matrix': {'status': 'NOT_RUN'},
        'no_write_operations_performed': True,
        'publisher_signature_verified': False,
        'claude_gui_functionally_verified': False,
        'tencent_repoql_functionally_verified': False,
        'services_functionally_verified': False,
        'release_ready': False,
    }
    if live:
        p = prepared_verifier(bundle, prepared, native_windows=True)
        if p.get('status') != 'PREPARED_CONTENT_VERIFIED_NOT_INSTALLED' or p.get('release_ready') is not False:
            raise ValueError('PREPARED_VERIFICATION_NOT_ACCEPTED')
        report['prepared_verification'] = {
            'status': p['status'],
            'verified_source_files': p.get('verified_source_files'),
            'verified_native_binaries': p.get('verified_native_binaries'),
        }
        runtime = runtime_observer(config, windows_host=True)
        if runtime.get('public_release_ready') is not False or runtime.get('variant') != 2:
            raise ValueError('RUNTIME_REPORT_INVALID')
        report['runtime_observation'] = {
            'status': 'OBSERVED_NOT_CERTIFIED',
            'binary_observations': runtime.get('binary_observations'),
            'service_observations': runtime.get('service_observations'),
        }
    if evidence_dir is not None:
        evidence = evidence_matrix(evidence_dir)
        if evidence.get('release_ready') is not False:
            raise ValueError('EVIDENCE_REPORT_MUST_NOT_CERTIFY')
        report['acceptance_matrix'] = {
            'status': 'EVIDENCE_INVENTORIED_NOT_CERTIFIED',
            'required_gates': evidence['required_gates'],
            'not_run': evidence['not_run'],
            'reported_pass_unreviewed': evidence['reported_pass_unreviewed'],
            'reported_fail': evidence['reported_fail'],
            'mixed_source_revisions': evidence['mixed_source_revisions'],
        }
    return report


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description='Inspect Option 2 Windows acceptance; never release approval')
    parser.add_argument('--bundle', required=True, type=Path)
    parser.add_argument('--runtime-config', required=True, type=Path)
    parser.add_argument('--prepared', type=Path)
    parser.add_argument('--evidence-dir', type=Path)
    parser.add_argument('--live', action='store_true', help='Explicit Windows-only, read-only native observations')
    parser.add_argument('--output', type=Path, help='New file only; never overwrites')
    args = parser.parse_args(argv)
    try:
        data = inspect_inputs(bundle=args.bundle, prepared=args.prepared,
                              runtime_config=args.runtime_config, evidence_dir=args.evidence_dir,
                              live=args.live)
        payload = json.dumps(data, indent=2, sort_keys=True) + '\n'
        if args.output:
            with args.output.open('x', encoding='utf-8') as f:
                f.write(payload)
        else:
            print(payload, end='')
        return 0
    except (ValueError, OSError, KeyError, TypeError) as exc:
        # Never echo private absolute paths or raw third-party payloads.
        detail = str(exc)
        if not detail.isascii() or not detail.replace('_','').isalnum():
            detail = type(exc).__name__.upper()
        print('WINDOWS_ACCEPTANCE_OBSERVATION_REFUSED:' + detail, file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
