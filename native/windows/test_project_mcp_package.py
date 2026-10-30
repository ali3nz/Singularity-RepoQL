"""Source package integration contracts: two correctly scoped MCP registrations."""
import json, tempfile, unittest, zipfile, subprocess
from pathlib import Path
from build_source_variants import build

class MCPArchiveContracts(unittest.TestCase):
    def test_all_options_include_native_mcp_registration_and_exclude_linux_old_config(self):
        for option in (1,2,3,4):
            with self.subTest(option=option),tempfile.TemporaryDirectory() as td:
                path=Path(td)/'package.zip';build(option,path)
                with zipfile.ZipFile(path) as z:
                    names=set(z.namelist());manifest=json.loads(z.read('NATIVE_WINDOWS_SOURCE_MANIFEST.json'))
                    self.assertIn('native/windows/configure_project_mcp.mjs',names)
                    self.assertIn('native/windows/provision_repoql.ps1',names)
                    self.assertIn('docs/WINDOWS-FIRST-RELEASE-CLAUDE-COMPLETE.md',names)
                    self.assertNotIn('openchamber/opencode.jsonc',names)
                    self.assertEqual(manifest['repoql']['requiredVersion'],'1.7.18')
                    self.assertEqual(manifest['repoql']['connectorContract'],'fetch-render')
                    self.assertNotIn('connectorAbi',manifest['repoql'])
                    self.assertEqual(manifest['gui'],'claude-desktop-code' if option<=2 else 'openchamber-desktop')
                    self.assertEqual(bool(manifest['features']['office']),option in (2,4))
                    self.assertEqual(bool(manifest['features']['ghost']),option in (2,4))
    def test_claude_complete_and_openchamber_complete_actual_extracted_modules(self):
        js = r"""
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
const [source,base,variantStr]=process.argv.slice(1);
const variant=Number(variantStr),w=join(base,'workspace'),b=join(base,'bin');
mkdirSync(w);mkdirSync(b);
const rqlExe=join(b,'rql.exe'),kanzoExe=join(b,'kanzo.exe');
writeFileSync(rqlExe,'fixture');writeFileSync(kanzoExe,'fixture');
const m=await import(pathToFileURL(join(source,'native/windows/configure_project_mcp.mjs')).href);
const opts={variant,workspace:w,rqlExe,kanzoExe,allowFixture:true};
const apply=m.applyProjectMcp(opts);
if(!apply.applied||apply.runtimeVerified!==false)throw Error('unexpected apply receipt');
const f=join(w,variant===2?'.mcp.json':'opencode.json');
const config=JSON.parse(readFileSync(f));
const entries=variant===2?config.mcpServers:config.mcp.servers;
if(!entries.kanzo || (variant===2 && entries.repoql) || (variant===4 && !entries.repoql))throw Error('incorrect MCP registration');
if(variant===4&&Array.isArray(config.mcp))throw Error('wrong OpenCode2 shape');
const rolled=m.rollbackProjectMcp({workspace:w});
if(!rolled.rolledBack)throw Error('rollback failed');
console.log(JSON.stringify({variant,applied:true,rolledBack:true,toolNames:Object.keys(entries).sort()}));
"""
        for option in (2,4):
            with self.subTest(option=option),tempfile.TemporaryDirectory() as td:
                base=Path(td);archive=base/'package.zip';build(option,archive)
                source=base/'source';source.mkdir()
                with zipfile.ZipFile(archive) as z:z.extractall(source)
                result=subprocess.run(['node','--input-type=module','--eval',js,str(source),str(base),str(option)],capture_output=True,text=True,timeout=25)
                self.assertEqual(result.returncode,0,result.stderr[-1000:])
                self.assertEqual(json.loads(result.stdout)['toolNames'],['kanzo'] if option==2 else ['kanzo','repoql'])
if __name__=='__main__': unittest.main()
