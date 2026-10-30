import tempfile
from pathlib import Path
from subprocess import CompletedProcess, TimeoutExpired
import unittest
from repoql_compat import (
    MANIFESTS,
    REQUIRED_CALLS,
    REQUIRED_CONNECTOR_CONTRACT,
    REQUIRED_VERSION,
    manifest_contract,
    parse_version,
    preflight,
)

ROOT = Path(__file__).resolve().parents[2]


def valid_manifest(scheme="kanzo", calls="[parse, fetch, render]"):
    return (f"scheme: {scheme}\n"
            "title: Test connector\n"
            "summary: Tests the native fetch and render contract.\n"
            f"calls: {calls}\n"
            "recordsVersion: 2\n"
            "fetchIntervalSeconds: 900\n"
            "fullFetchIntervalSeconds: 900\n")


class RepoQLPinTests(unittest.TestCase):
    def test_version_parser_requires_unambiguous_repoql_banner(self):
        self.assertEqual(parse_version('rql 1.7.18\n'), REQUIRED_VERSION)
        self.assertEqual(parse_version('1.7.18\n'), REQUIRED_VERSION)
        self.assertEqual(parse_version('v1.7.18\n'), REQUIRED_VERSION)
        self.assertIsNone(parse_version('rql 1.7.18\n1.7.17'))
        self.assertIsNone(parse_version('library 1.7.18\n1.7.18'))
        self.assertEqual(parse_version('RepoQL version v1.7.18\n'), REQUIRED_VERSION)
        self.assertIsNone(parse_version('Connector library version 1.7.18'))
        self.assertIsNone(parse_version('rql 1.7.18\nrql 1.7.17'))

    def test_both_bundled_manifests_use_the_current_contract(self):
        for relative, scheme in MANIFESTS.items():
            with self.subTest(manifest=relative):
                contract, errors = manifest_contract(ROOT / relative, scheme)
                self.assertEqual(errors, [])
                self.assertIsNotNone(contract)
                self.assertEqual(contract["scheme"], scheme)
                self.assertEqual(tuple(contract["calls"]), REQUIRED_CALLS)
                self.assertFalse(contract["obsolete_abi_present"])
                source = (ROOT / relative).read_text(encoding="utf-8")
                self.assertNotRegex(source, r"(?m)^\s*abi\s*:")

    def test_manifest_rejects_obsolete_abi_unknown_fields_and_bad_calls(self):
        cases = {
            "obsolete abi": valid_manifest().replace("calls:", "abi: 1\ncalls:"),
            "unknown top level": valid_manifest() + "mystery: true\n",
            "missing render": valid_manifest(calls="[parse, fetch]"),
            "duplicate top level": valid_manifest() + "scheme: memorycore\n",
            "malformed top level": valid_manifest() + "not a manifest entry\n",
            "not a full interval": valid_manifest().replace("fullFetchIntervalSeconds: 900", "fullFetchIntervalSeconds: 3600"),
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.yaml"
            for name, source in cases.items():
                with self.subTest(case=name):
                    path.write_text(source, encoding="utf-8")
                    contract, errors = manifest_contract(path, "kanzo")
                    self.assertIsNone(contract)
                    self.assertTrue(errors)

    def test_pin_accepts_118_and_refuses_older_versions(self):
        for version, accepted in [('1.7.18', True), ('1.7.17', False), ('1.7.15', False), ('1.7.16', False)]:
            with self.subTest(version=version):
                result = preflight(binary='C:/Tools/rql.exe', system='win32', runner=lambda *a, **k: CompletedProcess(a[0], 0, stdout=f'rql {version}', stderr=''))
                self.assertEqual(result['ok'], accepted)
                if not accepted:
                    self.assertIn('installation BLOCKED', result['errors'][-1])
                self.assertEqual(result['required_connector_contract'], REQUIRED_CONNECTOR_CONTRACT)

    def test_real_world_bare_stdout_is_accepted_by_preflight(self):
        result = preflight(binary='C:/Tools/rql.exe', system='win32',
                           runner=lambda *a, **k: CompletedProcess(a[0], 0, '1.7.18\n', ''))
        self.assertTrue(result['ok'])
        self.assertEqual(result['actual_version'], REQUIRED_VERSION)

    def test_windows_refuses_linux_binary_and_no_binary(self):
        self.assertFalse(preflight(binary='/usr/local/bin/rql', system='win32')['ok'])
        self.assertFalse(preflight(binary='', system='win32', runner=lambda *a, **k: CompletedProcess(a[0], 2, '', ''))['ok'])

    def test_failed_probe_is_fail_closed(self):
        def timeout(*args, **kwargs):
            raise TimeoutExpired('rql', 10)
        self.assertFalse(preflight(binary='C:/rql.exe', system='win32', runner=timeout)['ok'])

    def test_malformed_connector_manifests_are_blocked(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for relative in MANIFESTS:
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('abi: 1\n', encoding='utf-8')
            result = preflight(root=root, binary='C:/rql.exe', system='win32',
                               runner=lambda *a, **k: CompletedProcess(a[0], 0, 'rql 1.7.18', ''))
            self.assertFalse(result['ok'])
            self.assertIsNone(result['manifests']['connectors/kanzo/manifest.yaml'])
            self.assertIsNone(result['manifests']['connectors/memorycore/manifest.yaml'])
            self.assertTrue(result['errors'])
            self.assertTrue(all(error.startswith((
                'connectors/kanzo/manifest.yaml:',
                'connectors/memorycore/manifest.yaml:',
            )) for error in result['errors']))
            self.assertTrue(any('obsolete ABI field' in error for error in result['errors']))


if __name__ == '__main__':
    unittest.main()
