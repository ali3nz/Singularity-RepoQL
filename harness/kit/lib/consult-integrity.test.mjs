import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {humanizeForSol} from './sol-humanize.mjs';

const evidence = `===== updateWithRetry.mjs (raw on-host dump) =====
  async function updateWithRetry(head) {
    const content = await getHead(head.head.skill_id);
    return content;
  }
VGhpcyBpcyBhIGJhc2U2NCBsaW5lIG9mIGV2aWRlbmNlCg==
ABCDEF0123456789
`;
for (let seed=0; seed<100; seed++) {
  const result = humanizeForSol('You are the reviewer for this run.\n'+evidence, {seed});
  assert.ok(result.includes(evidence), `unfenced evidence changed, seed ${seed}`);
  assert.ok(result.includes("you're the reviewer"), 'role framing still natural');
}
console.log('100 seeds: raw code, base64 and hashes preserved; role framing retained');

let sourcePath = new URL('../orchestrate.mjs', import.meta.url);
if (!existsSync(sourcePath)) sourcePath = new URL('./orchestrate.mjs', import.meta.url);
const source = readFileSync(sourcePath, 'utf8');
const start = source.indexOf('  const fileArgs = (idx) =>');
const end = source.indexOf('  // Review fix (2026-09-15', start);
assert.ok(start > 0 && end > start);
const parse = new Function('argv', 'toContainerPath', 'openIdx', 'attachIdx', 'existsSync', 'statSync', 'console', 'process',
  source.slice(start, end) + '; return {openedFiles, attachedFiles};');
const args = ['topic', '--open', 'brief.md', '--attach', 'evidence.tar.gz', '--continue-session', 'session-id', '--engine', 'openai-sol'];
const fail = {exit(code) { throw new Error(`exit:${code}`); }};
const parsed = parse(args, x=>x, 1, 3, ()=>true, ()=>({isFile:()=>true}), {error(){}}, fail);
assert.deepEqual(parsed.attachedFiles, ['evidence.tar.gz']);
assert.deepEqual(parsed.openedFiles, ['brief.md', 'evidence.tar.gz']);
assert.throws(()=>parse(args, x=>x, 1, 3, ()=>false, ()=>({isFile:()=>true}), {error(){}}, fail), /exit:64/);
assert.throws(()=>parse(['--attach','a.txt','b.txt'], x=>x, -1, 0, ()=>true, ()=>({isFile:()=>true}), {error(){}}, fail), /exit:64/);
console.log('Attachment args stop at flags; missing/multiple files fail before dispatch');

const binaryStart = source.indexOf('      if (/\\.(?:tar');
const binaryEnd = source.indexOf('      const lines = c.split', binaryStart);
assert.ok(binaryStart > 0 && binaryEnd > binaryStart);
const preview = new Function('p', 'c', `const opened=[]; for (const item of [0]) {${source.slice(binaryStart,binaryEnd)} } return opened;`);
assert.ok(preview('evidence.tar.gz', 'binary\0bytes')[0].includes('Binary preview omitted'));
assert.equal(preview('evidence.mjs', 'return await f();').length, 0);
console.log('Binary archive previews omitted; text source previews retained');
