// Explicit opt-in differential adapter for kit/lib/worker-completion.mjs.
// Reads only; NEVER substitutes a Rust decision for the production JS gate.
// Accepts the actual JS module exports by injection so this workbench does not
// duplicate or silently load a stale copy of the authoritative source.
import { spawnSync } from 'node:child_process';

function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, sort(value[k])]));
  }
  return value;
}

export function evaluateWorkerShadow(texts, jsModule, { rustBinary = null, timeoutMs = 2500 } = {}) {
  if (typeof jsModule?.extractWorkerCompletion !== 'function' ||
      typeof jsModule?.completionGateDecision !== 'function') {
    throw Error('current JavaScript worker-completion exports are required');
  }
  const extraction = jsModule.extractWorkerCompletion(texts);
  const decision = jsModule.completionGateDecision(extraction);
  const primary = { extraction, decision };
  // Most important invariant: independent of Rust success, failure, mismatch,
  // timeout or absence, the JS gate remains the sole result.
  if (!rustBinary) return { primary, shadow: { status: 'disabled' } };
  try {
    const cases = [
      { op: 'worker.extract', texts },
      { op: 'worker.decision', extraction },
    ];
    const input = cases.map(x => JSON.stringify(x)).join('\n') + '\n';
    if (Buffer.byteLength(input, 'utf8') > 128 * 1024) {
      return { primary, shadow: { status: 'skipped', reason: 'input-over-limit' } };
    }
    const child = spawnSync(rustBinary, ['compat-lines'], {
      input, timeout: timeoutMs, maxBuffer: 128 * 1024, encoding: 'utf8',
      shell: false, windowsHide: true,
    });
    if (child.error || child.status !== 0) {
      return { primary, shadow: { status: 'unavailable' } };
    }
    const lines = child.stdout.trim().split('\n');
    if (lines.length !== 2) return { primary, shadow: { status: 'invalid-protocol' } };
    const outputs = lines.map(x => JSON.parse(x));
    const matches = JSON.stringify(sort(outputs)) === JSON.stringify(sort([extraction, decision]));
    return { primary, shadow: { status: matches ? 'match' : 'mismatch' } };
  } catch {
    return { primary, shadow: { status: 'unavailable' } };
  }
}
