#!/usr/bin/env python3
"""Run cross-language fixture comparisons after Rust has been compiled.

Default: runs reference JS/Python contract tests without requiring Rust.
With --rust-cli: compares identical snapshots against the native Rust CLI.
Does not write to the repository, change services, or access the network.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

NODE = r'''
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, cmd] = process.argv.slice(1);
const load = async (file) => import(pathToFileURL(path.join(root, file)).href);
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
let output;
if (cmd === 'rank') {
  const { liveSourceOrder } = await load('harness/kit/lib/repoql-client.mjs');
  output = { ok: true, results: liveSourceOrder(input.results, input.query) };
} else if (cmd === 'temporal') {
  const { currentTruth, historicalTruth, beliefTruth } = await load('harness/kit/lib/memory-temporal.mjs');
  const args = { capsuleBody: input.capsuleBody, temporal: input.temporal };
  if (input.mode === 'current') output = { ok: true, verdict: currentTruth({ ...args, now: new Date(input.now) }) };
  else if (input.mode === 'historical') output = { ok: true, verdict: historicalTruth({ ...args, asOf: input.asOf }) };
  else output = { ok: true, verdict: beliefTruth({ ...args, asOf: input.asOf }) };
} else if (cmd === 'tombstone-check') {
  const { evaluateTombstones } = await load('harness/kit/lib/memory-tombstone.mjs');
  const ev = evaluateTombstones({ subject: input.subject, field: input.field, claim: input.claim, scope: input.scope, tombstones: input.tombstones });
  output = { ok: true, blocked: ev.blocked, matchedIndex: ev.blocked ? input.tombstones.indexOf(ev.tombstone) : null };
} else if (cmd === 'tombstone-claim') {
  const { claimIsRejected } = await load('harness/kit/lib/memory-tombstone.mjs');
  const ev = claimIsRejected({ claim: input.claim, scope: input.scope, tombstones: input.tombstones });
  output = { ok: true, blocked: ev.blocked, matchedIndex: ev.blocked ? input.tombstones.indexOf(ev.tombstone) : null };
} else if (cmd === 'task-links') {
  const { linkedCaptureUnits } = await load('memory/portable/task-recovery.mjs');
  output = { ok: true, units: linkedCaptureUnits(input.ledger, input.taskId, input.agent) };
} else throw new Error(`Unknown ${cmd}`);
console.log(JSON.stringify(output));
'''

TASK = 'task-abcdef1234'
UNIT = {'task_id': TASK, 'task_id_source': 'binding', 'agent': 'agent-alpha',
        'session_id': 's1', 'first_seq': 1, 'last_seq': 2,
        'status': 'reconciled', 'at': '2026-11-12T00:00:00Z'}
TOMB = {'status': 'active', 'subject': 'Renewal', 'field': 'period',
        'rejectedClaim': '30 days', 'scope': 'concept:///knowledge/**'}

FIXTURES = [
    ('rank', {'query': 'src/config.mjs', 'results': [
        {'uri': 'local:///src/config.mjs.bak', 'score': .9},
        {'uri': 'local:///src/config.mjs', 'score': .5},
        {'uri': 'local:///src/config.js', 'score': .7}]}),
    ('rank', {'query': 'config', 'results': [
        {'uri': 'local:///src/config.mjs.bak', 'score': .9},
        {'uri': 'local:///other/config.mjs.bak', 'score': .95},
        {'uri': 'local:///src/config.mjs', 'score': .5}]}),
    ('temporal', {'mode': 'current', 'now': '2026-11-12T00:00:00Z',
                  'capsuleBody': '---\ncategory: rule\n---\nlegacy'}),
    ('temporal', {'mode': 'current', 'now': '2026-11-12T00:00:00Z',
                  'capsuleBody': '---\nvalidTo: 2026-02-01T00:00:00Z\n---\nexpired'}),
    ('temporal', {'mode': 'historical', 'asOf': '2026-01-15T00:00:00Z',
                  'capsuleBody': 'validFrom: 2026-01-01T00:00:00Z\nvalidTo: 2026-02-01T00:00:00Z'}),
    ('temporal', {'mode': 'belief', 'asOf': '2026-01-15T00:00:00Z',
                  'capsuleBody': 'validFrom: 2026-01-01T00:00:00Z'}),
    ('tombstone-check', {'subject': 'Renewal', 'field': 'period', 'claim': '30 days',
                         'scope': 'concept:///knowledge/Renewal.md', 'tombstones': [TOMB]}),
    ('tombstone-check', {'subject': 'Renewal', 'field': 'period', 'claim': '14 days',
                         'scope': 'concept:///knowledge/Renewal.md', 'tombstones': [TOMB]}),
    ('tombstone-check', {'subject': 'Renewal', 'field': 'period', 'claim': '30 days',
                         'scope': 'concept:///else/Renewal.md', 'tombstones': [TOMB]}),
    ('tombstone-claim', {'claim': '30 days', 'scope': 'concept:///knowledge/Renewal.md', 'tombstones': [TOMB]}),
    ('tombstone-claim', {'claim': '14 days', 'scope': 'concept:///knowledge/Renewal.md', 'tombstones': [TOMB]}),
    ('tombstone-claim', {'claim': '30 days', 'scope': 'concept:///else/Renewal.md', 'tombstones': [TOMB]}),
    ('task-links', {'ledger': {'units': {'oc:s1:1-2': UNIT, 'fake': UNIT}},
                    'taskId': TASK, 'agent': 'agent-alpha'}),
    ('task-links', {'ledger': {'units': {'oc:s1:1-2': UNIT}},
                    'taskId': 'task-9876543', 'agent': 'agent-alpha'}),
]


def run_json(args, payload, env=None):
    p = subprocess.run(args, input=json.dumps(payload), encoding='utf-8',
                       capture_output=True, env=env, check=False)
    if p.returncode != 0:
        raise RuntimeError(f'{args[0]} rc={p.returncode}: {p.stderr[:600]}')
    return json.loads(p.stdout)


def preflight_reference(repo, root, env):
    cmd = [sys.executable, str(repo / 'native/windows/memory_authority_preflight.py'), '--root', str(root)]
    p = subprocess.run(cmd, capture_output=True, text=True, env=env)
    return p.returncode, json.loads(p.stdout)


def differential_preflight(repo, rust_cli):
    count = 0
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        config = root / 'harness/kit/config.json'
        config.parent.mkdir(parents=True)
        config.write_text(json.dumps({'memoryProvenance': {'retrievalFilter': 'ENABLED'}}))
        env = dict(os.environ)
        for key in ('ORCH_MEMORY_RETRIEVAL_FILTER', 'ORCH_TOMBSTONES_DIR', 'ORCH_LINEAGE_DIR'):
            env.pop(key, None)
        for setup in ('missing_dirs', 'ready', 'disabled', 'config_missing'):
            if setup == 'ready':
                for key, name in [('ORCH_TOMBSTONES_DIR', 'tombstones'), ('ORCH_LINEAGE_DIR', 'lineage')]:
                    path = root / name
                    path.mkdir()
                    env[key] = str(path)
            elif setup == 'disabled':
                env['ORCH_MEMORY_RETRIEVAL_FILTER'] = 'DISABLED'
            elif setup == 'config_missing':
                config.unlink()
            reference = preflight_reference(repo, root, env)
            if setup == 'missing_dirs':
                assert reference[0] == 2 and reference[1]['code'] == 'WINDOWS_MEMORY_AUTHORITY_UNVERIFIED'
            if setup == 'ready':
                assert reference[0] == 0 and reference[1]['ok'] is True
            if setup == 'disabled':
                assert reference[0] == 0 and reference[1]['ok'] is True
            if setup == 'config_missing':
                assert reference[0] == 2 and reference[1]['code'] == 'KIT_CONFIG_UNAVAILABLE'
            if rust_cli:
                proc = subprocess.run([str(rust_cli), 'preflight', '--root', str(root)],
                                      capture_output=True, text=True, env=env)
                actual = (proc.returncode, json.loads(proc.stdout))
                if actual != reference:
                    raise AssertionError(f'preflight {setup}: Python={reference!r}, Rust={actual!r}')
            count += 1
    return count


def reference_source_policy(repo, payload):
    import importlib.util
    spec = importlib.util.spec_from_file_location('windows_source_policy',
        repo / 'native/windows/windows_source_policy.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    spec2 = importlib.util.spec_from_file_location('scan_source_archive',
        repo / 'native/windows/scan_source_archive.py')
    sys.path.insert(0, str(repo / 'native/windows'))
    try:
        archive_module = importlib.util.module_from_spec(spec2)
        spec2.loader.exec_module(archive_module)
    finally:
        sys.path.pop(0)
    name, variant = payload['name'], payload['variant']
    if variant != 2:
        return {'ok': False, 'code': 'INVALID_VARIANT'}
    return {'ok': True, 'windowsSafeMember': archive_module.windows_safe_member(name),
            'retired': module.windows_retired_source(name),
            'office': module.windows_office_source(name),
            'linuxAsset': module.linux_deployment_asset(name),
            'excluded': module.windows_variant_excludes(name, variant)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--rust-cli', type=Path)
    args = parser.parse_args()
    root = args.repo.resolve()
    if not (root / 'harness/kit/lib/repoql-client.mjs').exists():
        raise SystemExit('Repo root must contain original Windows V2 source')
    totals = {}
    for cmd, payload in FIXTURES:
        clean_env = dict(os.environ)
        clean_env.pop('SINGULARITY_RUST_MEMORY_POLICY_BIN', None)
        ref = run_json(['node', '--input-type=module', '-e', NODE, str(root), cmd], payload, env=clean_env)
        if args.rust_cli:
            ported = run_json([str(args.rust_cli), cmd], payload)
            if ref != ported:
                raise AssertionError(f'{cmd} mismatch: JS={ref!r} Rust={ported!r}')
        totals[cmd] = totals.get(cmd, 0) + 1
    totals['preflight'] = differential_preflight(root, args.rust_cli)
    for name, variant in [('CON.txt', 1), ('native/windows/supervisor.rs', 2),
                          ('office/patches/windows-ghost-only.patch', 3),
                          ('memory/portable/systemd/agent.service', 2), ('office/a.rs', 2),
                          ('openchamber/opencode.jsonc', 2), ('native/windows/manage_native_windows.ps1', 2)]:
        payload = {'name': name, 'variant': variant}
        ref = reference_source_policy(root, payload)
        if args.rust_cli:
            proc = subprocess.run([str(args.rust_cli), 'source-policy'], input=json.dumps(payload),
                                  capture_output=True, text=True, timeout=10, check=False)
            actual = json.loads(proc.stdout)
            assert proc.returncode == (0 if ref['ok'] else 2), (name, proc.returncode)
            assert ref == actual, (name, ref, actual)
        totals['source-policy'] = totals.get('source-policy', 0) + 1
    print(json.dumps({'ok': True, 'referenceFixtures': totals,
                      'rustCompared': bool(args.rust_cli),
                      'note': 'source-only and no native Windows runtime tests'}))


if __name__ == '__main__':
    main()
