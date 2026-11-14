import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyMemoryPromptOverlay, PROMPT_TARGET, verifyPromptOverlay } from './native-memory-prompt.mjs';
const base = 'export const prompt = `before\ncontract`;\n';
const overlay = 'export const prompt = `decision; evidence; open items\nJSON array`;\n';
const hash = value => createHash('sha256').update(value).digest('hex');
const manifest = { schema: 'singularity-l1-prompt-overlay/v1', commit: '99a1a2c251741658917e3fa700bf8e337ad15a5f', target: PROMPT_TARGET, normalization: 'CRLF-to-LF', baseSha256: hash(base), overlaySha256: hash(overlay) };
function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'l1-prompt-'));
  const build = join(root, 'build'), assets = join(root, 'assets'), target = join(build, PROMPT_TARGET);
  mkdirSync(dirname(target), { recursive: true }); mkdirSync(assets);
  writeFileSync(target, base);
  writeFileSync(join(assets, 'l1-extraction.override.ts'), overlay);
  writeFileSync(join(assets, 'manifest.json'), JSON.stringify(manifest));
  try { run({ root, build, assets, target }); } finally { rmSync(root, { recursive: true, force: true }); }
}
for (const newline of ['LF', 'CRLF']) test(`pinned ${newline} preimage and overlay become the same LF prompt`, () => {
  fixture(({ build, assets, target }) => {
    const convert = text => newline === 'CRLF' ? text.replace(/\n/g, '\r\n') : text;
    writeFileSync(target, convert(base)); writeFileSync(join(assets, 'l1-extraction.override.ts'), convert(overlay));
    assert.deepEqual(applyMemoryPromptOverlay(build, { overlayDirectory: assets }), { sha256: hash(overlay), changed: true });
    assert.equal(readFileSync(target, 'utf8'), overlay);
    assert.deepEqual(applyMemoryPromptOverlay(build, { overlayDirectory: assets }), { sha256: hash(overlay), changed: false });
    assert.deepEqual(readdirSync(dirname(target)), ['l1-extraction.ts']);
  });
});
test('already-applied CRLF overlay is normalized without changing its meaning', () => {
  fixture(({ build, assets, target }) => {
    writeFileSync(target, overlay.replace(/\n/g, '\r\n'));
    assert.equal(applyMemoryPromptOverlay(build, { overlayDirectory: assets }).changed, true);
    assert.equal(readFileSync(target, 'utf8'), overlay);
  });
});
test('unknown target or tampered overlay fails without writing', () => {
  fixture(({ build, assets, target }) => {
    writeFileSync(target, 'foreign prompt');
    assert.throws(() => applyMemoryPromptOverlay(build, { overlayDirectory: assets }), /PROMPT_PREIMAGE_SHA256_MISMATCH/);
    assert.equal(readFileSync(target, 'utf8'), 'foreign prompt');
    writeFileSync(target, base); writeFileSync(join(assets, 'l1-extraction.override.ts'), overlay + 'tampered');
    assert.throws(() => applyMemoryPromptOverlay(build, { overlayDirectory: assets }), /PROMPT_OVERLAY_SHA256_MISMATCH/);
    assert.equal(readFileSync(target, 'utf8'), base);
    assert.deepEqual(readdirSync(dirname(target)), ['l1-extraction.ts']);
  });
});
test('manifest cannot redirect the fixed prompt target or normalization', () => {
  for (const patch of [{ target: '../foreign.ts' }, { target: '/foreign.ts' }, { normalization: 'none' }, { commit: 'unreviewed' }]) {
    assert.throws(() => verifyPromptOverlay(base, overlay, { ...manifest, ...patch }), /PROMPT_MANIFEST_INVALID/);
  }
  assert.throws(() => applyMemoryPromptOverlay('relative'), /PROMPT_BUILD_ROOT_MUST_BE_ABSOLUTE/);
});
test('symlinked targets are refused and foreign files stay unchanged', t => {
  fixture(({ root, build, assets, target }) => {
    const foreign = join(root, 'foreign.ts'); writeFileSync(foreign, base); rmSync(target);
    try { symlinkSync(foreign, target, 'file'); } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip('symlink creation not permitted'); return; } throw error;
    }
    assert.throws(() => applyMemoryPromptOverlay(build, { overlayDirectory: assets }), /PROMPT_REPARSE_PATH/);
    assert.equal(readFileSync(foreign, 'utf8'), base); assert.equal(existsSync(foreign), true);
  });
});
test('shipped manifest pins both real sources, and both prompt modes retain engineering/array contracts', () => {
  const dir = new URL('../memory/patches/core-v2.0.2-l1prompt/', import.meta.url);
  const m = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8'));
  const body = readFileSync(new URL('l1-extraction.override.ts', dir), 'utf8');
  assert.equal(m.baseSha256, '4a443a170a5c6d754c8212728a2fa23b1d1f647d49f960b7e10b6a6cc5761816');
  assert.equal(m.overlaySha256, '89ba06ece0647f737734c34e022a4e5c1425b505739408d97d0dc39f4ba19660');
  assert.equal(verifyPromptOverlay(body, body, m).alreadyApplied, true);
  assert.equal(body.split('English form (use it when the output language is English)').length - 1, 2);
  assert.equal(body.split('即使整段对话只有一个情境').length - 1, 2);
});
