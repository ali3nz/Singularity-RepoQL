// Read-only Windows MemoryCore task recovery. This consumes the existing capture
// ledger; it does not create task links, bypass Kanzo, or register a Ghost service.
// An authorized native caller must verify Kanzo ownership and provide a registered
// MemoryCore identity. Returned memory is advisory, never source authority.
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { nativeMemoryPolicyEnabled, nativeLinkedCaptureUnits, nativeTaskRecoverySnapshot } from '../../harness/kit/lib/native-memory-policy.mjs';

const clip = (text, max = 360) => String(text ?? '').slice(0, max);
const validTask = (id) => /^(?:task-[a-z0-9]{6,40}|kanzo:[1-9][0-9]{0,10})$/.test(String(id ?? ''));
const validUnit = (id) => /^oc:[A-Za-z0-9_-]+:\d+-\d+$/.test(String(id ?? ''));
const validIdentity = (i) => !!(i && ['team_id', 'user_id', 'agent_id'].every(k => typeof i[k] === 'string' && i[k].trim()));

export function linkedCaptureUnits(ledger, taskId, agent) {
  if (!validTask(taskId) || typeof agent !== 'string' || !agent.trim()) return [];
  const units = ledger?.units;
  if (!units || typeof units !== 'object' || Array.isArray(units)) return [];
  const selected = Object.entries(units)
    .filter(([id, u]) => validUnit(id) && u?.status === 'reconciled' &&
      u.task_id_source === 'binding' && u.task_id === taskId && u.agent === agent &&
      typeof u.session_id === 'string' && u.session_id.length > 0 &&
      Number.isInteger(u.first_seq) && Number.isInteger(u.last_seq) && u.first_seq <= u.last_seq)
    .map(([unitId, u]) => ({ unitId, sessionId: u.session_id, firstSeq: u.first_seq,
      lastSeq: u.last_seq, capturedAt: u.at ?? null }))
    .sort((a, b) => String(a.capturedAt ?? '').localeCompare(String(b.capturedAt ?? '')) ||
      a.sessionId.localeCompare(b.sessionId) || a.firstSeq - b.firstSeq);
  if (nativeMemoryPolicyEnabled()) {
    // Keep the ledger contract independent of native execution. A native
    // selector must not invent a bound session or include another task.
    const native = nativeLinkedCaptureUnits(ledger, taskId, agent);
    if (!isDeepStrictEqual(native, selected)) {
      throw new Error('RUST_TASK_LINKS_MISMATCH');
    }
    return native; // selected, compared native result is now the opt-in owner
  }
  return selected;
}

const rawRows = (response, layer) => layer === 'L1'
  ? (response?.data?.atoms ?? response?.data?.items ?? response?.data?.memories ?? [])
  : (response?.data?.messages ?? response?.data?.items ?? []);

export async function recoverBoundTask({ ledgerPath, taskId, agent, identity, query, verifyTask,
    core, maxUnits = 30, l1Limit = 5, l0Limit = 3 } = {}) {
  if (!validTask(taskId) || !validIdentity(identity) || typeof agent !== 'string' || !agent.trim() ||
      typeof query !== 'string' || !query.trim() || query.length > 300 ||
      typeof verifyTask !== 'function' || typeof core !== 'function') {
    return { ok: false, code: 'INVALID_OR_UNAUTHORIZED_REQUEST', refs: [] };
  }
  let verified = false;
  try { verified = await verifyTask({ taskId, agent, identity }) === true; } catch { /* fail closed */ }
  if (!verified) return { ok: false, code: 'KANZO_AUTHORIZATION_NOT_VERIFIED', refs: [] };
  let ledger;
  try { ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')); }
  catch { return { ok: false, code: 'CAPTURE_LEDGER_UNAVAILABLE', refs: [] }; }
  let units;
  try { units = linkedCaptureUnits(ledger, taskId, agent); }
  catch { return { ok: false, code: 'RUST_TASK_LINKS_UNVERIFIED', refs: [] }; }
  if (!units.length) return { ok: false, code: 'NO_TASK_LINKED_EVIDENCE', refs: [] };
  if (units.length > maxUnits) return { ok: false, code: 'TASK_UNIT_BUDGET_EXCEEDED', refs: [] };
  const knownSessions = new Set(units.map(u => u.sessionId));
  const refs = [];
  const omitted = [];
  const verifiedResponses = []; // snapshots from the existing task-scoped transport
  for (const [layer, endpoint, limit] of [['L1', '/v3/atomic/search', l1Limit], ['L0', '/v3/conversation/search', l0Limit]]) {
    const topK = Math.max(1, Math.min(10, Number.isFinite(limit) ? Math.floor(limit) : 3));
    let response;
    try { response = await core(endpoint, { ...identity, query, task_id: taskId, limit: topK }); }
    catch { return { ok: false, code: 'MEMORYCORE_RECALL_FAILED', refs: [] }; }
    if (!response || response.error || (response.code !== undefined && response.code !== 0) ||
        !Array.isArray(rawRows(response, layer))) {
      return { ok: false, code: 'MEMORYCORE_RECALL_FAILED', refs: [] };
    }
    verifiedResponses.push(response);
    const seen = new Set();
    for (const row of rawRows(response, layer).slice(0, topK)) {
      if (!row || !row.id || row.task_id !== taskId ||
          (row.session_id != null && !knownSessions.has(row.session_id)) ||
          ['team_id', 'user_id', 'agent_id'].some(k => row[k] != null && row[k] !== identity[k])) {
        omitted.push({ layer, reason: 'task_or_identity_mismatch' });
        continue;
      }
      if (seen.has(String(row.id))) continue;
      seen.add(String(row.id));
      refs.push({ layer, id: String(row.id), taskId, sessionId: row.session_id ?? null,
        timestamp: row.timestamp ?? row.recorded_at ?? row.created_at ?? null,
        text: clip(row.content ?? row.body ?? '', 360),
        ...(row.superseded_by ? { state: 'superseded' } : row.supersedes ? { state: 'supersedes' } : {}) });
    }
  }
  // Retrieval is first bounded by the engine; order only the selected window.
  refs.sort((a, b) => String(a.timestamp ?? '').localeCompare(String(b.timestamp ?? '')) || a.id.localeCompare(b.id));
  const result = { ok: refs.length > 0, code: refs.length ? 'TASK_EVIDENCE_RECOVERED' : 'NO_TASK_LINKED_EVIDENCE',
    taskId, units, refs, omitted, advisory: true };
  if (!nativeMemoryPolicyEnabled()) return result;
  // The native process gets only the already-authorized task's capture units,
  // not unrelated ledger records. Both MemoryCore replies have already passed
  // the JavaScript checks. No native error is allowed to widen access or fall
  // back to an unverified result.
  const verifiedLedger = { units: Object.fromEntries(units.map(({ unitId }) => [unitId, ledger.units[unitId]])) };
  try {
    const native = nativeTaskRecoverySnapshot({
      ledger: verifiedLedger, taskId, agent, identity, query,
      l1Response: verifiedResponses[0], l0Response: verifiedResponses[1],
      maxUnits, l1Limit, l0Limit,
    });
    if (!isDeepStrictEqual(native, result)) {
      return { ok: false, code: 'RUST_TASK_RECOVERY_MISMATCH', refs: [] };
    }
    return native; // only verified native data is returned when opted in
  } catch {
    return { ok: false, code: 'RUST_TASK_RECOVERY_UNVERIFIED', refs: [] };
  }
}
