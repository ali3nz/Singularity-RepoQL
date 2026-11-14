"""Source contract: the Windows native upgrade gate covers every shipped gateway differential.

This cannot prove PowerShell execution or Rust parity. Those are native gates.
"""
import re
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
SCRIPT=ROOT/'native/windows/verify_rust_upgrade.ps1'
RUST_BINS=ROOT/'native/windows/unified-gateway-rust/src/bin'
DIFFERENTIALS=ROOT/'native/windows/unified-gateway-rust/tests'


class CompleteGatewayGate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source=SCRIPT.read_text(encoding='utf-8')
        cls.entries=re.findall(r"@\{ Binary = '([^']+)'; Suite = '([^']+)' \}",cls.source)

    def test_every_available_gateway_differential_has_exactly_one_native_binary(self):
        suites={p.name for p in DIFFERENTIALS.glob('differential_*.py')}
        self.assertEqual({suite for _,suite in self.entries},suites)
        self.assertEqual(len(self.entries),len(suites))
        for binary,suite in self.entries:
            with self.subTest(binary=binary):
                self.assertTrue((RUST_BINS/(binary+'.rs')).is_file())
                self.assertRegex(suite,r'^differential_[a-z_]+\.py$')

    def test_upgrade_gate_is_native_only_and_fail_closed(self):
        code=self.source
        self.assertIn('if (-not $Native) { return }',code)
        self.assertIn('check_rust_lock_provenance.py',code)
        self.assertIn('Missing compiled gateway binary:',code)
        self.assertIn('Missing gateway differential:',code)
        self.assertIn("Invoke-Checked 'python' @($test, '--rust-cli', $binary)",code)
        self.assertIn("'test_rust_release_policy','test_rust_release_source_contract'",code)
        self.assertNotIn("'test_rust_release_policy'test_rust_release_source_contract'",code)

    def test_compiled_document_integration_is_gated_on_both_hosts(self):
        compiled = self.source.split('if (-not $Native) { return }', 1)[1]
        workflow = (ROOT/'.github/workflows/rust-memory-upgrade-acceptance.yml').read_text()
        self.assertIn('$env:SINGULARITY_DOC_RUST_BIN = $MemoryBinary', compiled)
        self.assertIn('$env:SINGULARITY_DOC_RUST_BIN = $PreviousDocBinary', compiled)
        self.assertIn('$env:SINGULARITY_DOC_RUST_BIN = $binary', workflow)
        for source in (compiled, workflow):
            self.assertIn('test-memory-doc-ingest.py', source)
            self.assertIn('doc-ingest-parity.test.mjs', source)
            self.assertIn('SINGULARITY_PARITY_PYTHON', source)

    def test_native_gate_builds_tests_and_lints_the_full_office_bridge(self):
        self.assertIn("if ($crate -eq 'native/desktop-bridge')", self.source)
        self.assertIn("$Features = @('--no-default-features','--features','office')", self.source)
        for command in ('test', 'clippy', 'build'):
            with self.subTest(command=command):
                self.assertRegex(self.source, rf"@\('{command}',[^\n]+\+ \$Features")

    def test_memorycore_and_document_evidence_are_always_covered(self):
        self.assertIn(('singularity-memorycore-reader','differential_memorycore_reader.py'),self.entries)
        self.assertIn(('singularity-memorycore-writer','differential_memorycore_writer.py'),self.entries)
        self.assertIn(('singularity-doc-ledger-evidence','differential_doc_ledger_evidence.py'),self.entries)

if __name__=='__main__':unittest.main()
