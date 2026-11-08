"""Windows Option 2 OMB distribution proof, not a live MCP session."""
import tempfile
import unittest
import zipfile
from pathlib import Path
from build_source_variants import build

class OpenMausBotSourcePackage(unittest.TestCase):
    def test_option2_contains_shared_rules_launcher_and_onboarding(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'source.zip';build(2,p)
            with zipfile.ZipFile(p) as z:
                names=set(z.namelist())
                for name in ('native/windows/openmausbot/AGENTS.md',
                             'native/windows/openmausbot/install_shared_rules.mjs',
                             'native/windows/openmausbot/claude_mcp_launcher.mjs',
                             'native/windows/openmausbot/provision_maintainer.mjs',
                             'native/windows/openmausbot/provision_maintainer.test.mjs',
                             'native/windows/openmausbot/omb_integration.test.mjs',
                             'docs/WINDOWS-OPENMAUSBOT-CLAUDE-INTEGRATION.md'):
                    self.assertIn(name,names)
                self.assertNotIn('openmausbot/compose.yaml',names)
                self.assertNotIn('openmausbot/bridge/omb_registry.py',names)
                text=z.read('native/windows/openmausbot/AGENTS.md').decode()
                self.assertIn('Kanzo',text)
                self.assertIn('nudges',text.lower())
                self.assertIn('Tencent',text)
                self.assertNotIn('192.168.',text)
if __name__=='__main__':unittest.main()
