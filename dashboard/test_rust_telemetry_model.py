"""Source-stage parity checks; a compiled Rust executable is required separately."""
from __future__ import annotations
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import harness_telemetry as h

class RustModelTelemetryTests(unittest.TestCase):
    def test_normalized_reference_semantics(self):
        rows = [
            {'engine':'openai-sol','model':'chatgpt/reviewer', 'inputTokens':9000,'costUsd':90},
            {'engine':'openai-sol','model':'chatgpt/reviewer','usageScope':'sender',
             'sendInputTokens':9.9,'sendOutputTokens':2.6,'sendCostUsd':0.19},
            {'engine':'opencode-go','model':'deepseek/flash','inputTokens':12,'outputTokens':4,'costUsd':0.01},
            {'engine':'claude-5.5','model':'','inputTokens':0,'outputTokens':0,'costUsd':0},
            {'engine':'freebuff','model':'','inputTokens':'unreported','outputTokens':None},
        ]
        data = h.model_usage_metrics(rows,rust_bin='')
        self.assertEqual(data[0]['cost_kind'],'review_receiving_side')
        self.assertIsNone(data[0]['cost_usd'])
        self.assertEqual(data[1]['tokens_in'],9)
        self.assertEqual(data[1]['cost_usd'],0.19)
        self.assertEqual(data[2]['provider'],'deepseek')
        self.assertEqual(data[3]['cost_kind'],'reported')
        self.assertEqual(data[4]['tokens_in'],'unreported')

    def test_metadata_whitelist_and_successful_mock_native(self):
        row={'engine':'openai-sol','model':'chatgpt/reviewer','inputTokens':1,
             'usageScope':'sender','sendInputTokens':8,'sendCostUsd':0.01,
             'prompt':'PRIVATE_PROMPT','gatewayToken':'PRIVATE_SECRET','runId':'PRIVATE_RUN'}
        expected=h.model_usage_metrics([row],rust_bin='')
        with tempfile.TemporaryDirectory() as td:
            exe=Path(td,'model.exe');exe.write_text('fixture')
            def runner(_argv, **opts):
                req=json.loads(opts['input'])
                self.assertEqual(req['schema'],'singularity-model-usage/v1')
                self.assertEqual(req['rows'][0]['model'],'chatgpt/reviewer')
                self.assertNotIn('prompt',req['rows'][0]);self.assertNotIn('gatewayToken',req['rows'][0])
                self.assertNotIn('runId',req['rows'][0])
                self.assertFalse(any('TOKEN' in k.upper() for k in opts['env']))
                return SimpleNamespace(returncode=0,stdout=json.dumps({'ok':True,'metrics':expected}),stderr='')
            self.assertEqual(h.model_usage_metrics([row],rust_bin=exe,runner=runner),expected)

    def test_native_forgery_and_missing_binary_are_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            exe=Path(td,'model.exe');exe.write_text('fixture')
            def runner(_argv,**_kw):
                return SimpleNamespace(returncode=0,stdout=json.dumps({'ok':True,'metrics':[{'provider':'attacker'}]}),stderr='')
            with self.assertRaisesRegex(RuntimeError,'DIVERGENCE'):
                h.model_usage_metrics([{'engine':'claude'}],rust_bin=exe,runner=runner)
            with self.assertRaisesRegex(RuntimeError,'EXECUTABLE_INVALID'):
                h.model_usage_metrics([{'engine':'claude'}],rust_bin=Path(td,'missing.exe'))
            link=Path(td,'link.exe');link.symlink_to(exe)
            with self.assertRaisesRegex(RuntimeError,'EXECUTABLE_INVALID'):
                h.model_usage_metrics([{}],rust_bin=link)

    def test_native_bounded_batch_and_inputs(self):
        with self.assertRaisesRegex(ValueError,'BATCH_TOO_LARGE'):
            h.model_usage_metrics([{}]*129, rust_bin='')
        # The default Python collector must preserve its historical unlimited
        # model label acceptance. Only the opt-in native path restricts it.
        self.assertEqual(h.model_usage_metrics([{'model':'x'*129}], rust_bin='')[0]['provider'], None)
        with self.assertRaisesRegex(ValueError,'METADATA_TOO_LARGE'):
            h.model_usage_metrics([{'model':'x'*129}], rust_bin='/native/path')

    def test_collector_batches_and_preserves_python_accounting(self):
        with tempfile.TemporaryDirectory() as td:
            t=Path(td);runs=t/'runs';runs.mkdir()
            usage=runs/'engine-usage.jsonl'
            rows=[{'timestamp':'2026-11-13T00:00:00Z','runId':'test', 'engine':'openai-sol',
                   'model':'chatgpt/reviewer','success':True,'inputTokens':1000,'costUsd':18},
                  {'timestamp':'2026-11-13T00:00:01Z','runId':'test','engine':'openai-sol',
                   'model':'chatgpt/reviewer','success':True,'usageScope':'sender',
                   'sendInputTokens':20,'sendOutputTokens':4,'sendCostUsd':0.05},
                  {'timestamp':'2026-11-13T00:00:02Z','runId':'test','engine':'opencode',
                   'model':'deepseek/flash','success':True,'inputTokens':5,'outputTokens':10,'costUsd':0.03}]
            usage.write_text(''.join(json.dumps(r)+'\n' for r in rows))
            store=h.Store(t/'db.sqlite')
            try:
                with patch.object(h,'RUNS',runs), patch.dict(os.environ,{'SINGULARITY_RUST_TELEMETRY_BIN':''}):
                    c=h.Collector(store)
                    self.assertEqual(c.model_usage(),{'records':3})
                    self.assertEqual(c.model_usage(),{'records':0})
                result=store.conn.execute('SELECT cost_kind,tokens_in,cost_usd FROM events ORDER BY ts').fetchall()
                self.assertEqual(len(result),3)
                self.assertEqual(result[0]['cost_kind'],'review_receiving_side')
                self.assertIsNone(result[0]['cost_usd'])
                self.assertEqual(result[1]['tokens_in'],20)
                self.assertAlmostEqual(result[1]['cost_usd'],.05)
                self.assertEqual(result[2]['cost_kind'],'reported')
            finally:
                store.close()


    def test_failed_native_batch_rolls_back_telemetry_without_advancing_cursor(self):
        with tempfile.TemporaryDirectory() as td:
            t=Path(td);runs=t/'runs';runs.mkdir()
            usage=runs/'engine-usage.jsonl'
            usage.write_text(''.join(json.dumps({'timestamp':'2026-11-13T00:00:00Z',
                'engine':'claude','model':'claude/sonnet','success':True,'inputTokens':10,
                'outputTokens':2,'costUsd':0.001})+'\n' for _ in range(140)))
            store=h.Store(t/'db.sqlite')
            try:
                with patch.object(h,'RUNS',runs), patch.dict(os.environ,
                    {'SINGULARITY_RUST_TELEMETRY_BIN':str(t/'missing-native.exe')}):
                    c=h.Collector(store)
                    c._wrap('model_usage',c.model_usage)
                    self.assertFalse(c.sources['model_usage']['ok'])
                    self.assertEqual(store.conn.execute('SELECT COUNT(*) FROM events').fetchone()[0],0)
                with patch.object(h,'RUNS',runs), patch.dict(os.environ,
                    {'SINGULARITY_RUST_TELEMETRY_BIN':''}):
                    c=h.Collector(store)
                    c._wrap('model_usage',c.model_usage)
                    self.assertTrue(c.sources['model_usage']['ok'])
                    self.assertEqual(c.sources['model_usage']['records'],140)
            finally:
                store.close()

if __name__=='__main__':unittest.main()
