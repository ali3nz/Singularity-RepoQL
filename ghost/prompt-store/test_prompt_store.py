#!/usr/bin/env python3
"""Tests for the versioned Ghost prompt store."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import prompt_store  # noqa: E402


class PromptStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def seed(self, task="wake", entry="instruction", text="Block: {{date}} body\n"):
        return prompt_store.seed(task, entry, text, root=self.root)

    def test_seed_is_idempotent_and_first_revision(self):
        first = self.seed()
        self.assertEqual(first["rev"], 1)
        second = self.seed(text="different")
        self.assertIsNone(second)
        state = prompt_store.read("wake", "instruction", root=self.root)
        self.assertEqual(state["text"], "Block: {{date}} body\n")
        self.assertEqual(state["rev"], 1)
        self.assertTrue(state["onDisk"])

    def test_save_appends_history_and_current(self):
        self.seed()
        out = prompt_store.save("wake", "instruction", "Block: {{date}} v2", root=self.root)
        self.assertEqual(out["rev"], 2)
        state = prompt_store.read("wake", "instruction", root=self.root)
        self.assertEqual(state["text"], "Block: {{date}} v2")
        self.assertEqual([r["rev"] for r in state["history"]], [2, 1])
        self.assertTrue((self.root / ".history/wake/instruction/r0001.md").is_file())
        self.assertFalse(list((self.root / "wake").glob("*.tmp")))

    def test_revert_writes_new_revision(self):
        self.seed(text="one {{date}}")
        prompt_store.save("wake", "instruction", "two {{date}}", root=self.root)
        out = prompt_store.revert("wake", "instruction", 1, root=self.root)
        self.assertEqual(out["rev"], 3)
        state = prompt_store.read("wake", "instruction", root=self.root)
        self.assertEqual(state["text"], "one {{date}}")
        self.assertEqual([r["rev"] for r in state["history"]], [3, 2, 1])
        self.assertIn("revert to r0001", state["history"][0]["note"])

    def test_revert_rejects_unknown_or_tampered_revision(self):
        self.seed()
        with self.assertRaises(prompt_store.PromptError):
            prompt_store.revert("wake", "instruction", 99, root=self.root)
        path = self.root / ".history/wake/instruction/r0001.md"
        path.write_text("tampered")
        with self.assertRaises(prompt_store.PromptError) as caught:
            prompt_store.revert("wake", "instruction", 1, root=self.root)
        self.assertIn("modified", str(caught.exception))

    def test_validation(self):
        cases = [
            ("", "empty_prompt"),
            ("   \n ", "empty_prompt"),
            ("x" * 30000, "too_large"),
            ("Block {{nope}}", "unknown_placeholder:nope"),
            ("Block {{date", "malformed_placeholder"),
            ("Block {{bad token}}", "malformed_placeholder"),
        ]
        for text, expected in cases:
            with self.assertRaises(prompt_store.PromptError) as caught:
                prompt_store.save("wake", "instruction", text, root=self.root)
            self.assertIn(expected, str(caught.exception))
        prompt_store.save("wake", "instruction", "ok {{date}}", root=self.root)

    def test_registry_specs_unique_and_unknown_task_empty(self):
        # The fleet suite also asserted equality with taskguard.TASKS; that module
        # is fleet code, so this port keeps only the checks about the store itself.
        self.assertEqual(set(prompt_store.TASK_PROMPTS), {"sweep", "dream", "wake"})
        for task, specs in prompt_store.TASK_PROMPTS.items():
            ids = [s["id"] for s in specs]
            self.assertEqual(len(ids), len(set(ids)), task)
        self.assertEqual(prompt_store.status("no-such-task"), [])

    def test_status_reports_history_metadata(self):
        self.seed()
        prompt_store.save("wake", "instruction", "v2 {{date}}", root=self.root)
        rows = prompt_store.status("wake", root=self.root)
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["rev"], 2)
        self.assertEqual([h["rev"] for h in row["history"]], [2, 1])
        self.assertEqual(row["placeholders"], ["date", "slot", "summary"])
        self.assertEqual(prompt_store.status("no-such-task", root=self.root), [])

    def test_audit_lines_written(self):
        self.seed()
        prompt_store.save("wake", "instruction", "v2 {{date}}", root=self.root)
        lines = [json.loads(x) for x in (self.root / ".audit.jsonl").read_text().splitlines()]
        self.assertEqual([x["action"] for x in lines], ["seed", "set-prompt"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
