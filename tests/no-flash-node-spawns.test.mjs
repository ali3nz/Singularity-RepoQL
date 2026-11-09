import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
// Windows-run scripts: every child process must be hidden (windowsHide) so no console flashes.
const FILES=['scripts/skill-gate.mjs','scripts/selflearn-candidates.mjs','scripts/doc-policy.mjs',
 'scripts/runtime-proofs.mjs','scripts/acceptance-ordinary-session.mjs','scripts/doctor.mjs',
 'scripts/install-claude-code.mjs','scripts/native-memory-supervisor.mjs',
 'native/windows/openmausbot/claude_mcp_launcher.mjs'];
const CALL=/\b(spawnSync|execFileSync|execFile|execSync|spawn)\(/g;
test('every Node child process on Windows paths sets windowsHide',()=>{
 for(const f of FILES){
  const s=readFileSync(join(root,f),'utf8');let m;
  while((m=CALL.exec(s))){
   const before=s.slice(Math.max(0,m.index-12),m.index);
   if(/function\s*$|\.\s*$/.test(before)&&!/child_process\.\s*$/.test(before))continue;
   const win=s.slice(m.index,m.index+700);
   assert.ok(/windowsHide/.test(win)||/\.\.\.\w*opts/i.test(win),`${f}: ${m[1]} at ${m.index} lacks windowsHide`);
  }
 }
});
