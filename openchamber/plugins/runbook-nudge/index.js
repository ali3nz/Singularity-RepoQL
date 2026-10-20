// Runbook nudge — public release adaptation of the internal OpenChamber
// runbook-nudge plugin. Reminders belong in the PRIMARY agent's context before
// inference. The context hook also runs before tool continuations, so the agent
// sees the closing reminder before it can choose its final answer. No stop
// interception, synthetic follow-up turns, or forced documentation writes.
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

export const START_REMINDER =
  "[runbook start nudge] Before substantial work, first check for active related work: " +
  "read the project's tracking records (issue list, TODO files or whatever tracker the " +
  "project instructions name); search open, claimed and in-progress items by area, service " +
  "and task; and check recent activity or changelog notes. Reuse a matching record instead " +
  "of starting parallel work; check ownership and claim conflicts, and claim only an " +
  "unclaimed or stale record. If no record covers shared live state you are about to " +
  "change, record and claim one before starting. Then look for an existing runbook covering " +
  "this task in the narrowest relevant docs area. If one exists, read and follow it; note " +
  "missing or incorrect steps. Do not keep searching once the task is covered. Also search " +
  "existing RepoQL concepts for the files and decisions this task touches before editing " +
  "(for example `rql explore`), so you build on them instead of duplicating or contradicting them. " +
  "When current operational context helps, also search this installation's indexed shared " +
  "documentation (`python3 scripts/memory-doc-ingest.py search \"<topic>\"`; bounded result). " +
  "If an existing indexed runbook covers this task, prefer the current on-disk source; never act on an old memory copy.";

export const CLOSE_REMINDER =
  "[runbook closeout nudge] Before your final answer: " +
  "(1) RUNBOOK — if this work is reasonably likely to recur, check the project docs: " +
  "if none exists, CREATE one; if one exists, UPDATE it with verified steps, validation, " +
  "troubleshooting or rollback, and a Last updated date. " +
  "Skip one-off or trivial work and duplicates. " +
  "If your role cannot write docs, report the proposed runbook update instead; never exceed " +
  "your permissions. This is a reminder, not evidence that the runbook was checked or written. " +
  "(2) REPOQL — search existing concepts for the files and decisions you changed " +
  "(`rql explore`, `rql concept hints <path>`). Update stale or wrong concepts by " +
  "capturing a corrected capsule under the concept's existing name through the project's " +
  "documented capture path — that supersedes the record's lineage only, never its history. " +
  "Never hand-edit captured drawer files, and retract a claim that must never be stored " +
  "again only through the project's documented retirement process. Capture new durable " +
  "wisdom, rules, shapes or knowledge, and link related capsules through tags or SeeAlso. " +
  "(3) VALIDATION — report what you verified with observed output and what remains " +
  "untested; a command exiting successfully is not proof of correctness. " +
  "(4) DOCS-CLOSURE (shared documentation policy — the same rules Claude Code runs) — a " +
  "material task reports exactly one outcome: DOC_UPDATED, DOC_NOT_REQUIRED (with a " +
  "concrete reason) or DOC_BLOCKED. DOC_NOT_REQUIRED is only valid for non-material " +
  "changes (formatting, typos, throwaway work) and BLOCKED never closes a task. When " +
  "documentation was created or updated, ingest the CURRENT content into the installation's " +
  "memory stack (`python3 scripts/memory-doc-ingest.py ingest --file <doc> --root <docs " +
  "root>`) and only claim success with DOC_INGEST_INDEXED (or DOC_INGEST_UNCHANGED); a " +
  "PENDING/FAILED ingestion must be retried (`retry --file <doc> --root <root>`) or reported " +
  "as incomplete, never claimed. Finally record the closure assessment for verification: " +
  "`python3 scripts/doc-policy.mjs assess --session <session-id> --files <changed files> " +
  "--doc-status <DOC_UPDATED|DOC_NOT_REQUIRED> [--docs <doc files>] [--ingest-status " +
  "DOC_INGEST_INDEXED ...] --capture-status CAPTURED|NO_LESSON|DEFERRED` and report its " +
  "SINGDOC token. Filesystem docs remain the source of truth; memory holds the searchable " +
  "indexed copy.";

