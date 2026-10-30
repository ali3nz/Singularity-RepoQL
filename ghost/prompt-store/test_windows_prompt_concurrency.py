"""Parallel-writer and history regression for native-compatible prompt store.

Runs on this host and on the Windows CI matrix; Linux execution alone does
not prove Windows lock semantics.
"""
import concurrent.futures
import tempfile
import unittest
from pathlib import Path

from prompt_store import read, save, revert


class PromptConcurrentWrites(unittest.TestCase):
    def test_two_writers_keep_all_revisions_and_revert(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            def writer(label):
                for n in range(8):
                    save('sweep', 'review', f'Prompt {label}-{n}', root=root)
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                jobs = [pool.submit(writer, name) for name in ('a','b')]
                for job in jobs: job.result(timeout=15)
            result = read('sweep', 'review', root=root)
            self.assertEqual(result['rev'], 16)
            self.assertTrue(result['onDisk'])
            self.assertEqual([row['rev'] for row in result['history']], list(range(16,0,-1)))
            previous = revert('sweep','review',1, root=root)
            self.assertEqual(previous['rev'], 17)
            self.assertTrue(read('sweep','review',root=root)['onDisk'])

if __name__=='__main__': unittest.main()
