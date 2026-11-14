import tempfile
import unittest
import zipfile
import hashlib
import json
from pathlib import Path
from scan_source_archive import scan, windows_safe_member


REQUIRED_COMPONENT_FILES = (
    "native/windows/openmausbot/claude_mcp_launcher.mjs",
    "connectors/kanzo/connector.ts",
    "connectors/memorycore/connector.ts",
    "dashboard/server.py",
    "office/README.md",
    "adapters/claude-code/memory-hook.mjs",
)


def write_minimal_archive(path: Path, *, member: str = "README.md",
                          ghost_feature: bool = False,
                          omit_component: str | None = None,
                          variant: int = 2) -> None:
    # Complete valid archive shell, so negative tests isolate one rejection.
    payloads = {name: b"review-only source" for name in (*REQUIRED_COMPONENT_FILES, member)}
    if omit_component is not None:
        payloads.pop(omit_component)
    receipts = [
        {"path": name, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
        for name, data in sorted(payloads.items())
    ]
    checksums = ''.join(f"{row['sha256']}  {row['path']}\n" for row in receipts)
    receipts.append({"path": "SHA256SUMS", "sha256": hashlib.sha256(checksums.encode()).hexdigest(),
                     "bytes": len(checksums.encode())})
    manifest = {
        "schema": 1,
        "product": "Singularity RepoQL native Windows SOURCE review",
        "variant": variant,
        "features": {"ghost": ghost_feature, "office": True, "repoql_dashboard": True,
                     "tencent_connector": True, "kanzo": True, "openmausbot": True,
                     "memory": True, "repoql_mcp": True},
        "rustGhostFeature": False,
        "rustOfficeFeature": True,
        "repoql": {"requiredVersion": "1.7.18", "connectorContract": "fetch-render"},
        "release_status": "SOURCE_ONLY_UNCOMPILED_NOT_INSTALLER",
        "no_wsl_required_for_intended_runtime": "UNVERIFIED_NATIVE_ACCEPTANCE_REQUIRED",
        "production_feature_parity": "UNVERIFIED",
        "files": receipts,
    }
    with zipfile.ZipFile(path, "w") as out:
        for name, data in payloads.items():
            out.writestr(name, data)
        out.writestr("SHA256SUMS", checksums)
        out.writestr("NATIVE_WINDOWS_SOURCE_MANIFEST.json", json.dumps(manifest))


class SourceArchiveSecurity(unittest.TestCase):
    def test_rejects_untrusted_archive_path(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'bad.zip'
            with zipfile.ZipFile(target, 'w') as out:
                out.writestr('../private.key', 'not-a-real-key')
            result = scan(target)
            self.assertFalse(result['ok'])
            self.assertIn('invalid or duplicate archive member', result['issues'])

    def test_rejects_normalized_dot_segment(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'bad.zip'
            with zipfile.ZipFile(target, 'w') as out:
                out.writestr('src/./config.json', '{}')
            self.assertIn('invalid or duplicate archive member', scan(target)['issues'])

    def test_windows_ntfs_names_and_case_collisions(self):
        for bad in ('src/CON.txt', 'NUL', 'com1.json', 'Lpt9.d',
                    'src/final. ', 'src/trailing.', 'src/hidden:stream',
                    'src/question?.md', 'src/ctrl\x01.md', 'src\\bad.md',
                    'src/../bad.md', 'src//bad.md'):
            with self.subTest(path=bad):
                self.assertFalse(windows_safe_member(bad))
        for good in ('README.md', 'src/My Module.rs', 'src/CONTRIBUTING.md'):
            self.assertTrue(windows_safe_member(good))
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'case.zip'
            with zipfile.ZipFile(target, 'w') as out:
                out.writestr('README.md', 'x')
                out.writestr('readme.md', 'y')
            self.assertIn('invalid Windows member, reserved name or case-insensitive collision', scan(target)['issues'])

    def test_rejects_missing_manifest_and_checksums(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'bad.zip'
            with zipfile.ZipFile(target, 'w') as out:
                out.writestr('README.md', 'source-only')
            self.assertFalse(scan(target)['ok'])

    def test_valid_complete_source_shell_and_rejects_missing_component(self):
        with tempfile.TemporaryDirectory() as directory:
            valid = Path(directory) / 'complete.zip'
            write_minimal_archive(valid)
            self.assertTrue(scan(valid)['ok'], scan(valid))
            missing = Path(directory) / 'no-openmaus.zip'
            write_minimal_archive(missing,
                                  omit_component='native/windows/openmausbot/claude_mcp_launcher.mjs')
            self.assertIn('full Claude Code component source missing', scan(missing)['issues'])
            old = Path(directory) / 'old-profile.zip'
            write_minimal_archive(old, variant=1)
            self.assertIn('invalid source-only profile', scan(old)['issues'])

    def test_rejects_ghost_file_leaked_from_agent_group(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'ghost-leak.zip'
            write_minimal_archive(
                target,
                member='adapters/claude-code/agents/singularity-ghost.md',
            )
            result = scan(target)
            self.assertFalse(result['ok'])
            self.assertIn('Retired component entered Windows source package', result['issues'])

    def test_rejects_ghost_enabled_manifest_even_without_ghost_file(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'ghost-feature.zip'
            write_minimal_archive(target, member='README.md', ghost_feature=True)
            result = scan(target)
            self.assertFalse(result['ok'])
            self.assertIn('full Claude Code feature contract missing', result['issues'])


if __name__ == '__main__':
    unittest.main()