const MARKER = "[runbook closeout nudge]";
const runbookOn = () => String(process.env.OPENCHAMBER_RUNBOOK_NUDGE || "on").trim().toLowerCase() !== "off";
const safeSid = (sid) => String(sid).replace(/[^A-Za-z0-9_-]/g, "_");
const stateDir = () => join(process.env.OPENCHAMBER_CAPABILITY_DIR
  || join(homedir(), ".local/share/opencode/capability-state"), "runbook-nudge-state");

function audit(entry) {
  try {
    const file = process.env.OPENCHAMBER_AUDIT_LOG
      || join(homedir(), ".local/share/opencode/capability-audit.jsonl");
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch { /* a reminder must never break a request */ }
}

export const RunbookNudge = {
  id: "runbook-nudge",
  async setup(ctx) {
    // Per-instance cache; preserves the persisted startDelivered schema.
    const state = new Map();
    function load(sid) {
      if (state.has(sid)) return state.get(sid);
      let value = { startDelivered: false };
      try {
        const file = join(stateDir(), `${safeSid(sid)}.json`);
        if (existsSync(file)) value = JSON.parse(readFileSync(file, "utf8")) || value;
      } catch { /* unreadable state is cold; never prevent the closing reminder */ }
      // Discard unknown/old fields; only true counts as delivered.
      value = { startDelivered: value?.startDelivered === true };
      state.set(sid, value);
      if (state.size > 500) state.delete(state.keys().next().value);
      return value;
    }
    function save(sid, value) {
      try {
        mkdirSync(stateDir(), { recursive: true });
        writeFileSync(join(stateDir(), `${safeSid(sid)}.json`), JSON.stringify(value));
      } catch {
        audit({ sessionID: sid, tool: "runbook-nudge", decision: "NUDGE-RB-STATE-ERR", reason: "start-state persistence failed; closing reminder remains active" });
      }
    }
    try {
      if (typeof ctx.session?.hook !== "function") {
        audit({ tool: "runbook-nudge", decision: "CONTEXT_HOOK_UNAVAILABLE", reason: "No in-context reminder registered; the AGENTS.md runbook rules remain" });
        return;
      }
      const registration = await ctx.session.hook("context", (event) => {
        try {
          if (!runbookOn()) return;
          const sid = event?.sessionID;
          if (typeof sid !== "string" || !sid || sid === "unknown" || !Array.isArray(event.system)) return;
          // A reused draft must not accumulate our instruction. A fresh request
          // must always get it: per-session/turn dedup would miss later finals.
          if (event.system.some((part) => part?.type === "text" && typeof part.text === "string" && part.text.includes(MARKER))) return;
          const st = load(sid);
          const includeStart = !st.startDelivered;
          event.system.push({ type: "text", text: (includeStart ? START_REMINDER + "\n\n" : "") + CLOSE_REMINDER });
          if (includeStart) {
            st.startDelivered = true; // only after actual request-context insertion
            save(sid, st);
            audit({ sessionID: sid, tool: "runbook-nudge", decision: "NUDGE-RB-START", reason: "start reminder inserted into primary model context" });
          }
          audit({ sessionID: sid, tool: "runbook-nudge", decision: "NUDGE-RB-CONTEXT", reason: "before-final runbook/concepts/validation reminder inserted into primary model context" });
        } catch { /* malformed/frozen draft cannot break a model request */ }
      });
      audit({ tool: "runbook-nudge", decision: "CONTEXT_HOOK", reason: "pre-request runbook reminders registered" });
      return () => registration?.dispose?.();
    } catch {
      audit({ tool: "runbook-nudge", decision: "CONTEXT_HOOK_ERROR", reason: "context hook registration failed; the AGENTS.md runbook rules remain" });
    }
  },
};

export default RunbookNudge;
