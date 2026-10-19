import { createHash } from "node:crypto";

// Sessions are captured only when their directory sits inside one of the
// configured product roots. Default: the OpenChamber home directory, which
// covers the default project and workspaces/. Override with
// SINGULARITY_MEMORY_ROOTS (comma-separated absolute prefixes); blank or
// non-absolute entries are ignored and an empty result falls back to the
// default.
const DEFAULT_MEMORY_ROOTS = ["/home/openchamber"];

/** Resolve the configured capture roots at call time (tests vary the env). */
export function memoryRoots(env = process.env) {
  const configured = String(env.SINGULARITY_MEMORY_ROOTS ?? "")
    .split(",")
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => part.replace(/\/+$/, ""))
    .filter(part => part.startsWith("/") && part !== "/");
  return configured.length > 0 ? configured : DEFAULT_MEMORY_ROOTS;
}

/** True when the directory lies inside one of the roots (whole segments). */
export function withinMemoryRoots(directory, roots = memoryRoots()) {
  if (typeof directory !== "string" || !directory.startsWith("/")) return false;
  return roots.some(root => directory === root || directory.startsWith(root + "/"));
}

export function scopeForSession(session, agent, userID = "pilot-operator") {
  const directory = session?.location?.directory;
  if (!withinMemoryRoots(directory)) throw new Error("Outside product workspace");
  if (!agent || typeof agent !== "string") throw new Error("Missing agent attribution");
  const hash = createHash("sha256").update(JSON.stringify([session.projectID, directory, userID])).digest("hex").slice(0, 32);
  return { team_id: `project-${hash}`, user_id: userID, agent_id: agent };
}

const key = m => JSON.stringify([m.role, m.content, m.recorded_at ?? m.timestamp]);

/** Read/reconcile/write/verify: confirm what already exists before writing. */
export async function reconcileMemoryUnit(request, scope, unit) {
  const query = async () => {
    const rows = [];
    for (let offset = 0; offset < 10000; offset += 100) {
      const data = await request("/conversation/query", { ...scope, session_id: unit.session_id, offset, limit: 100 });
      rows.push(...data.messages.filter(row => row.task_id === unit.task_id));
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
