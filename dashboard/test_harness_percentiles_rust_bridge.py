"""Opt-in Rust harness performance projections; no private telemetry crosses stdin."""
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch, Mock

from harness_telemetry import Harness, performance_percentiles


class HarnessPercentilesBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.binary = Path(self.temp.name) / 'singularity-harness-percentiles.exe'
        self.binary.write_bytes(b'fixture')
        self.durations = [100, 200, 300, 400]
        self.latency = [25, 50, 75]
        self.expected = performance_percentiles(self.durations, self.latency, rust_bin='')

    def test_default_python_and_verified_opt_in(self):
        with patch.dict(os.environ, {'SINGULARITY_HARNESS_PERCENTILES_RUST_BINARY': ''}):
            self.assertEqual(performance_percentiles(self.durations, self.latency), self.expected)
        with patch.dict(os.environ, {'SINGULARITY_HARNESS_PERCENTILES_RUST_BINARY': str(self.binary),
                                      'PRIVATE_API_KEY': 'must_not_leak'}):
            run = Mock(return_value=subprocess.CompletedProcess([], 0, json.dumps(self.expected), ''))
            self.assertEqual(performance_percentiles(self.durations, self.latency, runner=run), self.expected)
            opts = run.call_args.kwargs
            self.assertFalse(opts['shell'])
            self.assertEqual(opts['timeout'], 8)
            self.assertNotIn('PRIVATE_API_KEY', opts['env'])
            self.assertEqual(json.loads(opts['input']), {
                'schema': 'singularity-harness-percentiles/v1',
                'completion_ms': self.durations, 'model_latency_ms': self.latency})
            self.assertNotIn('run_id', opts['input'])
            self.assertNotIn('token', opts['input'])
            self.assertNotIn('agent', opts['input'])

    def test_rejects_invalid_binary_and_symlink(self):
        for value in ('relative.exe', str(self.binary.parent / 'missing.exe')):
            with self.subTest(value=value):
                with self.assertRaisesRegex(RuntimeError, 'binary_invalid'):
                    performance_percentiles([1], [1], rust_bin=value)
        link = self.binary.parent / 'link.exe'
        try:
            link.symlink_to(self.binary)
        except (OSError, NotImplementedError):
            return
        with self.assertRaisesRegex(RuntimeError, 'binary_invalid'):
            performance_percentiles([1], [1], rust_bin=link)

    def test_mismatch_invalid_json_and_failed_process(self):
        for output, code in ((json.dumps(dict(self.expected, forged=True)), 0),
                             (json.dumps({'completion_ms': {}}), 0),
                             ('not json', 0), ('', 1)):
            with self.subTest(output=output, code=code):
                fake = Mock(return_value=subprocess.CompletedProcess([], code, output, ''))
                with self.assertRaises(RuntimeError):
                    performance_percentiles(self.durations, self.latency, rust_bin=self.binary, runner=fake)

    def test_bounded_and_strict_numeric_inputs(self):
        for bad in (True, float('nan'), float('inf'), 'text', {'run_id': 'secret'}, 1e13):
            with self.subTest(bad=repr(bad)):
                with self.assertRaisesRegex(RuntimeError, 'invalid_sample'):
                    performance_percentiles([bad], [], rust_bin=self.binary)
        with self.assertRaisesRegex(RuntimeError, 'too_many_samples'):
            performance_percentiles([1] * 20001, [], rust_bin=self.binary)
        # Legacy Python path does not acquire Rust-specific shape limitations.
        self.assertEqual(performance_percentiles([1] * 20001, [], rust_bin='')['completion_ms']['samples'], 20001)

    def test_performance_sql_ownership_and_output(self):
        with patch.dict(os.environ, {'SINGULARITY_HARNESS_PERCENTILES_RUST_BINARY': ''}):
            h = Harness(self.temp.name)
            try:
                result = h.performance('7d')
                self.assertEqual(result['completion_ms']['samples'], 0)
                self.assertEqual(result['model_latency_ms']['samples'], 0)
                self.assertIsNone(result['completion_ms']['p95'])
                self.assertEqual(result['failed_or_abandoned'], 0)
            finally:
                h.close()


if __name__ == '__main__':
    unittest.main()
