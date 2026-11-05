import os
import tempfile
import unittest
from pathlib import Path
from file_lock import fcntl

class LockTests(unittest.TestCase):
    def test_exclusive_nonblocking_lock_refuses_concurrent_writer(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/"locked"
            with path.open("w+") as a, path.open("r+") as b:
                fcntl.flock(a.fileno(), fcntl.LOCK_EX)
                with self.assertRaises(OSError):
                    fcntl.flock(b, fcntl.LOCK_EX | fcntl.LOCK_NB)
                fcntl.flock(a, fcntl.LOCK_UN)
                fcntl.flock(b, fcntl.LOCK_EX | fcntl.LOCK_NB)
                fcntl.flock(b, fcntl.LOCK_UN)

if __name__ == "__main__": unittest.main()
