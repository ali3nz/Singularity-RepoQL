// lib/run-summary.mjs — V3.4.0 Phase 9/§12.1/§11.10/D35 (ticket 088).
// Every accepted run gets a compact, deterministic run-summary.md BEFORE final
// acceptance (plan §11.10, acceptance 51). It is the bridge between permanent
// run identity and durable memory: QMD indexes accepted summaries (D35), so a
// future agent can resolve "Look at Run 042" without the original conversation.
// This module WRITES THE FILE only; the exact bytes are bound into the
// acceptance subject (knowledge section) by the closeout path.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifiedRustCompat } from "./rust-compat-policy.mjs";

function pad(n) { return String(n ?? 0).padStart(3, "0"); }

// Pure: build the summary body from run state + case + staged knowledge.
// Deterministic content given the same inputs (timestamps come from inputs).
function buildRunSummaryReference({ runNumber = null, caseId = null, runType = "orchestration", title = null, objective = null, decisions = [], changedComponents = [], validation = [], residuals = [], memoryRefs = [], outcome = "ACCEPTED", date = null } = {}) {
  const lines = [];
  const heading = runNumber != null ? `Run ${pad(runNumber)} | ${title ?? caseId ?? "untitled"}` : `${runType} ${caseId ?? "unnumbered"} | ${title ?? "untitled"}`;
  lines.push(`# ${heading}`);
  lines.push("");
  lines.push("## Identity");
  lines.push("");
  lines.push(`- Run number: ${runNumber != null ? runNumber : "unnumbered (pre-rollout)"}`);
  lines.push(`- Case ID: ${caseId ?? "unknown"}`);
  lines.push(`- Type: ${runType}`);
  lines.push(`- Date: ${date ?? new Date().toISOString().slice(0, 10)}`);
  lines.push("");
  lines.push("## Objective");
  lines.push("");
  lines.push(String(objective ?? "(not recorded)").slice(0, 1200));
  lines.push("");
  lines.push("## Important decisions");
  lines.push("");
  lines.push(decisions.length ? decisions.map((d) => `- ${d}`).join("\n") : "- (none recorded)");
  lines.push("");
  lines.push("## Changed components");
  lines.push("");
  lines.push(changedComponents.length ? changedComponents.map((c) => `- ${c}`).join("\n") : "- (none recorded)");
  lines.push("");
  lines.push("## Validation");
  lines.push("");
  lines.push(validation.length ? validation.map((v) => `- ${v}`).join("\n") : "- (none recorded)");
  lines.push("");
  lines.push("## Known residuals");
  lines.push("");
  lines.push(residuals.length ? residuals.map((r) => `- ${r}`).join("\n") : "- (none)");
  lines.push("");
  lines.push("## Durable memory references");
  lines.push("");
  lines.push(memoryRefs.length ? memoryRefs.map((m) => `- ${m}`).join("\n") : "- (no durable knowledge staged)");
  lines.push("");
  lines.push("## Final outcome");
  lines.push("");
  lines.push(String(outcome));
  lines.push("");
  return lines.join("\n");
}

// Native rendering is authoritative only after exact agreement with the
// existing builder. Fix date once to avoid comparing two independent clocks.
export function buildRunSummary(inputs = {}) {
  const fixed = { ...inputs, date: inputs?.date ?? new Date().toISOString().slice(0, 10) };
  const reference = buildRunSummaryReference(fixed);
  return verifiedRustCompat("run_summary.build", { inputs: fixed }, reference);
}

export function writeRunSummary(runDir, inputs) {
  const body = buildRunSummary(inputs);
  const path = join(runDir, "run-summary.md");
  writeFileSync(path, body);
  return { path, body };
}
