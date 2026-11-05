// openchamber-watch.mjs — V3.3.13 (ticket 028): Discord tracking for the HA
// automation job that lives in the openchamber OpenCode session (NOT a kit
// run, so the run heartbeat never covered it — operator gap report 2026-09-20:
// "There is supposed to be a discord channel for the ha and other automations
// orchestrate work").
//
// Per nanny cycle (5 min): one deterministic SSH snapshot of
//   - the newest openchamber chat session dir (staged automations/scripts/config)
//   - the opencode DB (session title + last turn time)
//   - the LIVE HA config (features.openchamberWatch.haConfig) deployment state
// then a narrator-composed update (display-only LLM, deterministic fallback)
// is appended to nanny-heartbeat.jsonl as {kind:"narrative",
// runId:"openchamber-ha"} — the existing bridge thread-per-runId logic does
// the rest. Fail-closed everywhere: any failure skips the tick silently.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { appendHeartbeat, appendAlert } from "./nanny.mjs";
import { composeNarrativeSync, fallbackNarrative, threadName } from "./narrator.mjs";
import { maybeAutoNudge, maybeNudgeSession, nudgingSuppressed } from "./openchamber-remediate.mjs";
import { HARNESS_PATHS } from "./kit-paths.mjs";

// Portable harness: the watched roots come from harness.config.json. When they
// are unmapped (or ssh/python3 is missing) this module reports unavailable and
// emits nothing — it never guesses a path and never fails a tick.
const OC = HARNESS_PATHS.openchamber;
const OC_CHATS_ROOT = OC.chatsRoot ?? "";
const OC_OPENCODE_DB = OC.opencodeDb ?? "";
const OC_HA_CONFIG = OC.haConfig ?? "";

export const OPENCHAMBER_RUN_ID = "openchamber-ha";
const STATE_FILE = "openchamber-watch.json";
export const OPENCHAMBER_CANCEL_FILE = `${OPENCHAMBER_RUN_ID}.cancelled`;
// V3.3.18: rate-limit burst detection window (zero-token turns within this
// window = the pinned model is failing; fail the nudge over to a healthy free
// model instead of sending more traffic into the rate limit).
export const RATE_LIMIT_BURST_MIN_FAILURES = 3;
export const RATE_LIMIT_BURST_WINDOW_MS = 20 * 60e3;
// V3.3.17: ONLY orchestrator-agent sessions are orchestration jobs. The first
// unfiltered rollout tracked operator DM chats too (agent=plan/build — e.g. a
// session titled "Top 10 Hentai Storyline Summaries" landed in
// #orchestration). Exported so selftest can pin the SQL filter in both
// snapshot programs.
export const OC_SESSIONS_AGENT_FILTER = "agent = 'orchestrator'";

