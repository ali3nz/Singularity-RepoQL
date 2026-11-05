// Shared core reconciliation. Both GUI variants require verified idempotent writes.
const key = m => JSON.stringify([m.role, m.content, m.recorded_at ?? m.timestamp]);

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
      if (incoming.length === 0) return rows;
      if (data.messages.length < 100 || offset + 100 >= data.total) return rows;
    }
    throw new Error("Conversation reconciliation page limit reached");
  };
  function missing(rows) {
    const counts = new Map();
    rows.forEach(row => counts.set(key(row), (counts.get(key(row)) ?? 0) + 1));
    return unit.messages.filter(message => {
      const k = key(message), count = counts.get(k) ?? 0;
      if (count) { counts.set(k, count - 1); return false; }
      return true;
    });
  }
  const before = missing(await query());
  for (let offset = 0; offset < before.length; offset += 100) {
    await request("/conversation/add", { ...scope, session_id: unit.session_id, task_id: unit.task_id, messages: before.slice(offset, offset + 100) });
  }
  if (missing(await query()).length) throw new Error("Capture persistence not verified");
  return { verified: true, written: before.length };
}
