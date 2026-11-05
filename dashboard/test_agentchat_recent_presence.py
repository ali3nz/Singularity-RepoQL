import json
import tempfile
import unittest
from datetime import datetime, timezone, timedelta
from pathlib import Path
from agentchat_feed import read_presence

class PresenceTests(unittest.TestCase):
    def test_missing_store_is_unavailable(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertFalse(read_presence(root=Path(directory) / 'not-present')['available'])

    def test_recent_chat_is_not_work_claim(self):
        now = datetime(2026, 11, 1, 1, 0, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory) / 'inbox'
            folder.mkdir()
            entries = [
                {'id': 1, 'from': 'luna', 'createdAt': (now - timedelta(minutes=2)).isoformat()},
                {'id': 2, 'from': 'sol', 'createdAt': (now - timedelta(hours=1)).isoformat()},
                {'id': 3, 'from': 'bad role', 'createdAt': now.isoformat()},
                {'id': 4, 'from': 'future', 'createdAt': (now + timedelta(days=1)).isoformat()},
            ]
            (folder / 'luna.jsonl').write_text('\n'.join(json.dumps(x) for x in entries) + '\n')
            result = read_presence(root=Path(directory), now=now)
        self.assertEqual(result['agents'], [
            {'role': 'luna', 'status': 'idle', 'last_seen': (now - timedelta(minutes=2)).isoformat()}])
        self.assertFalse(result['working_status_verified'])

if __name__ == '__main__': unittest.main()
