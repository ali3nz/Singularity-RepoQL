// Opt-in execution of existing rust-authority compatibility operations.
// Each call independently computes a JavaScript reference and accepts native
// output only on exact parity. This module NEVER authorizes stages or writes.
import { spawnSync } from 'node:child_process';
import { isAbsolute, win32 } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const BIN_ENV = 'SINGULARITY_RUST_COMPAT_BIN';
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const ALLOWED_OPS = new Set(['run_health.derive', 'run_summary.build', 'worker.decision', 'gate.parse']);

export class RustCompatPolicyError extends Error {
  constructor(code) {
    super(`Rust compat policy: ${code}`);
    this.name = 'RustCompatPolicyError';
    this.code = code;
  }
}

export function rustCompatPolicyEnabled() {
  return Boolean(process.env[BIN_ENV]);
}

export function verifiedRustCompat(op, request, expected) {
  if (!rustCompatPolicyEnabled()) return expected;
  if (!ALLOWED_OPS.has(op)) throw new RustCompatPolicyError('UNSUPPORTED_OPERATION');
  const bin = process.env[BIN_ENV];
  if (bin.includes('\0') || (!isAbsolute(bin) && !win32.isAbsolute(bin))) {
    throw new RustCompatPolicyError('INVALID_BINARY_PATH');
  }
  let input;
  try { input = JSON.stringify({ op, ...request }); }
  catch { throw new RustCompatPolicyError('INVALID_REQUEST'); }
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) {
    throw new RustCompatPolicyError('REQUEST_TOO_LARGE');
  }
  const child = spawnSync(bin, ['compat'], {
    input,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 3500,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (child.error) throw new RustCompatPolicyError('NATIVE_UNAVAILABLE');
  if (child.status !== 0) throw new RustCompatPolicyError('NATIVE_REJECTED');
  if (Buffer.byteLength(child.stdout ?? '', 'utf8') > MAX_OUTPUT_BYTES) {
    throw new RustCompatPolicyError('RESPONSE_TOO_LARGE');
  }
  let result;
  try { result = JSON.parse(child.stdout); }
  catch { throw new RustCompatPolicyError('INVALID_NATIVE_RESPONSE'); }
  if (!isDeepStrictEqual(result, expected)) {
    throw new RustCompatPolicyError('NATIVE_REFERENCE_MISMATCH');
  }
  return result;
}
