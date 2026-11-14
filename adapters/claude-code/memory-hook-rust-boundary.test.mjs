// Tests the opt-in native capture boundary with a local executable fixture.
// The fixture is not Rust; compiled Rust parity is separately required.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runMemoryHook } from './memory-hook.mjs';

const fake = `#!/usr/bin/env node
(async () => {
const fs = require('node:fs');
const crypto = require('node:crypto');
const v=JSON.parse(fs.readFileSync(0,'utf8'));
const command=process.argv[2];

if(process.env.FAKE_HOOK_NATIVE_FAILURE==='1')process.exit(3);
let output;
if(command==='hook-redact'){
  const mod=await import(${JSON.stringify(pathToFileURL(resolve('adapters/claude-code/memory-hook.mjs')).href)});
  const text=mod.redactSecrets(v.text);
  output={ok:true,text:process.env.FAKE_HOOK_WRONG_REDACTION==='1'?v.text:text};
}else if(command==='hook-capture-id'){
  const hash=(input,n)=>crypto.createHash('sha256').update(input).digest('hex').slice(0,n);
  output={ok:true,taskId:'cc-'+hash(JSON.stringify(v.parts),16),sessionHash8:hash(v.sessionKey,8)};
  if(process.env.FAKE_HOOK_WRONG_ID==='1')output.taskId='cc-0000000000000000';
}else if(command==='reconcile-missing'){
  const mod=await import(${JSON.stringify(pathToFileURL(resolve('scripts/memory-reconcile-core.mjs')).href)});
  output={ok:true,totalMessages:v.messages.length,missingIndexes:mod.missingReconciliationIndexes(v.rows,v.messages)};
}else output={ok:false,code:'UNSUPPORTED'};
process.stdout.write(JSON.stringify(output));
})().catch(()=>process.exit(3));
`;

function memoryFixture() {
  const calls = [];
  const stored = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, body });
    let data;
    if (url.endsWith('/v3/conversation/query')) {
      const rows = stored.filter(r => r.task_id === body.task_id && r.agent_id === body.agent_id);
      data = { messages: rows, total: rows.length };
    } else if (url.endsWith('/v3/conversation/add')) {
      for (const m of body.messages) stored.push({ ...m, task_id: body.task_id, agent_id: body.agent_id });
      data = { accepted_ids: ['synthetic-id'] };
    } else throw new Error('unexpected endpoint');
    return new Response(JSON.stringify({ code: 0, data }), { status: 200 });
  };
  return { calls, stored, fetchImpl };
}
const redactPayload = 'The key sk-abcdef123456789 is synthetic. '.repeat(9);

test('opt-in native hook prepares safe lesson and stable ID without changing existing memory I/O',
  { skip: process.platform === 'win32' }, async () => {
  const before = process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN;
  const dir = mkdtempSync(join(tmpdir(), 'singularity-hook-rust-'));
  const binary = join(dir, 'fixture-bin');
  const config = join(dir, 'memory.json');
  writeFileSync(binary, fake); chmodSync(binary, 0o700);
  writeFileSync(config, JSON.stringify({ baseUrl: 'http://127.0.0.1:9000', userKey: 'test-key' }));
  const settings = { SINGULARITY_REPO_ROOT: dir, SINGULARITY_MEMORY_CONFIG: config };
  const payload = JSON.stringify({ agent_type: 'singularity-code-reviewer', session_id: 'capture-1', last_assistant_message: redactPayload });
  const core = memoryFixture();
  try {
    process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN = binary;
    const first = await runMemoryHook(['subagent-stop'], { env: settings, stdin: payload, fetchImpl: core.fetchImpl, now: () => '2026-11-12T01:00:00Z' });
    const second = await runMemoryHook(['subagent-stop'], { env: settings, stdin: payload, fetchImpl: core.fetchImpl, now: () => '2026-11-12T02:00:00Z' });
    assert.equal(first.exitCode, 0); assert.equal(second.exitCode, 0);
    assert.equal(core.stored.length, 1);
    assert.match(first.stderr.join(' '), /reconciled 1/);
    assert.match(second.stderr.join(' '), /reconciled 0/);
    assert.match(core.stored[0].task_id, /^cc-[0-9a-f]{16}$/);
    assert.ok(core.stored[0].content.includes('[REDACTED]'));
    assert.ok(!core.stored[0].content.includes('sk-abcdef123456789'));

    // Separate parent memory scope, single record per role, no external services.
    const transcript = join(dir, 'transcript.jsonl');
    writeFileSync(transcript, [
      { type: 'user', message: { role: 'user', content: 'Parent query token=abcdefgh12345' } },
      { type: 'assistant', message: { role: 'assistant', content: 'Parent reply secret=abcdefgh12345' } },
    ].map(JSON.stringify).join('\n'));
    const parent = await runMemoryHook(['conversation-turn'], { env: settings,
      stdin: JSON.stringify({ session_id: 'parent1', transcript_path: transcript }),
      fetchImpl: core.fetchImpl, now: () => '2026-11-12T02:00:00Z' });
    assert.match(parent.stderr.join(' '), /reconciled 2/);
    assert.equal(core.stored.length, 3);
    assert.ok(core.stored.slice(1).every(r => !r.content.includes('abcdefgh12345')));
    assert.ok(core.stored.slice(1).every(r => r.agent_id === 'claude-code-main'));

    for (const [toggle, message] of [
      ['FAKE_HOOK_WRONG_REDACTION', 'NATIVE_HOOK_REDACTION_MISMATCH'],
      ['FAKE_HOOK_WRONG_ID', 'NATIVE_HOOK_ID_MISMATCH'],
      ['FAKE_HOOK_NATIVE_FAILURE', 'INVALID_NATIVE_RESPONSE'],
    ]) {
      const baselineCount = core.calls.length;
      const storedCount = core.stored.length;
      process.env[toggle] = '1';
      try {
        const result = await runMemoryHook(['subagent-stop'], { env: settings,
          stdin: JSON.stringify({ agent_type: 'singularity-code-reviewer', session_id: `bad-${toggle}`, last_assistant_message: redactPayload }),
          fetchImpl: core.fetchImpl, now: () => '2026-11-12T03:00:00Z' });
        assert.equal(result.exitCode, 0);
        assert.match(result.stderr.join(' '), new RegExp(message));
        assert.ok(!result.stderr.join(' ').includes('sk-abcdef123456789'));
        assert.equal(core.calls.length, baselineCount, 'rejected native result must not call MemoryCore');
        assert.equal(core.stored.length, storedCount, 'rejected native result must not write');
      } finally { delete process.env[toggle]; }
    }
  } finally {
    if (before === undefined) delete process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN;
    else process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN = before;
    for (const key of ['FAKE_HOOK_WRONG_REDACTION','FAKE_HOOK_WRONG_ID','FAKE_HOOK_NATIVE_FAILURE']) delete process.env[key];
    rmSync(dir, { recursive: true, force: true });
  }
});
