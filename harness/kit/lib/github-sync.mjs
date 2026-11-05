// lib/github-sync.mjs — V3.4.5 (ticket 129): Orchestra → GitHub Issues + Projects
// passive projection layer.
//
// DESIGN CONTRACT (Sol planning-gate verdict, consult 2026-09-27T05-34-21):
// - ONE shared sync path downstream of the coordinator (writeState funnel);
//   GitHub NEVER sets coordinator state (one-way projection).
// - Canonical work identity = runNumber (monotonic, run-ledger.jsonl); issue
//   footer carries BOTH "Orchestra-Run:<n>" and "Case-ID:<caseId>" markers;
//   dedupe key = Orchestra-Run marker.
// - Per-run serialization: syncRun() takes an in-process per-run queue AND an
//   on-disk in-flight marker; the github.json identity cache is RE-READ after
//   acquiring the serialization slot. A caller-side timeout never abandons an
//   in-flight create — the caller's bounded wait is decoupled from sync
//   completion (fire-and-forget callers do not race the create).
// - github.json is a CACHE, never authority: if lost, marker search
//   reconstructs it. Reconciliation changes GitHub, never the coordinator.
// - Deterministic 14-day auto-archive: rides the nanny cadence via
//   reconcileScan() (orch-nanny.timer → hourly throttle) — archiveProjectV2Item
//   for tracked items whose issue closed >14d ago. No Projects-UI workflows.
// - Consult coverage (ticket 142, Sol CONFIRMED): reconcileScan also scans
//   runs/consult/*/case.json (same flood guard/dedupe); consult terminal
//   hooks (--end-session, orphan close, nanny orphan sweep) fire syncRun.
// - Fail-open: sync failures log GH_SYNC lines (run.log + console) and never
//   affect worker state, phase verdicts, Sol gates, terminal compliance, or
//   Discord. No false success: a failed projection reports failure.
import { readFileSync, writeFileSync, existsSync, rmSync, statSync } from "node:fs";
import { buildRunIndex } from "./run-registry.mjs";
import { normalizeTopic } from "./consult-affinity.mjs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const HERE = new URL(".", import.meta.url).pathname;
const RUNS = join(HERE, "..", "runs");
const STATE_DIR = join(RUNS, "state");
const LEDGER = join(STATE_DIR, "run-ledger.jsonl");

// ----------------------------- configuration -----------------------------
// config.json block githubSync { enabled, owner, repo, projectNumber, tunnelPort,
// syncTimeoutMs, archiveAfterDays } + env kill-switch ORCH_GH_SYNC=off.
let cfgCache = null;
export function ghSyncConfig() {
  if (cfgCache) return cfgCache;
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(join(HERE, "..", "config.json"), "utf8")).githubSync ?? {}; } catch { }
  cfg = {
    enabled: false,
    owner: "",
    repo: "",
    projectNumber: null,
    tunnelPort: 18081,
    syncTimeoutMs: 8000,
    archiveAfterDays: 14,
    ...cfg,
  };
  // Hermetic test override (gh-sync-test.mjs). Test-only; never set in prod.
  if (process.env.ORCH_GH_SYNC_TEST_CONFIG) {
    try { Object.assign(cfg, JSON.parse(process.env.ORCH_GH_SYNC_TEST_CONFIG)); } catch { }
  }
  // Env kill-switch overrides config (fail-closed direction: off wins).
  if (String(process.env.ORCH_GH_SYNC ?? "").toLowerCase() === "off") cfg.enabled = false;
  cfgCache = cfg;
  return cfg;
}
export function _resetGhSyncConfigForTests() { cfgCache = null; }

// ------------------------- transport (MCP + GraphQL) ---------------------
const GH_TUNNEL_PORT = () => String(ghSyncConfig().tunnelPort ?? 18081);

async function ghTunnelHealthy(port) {
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 2500);
    const r = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "HEAD", signal: ctl.signal });
    clearTimeout(t); return r.status < 500; // 405/400 still means server is up
  } catch { return false; }
}

// Idempotent local forward to the mcp-github container (loopback-only bind on
// controller; qmd-tunnel pattern, V3.4.0 §10.4).
export async function ensureGhMcpTunnel({ port = GH_TUNNEL_PORT(), sshHost = "controller" } = {}) {
  try {
    if (await ghTunnelHealthy(port)) return { ok: true, reused: true, port };
    const { spawn } = await import("node:child_process");
    const child = spawn("ssh", ["-f", "-N",
      "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=10",
      "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3",
      "-L", `${port}:127.0.0.1:8081`, sshHost], { stdio: "ignore", detached: true });
    child.unref();
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await ghTunnelHealthy(port)) return { ok: true, reused: false, port };
    }
    return { ok: false, code: "TUNNEL_TIMEOUT" };
  } catch (e) { return { ok: false, code: "TUNNEL_ERROR", detail: String(e?.message ?? e).slice(0, 120) }; }
}

// JSON-RPC call over streamable-http. Each logical call re-initializes a
// session when the server reports a missing/expired session id (stateless
// enough for our purposes; the probe harness verified the handshake).
async function mcpCall(tool, args, { sessionId = null } = {}) {
  const base = `http://127.0.0.1:${GH_TUNNEL_PORT()}/mcp`;
  const hdrs = { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" };
  if (sessionId) hdrs["Mcp-Session-Id"] = sessionId;
  const res = await fetch(base, { method: "POST", headers: hdrs,
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name: tool, arguments: args } }) });
  const sid = res.headers.get("mcp-session-id");
  let body = await res.text();
  for (const line of body.splitlines ? body.splitlines() : body.split("\n")) {
    if (line.startsWith("data:")) { body = line.slice(5).trim(); break; }
  }
  let json;
  try { json = JSON.parse(body); } catch { throw Object.assign(new Error(`MCP_UNPARSEABLE: ${body.slice(0, 120)}`), { code: "MCP_UNPARSEABLE" }); }
  if (json.error) throw Object.assign(new Error(`MCP_ERROR: ${json.error.message ?? ""}`), { code: "MCP_ERROR", mcpError: json.error });
  const content = json.result?.content?.[0]?.text;
  let parsed = content;
  try { parsed = JSON.parse(content); } catch { /* plain text result */ }
  return { sid: sid ?? sessionId, parsed, raw: content };
}

// Full handshake: init → initialized → call. Retries once on session expiry.
export async function mcpHandshakeCall(tool, args) {
  const base = `http://127.0.0.1:${GH_TUNNEL_PORT()}/mcp`;
  const hdrs = { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" };
  const init = await fetch(base, { method: "POST", headers: { ...hdrs },
    body: JSON.stringify({ jsonrpc: "2.0", id: "i1", method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "orchestra-gh-sync", version: "1" } } }) });
  const sid = init.headers.get("mcp-session-id");
  await fetch(base, { method: "POST", headers: { ...hdrs, "Mcp-Session-Id": sid },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  try {
    return await mcpCall(tool, args, { sessionId: sid });
  } catch (e) {
    if (String(e?.message ?? "").includes("session")) return mcpCall(tool, args, { sessionId: sid });
    throw e;
  }
}

// Setup-time GraphQL (field creation only — the MCP server does not expose
// createProjectV2Field; Sol approved this narrow exception, setup-only,
// idempotent). Token travels via SSH to controller's token file; it never
// appears in code, logs, or this repo.
export async function gql(query, variables = {}) {
  const { spawn } = await import("node:child_process");
  const payload = JSON.stringify({ query, variables });
  const out = await new Promise((resolve, reject) => {
    const child = spawn("ssh", ["controller",
      "T=$(cat /root/.config/github-access/github_token); curl -s -H \"Authorization: Bearer $T\" -H \"Content-Type: application/json\" -d @- https://api.github.com/graphql"],
      { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("GQL_TIMEOUT")); }, 30000);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(`GQL_EXIT_${code}: ${stderr.slice(0, 120)}`)); });
    child.stdin.write(payload);
    child.stdin.end();
  });
  const r = JSON.parse(out);
  if (r.errors?.length) throw Object.assign(new Error(`GQL_ERROR: ${r.errors[0].message?.slice(0, 200)}`), { code: "GQL_ERROR", errors: r.errors });
  return r.data;
}

