// A fixed, hash-pinned prompt transform for staged native MemoryCore source.
// No runtime configuration, memory data, process lifecycle or network access.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROMPT_TARGET = 'src/core/prompts/l1-extraction.ts';
const DEFAULT_OVERLAY = fileURLToPath(new URL('../memory/patches/core-v2.0.2-l1prompt/', import.meta.url));
const PINNED_COMMIT = '99a1a2c251741658917e3fa700bf8e337ad15a5f';
const lf = text => text.replace(/\r\n/g, '\n');
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
function fail(code) { const error = new Error(code); error.code = code; throw error; }

// Pure so fixtures need not redistribute the pinned upstream engine.
export function verifyPromptOverlay(current, overlay, manifest) {
  if (manifest?.schema !== 'singularity-l1-prompt-overlay/v1' ||
      manifest.commit !== PINNED_COMMIT || manifest.target !== PROMPT_TARGET ||
      manifest.normalization !== 'CRLF-to-LF' ||
      !/^[a-f0-9]{64}$/.test(manifest.baseSha256 ?? '') ||
      !/^[a-f0-9]{64}$/.test(manifest.overlaySha256 ?? '')) fail('PROMPT_MANIFEST_INVALID');
  const text = lf(overlay);
  if (hash(text) !== manifest.overlaySha256) fail('PROMPT_OVERLAY_SHA256_MISMATCH');
  const before = hash(lf(current));
  if (before !== manifest.baseSha256 && before !== manifest.overlaySha256) fail('PROMPT_PREIMAGE_SHA256_MISMATCH');
  return { text, sha256: manifest.overlaySha256, alreadyApplied: before === manifest.overlaySha256 };
}

function plainPath(path) {
  let cursor = resolve(path);
  while (true) {
    if (lstatSync(cursor).isSymbolicLink()) fail('PROMPT_REPARSE_PATH');
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

// overlayDirectory is a trusted in-process fixture seam, never a config/CLI
// setting. Production prepare always uses the fixed repository-relative asset.
export function applyMemoryPromptOverlay(buildDir, { overlayDirectory = DEFAULT_OVERLAY } = {}) {
  if (!isAbsolute(buildDir)) fail('PROMPT_BUILD_ROOT_MUST_BE_ABSOLUTE');
  const target = join(buildDir, ...PROMPT_TARGET.split('/'));
  plainPath(target);
  const info = lstatSync(target);
  if (!info.isFile()) fail('PROMPT_TARGET_NOT_FILE');
  const current = readFileSync(target, 'utf8');
  const manifest = JSON.parse(readFileSync(join(overlayDirectory, 'manifest.json'), 'utf8'));
  const overlay = readFileSync(join(overlayDirectory, 'l1-extraction.override.ts'), 'utf8');
  const verified = verifyPromptOverlay(current, overlay, manifest);
  if (current === verified.text) return { sha256: verified.sha256, changed: false };
  const temporary = join(dirname(target), `.l1-extraction.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, 'wx', info.mode & 0o777);
    writeFileSync(fd, verified.text, 'utf8');
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    plainPath(target);
    if (readFileSync(target, 'utf8') !== current) fail('PROMPT_TARGET_CHANGED');
    renameSync(temporary, target);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { sha256: verified.sha256, changed: true };
}
