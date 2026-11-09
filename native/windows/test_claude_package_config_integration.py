"""Actual Option 1/2 source ZIP -> imported installer -> isolated filesystem round trip.

Linux/Windows runner filesystem contract only; it does NOT install Claude Code,
validate Windows ACLs, launch GUI hooks or certify self-learning runtime.
"""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from zipfile import ZipFile
from build_source_variants import build

SCRIPT = r"""
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
const [source,home,nodeExe,memoryConfig,officeConfig,variant] = process.argv.slice(1);
// Load actual ESM hook imports from the extracted, variant-scoped archive.
// This catches missing runtime dependencies even when settings/agents exist.
const memoryHook = await import(pathToFileURL(join(source,'adapters/claude-code/memory-hook.mjs')).href);
const docHook = await import(pathToFileURL(join(source,'adapters/claude-code/doc-hook.mjs')).href);
const m = await memoryHook.runMemoryHook(['subagent-start'], {stdin:JSON.stringify({agent_type:'foreign-agent'})});
const d = await docHook.runDocHook(['session-start'], {stdin:'{}',env:{OPENCHAMBER_DOC_POLICY:'off'}});
if (m.exitCode!==0 || d.exitCode!==0) throw Error('hook import or benign execution failed');
const mod = await import(pathToFileURL(join(source,'native/windows/configure_claude_code_windows.mjs')).href);
const settingsDir = join(home,'.claude');
mkdirSync(settingsDir,{recursive:true});
const prior={foreignCredential:'SECRET-NEVER-PRINT',hooks:{Stop:[{matcher:'only-specific',hooks:[{type:'command',command:'foreign'}]}]}};
writeFileSync(join(settingsDir,'settings.json'),JSON.stringify(prior));
const conf={source,home,nodeExe,memoryConfig,officeConfig:Number(variant)===2?officeConfig:undefined,variant:Number(variant)};
const plan=mod.prepareConfiguration(conf);
if (plan.agentWrites.length!==9 || plan.skillWrites.length!==(Number(variant)===2?10:9)) throw Error('missing agent/skill definitions');
const apply=mod.applyConfiguration(conf);
const verified=mod.verifyConfiguration({home});
if (!verified.configured || verified.runtimeVerified || apply.agentDefinitions!==9 || apply.skillsInstalled!==(Number(variant)===2?10:9)) throw Error('bad config result');
if(Number(variant)===2 && (!apply.officeEventHooksConfigured || !verified.officeEventHooksConfigured || verified.hookEventsExpected!==13))throw Error('Office event hooks not configured');
const rollback=mod.rollbackConfiguration({home});
const after=JSON.parse(readFileSync(join(settingsDir,'settings.json')));
if (JSON.stringify(after)!==JSON.stringify(prior)) throw Error('settings rollback mismatch');
console.log(JSON.stringify({variant:Number(variant),configured:verified.configured,rollback:rollback.state,agentDefinitions:apply.agentDefinitions,skillsInstalled:apply.skillsInstalled,sourceProvenanceChecked:true,realHookImportsExecuted:true}));
"""

class ClaudePackageToSettingsIntegration(unittest.TestCase):
    def test_both_claude_variants_round_trip_from_actual_zip(self):
        for option in (1, 2):
            with self.subTest(option=option), tempfile.TemporaryDirectory() as td:
                root = Path(td)
                archive = root / f'option{option}.zip'
                build(option, archive)
                source = root / 'source'
                source.mkdir()
                with ZipFile(archive) as z:
                    z.extractall(source)
                home = root / 'private-home'
                home.mkdir()
                node_exe = root / 'node.exe'
                node_exe.write_bytes(b'fixture-not-a-compiled-executable')
                memory = root / 'memory.json'
                memory.write_text('do not print or parse memory secrets', encoding='utf8')
                office = root / 'office.json'
                office.write_text(json.dumps({'endpoint':'http://127.0.0.1:8000','ingestKey':'fixture-secret-do-not-log'}), encoding='utf8')
                result = subprocess.run(
                    ['node', '--input-type=module', '--eval', SCRIPT,
                     str(source), str(home), str(node_exe), str(memory), str(office), str(option)],
                    capture_output=True, text=True, timeout=35,
                )
                self.assertEqual(result.returncode, 0, result.stderr[-1500:])
                details = json.loads(result.stdout)
                self.assertTrue(details['configured'])
                self.assertEqual(details['rollback'], 'CLAUDE_CONFIGURATION_ROLLED_BACK')
                self.assertEqual(details['agentDefinitions'], 9)
                self.assertEqual(details['skillsInstalled'], 10 if option==2 else 9)
                self.assertTrue(details['realHookImportsExecuted'])
                self.assertNotIn('SECRET-NEVER-PRINT', result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