// gh-sync-setup lives in gh-sync-setup.mjs and imports gql + the MCP helpers
// from here (single transport, one client implementation).

// --------------------------- test seams ----------------------------------
// Hermetic test battery (gh-sync-test.mjs) replaces the network operations
// and path roots. NEVER set in production code paths.
let testTransport = null;
let testPaths = null;
export function _setTransportForTests(t) { testTransport = t; }
export function _currentTransportForTests() { return testTransport ?? {}; }
export function _setPathsForTests({ runsDir, stateDir }) { testPaths = { runsDir, stateDir }; }
function runsRoot() { return testPaths?.runsDir ?? RUNS; }
function stateRoot() { return testPaths?.stateDir ?? STATE_DIR; }

// ---------------------------- run-log plumbing ---------------------------
import { appendFileSync } from "node:fs";
function ghLogRun(runId, line) {
  console.log(`GH_SYNC: ${line}`);
  try { appendFileSync(join(RUNS, runId, "run.log"), `[${new Date().toISOString()}] GH_SYNC: ${line}\n`); } catch { }
}

// ------------------------- per-run serialization -------------------------
// In-process queue per run + on-disk in-flight marker (cross-process safety).
// The caller never gets a "done" while a create is still untracked (Sol #1).
const inProcessChains = new Map();
const inflightMarker = (runId) => join(stateRoot(), `ghsync-${runId}.inflight`);
function serialize(runId, fn) {
  const prev = inProcessChains.get(runId) ?? Promise.resolve();
  const next = prev.catch(() => { }).then(() => fn());
  // Keep only the tail so the map cannot grow unbounded; failures don't break the chain.
  inProcessChains.set(runId, next.catch(() => { }));
  if (inProcessChains.size > 512) {
    for (const [k, v] of inProcessChains) { if (v === next) break; inProcessChains.delete(k); }
  }
  return next;
}

// --------------------------- identity + markers --------------------------
export function runMarker(runNumber) { return `Orchestra-Run:${runNumber}`; }
export function caseMarker(caseId) { return `Case-ID:${caseId}`; }

// Boundary-safe marker tests (ticket 142, Sol turn-2/3 regression requirement).
// GitHub issue search is TOKEN-based, so a search hit must be verified against
// the body with an exact boundary. INTENTIONAL IDENTITY RULE (same rule for
// discovery, dedupe, convergence, and tests):
//   accept:  "<!-- Orchestra-Run:9 -->", "...Case-ID:<id> -->" (our writer form)
//   reject:  Orchestra-Run:10/101/110 when searching run 1 (suffix digits)
//   reject:  Orchestra-Run: 1 (space after colon — never written by the sync)
//   reject:  Orchestra-Run:01 (zero-padded — not our canonical form)
//   reject:  Foo-Orchestra-Run:1 (left alnum/- boundary — not our marker)
// Marker ids are digits/dashes/T ⇒ suffix guard (?![0-9-]); the left guard
// (?<![0-9A-Za-z-]) rejects hyphen/alnum-prefixed lookalikes.
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function exactRunMarker(body, runNumber) {
  return new RegExp(`(?<![0-9A-Za-z-])Orchestra-Run:${runNumber}(?![0-9-])`).test(String(body ?? ""));
}
export function exactCaseMarker(body, caseId) {
  return new RegExp(`(?<![0-9A-Za-z-])Case-ID:${escapeRe(caseId)}(?![0-9-])`).test(String(body ?? ""));
}

// ------------------------- topic grouping (ticket 221) ---------------------
// One card per topic: follow-up consults on the same topic bind to the same
// GitHub issue instead of opening a card each. Topic identity mirrors the
// Sol-confirmed affinity contract (consult-affinity.mjs): a hub issue number
// wins outright (never overridden by text); otherwise the exact normalized
// topic. NO fuzzy matching — a merely similar topic stays its own card.
export function topicKeyOf({ hubIssue = null, topic = null } = {}) {
  const n = (typeof hubIssue === "number" && Number.isInteger(hubIssue) && hubIssue > 0) ? hubIssue
    : ((typeof hubIssue === "string" && /^\d+$/.test(hubIssue.trim())) ? parseInt(hubIssue.trim(), 10) : null);
  if (n) return `hub-${n}`;
  // Strip the kit's own "Consult |" title scaffolding (all consult ledger
  // titles carry it), then the shared normalizer; cap length for markers.
  const t = normalizeTopic(String(topic ?? "").replace(/^\s*consult\s*\|\s*/i, "")).replace(/--+/g, "-");
  if (!t) return null;
  return `topic-${t.slice(0, 100)}`;
}
export function topicMarker(key) { return `Consult-Topic:${key}`; }
export function exactTopicMarker(body, key) {
  return new RegExp(`(?<![0-9A-Za-z-])Consult-Topic:${escapeRe(key)}(?![0-9-])`).test(String(body ?? ""));
}

function githubJsonPath(runId, subDir = null) { return join(runsRoot(), ...(subDir ? [subDir, runId] : [runId]), "github.json"); }
function loadGithubJson(runId, subDir = null) {
  try { return JSON.parse(readFileSync(githubJsonPath(runId, subDir), "utf8")); } catch { return null; }
}
function saveGithubJson(runId, obj, subDir = null) {
  try {
    // atomic write (kit convention): temp + rename
    const tmp = githubJsonPath(runId, subDir) + ".tmp";
    writeFileSync(tmp, JSON.stringify({ runId, ...obj, updatedAt: new Date().toISOString() }, null, 1));
    renameSync(tmp, githubJsonPath(runId, subDir));
  } catch { /* best-effort cache; marker search is the fallback */ }
}
import { renameSync } from "node:fs";

// ----------------------------- issue body --------------------------------
export function buildIssueBody({ runNumber, caseId, title, task, sourceInterface, mode, runType, topicKey }) {
  return [
    "## Objective",
    (title ?? task ?? "(untitled)").slice(0, 400),
    "",
    "## Source",
    `Interface: ${sourceInterface ?? "System"}`,
    `Orchestration Run: ${runNumber != null ? `Run ${String(runNumber).padStart(3, "0")}` : "(unnumbered)"}`,
    caseId ? `Case: \`${caseId}\`` : null,
    mode ? `Mode: ${mode}` : null,
    "",
    "## Classification",
    "Type: auto (see Project fields)",
    "",
    "## Current State",
    "Maintained automatically by the orchestration coordinator.",
    "",
    "## Result",
    "Pending.",
    "",
    `<!-- ${runMarker(runNumber)} ${caseId ? caseMarker(caseId) : ""}${topicKey ? ` ${topicMarker(topicKey)}` : ""} -->`,
  ].filter((l) => l !== null).join("\n");
}

