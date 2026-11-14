import { nativeMemoryPolicyEnabled, nativeMissingReconciliationIndexes, NativeMemoryPolicyError } from "../harness/kit/lib/native-memory-policy.mjs";
// Shared core reconciliation. Both GUI variants require verified idempotent writes.
const key = m => JSON.stringify([m.role, m.content, m.recorded_at ?? m.timestamp]);

// The established reference selector: multiset matching preserves repeated
// messages, their original order and the recorded_at ?? timestamp preference.
export function missingReconciliationIndexes(rows, messages) {
  const counts = new Map();
  rows.forEach(row => counts.set(key(row), (counts.get(key(row)) ?? 0) + 1));
  const missing = [];
  messages.forEach((message, index) => {
    const k = key(message), count = counts.get(k) ?? 0;
    if (count) counts.set(k, count - 1);
    else missing.push(index);
  });
  return missing;
}

/** Read/reconcile/write/verify: confirm what already exists before writing. */
export async function reconcileMemoryUnit(request, scope, unit) {
  const query = async () => {
    const rows = [];
    // Query by task_id server-side (verified against the shipped Memory Core
    // image: /conversation/query accepts task_id and echoes it on each row).
    // Rows are still filtered by task_id defensively so a deployment that
    // pads responses with other rows can never cause a false "already stored".
    for (let offset = 0; offset < 10000; offset += 100) {
      const data = await request("/conversation/query", { ...scope, session_id: unit.session_id, task_id: unit.task_id, offset, limit: 100 });
      const incoming = data.messages.filter(row => row.task_id === undefined || row.task_id === null || row.task_id === unit.task_id);
      rows.push(...incoming.filter(row => row.task_id === unit.task_id));
      // A full page can contain only other tasks while later pages contain
      // this task. Do not stop on the filtered page: that would duplicate
      // the later task's messages during replay.
      if (data.messages.length === 0) return rows;
      if (data.messages.length < 100 || offset + 100 >= data.total) return rows;
    }
    throw new Error("Conversation reconciliation page limit reached");
  };
  function missing(rows) {
    const expected = missingReconciliationIndexes(rows, unit.messages);
    if (!nativeMemoryPolicyEnabled()) return expected.map(i => unit.messages[i]);
    // Compare all indexes against the authoritative JavaScript contract.
    // A native disagreement must never skip a pending write or certify one.
    const actual = nativeMissingReconciliationIndexes(rows, unit.messages);
    if (actual.length !== expected.length || actual.some((index, i) => index !== expected[i])) {
      throw new NativeMemoryPolicyError("NATIVE_RECONCILIATION_MISMATCH");
    }
    return actual.map(i => unit.messages[i]);
  }

  const before = missing(await query());
  for (let offset = 0; offset < before.length; offset += 100) {
    await request("/conversation/add", { ...scope, session_id: unit.session_id, task_id: unit.task_id, messages: before.slice(offset, offset + 100) });
  }
  if (missing(await query()).length) throw new Error("Capture persistence not verified");
  return { verified: true, written: before.length };
}
