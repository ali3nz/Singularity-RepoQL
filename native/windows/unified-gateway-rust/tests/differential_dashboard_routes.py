"""Check all public route keys, method splits, unknown routes and prefix handling."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'dashboard'))
from dashboard_route_policy import READ_PREFIXES, READ_ROUTES, WRITE_ROUTES, classify_dashboard_route


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--rust-cli', type=Path)
    args = parser.parse_args()
    keys = sorted(set(READ_ROUTES) | set(WRITE_ROUTES) | {p for p, _ in READ_PREFIXES})
    keys += ['/api/harness/detail', '/api/unified/unknown', '/api/unified',
             '/api/health/', '/api/unlisted', '/api/HEALTH', '/']
    count = 0
    for method in ('GET', 'POST', 'DELETE', 'PUT', 'PATCH'):
        for key in keys:
            expected = (READ_ROUTES if method == 'GET' else WRITE_ROUTES).get(key)
            if method == 'GET' and expected is None:
                expected = next((r for p, r in READ_PREFIXES if key.startswith(p)), None)
            assert classify_dashboard_route(method, key, rust_bin=args.rust_cli or '') == expected
            count += 1
    if args.rust_cli:
        bad = subprocess.run([str(args.rust_cli)], input='{"schema":"singularity-dashboard-routes/v1","read":true,"key":"","extra":1}',
                             text=True, capture_output=True, timeout=5, check=False)
        assert bad.returncode == 2
    print(f'DASHBOARD_ROUTES_{"COMPILED" if args.rust_cli else "REFERENCE_ONLY"}: {count} cases')


if __name__ == '__main__':
    main()
