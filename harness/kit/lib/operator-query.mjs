// lib/operator-query.mjs — V3.4.0 Phase 3 (plan §15, D12-D16). Typed operator
// query object persisted per run; ONE unresolved query per run (D13); button
// custom_ids carry a signed compact identity (plan §15.6); answers feed the
// EXISTING operator answer relay path — no second case mutation path (D16).
// The Discord bridge imports the same validation logic via a tiny JSON
// contract: the kit writes operator-query.json in the run dir; the bridge
// reads it, renders buttons, and writes operator-answer.json + edits the
// panel. Persistence in the run dir survives coordinator restart (acceptance 68).
import { createHmac, createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const QUERY_TYPES = new Set(["decision", "approval", "recoverable_issue", "blocking_issue", "information_request"]);
export const COORDINATOR_ACTIONS = new Set(["continue", "retry", "skip", "pause", "stop_run"]);
export const DECISION_RESPONSES = new Set(["approve", "reject", "option_1", "option_2", "option_3"]);

function sha16(s) { return createHash("sha256").update(String(s ?? "")).digest("hex").slice(0, 16); }

export function queryButtonsFor(query) {
  // Plan §15.4: button set depends on query type; Stop Run only when the run
  // is active and requires a second confirmation step (D15).
  const t = query.queryType;
  if (t === "decision") return (query.options ?? []).map((o, i) => ({ id: o.id ?? `option_${i + 1}`, label: o.label }));
  if (t === "approval") return [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }];
  if (t === "recoverable_issue") {
    const btns = [{ id: "retry", label: "Retry" }, { id: "skip", label: "Skip" }, { id: "continue", label: "Continue" }];
    if (query.runActive) btns.push({ id: "stop_run", label: "Stop Run", style: 4 });
    return btns;
  }
  if (t === "blocking_issue") {
    const btns = [{ id: "retry", label: "Retry" }, { id: "pause", label: "Pause" }];
    if (query.runActive) btns.push({ id: "stop_run", label: "Stop Run", style: 4 });
    return btns;
  }
  return []; // information_request: free text only
}

// Signed button identity (plan §15.6). Secret comes from the kit config env
// (ORCH_OQ_SECRET); falls back to a derived machine-local secret so the
// scheme works in tests without config. Validation rejects ANY mismatch.
export function signQueryIdentity({ queryId, action, nonce, secret }) {
  const s = secret ?? process.env.ORCH_OQ_SECRET ?? "oq-dev-secret";
  return createHmac("sha256", s).update(`${queryId}|${action}|${nonce}`).digest("hex").slice(0, 12);
}

export function buildButtonCustomId({ queryId, action, nonce, secret }) {
  const sig = signQueryIdentity({ queryId, action, nonce, secret });
  return `oq:${queryId}:${action}:${nonce}:${sig}`;
}

export function validateButtonCustomId(customId, { expectNonce = null } = {}) {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 5 || parts[0] !== "oq") return { ok: false, reason: "malformed" };
  const [, queryId, action, nonce, sig] = parts;
  if (signQueryIdentity({ queryId, action, nonce }) !== sig) return { ok: false, reason: "bad-signature" };
  if (expectNonce != null && nonce !== expectNonce) return { ok: false, reason: "stale-nonce" };
  if (!COORDINATOR_ACTIONS.has(action) && !DECISION_RESPONSES.has(action) && action !== "confirm_stop") {
    return { ok: false, reason: "action-not-whitelisted" };
  }
  return { ok: true, queryId, action, nonce };
}

// Open the run's operator query. Refuses when one is already open (D13).
// Writes operator-query.json AND returns the pointer to store in case.json
// through case-store (the caller owns the case write — single writer rule).
export function openOperatorQuery(runDir, { runNumber, caseId, caseRev, sourceAgent, queryType, prompt, options = [], allowFreeText = true, runActive = true }) {
  if (!QUERY_TYPES.has(queryType)) throw new Error(`queryType not in enum: ${queryType}`);
  mkdirSync(runDir, { recursive: true }); // first query on a fresh run dir
  const existing = readOperatorQuery(runDir);
  if (existing?.status === "open") {
    return { ok: false, reason: "query-already-open", existing };
  }
  const seq = (existing?.seq ?? 0) + 1;
  const query = {
    schema: 1,
    queryId: `OQ${String(seq).padStart(4, "0")}`,
    runNumber, caseId, caseRev, sourceAgent, queryType,
    severity: "normal",
    prompt: String(prompt ?? "").slice(0, 900),
    options: (options ?? []).slice(0, 3).map((o, i) => ({ id: o.id ?? `option_${i + 1}`, label: String(o.label ?? o).slice(0, 80) })),
    allowFreeText: allowFreeText !== false,
    runActive: runActive !== false,
    status: "open",
    seq,
    nonce: sha16(`${runNumber}:${seq}:${Date.now()}:${Math.random()}`),
    openedAt: new Date().toISOString(),
  };
  writeFileSync(join(runDir, "operator-query.json"), JSON.stringify(query, null, 2) + "\n");
  return { ok: true, query, buttons: queryButtonsFor(query).map((b) => ({ ...b, customId: buildButtonCustomId({ queryId: query.queryId, action: b.id, nonce: query.nonce }) })) };
}