// --------------------------- state projection ----------------------------
// Map coordinator state → GitHub projection. Sol: REMEDIATION_EXHAUSTED and
// ABORTED map to Blocked (honest: work is not executing) — never In Progress.
export function mapCoordinatorState(st) {
  // Ticket 138: consult payloads map through the SAME state machine — the
  // consult helper pre-translates terminal into COMPLETED (Done+closed);
  // active consults surface as In Progress (never Ready — a consult with a
  // number is real work in flight).
  if (st.runType === "consult" && st.runState === "RUNNING") {
    return { status: "In Progress", closed: false, note: "consult in progress" };
  }
  const runState = st.runState ?? "RUNNING";
  const pa = st.finalAcceptance;
  if (runState === "COMPLETED" || runState === "COMPLETED_UNREVIEWED" || runState === "COMPLETED_OPERATOR_ACCEPTED") {
    return { status: "Done", closed: true, reason: "completed", note: runState === "COMPLETED_UNREVIEWED" ? "closed unreviewed (--skip-review)" : null };
  }
  if (runState === "NEEDS_HUMAN_REVIEW") return { status: "Blocked", closed: false, note: "final acceptance needs operator decision" };
  if (runState === "REMEDIATION_EXHAUSTED") return { status: "Blocked", closed: false, note: `review still failing after bounded loop at phase ${st.blockedAtPhase ?? "?"} — operator decides` };
  if (runState === "ABORTED") return { status: "Blocked", closed: false, note: "run aborted — awaiting operator direction" };
  if (runState === "PLANNED") return { status: "Ready", closed: false };
  // RUNNING: explicit projectionPhase (from the two deliberate signals) wins.
  if (st.projectionPhase === "Review") return { status: "Review", closed: false };
  if (st.projectionPhase === "Validation") return { status: "Validation", closed: false };
  if (st.lastError) return { status: "Blocked", closed: false, note: String(st.lastError).slice(0, 300) };
  if (st.currentPhase != null) return { status: "In Progress", closed: false, note: `phase ${st.currentPhase}` };
  return { status: "Ready", closed: false };
}

// --------------------- consult projection (ticket 142) ---------------------
// Ticket 129 covered only orchestration runs (writeState funnel); every real
// post-89 run was a CONSULT and never reached GitHub (Sol CONFIRMED 2026-09-28,
// session 2026-09-27T19-24-51). This helper derives the canonical consult
// projection from the authoritative consult records — case.json (policyVersion
// 2) for identity/state, meta.json for terminal stamp, ledger (run-registry)
// for runNumber/title — and feeds the ONE existing syncRun path. NO second
// GitHub implementation (Sol watch-out): same identity markers, same
// serialization, same dedupe, same fail-open.
export function mapConsultState(cs, meta) {
  const metaState = String(meta?.state ?? "");
  const csStatus = String(cs?.status ?? "");
  const terminal = metaState === "done" || metaState === "closed" ||
    csStatus === "complete" || csStatus === "result_ready_signoff_failed";
  if (terminal) {
    return { status: "Done", closed: true, reason: "completed", runState: "COMPLETED",
      note: csStatus === "result_ready_signoff_failed" ? "consult terminal (signoff retry pending)" : "consult session terminal" };
  }
  // Ticket 214: a consult idle >24h with no recorded close was abandoned (the
  // 73 stale open issues). Close it honestly instead of showing In Progress forever.
  const last = Number(meta?.lastAt ?? meta?.heartbeatAt ?? meta?.startedAt ?? 0);
  if (last && Date.now() - last > 24 * 3600_000) {
    return { status: "Done", closed: true, reason: "completed", runState: "COMPLETED", abandoned: true,
      note: "consult idle >24h with no recorded close (auto-closed)" };
  }
  return { status: "In Progress", closed: false, runState: "RUNNING", note: "consult in progress" };
}

