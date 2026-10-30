import tempfile
import unittest
import zipfile
from pathlib import Path
from trace_linux_assumptions import audit

class SourceCandidateInventory(unittest.TestCase):
    def test_only_file_line_categories_not_source_or_secrets(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp)/'fixture.zip'
            with zipfile.ZipFile(p,'w') as z:
                z.writestr('harness/main.mjs', '''// docker is an inert comment
import {spawnSync} from "node:child_process";
spawnSync("docker", ["compose", "up", "--password=DO_NOT_PRINT_ME"]);
const x = "/proc/loadavg";
''')
                z.writestr('docs/README.md','run docker')
            r=audit(p)
            self.assertFalse(r['native_release_ready'])
            self.assertFalse(r['finding_is_execution_proof'])
            self.assertEqual(r['categories']['container_runtime']['count'],1)
            self.assertEqual(r['categories']['linux_proc']['count'],1)
            self.assertNotIn('DO_NOT_PRINT_ME',str(r))
            self.assertNotIn('README.md',str(r))

if __name__=='__main__':unittest.main()
