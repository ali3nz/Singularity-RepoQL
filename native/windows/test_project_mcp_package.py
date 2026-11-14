"""Source package integration contracts: Claude Code project Kanzo and separate RepoQL plugin ownership."""
import json, tempfile, unittest, zipfile, subprocess
from pathlib import Path
from build_source_variants import build

class MCPArchiveContracts(unittest.TestCase):
    def test_full_profile_includes_native_mcp_registration(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / 'package.zip'
            build(2, path)
            with zipfile.ZipFile(path) as z:
                names = set(z.namelist())
                manifest = json.loads(z.read('NATIVE_WINDOWS_SOURCE_MANIFEST.json'))
            self.assertIn('native/windows/configure_project_mcp.mjs', names)
            self.assertIn('native/windows/provision_repoql.ps1', names)
            self.assertIn('docs/WINDOWS-FIRST-RELEASE-CLAUDE-COMPLETE.md', names)
            self.assertNotIn('openchamber/opencode.jsonc', names)
            self.assertEqual(manifest['repoql']['requiredVersion'], '1.7.18')
            self.assertEqual(manifest['repoql']['connectorContract'], 'fetch-render')
            self.assertNotIn('connectorAbi', manifest['repoql'])
            self.assertEqual(manifest['gui'], 'claude-desktop-code')
            self.assertTrue(manifest['features']['office'])
            self.assertFalse(manifest['features']['ghost'])

    def test_extracted_module_owns_only_kanzo_in_project_mcp(self):
        js = r"""
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
const [source,base]=process.argv.slice(1);
const variant=2,w=join(base,'workspace'),b=join(base,'bin');
mkdirSync(w);mkdirSync(b);
const rqlExe=join(b,'rql.exe'),kanzoExe=join(b,'kanzo.exe');
writeFileSync(rqlExe,'fixture');writeFileSync(kanzoExe,'fixture');
const m=await import(pathToFileURL(join(source,'native/windows/configure_project_mcp.mjs')).href);
const opts={variant,workspace:w,rqlExe,kanzoExe,allowFixture:true};
const apply=m.applyProjectMcp(opts);
if(!apply.applied||apply.runtimeVerified!==false)throw Error('unexpected apply receipt');
const f=join(w,'.mcp.json');
const config=JSON.parse(readFileSync(f));
const entries=config.mcpServers;
if(!entries.kanzo || entries.repoql)throw Error('incorrect MCP registration');
const rolled=m.rollbackProjectMcp({workspace:w});
if(!rolled.rolledBack)throw Error('rollback failed');
console.log(JSON.stringify({variant,applied:true,rolledBack:true,toolNames:Object.keys(entries).sort()}));
"""
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            archive = base / 'package.zip'
            build(2, archive)
            source = base / 'source'
            source.mkdir()
            with zipfile.ZipFile(archive) as z:
                z.extractall(source)
            result = subprocess.run(
                ['node', '--input-type=module', '--eval', js, str(source), str(base)],
                capture_output=True, text=True, timeout=25,
            )
            self.assertEqual(result.returncode, 0, result.stderr[-1000:])
            self.assertEqual(json.loads(result.stdout)['toolNames'], ['kanzo'])


if __name__ == '__main__':
    unittest.main()
