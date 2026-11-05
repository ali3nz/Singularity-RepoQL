// lib/deviation-ledger.mjs — ticket 164 Wave 5 (plan §19.10): every
// implementation departure from the accepted plan is recorded with
// { planned, actual, reason, impact, requiresRegate }. The coordinator must
// never silently treat a material deviation as part of the original plan.
//
// Material deviations (normally requireRegate:true): scope expansion, new
// persistent state, changed migration order, changed acceptance criterion,
// changed worker ownership, changed destructive operation, changed gate
// semantics, changed run identity semantics.
// Minor substitutions (equivalent helper, same behaviour/files/evidence):
// requiresRegate:false.

import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const MATERIAL_KINDS = new Set([
  "scope-expansion",
  "new-persistent-state",
  "changed-migration-order",
  "changed-acceptance-criterion",
  "changed-worker-ownership",
  "changed-destructive-operation",
  "changed-gate-semantics",
  "changed-run-identity",
]);

export const DEVIATION_KINDS = [...MATERIAL_KINDS, "minor-substitution"];

export function classifyDeviation(kind, { detail = "" } = {}) {
  if (kind === "minor-substitution") return { requiresRegate: false, rationale: "minor substitution: equivalent behaviour/files/evidence" };
  if (MATERIAL_KINDS.has(kind)) return { requiresRegate: true, rationale: `material deviation kind: ${kind}${detail ? ` — ${detail}` : ""}` };
  // Unknown kinds fail CLOSED: treat as material until a human says otherwise.
  return { requiresRegate: true, rationale: `unknown deviation kind '${kind}' treated as material (fail-closed)` };
}

export function openDeviationLedger(runDir) {
  const p = join(runDir, "deviations.jsonl");
  try { mkdirSync(runDir, { recursive: true }); } catch { /* exists */ }
  const load = () => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return {
    path: p,
    all: load,
    record({ kind, planned, actual, reason, impact = "" }) {
      const cls = classifyDeviation(kind, { detail: reason ?? "" });
      const row = {
        schema: 1,
        at: new Date().toISOString(),
        kind, planned, actual, reason, impact,
        requiresRegate: cls.requiresRegate,
        rationale: cls.rationale,
        regatedAt: null,
      };
      appendFileSync(p, JSON.stringify(row) + "\n");
      return row;
    },
    markRegated(at = new Date().toISOString()) {
      const rows = load();
      for (const r of rows) if (r.requiresRegate && !r.regatedAt) r.regatedAt = at;
      const { writeFileSync } = require("node:fs");
      writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
      return rows;
    },
    pendingRegate() { return load().filter((r) => r.requiresRegate && !r.regatedAt); },
  };
}