// Collects one JSON snapshot on controller. Kept as a string and piped via
// stdin (`ssh host python3 -`) to avoid shell-quoting heredocs through ssh.
export const SNAPSHOT_PY = `
import json, os, glob, sqlite3, time, re
root = "${OC_CHATS_ROOT}"
cands = []
for d in glob.glob(root + "/*/session-*"):
    try:
        if os.path.isdir(d): cands.append((os.path.getmtime(d), d))
    except Exception: pass
cands.sort()
sess = cands[-1][1] if cands else None
files = []
if sess:
    for rel in ("", "automations", "python_scripts"):
        p = os.path.join(sess, rel) if rel else sess
        if os.path.isdir(p):
            for f in sorted(os.listdir(p)):
                fp = os.path.join(p, f)
                if os.path.isfile(fp):
                    stx = os.stat(fp)
                    files.append({"p": (rel + "/" if rel else "") + f, "m": int(stx.st_mtime), "s": stx.st_size})
files.sort(key=lambda x: -x["m"])
files = files[:40]
sid, title, lastTurn = "", "", 0
try:
    c = sqlite3.connect("file:${OC_OPENCODE_DB}?mode=ro", uri=True)
    row = None
    if sess:
        row = c.execute(
            "select id, title, time_updated from session where directory like ?",
            ("%" + os.path.basename(sess) + "%",),
        ).fetchone()
    if not row:
        row = c.execute(
            "select id, title, time_updated from session order by time_updated desc limit 1"
        ).fetchone()
    if row:
        sid, title, lastTurn = str(row[0] or ""), str(row[1] or ""), int(row[2] or 0)
except Exception: pass
ha = "${OC_HA_CONFIG}"
haScripts = []
try: haScripts = sorted(os.listdir(ha + "/python_scripts"))
except Exception: pass
haAutom = ""
try: haAutom = open(ha + "/automations.yaml", errors="replace").read()[:200000]
except Exception: pass
haCfg = ""
try: haCfg = open(ha + "/configuration.yaml", errors="replace").read()[:200000]
except Exception: pass
# V3.3.17: EVERY openchamber orchestrator session updated in the last 48h —
# the operator reported new solo orchestrator jobs (e.g. "Hermes Sidecar
# Implementation Plan") getting no Discord thread because only the newest
# chats-dir session (the HA backlog job) was ever narrated.
sessions = []
try:
    c2 = sqlite3.connect("file:${OC_OPENCODE_DB}?mode=ro", uri=True)
    cutoff = int(time.time() * 1000) - 48 * 3600 * 1000
    for row in c2.execute(
        "select id, title, time_updated from session where time_updated > ? and ${OC_SESSIONS_AGENT_FILTER} order by time_updated desc limit 10",
        (cutoff,),
    ):
        sessions.append({"id": str(row[0] or ""), "title": str(row[1] or ""), "updated": int(row[2] or 0)})
except Exception: pass
# V3.3.18: per-session turn health (finish reasons + zero-token failure count)
# and todo pending counts — the stall/rate-limit signals for the remediation
# policy. Failed turns tracked with timestamps for burst detection.
health = {}
try:
    cutoff2 = int(time.time() * 1000) - 72 * 3600 * 1000
    for (msid,) in c2.execute("select id from session where agent = 'orchestrator'"):
        stops = unknowns = aborted = total = 0
        last_finish = None
        failed_stamps = []
        last_prod = 0
        for (mdata, mtc) in c2.execute(
                "select data, time_created from message where session_id = ? and time_created > ? order by time_created",
                (msid, cutoff2)):
            try:
                md = json.loads(mdata)
            except Exception:
                continue
            if md.get("role") != "assistant":
                continue
            total += 1
            fr = str(md.get("finish") or "?")
            tok = md.get("tokens") or {}
            zero = not int(tok.get("output") or 0)
            err = md.get("error") or {}
            if zero and fr != "tool-calls":
                unknowns += 1
                failed_stamps.append(int(mtc or 0))
            elif fr == "stop":
                stops += 1
            if str(err.get("name") or "") in ("MessageAbortedError", "AbortError"):
                aborted += 1
            last_finish = fr
            if fr == "tool-calls":
                last_prod = max(last_prod, int((md.get("time") or {}).get("completed") or 0))
        health[msid] = {"total": total, "stops": stops, "unknown": unknowns, "aborted": aborted,
                        "lastFinish": last_finish, "failedStamps": failed_stamps[-40:], "lastProductive": last_prod}
except Exception: pass
todos = {}
try:
    for sid2, status in c2.execute("select session_id, status from todo"):
        t = todos.setdefault(sid2, [])
        t.append({"status": str(status or "")})
except Exception: pass
print(json.dumps({
    "now": int(time.time()), "sessionDir": sess, "sessionId": sid,
    "sessionTitle": title, "lastTurn": lastTurn, "files": files,
    "sessions": sessions,
    "health": health,
    "todos": todos,
    "haScripts": haScripts,
    "haCfgHasWebhook": bool(re.search(r"webhook", haCfg, re.I)),
    "haCfgHasPrometheus": bool(re.search(r"prometheus", haCfg, re.I)),
    "haAutom": haAutom,
}))
`;

