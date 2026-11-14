#!/usr/bin/env python3
"""Promotion cursor safety and the optional native policy boundary."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'memory_promote.py'
spec = importlib.util.spec_from_file_location('promotion_scan', SCRIPT)
promotion = importlib.util.module_from_spec(spec)
spec.loader.exec_module(promotion)


class PromotionSafetyTests(unittest.TestCase):
    def setUp(self):
        self.cursor = {"afterTs": 0, "doneIds": [], "deferred": {},
                       "lastShortlist": {"a": {"ts": 10}, "b": {"ts": 20}},
                       "pendingReview": {"a": {"ts": 10}, "b": {"ts": 20}},
                       "promotions": {}}

    def test_unresolved_shortlist_blocks_advance(self):
        out = promotion.advance_decision(self.cursor, 20)
        self.assertFalse(out['allowed'])
        self.assertEqual(out['blocked'], ['a', 'b'])

    def test_prior_shortlists_cannot_be_overwritten(self):
        self.cursor['lastShortlist'] = {'b': {'ts': 20}}
        out = promotion.advance_decision(self.cursor, 20)
        self.assertEqual(out['blocked'], ['a', 'b'])

    def test_resolved_ids_can_advance_without_deleting_review_state(self):
        self.cursor['doneIds'] = ['a', 'b']
        self.assertEqual(promotion.advance_decision(self.cursor, 20)['afterTs'], 20)

    def test_deferred_review_still_blocks_even_when_marked_done_in_cursor(self):
        self.cursor['doneIds'] = ['a', 'b']
        self.cursor['deferred'] = {'a': {'rec_ts': 10, 'reason': 'later'}}
        out = promotion.advance_decision(self.cursor, 20)
        self.assertEqual(out['blocked'], ['a'])

    def test_cannot_skip_unseen_or_unpresented_timestamp(self):
        self.assertEqual(promotion.advance_decision(self.cursor, 21)['code'], 'BEYOND_SHORTLIST')
        self.cursor['pendingReview'] = {}
        self.assertEqual(promotion.advance_decision(self.cursor, 10)['code'], 'NO_SHORTLIST')

    def test_old_timestamp_is_noop(self):
        self.cursor['afterTs'] = 15
        self.assertEqual(promotion.advance_decision(self.cursor, 15)['code'], 'NOOP')
        self.assertEqual(promotion.advance_decision(self.cursor, 13)['afterTs'], 15)

    def test_shortlist_keeps_budget_and_source_order(self):
        rows = [{'id': str(i), 'ts': i + 1, 'excerpt': 'x' * 300} for i in range(17)]
        out = promotion.select_shortlist(rows, self.cursor)
        self.assertEqual(len(out['indices']), 12)
        self.assertEqual(out['indices'], list(range(12)))
        self.assertEqual(out['newestTs'], 12)
        self.cursor['doneIds'] = ['0', '1']
        self.assertEqual(promotion.select_shortlist(rows, self.cursor)['indices'][0], 2)

    def test_scanning_retains_hidden_older_rows_across_runs(self):
        with tempfile.TemporaryDirectory() as temp:
            records = [{'id': f'rec-{i}', 'content': f'evidence {i}', 'timestamp': 100 + i * 10}
                       for i in range(14)]
            # The final two rows were returned in a later position despite
            # older timestamps, exactly the case that formerly allowed skips.
            records[-2]['timestamp'] = 101
            records[-1]['timestamp'] = 102
            doc = {'code': 0, 'data': {'messages': records}}
            argv = [str(SCRIPT), '--state-dir', temp]
            with mock.patch.object(sys, 'argv', argv), mock.patch.dict(os.environ, {'SINGULARITY_RUST_MEMORY_POLICY_BIN':''}):
                with mock.patch.object(promotion, 'search', return_value=doc):
                    with contextlib.redirect_stdout(io.StringIO()):
                        with self.assertRaises(SystemExit) as result:
                            promotion.main()
            self.assertEqual(result.exception.code, 0)
            state = json.loads((Path(temp)/'promotion-cursor.json').read_text())
            self.assertEqual(len(state['lastShortlist']), 12)
            self.assertEqual(len(state['pendingReview']), 14)
            shown = list(state['lastShortlist'])
            state['doneIds'] = shown
            blocked = promotion.advance_decision(state, state['maxPresentedTs'])
            self.assertEqual(blocked['code'], 'UNRESOLVED')
            self.assertEqual(blocked['blocked'], ['rec-12', 'rec-13'])

    def test_promotion_cap_and_repeat(self):
        self.cursor['promotions'] = {
            'old': {'ts': 1}, 'a': {'ts': 86400}, 'b': {'ts': 86401}}
        self.assertEqual(promotion.eligible_promotion(self.cursor, 'new', 86401)['code'], 'CAP_REACHED')
        self.cursor['promotions'].pop('old')
        self.assertEqual(promotion.eligible_promotion(self.cursor, 'b', 86401)['code'], 'REPEAT_CONCEPT')
        self.assertEqual(promotion.eligible_promotion(self.cursor, 'fresh', 86401)['code'], 'ELIGIBLE')

    def test_enabled_native_receives_only_sanitized_metadata(self):
        rows = [{'id':'a', 'ts':10, 'excerpt':'PRIVATE_STORY_DO_NOT_FORWARD'}]
        with tempfile.TemporaryDirectory() as temp:
            binary = Path(temp) / 'compiled-policy.exe'
            binary.write_bytes(b'test fixture')
            expected = promotion.select_shortlist(rows, self.cursor)
            with mock.patch.dict(os.environ, {'SINGULARITY_RUST_MEMORY_POLICY_BIN':str(binary)}):
                with mock.patch.object(promotion.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, stdout=json.dumps(expected))) as run:
                    self.assertEqual(promotion.guarded_shortlist(rows, self.cursor), rows)
            payload = run.call_args.kwargs['input']
            self.assertNotIn('PRIVATE_STORY', payload)
            self.assertEqual(run.call_args.args[0][1], 'promotion-shortlist')

    def test_forged_native_policy_blocks_read_and_write(self):
        with tempfile.TemporaryDirectory() as temp:
            binary = Path(temp) / 'compiled-policy.exe'
            binary.write_bytes(b'test fixture')
            with mock.patch.dict(os.environ, {'SINGULARITY_RUST_MEMORY_POLICY_BIN':str(binary)}):
                with mock.patch.object(promotion.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, stdout='{"ok":true,"allowed":true}')):
                    with self.assertRaises(promotion.PromotionPolicyError):
                        promotion.guarded_advance(self.cursor, 20)

    def test_invalid_native_binary_fails_closed(self):
        with mock.patch.dict(os.environ, {'SINGULARITY_RUST_MEMORY_POLICY_BIN':'policy.exe'}):
            with self.assertRaises(promotion.PromotionPolicyError):
                promotion.guarded_advance(self.cursor, 20)

    def test_cursor_replace_failure_leaves_original_intact(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'promotion-cursor.json'
            path.write_text('{"stable":true}\n')
            with mock.patch.object(promotion.os, 'replace', side_effect=OSError('synthetic crash')):
                with self.assertRaises(OSError):
                    promotion.save_cursor(path, {'afterTs': 25})
            self.assertEqual(path.read_text(), '{"stable":true}\n')
            self.assertFalse((Path(temp)/'.promotion-cursor.json.tmp').exists())

    def test_cli_advance_rejects_unresolved_without_mutating_disk(self):
        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp) / 'promotion-cursor.json'
            state.write_text(json.dumps(self.cursor), encoding='utf-8')
            initial = state.read_bytes()
            argv = [str(SCRIPT), '--state-dir', temp, '--advance-ts', '20']
            with mock.patch.object(sys, 'argv', argv), mock.patch.dict(os.environ, {'SINGULARITY_RUST_MEMORY_POLICY_BIN':''}):
                with contextlib.redirect_stdout(io.StringIO()):
                    with self.assertRaises(SystemExit) as ctx:
                        promotion.main()
            self.assertEqual(ctx.exception.code, 5)
            self.assertEqual(state.read_bytes(), initial)

    def test_cli_advance_with_completed_reviews_and_then_prunes(self):
        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp) / 'promotion-cursor.json'
            state.write_text(json.dumps(self.cursor), encoding='utf-8')
            argv = [str(SCRIPT), '--state-dir', temp, '--mark-done', 'a', 'b', '--advance-ts', '20']
            with mock.patch.object(sys, 'argv', argv), mock.patch.dict(os.environ, {'SINGULARITY_RUST_MEMORY_POLICY_BIN':''}):
                with contextlib.redirect_stdout(io.StringIO()):
                    with self.assertRaises(SystemExit) as ctx:
                        promotion.main()
            self.assertEqual(ctx.exception.code, 0)
            saved = json.loads(state.read_text())
            self.assertEqual(saved['afterTs'], 20)
            self.assertEqual(saved['pendingReview'], {})


if __name__ == '__main__':
    unittest.main(verbosity=2)
