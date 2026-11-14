// Opt-in native MemoryCore transports. Read operations are dual-read and
// checked against the legacy client. The separate write executable performs
// one write only; caller-controlled reconciliation and readback remain required.
// Credentials never travel on argv or stdin.
import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { isAbsolute, dirname, extname, parse } from 'node:path';
import { lstatSync } from 'node:fs';

const MAX_STDIN_BYTES = 128 * 1024;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const ALLOWED_OPERATIONS = new Set(['resolveBlocks', 'search', 'skillList', 'v3Read']);
const CONFIG_ENV = [
  'MEMORYCORE_HUB_URL', 'MEMORYCORE_KEY_FILE', 'MEMORYCORE_SERVICE_ID',
  'MEMORYCORE_TIMEOUT_MS', 'MEMORYCORE_L0_LIMIT', 'MEMORYCORE_L1_LIMIT',
  'MEMORYCORE_BUDGET_BYTES', 'MEMORYCORE_SKILL_TOP_N',
  'MEMORYCORE_V3_CONFIG_FILE', 'GHOST_MC_URL', 'GHOST_MC_SERVICE_KEY',
  'GHOST_MC_USER_KEY', 'GHOST_MC_SERVICE_ID',
];

export function nativeWriterEnabled() {
  return Object.hasOwn(process.env, 'SINGULARITY_RUST_MEMORYCORE_WRITER_BIN') &&
    process.env.SINGULARITY_RUST_MEMORYCORE_WRITER_BIN !== '';
}

export function nativeReaderEnabled() {
  return Object.hasOwn(process.env, 'SINGULARITY_RUST_MEMORYCORE_READER_BIN') &&
    process.env.SINGULARITY_RUST_MEMORYCORE_READER_BIN !== '';
}

function trustedExecutable(binary) {
  if (!binary || !isAbsolute(binary)) return false;
  if (process.platform === 'win32' && (extname(binary).toLowerCase() !== '.exe' ||
      !/^[A-Za-z]:[\\/]/.test(binary))) return false; // No UNC/device or relative binary
  try {
    const stat = lstatSync(binary);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    // A reparse/symlink parent could swap the binary after path validation.
    // A Windows release still requires the native upgrade ownership checks.
    for (let dir = dirname(binary); dir !== parse(dir).root; dir = dirname(dir)) {
      if (lstatSync(dir).isSymbolicLink()) return false;
    }
    return true;
  } catch { return false; }
}

async function invokeNativeMemorycore(binary, operation, input, config) {
  if (!trustedExecutable(binary)) throw new Error('NATIVE_MEMORYCORE_EXECUTABLE_INVALID');
  const data = JSON.stringify({ operation, ...input });
  if (Buffer.byteLength(data, 'utf8') > MAX_STDIN_BYTES) throw new Error('NATIVE_MEMORYCORE_INPUT_TOO_LARGE');
  const env = {};
  for (const k of ['PATH', 'Path', 'SystemRoot', 'WINDIR', ...CONFIG_ENV]) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  for (const k of CONFIG_ENV) {
    if (config[k] !== undefined) env[k] = String(config[k]);
  }
  const timeout = Math.min(65000, Math.max(3000, 2 * Number(env.MEMORYCORE_TIMEOUT_MS || 6000) + 3000));
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const chunks = [];
    let count = 0;
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('NATIVE_MEMORYCORE_TIMEOUT'));
    }, timeout);
    child.once('error', () => finish(new Error('NATIVE_MEMORYCORE_SPAWN_FAILED')));
    child.stdout.on('data', chunk => {
      count += chunk.length;
      if (count > MAX_STDOUT_BYTES) {
        child.kill();
        return finish(new Error('NATIVE_MEMORYCORE_OUTPUT_TOO_LARGE'));
      }
      chunks.push(chunk);
    });
    child.once('close', code => {
      if (code !== 0) return finish(new Error('NATIVE_MEMORYCORE_NONZERO_EXIT'));
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.ok !== 'boolean') {
          throw new Error('invalid response');
        }
        finish(null, value);
      } catch { finish(new Error('NATIVE_MEMORYCORE_INVALID_JSON')); }
    });
    child.stdin.on('error', () => {}); // Child exit is handled by close/error.
    child.stdin.end(data);
  });
}

export async function requestNativeMemorycoreReader(operation, input, { config = {} } = {}) {
  if (!ALLOWED_OPERATIONS.has(operation)) throw new Error('NATIVE_MEMORYCORE_OPERATION_BLOCKED');
  return invokeNativeMemorycore(process.env.SINGULARITY_RUST_MEMORYCORE_READER_BIN, operation, input, config);
}

// A write can be accepted only once; do not call the reference HTTP transport
// after executing it, and never retry after an ambiguous transport failure.
export async function requestNativeMemorycoreWriter(path, body, configFile) {
  if (path !== '/v3/conversation/add') throw new Error('NATIVE_MEMORYCORE_WRITE_PATH_BLOCKED');
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      !['team_id','user_id','agent_id','session_id','task_id'].every(key =>
        typeof body[key] === 'string' && body[key].trim() && Buffer.byteLength(body[key],'utf8') <= 256) ||
      !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 100 ||
      body.messages.some(m => !m || typeof m !== 'object' || Array.isArray(m) ||
        !['assistant','user','system','tool'].includes(m.role) || typeof m.content !== 'string')) {
    throw new Error('NATIVE_MEMORYCORE_WRITE_BODY_INVALID');
  }
  const result = await invokeNativeMemorycore(process.env.SINGULARITY_RUST_MEMORYCORE_WRITER_BIN,
    'v3Write', { path, body }, { MEMORYCORE_V3_CONFIG_FILE: configFile });
  if (!result.ok || !result.payload || typeof result.payload !== 'object' ||
      Array.isArray(result.payload) || result.payload.code !== 0) {
    throw new Error('NATIVE_MEMORYCORE_WRITE_UNCONFIRMED');
  }
  return result.payload;
}

export async function guardedMemorycoreRead(operation, input, calculateLegacy, options = {}) {
  if (!nativeReaderEnabled()) return calculateLegacy();
  // Neither a failed reference read nor a disagreement authorizes a memory hit.
  // This is intentionally separate from the normal legacy fail-open retrieval.
  try {
    const legacy = await calculateLegacy();
    const native = await requestNativeMemorycoreReader(operation, input, options);
    if (!isDeepStrictEqual(native, legacy)) return { ok: false, code: 'NATIVE_MEMORYCORE_PARITY_FAILED' };
    return native;
  } catch { return { ok: false, code: 'NATIVE_MEMORYCORE_REJECTED' }; }
}

// Only whitelisted read-only MemoryCore v3 methods may be delegated. Every
// output is checked against the authenticated caller's actual v3 read.
export async function guardedMemorycoreV3Read(path, body, reference, configFile) {
  if (!nativeReaderEnabled()) return reference;
  if (!['/v3/conversation/search', '/v3/atomic/search',
        '/v3/conversation/query', '/v3/atomic/query',
        '/v3/conversation/count', '/v3/atomic/count'].includes(path)) {
    return reference; // Never delegate a memory write or mutation to this CLI.
  }
  const native = await requestNativeMemorycoreReader('v3Read',
    { path, body }, { config: { MEMORYCORE_V3_CONFIG_FILE: configFile } });
  if (!native.ok || !isDeepStrictEqual(native.payload, reference)) {
    throw new Error('NATIVE_MEMORYCORE_V3_PARITY_FAILED');
  }
  return native.payload;
}
