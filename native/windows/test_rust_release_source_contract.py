"""Static cross-language source inventory, not compiled Rust parity."""
import re
from pathlib import Path
import unittest
from claude_complete_acceptance_matrix import GATES, SCHEMA as ACCEPTANCE_SCHEMA
from plan_option2_upgrade import RECEIPTS, SCHEMA as UPGRADE_SCHEMA

HERE = Path(__file__).resolve().parent
RUST = HERE / 'release-evidence-rust' / 'src'


def rust_string_array(module, constant):
    data=(RUST/module).read_text(encoding='utf-8')
    match=re.search(r'const\s+'+constant+r':\s*\[&str;\s*\d+\]\s*=\s*\[(.*?)\];',
                    data,flags=re.S)
    if not match:
        raise AssertionError(f'Rust source constant missing: {constant}')
    return re.findall(r'"([a-z0-9_]+)"',match.group(1))


class RustReleaseContractSourceTests(unittest.TestCase):
    def test_acceptance_gates_match_authoritative_python_order(self):
        self.assertEqual(rust_string_array('acceptance.rs','GATES'),list(GATES))

    def test_upgrade_receipt_keys_match_authoritative_python_order(self):
        self.assertEqual(rust_string_array('upgrade.rs','RECEIPTS'),list(RECEIPTS))

    def test_native_schema_and_cli_commands_are_present(self):
        self.assertIn(ACCEPTANCE_SCHEMA,(RUST/'acceptance.rs').read_text())
        self.assertIn(UPGRADE_SCHEMA,(RUST/'upgrade.rs').read_text())
        main=(RUST/'main.rs').read_text()
        self.assertIn('"upgrade-plan-stdin"',main)
        self.assertIn('"acceptance-matrix-stdin"',main)


if __name__=='__main__':unittest.main()
