"""Native Windows startup gate for the externally installed RepoQL 1.7.18 binary.

No shell execution, no automatic upgrade and no connector installation.
Refuse opening the dashboard listener before the exact supported version and
both bundled fetch/render manifests have been checked. Legacy Linux dashboard
is unchanged.
"""
from __future__ import annotations
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from native.windows.repoql_compat import preflight


def check_native_repoql(config, *, native=None, runner=None):
    if native is None:
        native = os.environ.get('SINGULARITY_WINDOWS_NATIVE') == '1'
    if not native:
        return {'ok': True, 'legacy_unchanged': True, 'checked': False}
    kwargs = {'binary': str(config.rql), 'system': 'win32'}
    if runner is not None:
        kwargs['runner'] = runner
    return preflight(**kwargs)