export function readOperatorQuery(runDir) {
  try { return JSON.parse(readFileSync(join(runDir, "operator-query.json"), "utf8")); }
  catch { return null; }
}

// Resolve the open query. Returns the answer record for the caller to persist
// into case history; also rewrites operator-query.json (status closed) and
// stamps who/when. stop_run requires prior confirm_stop (D15).
export function resolveOperatorQuery(runDir, { action, by, viaButton = true, freeText = null, stopConfirmed = false }) {
  const q = readOperatorQuery(runDir);
  if (!q || q.status !== "open") return { ok: false, reason: "no-open-query" };
  // D14: actions are typed + whitelisted — the bridge checks the signed
  // custom_id BEFORE calling us; here we re-validate the action itself so a
  // fabricated answer file can never smuggle an arbitrary action in.
  // confirm_stop is the D15 second-click action and resolves as stop_run.
  const effAction = action === "confirm_stop" ? "stop_run" : action;
  // V3.4.0 acceptance 66 (Sol sign-off FIX PLAN): a plain free-text REPLY in
  // the run thread is a plan-mandated answer channel (D12/D16) — whitelisted
  // as its own answer class. It carries no coordinator mutation by itself;
  // the coordinator interprets it (same as a button's decision response).
  // Defense in depth (acceptance 66b): an answer can never be anonymous —
  // the bridge allowlist gates WHO resolves; the kit gates THAT it is a
  // named actor even if a future caller forgets to check the allowlist.
  if (!String(by ?? "").trim()) return { ok: false, reason: "no-actor" };
  const isFreeText = action === "free_text" && typeof freeText === "string" && freeText.trim().length > 0;
  if (action === "free_text" && !isFreeText) {
    return { ok: false, reason: "free-text-empty" };
  }
  if (!isFreeText && !COORDINATOR_ACTIONS.has(effAction) && !DECISION_RESPONSES.has(effAction)) {
    return { ok: false, reason: "action-not-whitelisted" };
  }
  // D15 two-click stop: action "stop_run" = FIRST click (panel flips to
  // Confirm Stop / Keep Running); action "confirm_stop" = SECOND click
  // (executes). confirm_stop implies stopConfirmed.
  const confirmed = stopConfirmed || action === "confirm_stop";
  if (effAction === "stop_run" && !confirmed) {
    // First click: flip to confirm state (D15) — the panel re-renders with
    // Confirm Stop / Keep Running; nothing stops yet.
    q.confirmPending = true;
    writeFileSync(join(runDir, "operator-query.json"), JSON.stringify(q, null, 2) + "\n");
    return { ok: true, result: "confirm-required", buttons: [
      { id: "confirm_stop", label: "Confirm Stop", style: 4, customId: buildButtonCustomId({ queryId: q.queryId, action: "confirm_stop", nonce: q.nonce }) },
      { id: "continue", label: "Keep Running", customId: buildButtonCustomId({ queryId: q.queryId, action: "continue", nonce: q.nonce }) },
    ] };
  }
  q.status = "closed";
  q.resolvedAt = new Date().toISOString();
  q.resolvedBy = by;
  q.resolvedVia = viaButton ? "button" : "free_text";
  q.resolution = freeText ? `${action}:${String(freeText).slice(0, 300)}` : action;
  writeFileSync(join(runDir, "operator-query.json"), JSON.stringify(q, null, 2) + "\n");
  const answer = {
    schema: 1, queryId: q.queryId, runNumber: q.runNumber, caseId: q.caseId,
    caseRev: q.caseRev, action: effAction, by, via: q.resolvedVia, freeText: freeText ?? null,
    resolvedAt: q.resolvedAt,
  };
  writeFileSync(join(runDir, "operator-answer.json"), JSON.stringify(answer, null, 2) + "\n");
  return { ok: true, result: "resolved", answer };
}

// Idempotent double-click guard (acceptance 65): a closed query resolves to
// a typed no-op — the caller (bridge) edits the panel instead of re-mutating.
export function isIdempotentReplay(runDir) {
  const q = readOperatorQuery(runDir);
  return q ? q.status === "closed" : false;
}

// Read the resolved answer (if any) — used by resume/closeout to surface the
// authoritative operator decision in the run record (D16: ONE answer path).
export function readOperatorAnswer(runDir) {
  try { return JSON.parse(readFileSync(join(runDir, "operator-answer.json"), "utf8")); }
  catch { return null; }
}
