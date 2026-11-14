"""Opt-in Rust read-only upgrade/acceptance boundary, including forged results."""
from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase, main, mock
import tempfile

from claude_complete_acceptance_matrix import matrix
from plan_option2_upgrade import upgrade_plan


class ReleasePolicyBoundaryTests(TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.binary = self.root / 'release-evidence.exe'
        self.binary.write_bytes(b'UNEXECUTABLE MOCK ONLY')
        self.stage = self.root / 'stage'
        self.home = self.root / 'home'
        self.workspace = self.root / 'workspace'
        for directory in (self.stage, self.home, self.workspace):
            directory.mkdir()

    def check(self, fn, expected, *, mutate=None, exit_code=0):
        returned = expected.copy()
        if mutate:
            returned.update(mutate)
        calls = []

        def fake_run(argv, **kwargs):
            calls.append((argv, kwargs))
            return SimpleNamespace(returncode=exit_code, stdout=json.dumps(returned), stderr='')

        with mock.patch.dict(os.environ, {'SINGULARITY_RUST_RELEASE_EVIDENCE_BIN': str(self.binary)}):
            with mock.patch('rust_release_policy.subprocess.run', side_effect=fake_run):
                if mutate is None and exit_code == 0:
                    self.assertEqual(fn(), expected)
                else:
                    with self.assertRaisesRegex(ValueError, 'RELEASE_RUST_'):
                        fn()
        self.assertEqual(len(calls), 1)
        args, kwargs = calls[0]
        self.assertEqual(args[0], str(self.binary))
        self.assertIn(args[1], ('upgrade-plan-stdin', 'acceptance-matrix-stdin'))
        self.assertEqual(kwargs['timeout'], 10)
        facts = json.loads(kwargs['input'])
        self.assertFalse(any(s in kwargs['input'] for s in (str(self.root), 'password', 'api_key')))
        if args[1] == 'upgrade-plan-stdin':
            self.assertEqual(set(facts), {'receipts','taskState','dashboardTaskState'})
        else:
            self.assertEqual(set(facts), {'gateResults'})

    def test_upgrade_plan_reference_can_be_returned_only_with_exact_match(self):
        fn = lambda: upgrade_plan(self.stage,self.home,self.workspace,'ABSENT','ABSENT')
        ref = fn()
        self.check(fn, ref)
        self.check(fn, ref, mutate={'first_stage_clear': False})
        self.check(fn, ref, exit_code=2)

    def test_matrix_never_becomes_release_ready(self):
        fn = matrix
        ref = fn()
        self.check(fn, ref)
        self.check(fn, ref, mutate={'release_ready': True})
        self.check(fn, ref, exit_code=1)

    def test_selected_nonexistent_binary_refused_without_fallback(self):
        with mock.patch.dict(os.environ, {'SINGULARITY_RUST_RELEASE_EVIDENCE_BIN':str(self.root/'missing.exe')}):
            with self.assertRaisesRegex(ValueError,'RELEASE_RUST_BINARY_INVALID'):
                matrix()

    def test_symlink_binary_refused(self):
        link = self.root/'alias.exe'
        try:
            link.symlink_to(self.binary)
        except OSError:
            self.skipTest('symlinks unavailable')
        with mock.patch.dict(os.environ, {'SINGULARITY_RUST_RELEASE_EVIDENCE_BIN':str(link)}):
            with self.assertRaisesRegex(ValueError,'RELEASE_RUST_BINARY_INVALID'):
                matrix()

    def test_reparse_parent_binary_refused(self):
        parent = self.root/'owned'; parent.mkdir()
        child = parent/'release.exe'; child.write_bytes(b'FIXTURE')
        link = self.root/'foreign'
        try:link.symlink_to(parent, target_is_directory=True)
        except OSError:self.skipTest('symlinks unavailable')
        with mock.patch.dict(os.environ, {'SINGULARITY_RUST_RELEASE_EVIDENCE_BIN':str(link/'release.exe')}):
            with self.assertRaisesRegex(ValueError,'RELEASE_RUST_BINARY_INVALID'):
                matrix()


if __name__ == '__main__':
    main()