// V3.3.17: light sessions-only snapshot for the `jobs` board (no HA config
// reads — the board renders every few operator commands, keep it cheap).
// V3.3.18: SESSIONS_ROWS_PY adds per-session turn health + todos for the
// remediation policy (turnHealth inputs). Bounded: top-10 sessions, 72h,
// last-40 failure stamps.
const SESSIONS_ROWS_PY = `
import json, sqlite3, time
out = []
try:
    c = sqlite3.connect("file:${OC_OPENCODE_DB}?mode=ro", uri=True)
    cutoff = int(time.time() * 1000) - 48 * 3600 * 1000
    ids = []
    for row in c.execute(
        "select id, title, time_updated, directory from session where time_updated > ? and ${OC_SESSIONS_AGENT_FILTER} order by time_updated desc limit 10",
        (cutoff,),
    ):
        ids.append({"id": str(row[0] or ""), "title": str(row[1] or ""), "updated": int(row[2] or 0), "directory": str(row[3] or "")})
    hcut = int(time.time() * 1000) - 72 * 3600 * 1000
    for s in ids:
        stops = unknowns = aborted = total = 0
        last_finish = None
        failed_stamps = []
        last_prod = 0
        for (mdata, mtc) in c.execute(
                "select data, time_created from message where session_id = ? and time_created > ? order by time_created",
                (s["id"], hcut)):
            try:
                md = json.loads(mdata)
            except Exception:
                continue
            if md.get("role") != "assistant":
                continue
            total += 1
            fr = str(md.get("finish") or "?")
            tok = md.get("tokens") or {}
            zero = not int(tok.get("output") or 0)
            err = md.get("error") or {}
            if zero and fr != "tool-calls":
                unknowns += 1
                failed_stamps.append(int(mtc or 0))
            elif fr == "stop":
                stops += 1
            if str(err.get("name") or "") in ("MessageAbortedError", "AbortError"):
                aborted += 1
            last_finish = fr
            if fr == "tool-calls":
                last_prod = max(last_prod, int((md.get("time") or {}).get("completed") or 0))
        todos = []
        try:
            for (status,) in c.execute("select status from todo where session_id = ?", (s["id"],)):
                todos.append({"status": str(status or "")})
        except Exception:
            pass
        out.append({**s, "health": {"total": total, "stops": stops, "unknown": unknowns,
                     "aborted": aborted, "lastFinish": last_finish,
                     "failedStamps": failed_stamps[-40:], "lastProductive": last_prod},
                    "todos": todos})
except Exception: pass
print(json.dumps(out))
`;

export const SESSIONS_PY = `
import json, sqlite3, time
out = []
try:
    c = sqlite3.connect("file:${OC_OPENCODE_DB}?mode=ro", uri=True)
    cutoff = int(time.time() * 1000) - 48 * 3600 * 1000
    for row in c.execute(
        "select id, title, time_updated from session where time_updated > ? and ${OC_SESSIONS_AGENT_FILTER} order by time_updated desc limit 10",
        (cutoff,),
    ):
        out.append({"id": str(row[0] or ""), "title": str(row[1] or ""), "updated": int(row[2] or 0)})
except Exception: pass
print(json.dumps(out))
`;

