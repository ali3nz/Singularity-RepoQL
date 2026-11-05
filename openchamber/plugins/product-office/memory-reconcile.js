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

export { reconcileMemoryUnit } from "../../../scripts/memory-reconcile-core.mjs";
