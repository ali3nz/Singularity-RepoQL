"""Harness usage numeric receipt projection and opt-in Rust strict parity."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

from harness_telemetry import Harness, usage_counter_projection


def row(calls, got_in, got_out, reported, cost=0.0):
    return dict(calls=calls, tin_samples=got_in, tout_samples=got_out,
                reported_calls=reported, cost=cost)


class HarnessUsageBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.binary = Path(self.temp.name) / 'singularity-harness-usage.exe'
        self.binary.write_bytes(b'fixture')
        self.rows = [row(5, 4, 2, 2, 0.31), row(1, 0, 1, 0, 0.0)]
        self.expected = usage_counter_projection(self.rows, 7, rust_bin='')

    def test_python_default_and_verified_rust_without_billing_data(self):
        with patch.dict(os.environ, {'SINGULARITY_HARNESS_USAGE_RUST_BINARY': ''}):
            self.assertEqual(usage_counter_projection(self.rows, 7), self.expected)
        fake = Mock(return_value=subprocess.CompletedProcess([], 0, json.dumps(self.expected), ''))
        with patch.dict(os.environ, {'SINGULARITY_HARNESS_USAGE_RUST_BINARY': str(self.binary),
                                      'PRIVATE_API_KEY': 'never-to-child'}):
            self.assertEqual(usage_counter_projection(self.rows, 7, runner=fake), self.expected)
        opts = fake.call_args.kwargs
        self.assertFalse(opts['shell'])
        self.assertEqual(opts['timeout'], 8)
        self.assertNotIn('PRIVATE_API_KEY', opts['env'])
        req = json.loads(opts['input'])
        self.assertEqual(req, {'schema':'singularity-harness-usage-counts/v1',
                               'rows': [[5,4,2,2],[1,0,1,0]], 'completed':7})
        for field in ('PRIVATE', 'cost', 'provider', 'model', 'agent', 'path', 'token'):
            self.assertNotIn(field, opts['input'])

    def test_numeric_counts_and_malformed_input(self):
        self.assertEqual(self.expected, {'calls_without_input_tokens': 2,
                                         'calls_without_output_tokens': 3,
                                         'paid_calls': 2, 'completed_tasks': 7})
        for bad in (row(1,2,0,0), row(1,0,0,2), row(1,True,0,0), row(1,'secret',0,0),
                    row(-1,0,0,0), row(10**13,0,0,0)):
            with self.subTest(bad=bad):
                with self.assertRaises(RuntimeError):
                    usage_counter_projection([bad],0,rust_bin=self.binary)
        with self.assertRaisesRegex(RuntimeError, 'invalid_count'):
            usage_counter_projection([row(1,1,1,1)]*501,0,rust_bin=self.binary)
        # The original source-owned SQL path has no new cap when Rust is disabled.
        self.assertEqual(usage_counter_projection([row(1,1,1,1)]*501,0,rust_bin='')['paid_calls'], 501)

    def test_missing_symlink_and_forged_output_fail_closed(self):
        for path in ('relative.exe', str(self.binary.parent/'missing.exe')):
            with self.assertRaisesRegex(RuntimeError,'binary_invalid'):
                usage_counter_projection(self.rows,7,rust_bin=path)
        link = self.binary.parent/'alias.exe'
        try:
            link.symlink_to(self.binary)
        except (OSError, NotImplementedError):
            pass
        else:
            with self.assertRaisesRegex(RuntimeError,'binary_invalid'):
                usage_counter_projection(self.rows,7,rust_bin=link)
        for data, code in ((json.dumps(dict(self.expected, paid_calls=7)),0),
                           (json.dumps(dict(self.expected, extra='private')),0),
                           ('invalid json',0), ('',1)):
            fake = Mock(return_value=subprocess.CompletedProcess([],code,data,''))
            with self.assertRaises(RuntimeError):
                usage_counter_projection(self.rows,7,rust_bin=self.binary,runner=fake)

    def test_usage_return_preserves_python_cost_scope(self):
        h = Harness(self.temp.name)
        try:
            # Three queries: grouped model receipts, daily aggregates, completed runs.
            sql_results = [[dict(self.rows[0], model='claude/opus', provider='claude'),
                            dict(self.rows[1], model='other', provider='unknown')],
                           [], [{'n':7}]]
            with patch.object(h,'_q', side_effect=sql_results), patch.dict(os.environ,
                {'SINGULARITY_HARNESS_USAGE_RUST_BINARY':''}):
                result = h.usage('30d')
            self.assertEqual(result['paid_calls'],2)
            self.assertEqual(result['calls_without_input_tokens'],2)
            self.assertEqual(result['reported_usd'],.31)
            self.assertEqual(result['completed_tasks'],7)
            self.assertEqual(result['cost_per_completed_task'],round(.31/7,6))
            self.assertIsNone(result['estimated_usd'])
        finally:
            h.close()


if __name__ == '__main__':
    unittest.main()
