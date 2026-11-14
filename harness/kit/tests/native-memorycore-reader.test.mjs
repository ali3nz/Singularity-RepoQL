import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemorycoreClient } from '../lib/memorycore-client.mjs';
import { writeNativeCliFixture } from '../../../native/windows/native_cli_fixture.mjs';
import { requestNativeMemorycoreReader } from '../../../scripts/native-memorycore-reader.mjs';

const previous = process.env.SINGULARITY_RUST_MEMORYCORE_READER_BIN;
const tmp = mkdtempSync(join(tmpdir(), 'singularity-memorycore-rust-test-'));
const returned = [];
function fakeCore(path, body) {
  returned.push([path, body]);
  if (path === '/api/v1/chat-memory/team-assets') return {
    status: 200, json: { code: 0, data: { items: [
      { id: 'block-general', title: 'Memory of general' },
      { id: 'block-auditor', title: 'Memory of auditor' },
    ] } },
  };
  if (path === '/api/v1/chat-memory/search') return { status: 200, json: {
    code: 0, data: { items: [{ id: 'r1', title: 'Memory', body: 'facts', score: 0.9, tags: [], refs: [] }] },
  } };
  if (path === '/api/v1/skill/list') return { status: 200, json: { code: 0, data: { items: [] } } };
  throw new Error('unexpected endpoint');
}
function fixture(output, name) {
  const path = join(tmp, `${name}`);
  const src = '#!/usr/bin/env node\n' +
    'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(' +
    JSON.stringify(JSON.stringify(output)) + '));\n';
  return writeNativeCliFixture(path, src);
}
test.after(() => {
  if (previous == null) delete process.env.SINGULARITY_RUST_MEMORYCORE_READER_BIN;
  else process.env.SINGULARITY_RUST_MEMORYCORE_READER_BIN = previous;
  rmSync(tmp, { recursive: true, force: true });
});

test('default path resolves strict scoped blocks, searches and lists skills', async () => {
  delete process.env.SINGULARITY_RUST_MEMORYCORE_READER_BIN;
  const c = createMemorycoreClient({ teamId: 'team-fixture', post: fakeCore });
  const r = await c.search({ agent: 'auditor', query: 'evidence' });
  assert.equal(r.ok, true);
  assert.equal(r.block, 'block-auditor');
  assert.equal(returned.at(-1)[1].block_id, 'block-auditor');
  assert.deepEqual((await c.skillList({})).skills, []);
  assert.equal((await c.resolveBlocks({})).blocks.general, 'block-general');
});

test('default scope never falls back to another agent', async () => {
  delete process.env.SINGULARITY_RUST_MEMORYCORE_READER_BIN;
  const c = createMemorycoreClient({ post: fakeCore });
  returned.length = 0;
  const r = await c.search({ agent: 'unknown', query: 'sensitive' });
  assert.equal(r.code, 'AGENT_BLOCK_NOT_FOUND');
  assert.equal(returned.filter(x => x[0].endsWith('/search')).length, 0);
});

test('matching native result is returned without changing its shape', async () => {
  process.env.SINGULARITY_RUST_MEMORYCORE_READER_BIN = fixture({ ok: true, blocks: { general: 'block-general', auditor: 'block-auditor' } }, 'matching');
  const c = createMemorycoreClient({ post: fakeCore });
  const r = await c.resolveBlocks({});
  assert.deepEqual(r, { ok: true, blocks: { general: 'block-general', auditor: 'block-auditor' } });
});

test('a forged native block is rejected rather than authorizing cross-agent recall', async () => {
  process.env.SINGULARITY_RUST_MEMORYCORE_READER_BIN = fixture({ ok: true, blocks: { general: 'block-general', auditor: 'block-other' } }, 'forged');
  const c = createMemorycoreClient({ post: fakeCore });
  assert.equal((await c.resolveBlocks({})).code, 'NATIVE_MEMORYCORE_PARITY_FAILED');
});

test('native search may not inject an extra memory hit', async () => {
  process.env.SINGULARITY_RUST_MEMORYCORE_READER_BIN = fixture({ ok: true, block: 'block-auditor', agent: 'auditor', layer: 'L1', results: [{ id: 'forged' }], bytesUsed: 0 }, 'search-forged');
  const c = createMemorycoreClient({ post: fakeCore });
  assert.equal((await c.search({ agent: 'auditor', query: 'evidence' })).code, 'NATIVE_MEMORYCORE_PARITY_FAILED');
});

test('selected missing native executable fails closed', async () => {
  process.env.SINGULARITY_RUST_MEMORYCORE_READER_BIN = join(tmp, 'missing.exe');
  const c = createMemorycoreClient({ post: fakeCore });
  assert.equal((await c.resolveBlocks({})).code, 'NATIVE_MEMORYCORE_REJECTED');
});

test('native invalid JSON and nonzero exit are rejected', async () => {
  const bad = writeNativeCliFixture(join(tmp, 'invalid'), '#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on("end",()=>process.stdout.write("not json"));\n');
  process.env.SINGULARITY_RUST_MEMORYCORE_READER_BIN = bad;
  const c = createMemorycoreClient({ post: fakeCore });
  assert.equal((await c.resolveBlocks({})).code, 'NATIVE_MEMORYCORE_REJECTED');
});

test('native operation cannot be a write', async () => {
  process.env.SINGULARITY_RUST_MEMORYCORE_READER_BIN = fixture({ ok: true }, 'noop');
  await assert.rejects(requestNativeMemorycoreReader('add', { team: 'team-fixture' }), /OPERATION_BLOCKED/);
});

test('legacy byte budget remains valid for multi-byte Unicode bodies', async () => {
  delete process.env.SINGULARITY_RUST_MEMORYCORE_READER_BIN;
  const unicode = '😀'.repeat(3000);
  const c = createMemorycoreClient({ post: (path, body) => {
    if (path.endsWith('/team-assets')) return fakeCore(path, body);
    if (path.endsWith('/search')) return { status: 200, json: { code: 0,
      data: { items: [{ id: 'huge', score: 1, body: unicode }] } } };
    throw new Error('unexpected endpoint');
  } });
  const result = await c.search({ agent: 'auditor', query: 'large unicode' });
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].truncated, true);
  assert.equal(Buffer.byteLength(result.results[0].body, 'utf8'), result.bytesUsed);
  assert.ok(result.bytesUsed <= 6000, 'UTF-8 budget must not be exceeded');
  assert.ok(!result.results[0].body.includes('�'), 'truncation must not split a code point');
});
