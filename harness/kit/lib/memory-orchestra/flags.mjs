// lib/memory-orchestra/flags.mjs — MemOS gap-closure addendum (2026-10-23) §11.
// Feature-flag block for the memory-orchestra plane. Same contract as
// lib/memory-lineage.mjs flags(): config-backed (config.json memoryOrchestra
// block), env overrides win, ALL DEFAULTS OFF, and flag-off is byte-identical
// legacy behaviour. The config file is re-read on EVERY call (lib pattern —
// "next call sees the change" rollout control; the block is tiny and call
// frequency low). ORCH_MEMORY_CONFIG is a test/ops override for the config
// PATH only — it never changes precedence or defaults.
//
// Planned turn-on order AFTER the operator's validation directive (§30 — none
// of these may ship enabled from this implementation phase):
//   stepsCapture -> plannerfast -> fusion -> hooks (repair last).
// Rollback is always one flag. Every flag-off path returns typed
// { ok:false, code:"FLAG_DISABLED" } at the caller boundary, never silent
// empty-success.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CONFIG_FILE = () => process.env.ORCH_MEMORY_CONFIG ?? fileURLToPath(new URL("../../config.json", import.meta.url));

function memoryOrchestraConfig() {
  try {
    const doc = JSON.parse(readFileSync(CONFIG_FILE(), "utf8"));
    return doc?.memoryOrchestra ?? {};
  } catch {
    return {};
  }
}

function flagFrom(envName, cfgKey) {
  const env = process.env[envName];
  if (env != null && String(env).trim() !== "") return String(env).toUpperCase() === "ENABLED";
  return String(memoryOrchestraConfig()[cfgKey] ?? "disabled").toUpperCase() === "ENABLED";
}

// PENDING_VALIDATION markers (directive §34): implemented, gated, awaiting the
// operator's separate validation directive before any turn-on.
export const PENDING_VALIDATION = "PENDING_VALIDATION";

export function flags() {
  const raw = memoryOrchestraConfig();
  return {
    // P2: step-level capture rows on the EXISTING capture consumer (no new recorder).
    stepsCapture: flagFrom("ORCH_MORCH_STEPS_CAPTURE", "stepsCapture"),
    // P1: retrieval planner (FAST tier mechanics).
    planner: flagFrom("ORCH_MORCH_PLANNER", "planner"),
    // P1: multi-channel rank fusion (RRF + MMR + hard eligibility).
    fusion: flagFrom("ORCH_MORCH_FUSION", "fusion"),
    // P1: JSONL retrieval instrumentation ledger.
    ledger: flagFrom("ORCH_MORCH_LEDGER", "ledger"),
    // P2: verified-outcome attribution over step records.
    attribution: flagFrom("ORCH_MORCH_ATTRIBUTION", "attribution"),
    // P3: cross-task policy induction (candidate-only; approval gate unchanged).
    policyInduction: flagFrom("ORCH_MORCH_POLICY_INDUCTION", "policyInduction"),
    // P4: L3 world-model draft + gated concept path.
    worldModel: flagFrom("ORCH_MORCH_WORLD_MODEL", "worldModel"),
    // P4: decision repair (failure-triggered retrieval, advisory-only).
    decisionRepair: flagFrom("ORCH_MORCH_DECISION_REPAIR", "decisionRepair"),
    // P1: L2/L3 MemoryCore read/write client extensions.
    l23Read: flagFrom("ORCH_MORCH_L23_READ", "l23Read"),
    l23Write: flagFrom("ORCH_MORCH_L23_WRITE", "l23Write"),
    // P5: portability exporter + inspector.
    portability: flagFrom("ORCH_MORCH_PORTABILITY", "portability"),
    // Raw config passthrough for bounded budget overrides (never silently raised).
    budgets: raw?.budgets && typeof raw.budgets === "object" ? raw.budgets : {},
    configBlock: raw,
  };
}

// Single entry check: an orchestrator op is callable only when its owning flag
// is ENABLED. Returns flagState object, or a typed disabled marker.
export function enabledWhen(flagState, key) {
  if (flagState?.[key]) return { ok: true };
  return { ok: false, code: "FLAG_DISABLED", flag: key, status: PENDING_VALIDATION };
}
