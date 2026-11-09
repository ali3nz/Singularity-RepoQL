"""Static guard: Windows-shipped Python must not spawn a visible console window."""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# Files that run on the user's Windows desktop (windowless parents), where a
# console child would flash a window unless CREATE_NO_WINDOW is passed.
FILES = [
    "dashboard/repoql_native_auth.py",
    "dashboard/unified_bridge.py",
    "dashboard/native_cpu.py",
    "dashboard/freebuff_allowance.py",
    "scripts/memory_turn_capture.py",
    "native/windows/openmausbot/headless.py",
]
CALL = re.compile(r"subprocess\.(run|Popen)\(")


class NoFlashSpawns(unittest.TestCase):
    def test_every_spawn_is_windowless(self):
        for rel in FILES:
            text = (ROOT / rel).read_text(encoding="utf-8")
            if rel.endswith("headless.py"):
                # Calls must go through the hiding helpers; only they touch subprocess.
                direct = [m for m in CALL.finditer(text)
                          if "creationflags" not in text[m.start():m.start() + 400]
                          and "return subprocess" not in text[max(0, m.start() - 8):m.start() + 20]
                          and "Popen | None" not in text[m.start():m.start() + 20]]
                self.assertEqual(direct, [], rel)
                self.assertIn("CREATE_NO_WINDOW", text)
                continue
            for m in CALL.finditer(text):
                window = text[m.start():m.start() + 600]
                self.assertTrue("CREATE_NO_WINDOW" in window or "creationflags" in window,
                                f"{rel}: spawn without windowless flag near offset {m.start()}")


if __name__ == "__main__":
    unittest.main()
