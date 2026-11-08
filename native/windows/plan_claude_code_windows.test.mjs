import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPlan, localWindowsPath } from './plan_claude_code_windows.mjs';

const root = 'C:\\Users\\Example\\AppData\\Local\\Singularity\\current\\source';
const exe = 'C:\\Program Files\\nodejs\\node.exe';
const script = fileURLToPath(new URL('./plan_claude_code_windows.mjs',import.meta.url));

test('Option 2 includes 15 roles, 4 native exec-form hooks and all optional feature flags',()=>{
  const p=buildPlan({variant:2,repoRoot:root,nodeExe:exe});
  assert.equal(p.agentDefinitions.length,15);
  assert.deepEqual(p.managedHooks.map(h=>h.event),['SubagentStart','SubagentStop','SessionStart','Stop']);
  assert.ok(p.managedHooks.every(h=>h.command===exe && h.args.length===2 && h.args[0].startsWith(root)));
  assert.equal(p.officeIncludedByVariant,true);
  assert.equal(p.ghostIncludedByVariant,true);
  assert.equal(p.releaseReady,false);
  assert.equal(p.memoryHookPreviewOnly,true);
  assert.equal(p.officeEventHooksInPreview,false);
  assert.equal(p.completeInstaller,'native/windows/configure_claude_code_windows.mjs');
  assert.equal(p.mode,'READ_ONLY_NO_INSTALLATION');
});

test('Option 1 excludes Ghost/Office while preserving four hooks',()=>{
  const p=buildPlan({variant:1,repoRoot:root,nodeExe:exe});
  assert.equal(p.officeIncludedByVariant,false);
  assert.equal(p.ghostIncludedByVariant,false);
  assert.equal(p.managedHooks.length,4);
});

test('Unrelated hooks and secrets remain in input, never appear in the emitted preview',()=>{
  const existing={ env:{MY_API_TOKEN:'VERY_PRIVATE_TEST_SECRET'},hooks:{Stop:[{matcher:'*',hooks:[{type:'command',command:'foreign-helper.exe --secret VERY_PRIVATE_TEST_SECRET'}]}]}};
  const snapshot=JSON.stringify(existing);
  const p=buildPlan({variant:2,repoRoot:root,nodeExe:exe,existingSettings:existing});
  assert.equal(JSON.stringify(existing),snapshot);
  assert.ok(!JSON.stringify(p).includes('VERY_PRIVATE_TEST_SECRET'));
  assert.ok(!JSON.stringify(p).includes('foreign-helper.exe'));
  assert.equal(p.managedHooks.length,4);
});

test('Reject alternate paths and non-Node command',()=>{
  for (const value of ['\\\\server\\share\\repo','\\\\?\\C:\\Root','C:relative','C:\\Root\\..\\repo','C:\\Root\\CON\\a','C:\\Root\\end.','C:\\Root\\dir\\\\file','C:\\Root/dir','C:\\Root\\bad:name',' C:\\bad']) {
    assert.throws(()=>localWindowsPath(value),undefined,value);
  }
  for (const variant of [0,3,4,5,'2',null]) assert.throws(()=>buildPlan({variant,repoRoot:root,nodeExe:exe}));
  assert.throws(()=>buildPlan({variant:2,repoRoot:root,nodeExe:'C:\\Tools\\powershell.exe'}));
  assert.throws(()=>buildPlan({variant:2,repoRoot:root,nodeExe:exe,existingSettings:[]}));
});

test('CLI emits no existing secret and never writes settings',()=>{
  const d=mkdtempSync(join(tmpdir(),'cc-plan-'));
  try {
    const settings=join(d,'settings.json');
    const existing='{"env":{"API_TOKEN":"VERY_PRIVATE_TEST_SECRET"},"hooks":{"Stop":[{"hooks":[{"type":"command","command":"foreign-helper.exe"}]}]}}';
    writeFileSync(settings,existing);
    const run=spawnSync(process.execPath,[script,'--variant','2','--repo-root',root,'--node-exe',exe,'--existing-settings',settings],{encoding:'utf8',timeout:3000});
    assert.equal(run.status,0,run.stderr);
    assert.equal(JSON.parse(run.stdout).agentDefinitions.length,15);
    assert.ok(!run.stdout.includes('VERY_PRIVATE_TEST_SECRET'));
    assert.equal(readFileSync(settings,'utf8'),existing);
    const bad=spawnSync(process.execPath,[script,'--variant','3','--repo-root',root,'--node-exe',exe],{encoding:'utf8',timeout:3000});
    assert.equal(bad.status,2);
  } finally { rmSync(d,{recursive:true,force:true}); }
});
