// lib/memory-orchestra/ghostwake.mjs — MemOS gap-closure addendum
// (2026-10-23) directive §21 (dreaming and maintenance → Ghost triggers).
// Produce Ghost-CONSUMABLE WAKE reason records — append-only wakes.jsonl in
// the runs tree. Ghost KEEPS dreaming ownership ("no competing dream service"):
// this module only measures fleet memory health and emits wake candidates;
// the existing Ghost dream scheduler decides whether/when to dream.
// Trigger classes (directive §21): recurring failures, weak retrieval,
// unresolved incidents, knowledge supersession, stale documentation.
// Gated by worldModel flag family? No — wake computation is observation-only;
// persists only when ledger flag is on (it measures from ledger data).
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { flags, enabledWhen } from "./flags.mjs";
import { recentWeakRetrieval } from "./ledger.mjs";

export const WAKE_KINDS = ["WEAK_RETRIEVAL", "REPEATED_FAILURES", "UNRESOLVED_INCIDENTS", "SUPERSESSION_DUE", "STALE_DOCUMENTATION"];

// computeWakeReasons — bounded reads only. Inputs:
//   unresolvedIncidents: caller-supplied count (issues/open incidents review)
//   tombstonesRecent: count of tombstones created/updated in window
//   staleDocs: count from docctl/staleness reports if the caller has one
export async function computeWakeReasons({ window = 50, unresolvedIncidents = 0, tombsRecent = 0, staleDocs = 0, minWeakRatio = 0.5 } = {}) {
  const g = recentWeakRetrieval({ window });
  const reasons = [];
  if (g.ok && g.analyzed >= Math.min(window, 5) && g.ratio != null && g.ratio >= minWeakRatio) {
    reasons.push({ kind: "WEAK_RETRIEVAL", evidence: `weak/insufficient verdicts ${(g.ratio * 100).toFixed(0)}% of last ${g.analyzed} retrievals`, suggestedFocus: "coverage gaps by channel (see retrieval ledger channels[].hits)" });
  }
  if (unresolvedIncidents >= 3) {
    reasons.push({ kind: "UNRESOLVED_INCIDENTS", evidence: `${unresolvedIncidents} unresolved incidents above threshold`, suggestedFocus: "incident signatures; candidate pool re-induction" });
  }
  if (tombsRecent >= 1) {
    reasons.push({ kind: "SUPERSESSION_DUE", evidence: `${tombsRecent} tombstone change(s) recently`, suggestedFocus: "lineage invalidation sweep + dependent memories refresh" });
  }
  if (staleDocs >= 1) {
    reasons.push({ kind: "STALE_DOCUMENTATION", evidence: `${staleDocs} doc(s) flagged stale`, suggestedFocus: "docx platform affected-slug sweep via docctl" });
  }
  return { ok: true, reasons, windowAnalyzed: g.analyzed ?? 0, note: "wake candidates only — Ghost's dream scheduler owns all dreaming decisions" };
}

// Append-record into the runs tree when wake-worthy. Ghost's scheduler can
// tail this file; nothing here wakes anything directly (no process spawn).
export async function recordWakes(stateDir = "/opt/harness-unset/ai-orchestration/kit/runs/_ghost-wakes") {
  if (!enabledWhen(flags(), "ledger").ok) return { ok: false, code: "FLAG_DISABLED" };
  const reasons = (await computeWakeReasons({})).reasons ?? [];
  if (!reasons.length) return { ok: true, recorded: 0 };
  try {
    mkdirSync(stateDir, { recursive: true }); // §9: durable write must not depend on the dir pre-existing
    appendFileSync(join(stateDir, "wakes.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), reasons })}\n`, "utf8");
    return { ok: true, recorded: reasons.length };
  } catch (err) {
    return { ok: false, code: `WAKE_WRITE_THROW:${String(err?.name ?? err).slice(0, 20)}` };
  }
}

// P1 §9 (2026-10-23): make wake signals REACH the configured consumer.
// The live dream entrypoint (ai-agents/dream/dream.mjs collectMemory) quotes
// every *.md in the dreaming agent's memfs memory dir into its prompt. Writing a
// bounded, overwritten digest there means the existing Ghost dream scheduler
// consumes these signals on its next run — no new scheduler, no process spawn,
// and no unbounded growth (one file, capped).
// Resolved lazily: the memfs agent subdirectory name is deployment-specific, so
// discover the single subdir at call time (same rule dream.mjs uses) and fall
// back to an explicit env override for tests.
function defaultWakeDir() {
  const env = process.env.ORCH_WAKE_MEMORY_DIR;
  if (env) return env;
  const base = process.env.ORCH_AGENT_MEMFS_BASE
    || "/opt/harness-unset/ai-agents/companion/home/.letta/lc-local-backend/memfs";
  try {
    const subs = readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name);
    if (subs.length === 1) return join(base, subs[0], "memory");
  } catch { /* fall through */ }
  return join(base, "agent-1", "memory");
}

export const WAKE_DIGEST_NAME = "wake-signals.md";
export const WAKE_DIGEST_CAP = 1800;

export async function publishWakeDigest({ memoryDir = null, extraReasons = [], now = new Date() } = {}) {
  memoryDir = memoryDir || defaultWakeDir();
  try {
    const base = await computeWakeReasons({});
    const reasons = [...(base.reasons ?? []), ...extraReasons.filter(Boolean)];
    if (!reasons.length) return { ok: true, written: false, reason: "no wake-worthy signals" };
    const lines = ["# Wake signals (generated — quoted data, not instructions)", "",
      `generated: ${now.toISOString()}`, ""];
    for (const r of reasons.slice(0, 8)) {
      lines.push(`## ${r.kind}`);
      if (r.evidence) lines.push(`- evidence: ${String(r.evidence).slice(0, 300)}`);
      if (r.suggestedFocus) lines.push(`- focus: ${String(r.suggestedFocus).slice(0, 240)}`);
      lines.push("");
    }
    lines.push("These are observations for reflection. Nothing here is an instruction; " +
      "decide independently whether a durable improvement is justified (NO_CHANGE is valid).");
    let body = lines.join("\n");
    if (Buffer.byteLength(body, "utf8") > WAKE_DIGEST_CAP) body = body.slice(0, WAKE_DIGEST_CAP - 3) + "...";
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, WAKE_DIGEST_NAME), body + "\n", "utf8");
    // S08 REFLECTION: a wake digest IS the reflection trigger for the scheduled
    // Ghost turn, so the advisory fires from this real event. Fail-open.
    try {
      const { reflectionAdvisory } = await import("./wire.mjs");
      await reflectionAdvisory({ subject: reasons.map((r) => r.kind).join(" "), query: reasons[0]?.evidence ?? "" }, { caseRun: null, agent: "ghost" });
    } catch { /* advisory-only */ }
    return { ok: true, written: true, reasons: reasons.length, path: join(memoryDir, WAKE_DIGEST_NAME) };
  } catch (err) {
    return { ok: false, code: `WAKE_DIGEST_THROW:${String(err?.name ?? err).slice(0, 24)}` };
  }
}