// Ticket 214: human-useful resolution text for a finished consult, derived from
// authoritative disk records (meta.closeReason + last consultant turn).
// Confidential consults withhold content.
export function deriveConsultResult(dir, caseData = null, meta = null) {
  try {
    if (caseData?.confidential) return "_Confidential consult — details withheld._";
    const lines = [];
    const reason = String(meta?.closeReason ?? caseData?.checkpoints?.find((c) => c.event === "consult_complete")?.detail?.note ?? "").trim();
    let verdict = "", consultant = "", turns = meta?.turns ?? null;
    try {
      const t = readFileSync(join(dir, "transcript.md"), "utf8");
      const parts = t.split(/\n## CONSULTANT \(([^)]*)\)[^\n]*\n/);
      if (parts.length >= 3) {
        consultant = parts[parts.length - 2];
        let last = parts[parts.length - 1].split(/\n## SESSION CLOSED/)[0];
        last = last.replace(/^\s*(…|\.\.\.)?\s*Show more\s*/i, "").replace(/ChatGPT said:\s*/g, "").trim();
        const m = /(?:^|\n)\s*(VERDICT:[^\n]+)/i.exec(last);
        verdict = (m ? m[1] : last.split(/\n\s*\n/)[0]).replace(/\s+/g, " ").trim().slice(0, 700);
        const na = /NEXT ACTIONS[^\n]*\n+([\s\S]{0,700}?)(?:\n\s*\n|$)/i.exec(last);
        if (na && !m) verdict += " " + na[1].replace(/\s+/g, " ").slice(0, 300);
      }
    } catch { }
    if (reason) lines.push(`**Outcome:** ${reason.slice(0, 700)}`);
    if (verdict) lines.push(`**Consultant answer:** ${verdict}`);
    const meta2 = [consultant && `consultant ${consultant}`, turns != null && `${turns} turn(s)`].filter(Boolean).join(" · ");
    if (meta2) lines.push(`**Session:** ${meta2}`);
    return lines.length ? lines.join("\n\n") : null;
  } catch { return null; }
}

// Ticket 214: resolution text for an orchestration run from its deterministic
// debrief.md (structured facts only) + state.json final acceptance verdict.
export function deriveRunResult(dir, st = null) {
  try {
    if (st?.confidential) return "_Confidential run — details withheld._";
    const sec = (md, name) => {
      const m = new RegExp(`## ${name}\\n([\\s\\S]*?)(?:\\n## |$)`).exec(md);
      return m ? m[1].trim() : "";
    };
    let md = "";
    try { md = readFileSync(join(dir, "debrief.md"), "utf8"); } catch { }
    const out = [];
    const outcome = /^Outcome:\s*(.+)$/m.exec(sec(md, "TASK / OUTCOME"))?.[1];
    out.push(`**Outcome:** ${outcome ?? st?.runState ?? "unknown"}`);
    const fa = st?.finalAcceptance?.verdict;
    if (fa) out.push(`**Final acceptance:** ${fa}${st.finalAcceptance.attempts ? ` (${st.finalAcceptance.attempts} attempt(s))` : ""}`);
    const exec = sec(md, "EXECUTION SUMMARY"); if (exec) out.push(`**Execution:** ${exec.replace(/\s+/g, " ").slice(0, 300)}`);
    const ph = sec(md, "PHASES / GATES"); if (ph) out.push(`**Phases:** ${ph.split("\n").join("; ").slice(0, 300)}`);
    const fi = sec(md, "FINDINGS"); if (fi) out.push(`**Findings:** ${fi.replace(/\s+/g, " ").slice(0, 400)}`);
    const fl = sec(md, "FAILURES / RECOVERIES"); if (fl) out.push(`**Failures/recoveries:** ${fl.split("\n").slice(0, 4).join("; ").slice(0, 400)}`);
    if (st?.abortedReason) out.push(`**Ended because:** ${String(st.abortedReason).slice(0, 300)}`);
    return out.join("\n\n");
  } catch { return null; }
}

// Build a syncRun payload for one consult session. Returns null when the
// session has no ledger runNumber (pre-allocation stubs stay untracked).
// Ledger title (buildRunIndex) wins; caseId = the consult dir id.
export function buildConsultPayload(dirName, { caseData = null, meta = null, ledgerEntry = null } = {}) {
  const runNumber = caseData?.runNumber ?? ledgerEntry?.runNumber ?? null;
  if (runNumber == null) return null;
  const mapped = mapConsultState(caseData, meta);
  const mode = String(caseData?.engine ?? meta?.engine ?? ledgerEntry?.engine ?? "");
  const sourceInterface = caseData?.authority?.launchedBy ??
    (String(mode).includes("codex") ? "Codex" : "Freebuff");
  return {
    runNumber,
    caseId: dirName,
    runState: mapped.runState,
    runType: "consult",
    projectionPhase: null,
    task: `Consult session ${dirName}${ledgerEntry?.title ? ` — ${ledgerEntry.title}` : ""}`,
    title: ledgerEntry?.title ?? `Run ${runNumber}`,
    mode: mode || null,
    sourceInterface,
    resultSummary: mapped.note ?? null,
    resultMd: mapped.closed && dirName ? deriveConsultResult(join(runsRoot(), "consult", dirName), caseData, meta) : null,
    // Ticket 221: topic grouping — follow-ups share the topic's card.
    topicKey: topicKeyOf({ hubIssue: caseData?.issueNumber ?? null, topic: ledgerEntry?.title ?? caseData?.task ?? null }),
    _terminal: mapped,
  };
}

// One-shot consult sync (ticket 142): derive payload from disk + sync. Called
// ONLY from authoritative consult terminal transitions (cmdConsultEnd --end
// path, cmdConsultEnd orphan-close path, nanny orphan sweep) and reconcileScan.
// Fire-and-forget, fail-open by contract; callers never await projection.
export function syncConsultTerminal(dirName, { runsRootOverride = null } = {}) {
  try {
    const root = runsRootOverride ?? runsRoot();
    const dir = join(root, "consult", dirName);
    let caseData = null, meta = null;
    try { caseData = JSON.parse(readFileSync(join(dir, "case.json"), "utf8")); } catch { }
    try { meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")); } catch { }
    if (!caseData && !meta) return Promise.resolve({ ok: false, skipped: true, why: "no-consult-record" });
    let ledgerEntry = null;
    try {
      // Derived ledger index (run-ledger.jsonl is authoritative); torn tail →
      // buildRunIndex throws → fail-open with title fallback.
      const idx = buildRunIndex(stateRoot());
      ledgerEntry = caseData?.runNumber != null ? idx?.[caseData.runNumber] ?? null : null;
    } catch { }
    const payload = buildConsultPayload(dirName, { caseData, meta, ledgerEntry });
    if (!payload) return Promise.resolve({ ok: false, skipped: true, why: "unnumbered" });
    // Normalize payload for syncRun: swap our _terminal mapping for explicit
    // coordinator-style fields mapCoordinatorState already understands.
    const { _terminal, ...stdPayload } = payload;
    return syncRun(dirName, stdPayload, { runsSubdir: "consult" }).then((r) => ({ ...r, consult: true }));
  } catch (e) {
    return Promise.resolve({ ok: false, error: String(e?.message ?? e).slice(0, 240), code: "CONSULT_SYNC" });
  }
}

// ---------------------------- core operations ----------------------------
async function searchIssueByMarker(runNumber) {
  const cfg = ghSyncConfig();
  const r = await mcpHandshakeCall("search_issues", {
    query: `repo:${cfg.owner}/${cfg.repo} "${runMarker(runNumber)}" in:body`,
    perPage: 5,
  });
  const items = r.parsed?.items ?? r.parsed ?? [];
  const candidates = (Array.isArray(items) ? items : []).filter((x) => x.number != null);
  // Ticket 142 live-learned (2026-09-28): GitHub issue search is TOKEN-based —
  // "Orchestra-Run:1" in:body matched issues carrying Orchestra-Run:84 etc.,
  // binding consults to WRONG issues and polluting bodies via the Case-ID
  // convergence patch. VERIFY the exact marker in the fetched body before
  // trusting a hit (boundary-safe helper, regression-tested).
  for (const c of candidates) {
    try {
      const rr = await mcpHandshakeCall("issue_read", { owner: cfg.owner, repo: cfg.repo, method: "get", issue_number: c.number });
      const iss = rr?.parsed !== undefined ? (typeof rr.parsed === "string" ? (() => { try { return JSON.parse(rr.parsed); } catch { return null; } })() : rr.parsed) : rr;
      const body = String(iss?.body ?? "");
      if (exactRunMarker(body, runNumber)) return { number: c.number, url: c.html_url ?? c.url ?? iss?.html_url, title: iss?.title ?? c.title, state: iss?.state ?? c.state };
    } catch { /* unreadable candidate → not verified → skipped */ }
  }
  return null;
}

// Ticket 221: topic discovery for consult follow-ups. Own run-marker card
// wins if present (transition-period safety); otherwise bind to the earliest
// (lowest-numbered) verified topic card. Returns topicBound:true on a topic
// match so callers skip per-run body convergence on the shared card.
async function searchIssueByTopic(payload) {
  const own = await searchIssueByMarker(payload.runNumber);
  if (own) return own;
  const cfg = ghSyncConfig();
  const r = await mcpHandshakeCall("search_issues", {
    query: `repo:${cfg.owner}/${cfg.repo} "${topicMarker(payload.topicKey)}" in:body`,
    perPage: 10,
  });
  const items = r.parsed?.items ?? r.parsed ?? [];
  const candidates = (Array.isArray(items) ? items : []).filter((x) => x.number != null);
  let best = null;
  for (const c of candidates) {
    try {
      const rr = await mcpHandshakeCall("issue_read", { owner: cfg.owner, repo: cfg.repo, method: "get", issue_number: c.number });
      const iss = rr?.parsed !== undefined ? (typeof rr.parsed === "string" ? (() => { try { return JSON.parse(rr.parsed); } catch { return null; } })() : rr.parsed) : rr;
      const body = String(iss?.body ?? "");
      if (!exactTopicMarker(body, payload.topicKey)) continue;
      if (!best || c.number < best.number) best = { number: c.number, url: c.html_url ?? c.url ?? iss?.html_url, title: iss?.title ?? c.title, state: iss?.state ?? c.state, topicBound: true };
    } catch { /* unreadable candidate → skipped */ }
  }
  return best;
}

async function createIssue({ runNumber, caseId, title, task, sourceInterface, mode, topicKey }) {
  const cfg = ghSyncConfig();
  const r = await mcpHandshakeCall("issue_write", {
    owner: cfg.owner, repo: cfg.repo, method: "create",
    title: `${title ?? `Run ${runNumber}`}`.slice(0, 120),
    body: buildIssueBody({ runNumber, caseId, title, task, sourceInterface, mode, topicKey }),
    labels: [],
  });
  // issue_write create returns {"id":<internal>, "url":"…/issues/<n>"} —
  // the number rides in the url, not as a field (verified live, ticket 129).
  const num = r.parsed?.number ?? (Number(String(r.parsed?.url ?? "").match(/\/issues\/(\d+)$/)?.[1]) || null);
  if (num == null) throw Object.assign(new Error(`ISSUE_CREATE_NO_NUMBER: ${String(r.raw).slice(0, 160)}`), { code: "ISSUE_CREATE_NO_NUMBER" });
  return { number: num, url: r.parsed?.html_url ?? r.parsed?.url ?? `https://github.com/${ghSyncConfig().owner}/${ghSyncConfig().repo}/issues/${num}` };
}

async function addComment(issueNumber, marker, text) {
  // Deduped comments: search the issue body context is expensive; instead the
  // marker line makes retries produce the SAME text, and we check recent
  // comments first via list (bounded).
  const cfg = ghSyncConfig();
  // Ticket 214: list_issue_comments does not exist in github-mcp-server 1.30
  // (the old call always failed -> never deduped -> hourly duplicate comments).
  // Correct API: issue_read method=get_comments, paginated. FAIL CLOSED: if the
  // listing cannot be read we do NOT post (no unverifiable duplicates).
  let arr = [];
  for (let page = 1; page <= 10; page++) {
    const list = await mcpHandshakeCall("issue_read", { owner: cfg.owner, repo: cfg.repo, method: "get_comments", issue_number: issueNumber, page, perPage: 100 }).catch(() => null);
    if (!list) return { skipped: true, why: "comment-list-unavailable" };
    const c = list.parsed;
    const chunk = Array.isArray(c) ? c : (c?.comments ?? []);
    arr = arr.concat(chunk);
    if (chunk.length < 100) break;
  }
  if (arr.some((c) => String(c.body ?? "").includes(`<!-- ${marker} -->`))) return { deduped: true };
  const r = await mcpHandshakeCall("add_issue_comment", { owner: cfg.owner, repo: cfg.repo, issue_number: issueNumber, body: `${text}\n\n<!-- ${marker} -->` });
  return { created: true, id: r.parsed?.id ?? null };
}

// Ticket 214: replace the "## Result" section of an issue body (keeps marker).
export function withResultSection(body, resultMd) {
  const b = String(body ?? "");
  const re = /(## Result\n)[\s\S]*?(\n\n?<!-- Orchestra-Run:)/;
  if (!re.test(b)) return b;
  return b.replace(re, (_m, a, z) => `${a}${resultMd}\n${z.startsWith("\n\n") ? z : "\n" + z}`);
}

// Ticket 220: read back the remote issue state (open/closed/null-unreadable).
// Local flags must never assert what GitHub was never confirmed to have.
async function readIssueState(issueNumber) {
  const cfg = ghSyncConfig();
  const r = await mcpHandshakeCall("issue_read", { owner: cfg.owner, repo: cfg.repo, method: "get", issue_number: issueNumber });
  const iss = typeof r.parsed === "string" ? JSON.parse(r.parsed) : r.parsed;
  return iss?.state ?? null;
}

async function updateIssueState(issueNumber, { close, reason, commentText, commentMarker, resultMd }) {
  const cfg = ghSyncConfig();
  let newBody = null, comment = null;
  if (resultMd) {
    try {
      const r = await mcpHandshakeCall("issue_read", { owner: cfg.owner, repo: cfg.repo, method: "get", issue_number: issueNumber });
      const iss = typeof r.parsed === "string" ? JSON.parse(r.parsed) : r.parsed;
      const nb = withResultSection(iss?.body, resultMd);
      if (nb && nb !== iss?.body) newBody = nb;
    } catch { /* body refresh is best-effort */ }
  }
  if (commentText) comment = await addComment(issueNumber, commentMarker ?? `ghsync-${Date.now()}`, commentText);
  await mcpHandshakeCall("issue_write", {
    owner: cfg.owner, repo: cfg.repo, method: "update", issue_number: issueNumber,
    state: close ? "closed" : "open",
    ...(close && reason ? { state_reason: reason } : {}),
    ...(newBody ? { body: newBody } : {}),
  });
  // Ticket 214 repair: report whether the resolution comment actually landed
  // (null = no comment requested; {skipped} = list unreadable, fail-closed).
  return { comment };
}

// ------------------------- project item operations -----------------------
async function ensureProjectItem(issueNumber, cfg) {
  // add_project_item is idempotent-ish: re-adding an existing item errors or
  // returns the same item. We resolve by (owner, repo, issue_number) in
  // update calls, so we never need to persist item id — but we try to capture it.
  const r = await mcpHandshakeCall("projects_write", {
    method: "add_project_item", owner: cfg.owner, project_number: cfg.projectNumber,
    item_type: "issue", item_owner: cfg.owner, item_repo: cfg.repo, issue_number: issueNumber,
  });
  const id = r.parsed?.id ?? r.parsed?.item_id ?? null;
  return { itemId: id, raw: r.raw?.slice(0, 200) };
}

async function setProjectFields(issueNumber, fields, cfg) {
  // One update_project_item per field via the name form (validated options).
  // Status is a REQUIRED default field on every project; custom fields were
  // created by gh-sync-setup with exact names.
  for (const [fieldName, value] of Object.entries(fields)) {
    if (value == null) continue;
    await mcpHandshakeCall("projects_write", {
      method: "update_project_item", owner: cfg.owner, project_number: cfg.projectNumber,
      item_owner: cfg.owner, item_repo: cfg.repo, issue_number: issueNumber,
      updated_field: { name: fieldName, value },
    });
  }
}

// ------------------------------ syncRun ----------------------------------
// The ONE shared entry point. Called from the writeState funnel (fire-and-
// forget) and from explicit signals and the reconcile verb.
export async function syncRun(runId, payload, opts = {}) {
  const cfg = ghSyncConfig();
  if (!cfg.enabled) return { ok: false, skipped: true, why: "disabled" };
  if (!cfg.owner || !cfg.repo) return { ok: false, skipped: true, why: "unconfigured" };
  if (!cfg.projectNumber) return { ok: false, skipped: true, why: "no-project" };
  if (payload.runNumber == null) return { ok: false, skipped: true, why: "unnumbered" };
  // Closure stamp for the archive sweep (deterministic 14d policy input).
  if (payload.runState && ["COMPLETED", "COMPLETED_UNREVIEWED", "COMPLETED_OPERATOR_ACCEPTED"].includes(payload.runState)) {
    try {
      const p = githubJsonPath(runId, opts.runsSubdir ?? null);
      const cur = loadGithubJson(runId, opts.runsSubdir ?? null);
      if (cur && !cur.closedAt) saveGithubJson(runId, { ...cur, closedAt: new Date().toISOString() }, opts.runsSubdir ?? null);
      else if (!cur) { /* identity not yet resolved; syncRun below stamps after create/rediscovery */ }
    } catch { }
  }

  return serialize(runId, async () => {
    const markerFile = inflightMarker(runId);
    try { writeFileSync(markerFile, new Date().toISOString()); } catch { }
    try {
      const tun = { ok: true };
      if (!testTransport) {
        const tunReal = await ensureGhMcpTunnel({ port: cfg.tunnelPort });
        if (!tunReal.ok) throw Object.assign(new Error(`tunnel ${tunReal.code}`), { code: "GH_TUNNEL" });
        // MCP reachability check: a healthy-looking tunnel to a DEAD upstream
        // must fail as GH_UNREACHABLE, not hang through spawn retries.
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 2500);
        try {
          const probe = await fetch(`http://127.0.0.1:${cfg.tunnelPort}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: "p", method: "ping" }), signal: ctl.signal });
          if (probe.status >= 500) throw new Error(`mcp http ${probe.status}`);
        } catch (e) {
          throw Object.assign(new Error(`MCP_UNREACHABLE on 127.0.0.1:${cfg.tunnelPort}: ${String(e?.message ?? e).slice(0, 80)}`), { code: "GH_UNREACHABLE" });
        } finally { clearTimeout(t); }
      }

      // 1. Identity: cache re-read UNDER the serialization slot (Sol #1).
      const ghSub = opts.runsSubdir ?? null;
      let identity = loadGithubJson(runId, ghSub);
      // 2. Reconcile/rediscovery mode: ignore cache, find by marker.
      if (opts.forceRediscover) identity = null;
      if (!identity && !opts.skipDiscovery) {
        const forTopic = payload.runType === "consult" && payload.topicKey;
        const found = testTransport
          ? await (forTopic && testTransport.searchIssueByTopic
              ? testTransport.searchIssueByTopic(payload.topicKey)
              : testTransport.searchIssueByMarker(payload.runNumber))
          : await (forTopic ? searchIssueByTopic(payload) : searchIssueByMarker(payload.runNumber)).catch((e) => { throw Object.assign(e, { code: e.code ?? "GH_SEARCH" }); });
        if (found) identity = { issueNumber: found.number, issueUrl: found.url, discoveredAt: new Date().toISOString(), ...(forTopic && found.topicBound ? { topicBound: true } : {}) };
      }
      // 3. Create only if still absent (inside the slot).
      if (!identity && !opts.skipDiscovery) {
        const created = testTransport ? await testTransport.createIssue({ ...payload }) : await createIssue({ ...payload });
        identity = { issueNumber: created.number, issueUrl: created.url, created: true };
        ghLogRun(runId, `issue #${created.number} created for Run ${payload.runNumber} (${payload.sourceInterface ?? "System"})`);
      }
      if (!identity) return { ok: false, skipped: true, why: "no-identity" };
      if (opts.discoverOnly) {
        saveGithubJson(runId, identity, ghSub);
        return { ok: true, identity };
      }
      // 3b. Case-ID marker convergence (Sol acceptance fix, ticket 129): issues
      // created before the caseId payload existed carry only Orchestra-Run —
      // patch the Case-ID marker in via a bounded body update. Stamped only on
      // success so a transiently failed patch self-heals on the next sync /
      // reconcile scan (Sol turn-2 watch-out; each attempt is bounded, so a
      // persistent GitHub failure retries per sync without blocking anything).
      if (payload.caseId && !identity.caseIdStamped && !identity.topicBound) {
        let stamped = true; // body already correct or nothing to do → done
        try {
          const cfgX = cfg;
          const r = testTransport ? { parsed: await testTransport.issueRead(identity.issueNumber) }
            : await mcpHandshakeCall("issue_read", { owner: cfgX.owner, repo: cfgX.repo, method: "get", issue_number: identity.issueNumber });
          const iss = r?.parsed !== undefined ? (typeof r.parsed === "string" ? (() => { try { return JSON.parse(r.parsed); } catch { return null; } })() : r.parsed) : r;
          const body = String(iss?.body ?? "");
          // Ticket 142 (Sol turn-2): boundary-safe Case-ID check — a foreign
          // longer Case-ID that merely STARTS WITH ours must not count as
          // "already stamped".
          if (body && !exactCaseMarker(body, payload.caseId)) {
            const newBody = body.replace(/(<!--\s*Orchestra-Run:\d+)/, `$1 ${caseMarker(payload.caseId)}`);
            if (newBody !== body) {
              if (testTransport?.updateIssueBody) await testTransport.updateIssueBody(identity.issueNumber, newBody);
              else if (!testTransport) await mcpHandshakeCall("issue_write", { owner: cfgX.owner, repo: cfgX.repo, method: "update", issue_number: identity.issueNumber, body: newBody });
              ghLogRun(runId, `issue #${identity.issueNumber}: Case-ID marker converged`);
            }
          } else if (!body) {
            stamped = false; // unreadable body → retry next sync
          }
        } catch (e) { stamped = false; ghLogRun(runId, `caseId marker convergence deferred: ${String(e?.message ?? e).slice(0, 120)}`); }
        if (stamped) identity.caseIdStamped = true;
      }
      // Stamp closedAt after identity resolution on terminal-closed states.
      if (["COMPLETED", "COMPLETED_UNREVIEWED", "COMPLETED_OPERATOR_ACCEPTED"].includes(payload.runState) && !identity.closedAt) {
        identity.closedAt = new Date().toISOString();
      }

      // 4. Converge project membership + fields.
      if (testTransport) await testTransport.ensureProjectItem(identity.issueNumber);
      else {
        const proj = await ensureProjectItem(identity.issueNumber, cfg);
        if (proj.itemId && !identity.projectItemId) identity.projectItemId = proj.itemId;
      }
      const mapped = mapCoordinatorState(payload);
      if (testTransport) await testTransport.setProjectFields(identity.issueNumber, {
        Status: mapped.status,
        "Source Interface": payload.sourceInterface ?? "System",
        "Source Run": payload.runNumber != null ? `Run ${String(payload.runNumber).padStart(3, "0")}` : null,
      });
      else await setProjectFields(identity.issueNumber, {
        Status: mapped.status,
        "Source Interface": payload.sourceInterface ?? "System",
        "Source Run": payload.runNumber != null ? `Run ${String(payload.runNumber).padStart(3, "0")}` : null,
      }, cfg);

      // 5. Lifecycle comment on state CHANGES only (bounded, deduped).
      const prevStatus = identity.lastStatus;
      // Ticket 214: no "Status →" comments in production — the Project board
      // already shows status; those were pure noise. Tests keep the old hook.
      if (mapped.status !== prevStatus) {
        if (testTransport) await Promise.resolve(testTransport.addComment(identity.issueNumber, `ghsync-status-${mapped.status}-${payload.runNumber}`, `Status → **${mapped.status}**${mapped.note ? ` — ${mapped.note}` : ""}`));
        identity.lastStatus = mapped.status;
      }

      // 6. Closure / reopen (converged both ways — coordinator is authority).
      // Close path ALWAYS re-issues the close (idempotent server-side; the
      // explicit state_reason=completed also repairs items closed by the
      // issue_write update path, which drops state_reason when already closed).
      if (mapped.closed) {
        // Ticket 214: close ONCE (guarded below by wasClosed+resultStamped).
        // Ticket 220: flags are set ONLY after the remote state confirms the
        // write — a failed close must retry next sync, never park as phantom-Done.
        if (identity.wasClosed && identity.resultStamped) { /* already converged */ }
        else if (testTransport) { await testTransport.updateIssueState(identity.issueNumber, { close: true, reason: "completed" }); identity.wasClosed = true; }
        else {
          const resultMd = payload.resultMd ?? null;
          const up = await updateIssueState(identity.issueNumber, {
            close: true, reason: mapped.reason ?? "completed", resultMd,
            commentText: resultMd ? `### Resolution — run ${payload.runNumber}\n\n${resultMd}` : `Closed — run ${payload.runNumber} reached ${payload.runState}.`,
            commentMarker: `ghsync-close-${payload.runNumber}-${payload.runState}`,
          }).catch(() => null);
          const remote = up ? await readIssueState(identity.issueNumber).catch(() => null) : null;
          if (remote === "closed") {
            identity.wasClosed = true;
            if (up?.comment?.created || up?.comment?.deduped) identity.resultStamped = true;
          } else if (remote === "open") {
            ghLogRun(runId, `close unconfirmed for #${identity.issueNumber} (remote still open) — will retry`);
          }
          // remote null (unreadable): flags stay unset → safe retry next sync
          // (comment deduped by marker, body converge idempotent, close idempotent).
        }
      } else if (identity.wasClosed) {
        // Reopened work: coordinator resumed a previously-terminal run — the
        // issue must reopen and return to the mapped active status (plan §Reopened).
        if (testTransport) await testTransport.updateIssueState(identity.issueNumber, { close: false });
        else {
          await updateIssueState(identity.issueNumber, {
            close: false,
            commentText: `Issue reopened — run ${payload.runNumber} resumed (${payload.runState}${payload.currentPhase != null ? `, phase ${payload.currentPhase}` : ""}).`,
            commentMarker: `ghsync-reopen-${payload.runNumber}-${new Date(identity.reopenStamp ?? Date.now()).toISOString().slice(0, 10)}`,
          }).catch(() => { });
          const remote = await readIssueState(identity.issueNumber).catch(() => null);
          if (remote === "open" || remote === null) {
            // null (unreadable) still clears the flag: coordinator is authority
            // that work resumed, and reopen is idempotent server-side.
            identity.wasClosed = false;
          }
        }
      }

      // Ticket 214: non-closed states with a known outcome (e.g. Blocked) also
      // converge the Result body section so the issue shows what happened —
      // no comment, no state change, body only (idempotent).
      if (!mapped.closed && payload.resultMd && !testTransport) {
        await updateIssueState(identity.issueNumber, { close: false, resultMd: payload.resultMd }).catch(() => { });
      }

      saveGithubJson(runId, identity, ghSub);
      return { ok: true, identity, status: mapped.status };
    } catch (e) {
      ghLogRun(runId, `github_sync_failed: ${String(e?.message ?? e).slice(0, 240)}`);
      return { ok: false, error: String(e?.message ?? e).slice(0, 240), code: e?.code ?? "GH_SYNC" };
    } finally {
      try { rmSync(inflightMarker(runId), { force: true }); } catch { }
    }
  });
}

// Bounded fire-and-forget for the writeState funnel: wait up to timeoutMs, but
// NEVER abandon the underlying work (serialization keeps it tracked) — the
// funnel just stops waiting (Sol #1 timeout semantics).
export function syncRunBounded(runId, payload, timeoutMs) {
  const ms = timeoutMs ?? ghSyncConfig().syncTimeoutMs ?? 8000;
  return Promise.race([
    syncRun(runId, payload).catch(() => { }),
    new Promise((res) => setTimeout(() => res({ ok: null, timedOut: true }), ms)),
  ]);
}

// ------------------------------ reconcile --------------------------------
// gh-sync --scan: one-way repair. Reads coordinator state, converges GitHub.
// NEVER the reverse. Also the deterministic 14-day archive sweep (Sol #3).
export async function reconcileScan({ archiveDays } = {}) {
  const cfg = ghSyncConfig();
  if (!cfg.enabled || !cfg.projectNumber) return { ok: false, why: "disabled-or-unconfigured" };
  const out = { scanned: 0, synced: 0, failed: 0, archived: 0, details: [] };
  const tun = await ensureGhMcpTunnel({ port: cfg.tunnelPort });
  if (!tun.ok) return { ok: false, why: `tunnel ${tun.code}` };

  // 1. Active + recent runs with run numbers → converge projection.
  // Ticket 220: pre-ledger runs carry no runNumber in state.json — resolve it
  // from the ledger by caseId (= dir name) so they stay visible to repair.
  let ledgerByCase = null;
  function runNumberForCase(cid) {
    if (!ledgerByCase) {
      ledgerByCase = {};
      try {
        for (const line of readFileSync(join(stateRoot(), "run-ledger.jsonl"), "utf8").split("\n")) {
          try { const e = JSON.parse(line); if (e.event === "run_allocated" && e.caseId) ledgerByCase[e.caseId] = e.runNumber; } catch { }
        }
      } catch { }
    }
    return ledgerByCase[cid] ?? null;
  }
  let runDirs = [];
  try { runDirs = (await import("node:fs")).readdirSync(runsRoot(), { withFileTypes: true }).filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}T/.test(d.name)).map((d) => d.name); } catch { }
  for (const id of runDirs) {
    try {
      // Ticket 138 hermeticity fix: read via runsRoot() (sandbox-aware), not
      // the hardcoded RUNS constant — tests must never touch the real runs dir.
      const st = JSON.parse(readFileSync(join(runsRoot(), id, "state.json"), "utf8"));
      const runNumber = st.runNumber ?? runNumberForCase(id);
      if (runNumber == null) continue;
      out.scanned++;
      // Converge only runs that already have an identity or a terminal/active
      // state worth projecting; skip untracked PLANNED-only ghosts older than
      // a day unless they are the CURRENT run.
      const hasGh = existsSync(githubJsonPath(id));
      const terminal = ["COMPLETED", "COMPLETED_UNREVIEWED", "COMPLETED_OPERATOR_ACCEPTED", "NEEDS_HUMAN_REVIEW", "REMEDIATION_EXHAUSTED", "ABORTED"].includes(st.runState);
      if (!hasGh && st.runState === "PLANNED") continue;
      if (!hasGh && !terminal && !st.currentPhase) continue;
      // Retroactive-flood guard: a run WITHOUT an existing GitHub identity is
      // only CREATED-for during reconcile if it is recent (state.json mtime
      // ≤7d) or live. Old finished runs pre-dating the integration stay
      // untracked instead of flooding GitHub on the first scan.
      if (!hasGh) {
        try {
          const mt = (await import("node:fs")).statSync(join(runsRoot(), id, "state.json")).mtimeMs;
          const live = st.runState === "RUNNING";
          if (!live && Date.now() - mt > 7 * 86400_000) { out.details.push(`${id}: skipped (old untracked run)`); continue; }
        } catch { continue; }
      }
      const r = await syncRun(id, { ...st, runNumber, sourceInterface: st.sourceInterface ?? "System", resultMd: terminal ? deriveRunResult(join(runsRoot(), id), st) : null }, { skipDiscovery: false });
      if (r.ok) out.synced++; else if (!r.skipped) { out.failed++; out.details.push(`${id}: ${r.error ?? "?"}`); }
      else out.details.push(`${id}: skipped (${r.why})`);
    } catch { /* unreadable run dir — skip */ }
  }

  // 1b. Consult sessions (ticket 142): runs/consult/<id>/case.json with a
  // valid ledger runNumber — same flood guard, same dedupe, same lifecycle.
  // Sol: hooks give liveness; the sweep gives repair for missed hooks,
  // crashed coordinators, and historical consults (backfill 90-104).
  let consultDirs = [];
  try {
    consultDirs = (await import("node:fs")).readdirSync(join(runsRoot(), "consult"), { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}T/.test(d.name)).map((d) => d.name);
  } catch { }
  // One derived ledger index for titles + done-status (never per-consult reads).
  let idx = null;
  try { idx = buildRunIndex(stateRoot()); } catch { }
  for (const id of consultDirs) {
    try {
      const cdir = join(runsRoot(), "consult", id);
      let cs = null, meta = null;
      try { cs = JSON.parse(readFileSync(join(cdir, "case.json"), "utf8")); } catch { }
      try { meta = JSON.parse(readFileSync(join(cdir, "meta.json"), "utf8")); } catch { }
      if (!cs && !meta) continue;
      out.scanned++;
      const runNumber = cs?.runNumber ?? null;
      if (runNumber == null) continue; // pre-allocation stubs stay untracked
      const hasGh = existsSync(join(cdir, "github.json"));
      const mapped = mapConsultState(cs, meta);
      // Flood guard mirrors the orchestration half: create-for only if the
      // session is recent (≤7d since last activity) or already tracked.
      if (!hasGh) {
        let recent = false;
        for (const f of ["case.json", "meta.json", "transcript.md"]) {
          try { if (Date.now() - statSync(join(cdir, f)).mtimeMs <= 7 * 86400_000) { recent = true; break; } } catch { }
        }
        const ledgerDone = idx?.[String(runNumber)] ? ["COMPLETED", "FAILED", "STOPPED"].includes(idx[String(runNumber)].status) : false;
        if (!recent && !ledgerDone) { out.details.push(`consult ${id}: skipped (old untracked consult)`); continue; }
          }
      const payload = buildConsultPayload(id, { caseData: cs, meta, ledgerEntry: idx?.[String(runNumber)] ?? null });
      if (!payload) continue;
      const r = await syncRun(id, payload, { skipDiscovery: false, runsSubdir: "consult" });
      if (r.ok) out.synced++; else if (!r.skipped) { out.failed++; out.details.push(`consult ${id}: ${r.error ?? "?"}`); }
      else out.details.push(`consult ${id}: skipped (${r.why})`);
    } catch (e) { out.failed++; out.details.push(`consult ${id}: ${String(e?.message ?? e).slice(0, 120)}`); }
  }

  // 2. Deterministic archive: tracked closed items older than N days
  // (orchestration runs AND consult sessions, ticket 142).
  const archiveTargets = [
    ...runDirs.map((id) => ({ id, sub: null })),
    ...consultDirs.map((id) => ({ id, sub: "consult" })),
  ];
  const days = archiveDays ?? cfg.archiveAfterDays ?? 14;
  const cutoff = Date.now() - days * 86400_000;
  for (const { id, sub } of archiveTargets) {
    try {
      const gh = loadGithubJson(id, sub);
      if (!gh?.issueNumber || !gh.closedAt) continue;
      if (new Date(gh.closedAt).getTime() > cutoff) continue;
      // Verify the issue is actually closed before archiving the item.
      let parsedState = null;
      if (testTransport) {
        const iss = await testTransport.issueRead(gh.issueNumber).catch(() => null);
        parsedState = iss?.state ?? null;
      } else {
        const r = await mcpHandshakeCall("issue_read", { owner: cfg.owner, repo: cfg.repo, method: "get", issue_number: gh.issueNumber }).catch(() => null);
        parsedState = r?.parsed?.state ?? (typeof r?.parsed === "string" ? (() => { try { return JSON.parse(r.parsed).state; } catch { return null; } })() : null);
      }
      if (parsedState !== "closed") continue;
      // use the verified GraphQL mutation (Sol: deterministic mechanism).
      let archived = false;
      if (testTransport) archived = await testTransport.archiveItem(gh.issueNumber);
      else {
        const data = await gql(
          `mutation($project: ID!, $item: ID!) { archiveProjectV2Item(input: { projectId: $project, itemId: $item }) { item { id } } }`,
          { project: await projectNodeId(cfg), item: gh.projectItemId }
        ).catch(() => null);
        archived = !!data;
      }
      if (!archived) { out.details.push(`${sub ? "consult " : ""}${id}: archive failed`); continue; }
      gh.archivedAt = new Date().toISOString();
      saveGithubJson(id, gh, sub);
      out.archived++;
    } catch { /* per-run archive failures never break the sweep */ }
  }
  return out;
}

// Project node id lookup (setup caches it into config via gh-sync-setup;
// reconcile falls back to a live lookup).
async function projectNodeId(cfg) {
  const data = await gql(
    `query($owner: String!, $number: Int!) { user(login: $owner) { projectV2(number: $number) { id } } }`,
    { owner: cfg.owner, number: cfg.projectNumber }
  );
  return data?.user?.projectV2?.id;
}

// ------------------------------ selftest ---------------------------------
export function selfTest() {
  const results = [];
  const ok = (cond, msg) => results.push(`${cond ? "PASS" : "FAIL"} — ${msg}`);
  ok(runMarker(9) === "Orchestra-Run:9", "run marker format");
  ok(caseMarker("2026-09-27T05-34-21") === "Case-ID:2026-09-27T05-34-21", "case marker format");
  const body = buildIssueBody({ runNumber: 9, caseId: "c-1", title: "T", task: "do", sourceInterface: "Freebuff", mode: "dual" });
  ok(body.includes("Orchestra-Run:9") && body.includes("Case-ID:c-1"), "issue body carries both markers");
  ok(mapCoordinatorState({ runState: "COMPLETED" }).status === "Done" && mapCoordinatorState({ runState: "COMPLETED" }).closed, "COMPLETED → Done+closed");
  ok(mapCoordinatorState({ runState: "REMEDIATION_EXHAUSTED" }).status === "Blocked", "REMEDIATION_EXHAUSTED → Blocked (Sol #correction)");
  ok(mapCoordinatorState({ runState: "ABORTED" }).status === "Blocked", "ABORTED → Blocked (Sol correction)");
  ok(mapCoordinatorState({ runState: "RUNNING", projectionPhase: "Review" }).status === "Review", "explicit Review signal");
  ok(mapCoordinatorState({ runState: "RUNNING", projectionPhase: "Validation" }).status === "Validation", "explicit Validation signal");
  ok(mapCoordinatorState({ runState: "RUNNING", lastError: "x" }).status === "Blocked", "lastError → Blocked");
  ok(mapCoordinatorState({ runState: "RUNNING", currentPhase: 2 }).status === "In Progress", "currentPhase → In Progress");
  ok(mapCoordinatorState({ runState: "PLANNED" }).status === "Ready", "PLANNED → Ready");
  ok(mapCoordinatorState({ runState: "COMPLETED_UNREVIEWED" }).note?.includes("unreviewed"), "unreviewed note");
  const cfg = ghSyncConfig();
  ok(typeof cfg.enabled === "boolean" && typeof cfg.syncTimeoutMs === "number", "config shape");
  ok(String(process.env.ORCH_GH_SYNC ?? "") === "off" ? cfg.enabled === false : true, "kill-switch respected");
  return results;
}