export function collectSessionsSnapshot(sshHost = OC.sshHost, { rows = false } = {}) {
  if (!OC.available) return [];
  try {
    const r = spawnSync("ssh", [sshHost, "python3", "-"], {
      input: rows ? SESSIONS_ROWS_PY : SESSIONS_PY, encoding: "utf8", timeout: 20_000,
    });
    if (r.status !== 0 || !r.stdout) return [];
    const v = JSON.parse(r.stdout);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// V3.3.17 pure helpers: per-session runId/title/text for the extra sessions.
export function ocSessionShort(id) {
  return String(id ?? "").replace(/^ses_/, "").slice(-6) || "unknown";
}
export function ocSessionRunId(id) {
  return `openchamber-${ocSessionShort(id)}`;
}
export function ocSessionTitle(title) {
  return threadName(title ?? "", "openchamber-session") || "openchamber orchestrator session";
}
export function buildOcSessionText(s, { nowMs = Date.now() } = {}) {
  const updated = Number(s.updated ?? 0);
  const active = updated > 0 && nowMs - updated < 5 * 60e3;
  const ageMin = updated > 0 ? Math.max(0, Math.round((nowMs - updated) / 60e3)) : null;
  const state = active ? "turn ACTIVE" : ageMin != null ? `last turn ${ageMin} min ago` : "no turn data";
  return `**NOW** OpenChamber orchestrator session \`${ocSessionShort(s.id)}\` — ${state}. ` +
    "Display-only tracking; the HA backlog job stays `openchamber-ha`.";
}

// Pure: which sessions get a narrative this cycle (emit on CHANGE of
// time_updated only — no keepalive spam; the thread persists in Discord).
export function planSessionEmits(sessions, seen, { nowMs = Date.now(), max = 6 } = {}) {
  const next = { ...(seen ?? {}) };
  const emit = [];
  for (const s of (sessions ?? []).slice(0, max)) {
    if (!s?.id) continue;
    if (next[s.id] === s.updated) continue;
    next[s.id] = s.updated;
    const updated = Number(s.updated ?? 0);
    emit.push({
      ...s,
      short: ocSessionShort(s.id),
      active: updated > 0 && nowMs - updated < 5 * 60e3,
      ageMin: updated > 0 ? Math.max(0, Math.round((nowMs - updated) / 60e3)) : null,
    });
  }
  // prune state to the ids just seen (bounded, current window only)
  const live = new Set((sessions ?? []).slice(0, max).map((s) => s?.id).filter(Boolean));
  for (const id of Object.keys(next)) if (!live.has(id)) delete next[id];
  return { emit, seen: next };
}

// V3.3.14.4: exported for the orchestrate.mjs `openchamber-nudge` CLI verb.
export function collectSnapshot(sshHost = OC.sshHost) {
  if (!OC.available) return null;
  try {
    const r = spawnSync("ssh", [sshHost, "python3", "-"], {
      input: SNAPSHOT_PY, encoding: "utf8", timeout: 30_000,
    });
    if (r.status !== 0 || !r.stdout) return null;
    const snap = JSON.parse(r.stdout);
    return snap && Array.isArray(snap.files) ? snap : null;
  } catch {
    return null;
  }
}

// Pure: prev file map {path: mtime} vs current snapshot list.
export function diffFiles(prevMap, files) {
  const added = [];
  const modified = [];
  for (const f of files) {
    if (!(f.p in prevMap)) added.push(f.p);
    else if (prevMap[f.p] !== f.m) modified.push(f.p);
  }
  return { added, modified };
}

// Pure: how far the openchamber suite has made it into the LIVE HA config.
export function deploymentSummary(snap) {
  const files = snap.files ?? [];
  const scripts = files.filter((f) => f.p.startsWith("python_scripts/")).map((f) => f.p.split("/")[1]);
  const autos = files
    .filter((f) => f.p.startsWith("automations/"))
    .map((f) => f.p.split("/")[1].replace(/\.ya?ml$/, ""));
  const haScripts = new Set(snap.haScripts ?? []);
  const haAutom = String(snap.haAutom ?? "");
  const maxConfigPhase = files.reduce((mx, f) => {
    const m = f.p.match(/^configuration\.yaml\.phase(\d+)$/);
    return m ? Math.max(mx, Number(m[1])) : mx;
  }, 0);
  const scriptsDeployed = scripts.filter((s) => haScripts.has(s)).length;
  const automationsMerged = autos.filter((a) => haAutom.includes(a)).length;
  const configMerged = Boolean(snap.haCfgHasWebhook || snap.haCfgHasPrometheus);
  const deployed =
    scripts.length > 0 &&
    scriptsDeployed === scripts.length &&
    automationsMerged === autos.length &&
    configMerged;
  return {
    scriptsTotal: scripts.length,
    scriptsDeployed,
    automationsTotal: autos.length,
    automationsMerged,
    maxConfigPhase,
    configMerged,
    deployed,
  };
}

// Pure: cadence. Change always emits; otherwise emit while the job is fresh
// (activity < 6h) every tick, every 2nd tick within 24h, every 4th when cold.
export function shouldEmit({ changed, lastTurnAt, nowMs, tick }) {
  if (changed) return true;
  if (!lastTurnAt) return tick % 4 === 0;
  const age = nowMs - lastTurnAt;
  if (age < 6 * 3600e3) return true;
  if (age < 24 * 3600e3) return tick % 2 === 0;
  return tick % 4 === 0;
}

// Pure: narrator bundle in the exact shape narrator.mjs consumes.
export function buildOpenchamberBundle(snap, diff, { nowMs = Date.now() } = {}) {
  const ds = deploymentSummary(snap);
  const turnActive = snap.lastTurn > 0 && nowMs - snap.lastTurn < 5 * 60e3;
  const idleMin = snap.lastTurn > 0 ? Math.round((nowMs - snap.lastTurn) / 60e3) : null;
  const title =
    threadName(snap.sessionTitle ?? "", OPENCHAMBER_RUN_ID) ||
    "HA automations & incident-response suite (openchamber)";
  const runState = turnActive ? "ACTIVE" : ds.deployed ? "DEPLOYED-IDLE" : "STAGED-NOT-DEPLOYED";
  const findings = [];
  if (ds.scriptsTotal || ds.automationsTotal) {
    findings.push(
      `staged in openchamber session: ${ds.scriptsTotal} python_scripts, ${ds.automationsTotal} automations` +
      (ds.maxConfigPhase ? `, configuration rev phase${ds.maxConfigPhase}` : "")
    );
    findings.push(
      `deployed into live HA config: ${ds.scriptsDeployed}/${ds.scriptsTotal} scripts, ` +
      `${ds.automationsMerged}/${ds.automationsTotal} automations, webhook config ${ds.configMerged ? "merged" : "NOT merged"}`
    );
  } else {
    findings.push("no staged suite files found in the openchamber session dir");
  }
  if (turnActive) findings.push(`orchestrator turn ACTIVE (last session update ${Math.round((nowMs - snap.lastTurn) / 1e3)}s ago)`);
  else if (idleMin !== null && !ds.deployed) findings.push(`orchestrator turn ended ${idleMin} min ago — deployment step not executed`);
  if (diff?.added?.length) findings.push(`new since last check: ${diff.added.slice(0, 6).join(", ")}`);
  if (diff?.modified?.length) findings.push(`changed since last check: ${diff.modified.slice(0, 6).join(", ")}`);
  const recent = (snap.files ?? []).slice(0, 4).map((f) => f.p);
  return {
    runs: [{
      runId: OPENCHAMBER_RUN_ID,
      title,
      runState,
      currentPhase: recent.length ? `latest files: ${recent.join(", ")}` : null,
      completedThrough: ds.scriptsDeployed,
      workers: [],
      findings,
    }],
    issues: [],
    engineNote: null,
  };
}

// V3.3.18: turn-health per orchestrator session — the operator's stop/rate-limit
// report (2026-09-20) quantified from the opencode DB:
//   finish=stop        → premature prose stop mid-task (chronic free-model drift)
//   finish=unknown     → zero-token turn = provider call returned NOTHING
//                        (rate-limit / provider failure signature)
//   MessageAbortedError→ aborted turn (provider/timeout)
// Failed (zero-token) bursts cluster: lightning 13 in 3h on ONE session — the
// model keeps getting rate-limited and nothing fails over. Pure analysis over
// a snapshot rows list (see collectSessionsSnapshot(rows=true)).
export function turnHealth(rows) {
  const out = { total: 0, stops: 0, unknown: 0, aborted: 0, lastFinish: null };
  for (const m of rows ?? []) {
    if (m?.role !== "assistant") continue;
    out.total += 1;
    const tok = m.tokens ?? {};
    // V3.3.18 live fix: a provider failure returns NOTHING — output=0 is the
    // signature regardless of recorded input tokens (input may be counted
    // before the call fails). A real prose stop always has output > 0.
    const failed = !Number(tok.output ?? 0);
    const fr = String(m.finish ?? "?");
    if (failed && fr !== "tool-calls") out.unknown += 1;
    else if (fr === "stop") out.stops += 1;
    if (m.error?.name === "MessageAbortedError" || m.error?.name === "AbortError") out.aborted += 1;
    out.lastFinish = fr;
  }
  return out;
}

// Pure: recent HEALTHY (tool-calls) turn time — idle is measured against the
// last turn that actually DID something, not any last message.
export function lastProductiveMs(rows) {
  let t = 0;
  for (const m of rows ?? []) {
    if (m?.role === "assistant" && m.finish === "tool-calls") {
      t = Math.max(t, Number(m.completedAt ?? 0));
    }
  }
  return t;
}

// Pure: current task state from the todo table rows ({content,status}).
// done = no rows, or zero pending (pending = anything not completed/cancelled).
export function todoState(todos) {
  const list = Array.isArray(todos) ? todos : [];
  if (!list.length) return { pending: 0, done: true };
  const pending = list.filter((t) => t && String(t.status ?? "").toLowerCase() !== "completed").length;
  return { pending, done: pending === 0 };
}

// Pure rate-limit burst policy (V3.3.18): a burst = >= N zero-token turns on
// the same session within the burst window AND its most recent turn was a
// zero-token one (i.e. the session is currently failing, not historically).
export function isRateLimitBurst({ health, failedStamps = [], now = Date.now(), minFailures = RATE_LIMIT_BURST_MIN_FAILURES, windowMs = RATE_LIMIT_BURST_WINDOW_MS } = {}) {
  if (!health || (health.unknown ?? 0) < minFailures) return false;
  if (!failedStamps.length) return false;
  const recent = failedStamps.filter((t) => now - Number(t || 0) <= windowMs).length;
  return recent >= minFailures;
}

// 2026-09-27 (claude): `deterministic` = compose the update WITHOUT any model
// call (fallbackNarrative only). The nanny passes it during a load-standdown so
// the operator still gets a 5-minute update while the host is hot — incident
// 033 bans model spawns under load, not observation.
export function openchamberWatchCycle(runsDir, { sshHost = OC.sshHost, now = Date.now(), deterministic = false } = {}) {
  const out = { emitted: false, reason: "" };
  try {
    const statePath = join(runsDir, STATE_FILE);
    let st = { tick: 0, prevFiles: {}, lastTurn: 0, lastEmitAt: 0, sessionsSeen: {}, sessionNudges: {} };
    if (existsSync(statePath)) {
      try { st = { ...st, ...JSON.parse(readFileSync(statePath, "utf8")) }; } catch { /* fresh */ }
    }
    st.tick = (st.tick ?? 0) + 1;
    const primaryCancelled = existsSync(join(runsDir, OPENCHAMBER_CANCEL_FILE));
    const snap = collectSnapshot(sshHost);
    if (!snap) {
      out.reason = "snapshot unavailable (ssh/parse failed) — skipped";
      try { writeFileSync(statePath, JSON.stringify(st)); } catch { /* non-fatal */ }
      return out;
    }
    const diff = diffFiles(st.prevFiles ?? {}, snap.files ?? []);
    const changed =
      diff.added.length + diff.modified.length > 0 ||
      (snap.lastTurn > 0 && snap.lastTurn !== st.lastTurn);
    if (!primaryCancelled && shouldEmit({ changed, lastTurnAt: snap.lastTurn, nowMs: now, tick: st.tick })) {
      const bundle = buildOpenchamberBundle(snap, diff, { nowMs: now });
      const nar = deterministic
        ? { ok: false, model: "deterministic", text: fallbackNarrative(bundle) }
        : composeNarrativeSync(bundle, { runsDir, runId: OPENCHAMBER_RUN_ID });
      appendHeartbeat(
        runsDir,
        JSON.stringify({
          kind: "narrative",
          runId: OPENCHAMBER_RUN_ID,
          title: bundle.runs[0].title,
          by: nar.model ?? "fallback",
          text: nar.text,
        })
      );
      out.emitted = true;
      out.model = nar.model ?? "fallback";
    } else if (primaryCancelled) {
      out.reason = "external job cancelled — primary narration/remediation suppressed";
    } else {
      out.reason = `quiet (tick ${st.tick}) — cadence skip`;
    }
    st.prevFiles = Object.fromEntries((snap.files ?? []).map((f) => [f.p, f.m]));
    st.lastTurn = snap.lastTurn ?? 0;
    if (out.emitted) st.lastEmitAt = now;
    // V3.3.17: every OTHER openchamber orchestrator session (solo jobs beyond
    // the HA backlog job) gets its own deterministic narrative when its
    // time_updated moves — the bridge turns each runId into its own Discord
    // thread. Display-only, fail-closed; no keepalive (change-driven only).
    try {
      // exclude the PRIMARY job's session — it already narrates as
      // openchamber-ha; tracking it again made a duplicate thread
      // (openchamber-rRZK0j, live-caught in the first rollout).
      const others = (snap.sessions ?? []).filter((s) => s?.id && s.id !== snap.sessionId);
      const plan = planSessionEmits(others, st.sessionsSeen ?? {}, { nowMs: now });
      for (const s of plan.emit) {
        appendHeartbeat(runsDir, JSON.stringify({
          kind: "narrative",
          runId: ocSessionRunId(s.id),
          title: ocSessionTitle(s.title),
          by: "deterministic",
          text: buildOcSessionText(s, { nowMs: now }),
        }));
        out.emittedSessions = (out.emittedSessions ?? 0) + 1;
      }
      st.sessionsSeen = plan.seen;
    } catch { /* display-only; never break the cycle */ }
    // V3.3.18: per-session stall/rate-limit remediation for ALL orchestrator
    // sessions (not just the primary HA job). Runs EVERY tick against a live
    // DB rows snapshot (change-driven emission above is display-only and
    // cadence-independent). Bounded per-session (6/day, cooldowns), fail-closed.
    try {
      const rows = collectSessionsSnapshot(sshHost, { rows: true });
      for (const s of (rows ?? []).slice(0, 6)) {
        if (!s?.id || s.id === snap.sessionId) continue; // primary job has its own policy
        st.sessionNudges = st.sessionNudges ?? {};
        const sst = st.sessionNudges[s.id] ?? {};
        const res = maybeNudgeSession(s, sst, { now, sshHost, foAttempt: st.tick });
        if (res.nudged) {
          st.sessionNudges[s.id] = sst;
          appendAlert(runsDir, "action",
            `openchamber session ${s.id.slice(-6)} (${String(s.title ?? "").slice(0, 40)}): ${res.reason}`);
          appendHeartbeat(runsDir, JSON.stringify({
            kind: "narrative",
            runId: ocSessionRunId(s.id),
            title: ocSessionTitle(s.title),
            by: "nanny",
            text: `AUTO-NUDGE: ${res.reason}. A continuation message was delivered to the session.`,
          }));
          out.remediated = (out.remediated ?? 0) + 1;
        }
      }
      // prune nudge state to sessions still in the snapshot
      const liveIds = new Set((rows ?? []).map((s) => s?.id).filter(Boolean));
      for (const id of Object.keys(st.sessionNudges ?? {})) if (!liveIds.has(id)) delete st.sessionNudges[id];
    } catch (e) { /* remediation is best-effort; never break the cycle */ }
    // V3.3.14.4 (ticket 030): bounded auto-remediation. Checked EVERY tick
    // (not cadence-gated): policy (30 min idle, 2 h cooldown, 4/day cap) lives
    // in openchamber-remediate.mjs; a sent nudge is alerted (MQTT via the
    // relay) + narrated (Discord thread) so the operator always sees it.
    try {
      if (primaryCancelled) {
        out.remediationReason = "external job cancelled — primary remediation suppressed";
      } else if (nudgingSuppressed(st)) {
        out.remediationReason = "completed by ops — nudging suppressed (st.completed set)";
      } else {
      const ds = deploymentSummary(snap);
      const runState = buildOpenchamberBundle(snap, diff, { nowMs: now }).runs[0].runState;
      st.nudges = st.nudges || { day: "", count: 0, lastAt: 0 };
      const rem = maybeAutoNudge({ snap, ds, nudges: st.nudges, now, runState });
      if (rem.nudged) {
        out.remediated = true;
        appendAlert(runsDir, "action",
          `openchamber-ha stalled (staged-not-deployed) — ${rem.reason}; continue message delivered to session ${snap.sessionId}`);
        appendHeartbeat(runsDir, JSON.stringify({
          kind: "narrative", runId: OPENCHAMBER_RUN_ID,
          title: buildOpenchamberBundle(snap, diff, { nowMs: now }).runs[0].title,
          by: "nanny",
          text: ("AUTO-NUDGE: the job turn ended mid-task and sat idle past 30 minutes with the deployment " +
            `incomplete (${ds.scriptsDeployed}/${ds.scriptsTotal} scripts, ${ds.automationsMerged}/${ds.automationsTotal} automations live). ` +
            "A deterministic continue message naming the exact shortfall was delivered to the same session — watching for the turn to resume."),
        }));
      } else {
        out.remediationReason = rem.reason;
      }
      }
    } catch { /* remediation is best-effort; never break the cycle */ }
    try { writeFileSync(statePath, JSON.stringify(st)); } catch { /* non-fatal */ }
  } catch {
    /* display-only; never break the nanny cycle */
  }
  return out;
}
