#!/usr/bin/env node
// scripts/doctor.mjs — the ONE public diagnostic entrypoint for an installed
// Singularity (§11 of the release round). It REUSES the shipped checks and the
// shipped state files — no second monitoring system, no daemon, no parallel
// source of truth:
//
//   - installation option + detected harness   → the installer's own state file
//   - RepoQL                                   → the real `rql` binary (read-only)
//   - MemoryCore health + scoped identity      → a live auth/verify (never the admin key)
//   - main-session capture                     → the installer record + hook wiring on disk
//   - last verified recall                     → scripts/acceptance-ordinary-session.mjs evidence
//   - extraction state + provider ladder       → the failover router's /health
//   - documentation ingestion backlog          → scripts/memory-doc-ingest.py status
//   - Ghost / Claude Office                    → only when the selected option ships them
//
// Output: concise human text, optional --json, correct exit code:
//   0 — every section VERIFIED or NOT_CONFIGURED by design (e.g. Ghost on an
//       option that does not ship it)
//   1 — at least one section INCOMPLETE / DEGRADED / FAILED
// Nothing prints, hashes or echoes key material, and nothing claims VERIFIED
// for an untested capability.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  probeOrdinarySessionRecall,
  probeOfficeFunctional,
  probeGhostMemoryOnHost,
  dreamOutcomeToday,
  readState as readInstallerState,
} from "./install-claude-code.mjs";
import { callMemoryCore, loadGhostMemoryConfig } from "../ghost/ghost-memory.mjs";
import { isAdministrativeKey, readAdministrativeKey } from "./runtime-proofs.mjs";
import { candidateSummary } from "./selflearn-candidates.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_STATE_FILE = join(ROOT, "data/claude-code-integration.json");
const OK_STATES = new Set(["VERIFIED", "NOT_CONFIGURED"]);
const section = (name, state, detail = "", extra = {}) => ({ name, state, detail, ...extra });
/** Is there a SELECTED installation? A mandatory component (e.g. two-provider
 *  extraction failover) is INCOMPLETE on an installed host and merely
 *  NOT_CONFIGURED before any installation (docs/doctor semantics, §6). */
const installedSection = (selectedOption) => Number.isInteger(Number(selectedOption)) && Number(selectedOption) >= 1 && Number(selectedOption) <= 4;

export async function doctor({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const out = [];
  let selectedOption = null;

  // ── installation option + detected harness (the installer's own record) ───
  try {
    const stateFile = env.SINGULARITY_CLAUDE_CODE_STATE || DEFAULT_STATE_FILE;
    const state = readInstallerState(stateFile);
    const rec = (state.installs || []).at(-1);
    if (!rec) {
      out.push(section("installation", "NOT_CONFIGURED", "no install record on this host — run the installer for one of the four README options"));
    } else {
      const v = rec.variant || {};
      selectedOption = v.id || null;
      out.push(section("installation",
        v.verified ? "VERIFIED" : "INCOMPLETE",
        `option ${v.id || "?"} (${v.name || "?"}): settings ${rec.settingsPath}${v.verified ? "" : ` — INCOMPLETE: ${(v.incomplete || []).join("; ") || "the gate was never run"}`}`,
        { option: v.id || null, settingsPath: rec.settingsPath }));
      const hooksOk = rec.hooksScript ? existsSync(rec.hooksScript) : false;
      out.push(section("capture-hooks",
        hooksOk ? "VERIFIED" : "DEGRADED",
        hooksOk ? `memory/doc hooks installed (${rec.hooksScript})` : "the installed hook script is missing from disk — re-run the installer (idempotent)"));
    }
  } catch (e) {
    out.push(section("installation", "DEGRADED", `install record unreadable: ${String(e?.message || e).slice(0, 120)}`));
  }

  // ── RepoQL connection (read-only version probe of the real binary) ────────
  {
    const rqlPath = env.SINGULARITY_RQL_PATH || "rql";
    const r = spawnSync(rqlPath, ["--version"], { encoding: "utf8", timeout: 15_000 });
    out.push(section("repoql", r.status === 0 ? "VERIFIED" : "NOT_CONFIGURED",
      r.status === 0 ? `rql answers: ${String(r.stdout || "").trim().slice(0, 60)}` : `rql (${rqlPath}) is not reachable: ${String(r.stderr || r.error?.message || "not found").split("\n")[0].slice(0, 80)}`));
  }

  // ── MemoryCore health + scoped identity (administrative key never used) ───
  {
    let st = "FAILED", detail = "";
    try {
      const cfg = loadGhostMemoryConfig(env);
      if (!cfg.userKey && !cfg.gatewayKey) { st = "NOT_CONFIGURED"; detail = "no scoped memory configuration on this host"; }
      else if (isAdministrativeKey(cfg.userKey || cfg.gatewayKey, readAdministrativeKey(ROOT))) {
        st = "FAILED"; detail = "the configured key IS the administrative key — a scoped business-user key is required";
      } else {
        const r = await callMemoryCore("/v3/meta/auth/verify", { user_key: cfg.userKey }, cfg, fetchImpl).catch((e) => ({ error: String(e?.message || e) }));
        if (r && r.data && r.data.valid === true) { st = "VERIFIED"; detail = `scoped identity verified live at ${cfg.baseUrl}`; }
        else { st = "FAILED"; detail = `auth/verify did not accept the scoped key (${String(r?.error || r?.data?.valid || "no valid response").slice(0, 80)})`; }
      }
    } catch (e) { detail = `health check failed: ${String(e?.message || e).slice(0, 100)}`; }
    out.push(section("memorycore", st, detail));
  }

  // ── documentation ingestion backlog (the shipped ledger status) ───────────
  {
    const script = join(ROOT, "scripts", "memory-doc-ingest.py");
    if (!existsSync(script)) {
      out.push(section("doc-ingestion", "DEGRADED", "the shipped ingestion helper is missing"));
    } else {
      const r = spawnSync("python3", [script, "status"], { encoding: "utf8", timeout: 30_000, cwd: env.SINGULARITY_REPO_ROOT || ROOT });
      let rows = null;
      try { rows = JSON.parse(r.stdout || "null"); } catch { /* not json */ }
      if (!Array.isArray(rows)) {
        out.push(section("doc-ingestion", "NOT_CONFIGURED", `no readable ledger status (rc=${r.status}); nothing is claimed`));
      } else {
        const counts = { DOC_INGEST_INDEXED: 0, DOC_INGEST_PENDING: 0, DOC_INGEST_FAILED: 0 };
        for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1;
        const stale = rows.filter((x) => x.stale_source === true).length;
        const st = (counts.DOC_INGEST_FAILED > 0 && "DEGRADED")
          || (counts.DOC_INGEST_PENDING > 0 && "INCOMPLETE")
          || "VERIFIED";
        out.push(section("doc-ingestion", st || "VERIFIED",
          `indexed ${counts.DOC_INGEST_INDEXED || 0}, pending ${counts.DOC_INGEST_PENDING || 0}, failed ${counts.DOC_INGEST_FAILED || 0}, stale ${stale}` +
          (st !== "VERIFIED" ? " — retry with `python3 scripts/memory-doc-ingest.py retry`" : "")));
      }
    }
  }

  // ── self-learning queue (a pending file is NOT proof of learning) ────────
  // States are distinguished explicitly: DISCOVERED/DEFERRED = work waiting
  // for evaluation, NEEDS_VERIFICATION/AWAITING_APPROVAL = a REAL formulated
  // lesson, PROMOTED = authoritative knowledge, FAILED = processing failure.
  // VERIFIED requires at least one actually promoted lesson; a populated queue
  // alone is INCOMPLETE, never a pass.
  {
    // The selflearn store is PER PROJECT: the hooks write it under the task's
    // own root. RepoQL doctor must therefore inspect the project the operator
    // is running in (cwd), not the product checkout — running it inside a
    // project that had already PROMOTED a lesson reported "no promotion yet"
    // (real false negative on .241). With neither an explicit root nor a
    // project store, fall back to the product checkout.
    const cwdRoot = env.SINGULARITY_REPO_ROOT || process.cwd();
    const root = cwdRoot !== ROOT && candidateSummary(cwdRoot).total === 0 && candidateSummary(ROOT).total > 0 ? ROOT : cwdRoot;
    try {
      const s = candidateSummary(root);
      const b = s.byState || {};
      const oldestDays = s.oldestPendingAt ? Math.max(0, Math.floor((Date.now() - Date.parse(s.oldestPendingAt)) / 86_400_000)) : null;
      const counts = `discovered ${b.DISCOVERED || 0}, evaluating ${b.EVALUATING || 0}, deferred ${b.DEFERRED || 0}, awaiting verification ${s.awaitingVerification}, awaiting approval ${s.awaitingApproval}, duplicate ${b.DUPLICATE || 0}, no-lesson ${b.NO_LESSON || 0}, failed ${s.failed}, promoted ${b.PROMOTED || 0}`;
      const last = s.lastPromotion ? ` | last promotion ${s.lastPromotion.conceptId || "?"} at ${s.lastPromotion.at || "?"}` : " | no promotion yet";
      const oldest = oldestDays === null ? "" : ` | oldest pending ${oldestDays}d`;
      let st;
      if ((b.PROMOTED || 0) > 0) st = "VERIFIED";
      else if (s.failed > 0) st = "DEGRADED";
      else if (s.total === 0) st = "NOT_CONFIGURED";
      else st = "INCOMPLETE";
      const advice = st === "NOT_CONFIGURED" ? " (idle: no material task has been observed yet)"
        : st === "VERIFIED" ? ""
        : s.awaitingApproval > 0 ? " — approve one with `node scripts/selflearn-candidates.mjs list` then the printed gated command + mark-promoted"
        : s.awaitingVerification > 0 ? " — verify with `node scripts/selflearn-candidates.mjs verify --id <id> --note <receipt>`"
        : " — run `node scripts/selflearn-candidates.mjs run` (or install systemd/selflearn-candidates.timer)";
      out.push(section("selflearn", st, counts + oldest + last + ` | store ${root}` + advice, { summary: s, root }));
    } catch (e) {
      out.push(section("selflearn", "DEGRADED", `learning queue unreadable: ${String(e?.message || e).slice(0, 120)}`));
    }
  }

  // ── extraction router + provider ladder (CONFIGURED is never VERIFIED) ────
  // Two working providers + verified failover are MANDATORY for every option,
  // so a missing or single-provider router cannot count as success on an
  // installed host. VERIFIED requires FUNCTIONAL evidence: one small real
  // completion served through the router (a listed ladder is configuration,
  // not proof).
  {
    const port = Number(env.EXTRACTION_FAILOVER_PORT || 8430);
    const base = String(env.EXTRACTION_FAILOVER_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, "");
    let h = null;
    try {
      const r = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(4000) });
      h = r.ok ? await r.json().catch(() => null) : null;
    } catch { h = null; }
    const ladder = Array.isArray(h?.ladder) ? h.ladder : [];
    if (!h || h.status !== "ok") {
      out.push(section("extraction-router", installedSection(selectedOption) ? "INCOMPLETE" : "NOT_CONFIGURED",
        installedSection(selectedOption)
          ? `MANDATORY: no failover router answers at ${base}/health — every option needs TWO working providers with verified failover (start compose/extraction-failover.compose.yml, then the provider proof in scripts/runtime-proofs.mjs)`
          : `no failover router answers at ${base}/health — start compose/extraction-failover.compose.yml when extraction failover is required`));
    } else if (h.inject) {
      out.push(section("extraction-router", "FAILED", `the router still carries the TEST injection knob (${h.inject}) — recreate it without EXTRACTION_FAILOVER_INJECT`));
    } else if (ladder.length >= 2) {
      // One bounded real completion through the ladder (tiny token budget).
      let verified = false, vd = "";
      try {
        const r = await fetchImpl(`${base}/chat/completions`, {
          method: "POST", headers: { "content-type": "application/json" },
          // Reasoning-style upstream models spend the budget on thinking before
          // any content; a tiny budget would turn a REAL completion into an
          // empty-content false negative (observed on groq gpt-oss-120b).
          body: JSON.stringify({ messages: [{ role: "user", content: "ping" }], max_tokens: 256 }),
          signal: AbortSignal.timeout(15_000),
        });
        const j = await r.json().catch(() => null);
        verified = r.ok && !!j?.choices?.[0]?.message?.content;
        vd = verified ? "a real completion round-tripped through the router" : `the real completion did NOT succeed (HTTP ${r.status})`;
      } catch (e) { vd = `the real completion could not run: ${String(e?.message || e).slice(0, 80)}`; }
      out.push(section("extraction-router", verified ? "VERIFIED" : "CONFIGURED",
        `router alive; ladder ${ladder.length} provider(s) (${ladder.join(", ")}); attempts ${h.attempts || 0}, failovers ${h.failovers || 0} — ${vd}`));
    } else {
      out.push(section("extraction-router", "DEGRADED", `router alive with ${ladder.length} provider(s) — a controlled fallback needs TWO providers (set the provider key files; scripts/runtime-proofs.mjs proves the pair)`));
    }
  }

  // ── last verified recall (ordinary-session evidence; the gate's own probe) ─
  try {
    const r = await probeOrdinarySessionRecall();
    out.push(section("ordinary-session-recall", r.ok ? "VERIFIED" : (r.state === "HOLD" ? "NOT_CONFIGURED" : r.state), r.detail.slice(0, 240)));
  } catch (e) {
    out.push(section("ordinary-session-recall", "DEGRADED", `recall evidence unreadable: ${String(e?.message || e).slice(0, 120)}`));
  }

  // ── Ghost / Claude Office — only rows the SELECTED option ships. Existence
  // of a configuration file is CONFIGURATION, never a VERIFIED capability
  // (§6): Ghost needs its authenticated memory identity + a completed dream
  // consolidation; Office needs a real native event consumed AND read back.
  if (selectedOption === "2" || selectedOption === "4") {
    const ghostCfg = env.GHOST_MEMORY_CONFIG || join(ROOT, "data/opencode/config/product-secrets/ghost.json");
    if (!existsSync(ghostCfg)) {
      out.push(section("ghost", "INCOMPLETE", `option ${selectedOption} selected but the ghost configuration is missing (${ghostCfg})`));
    } else {
      const mem = await probeGhostMemoryOnHost(ghostCfg);
      const dream = dreamOutcomeToday(env.GHOST_AGENT_DIR || undefined);
      const state = mem.ok && dream.complete && dream.provenance ? "VERIFIED"
        : mem.ok && dream.complete ? "INCOMPLETE" // consolidation provenance missing
        : mem.ok ? "INCOMPLETE" : "DEGRADED"; // memory identity exists but the dream did not complete today
      out.push(section("ghost", state,
        `memory ${mem.ok ? "identity verified (authenticated probe)" : `NOT usable: ${mem.detail}`} | dream ${dream.complete ? (dream.provenance ? `completed with provenance (${dream.journal})` : "completed but WITHOUT provenance — not verifiable") : (dream.detail || "not completed today")}` +
        (state !== "VERIFIED" ? " — config existence alone is CONFIGURED, never VERIFIED (docs/GHOST-SETUP.md)" : "")));
    }
    const officeCfg = env.SINGULARITY_OFFICE_CONFIG || join(ROOT, "data/opencode/config/product-secrets/office.json");
    if (!existsSync(officeCfg)) {
      out.push(section("claude-office", "INCOMPLETE", `option ${selectedOption} selected but the office configuration is missing (${officeCfg})`));
    } else {
      const office = await probeOfficeFunctional(officeCfg);
      out.push(section("claude-office", office.ok ? "VERIFIED" : "DEGRADED",
        office.ok ? office.detail : `native event NOT consumed/verified: ${office.detail}`));
    }
  }

  return out;
}

export function renderHuman(sections) {
  // Same rule as the exit code: an uninstalled host (or any non-OK section)
  // reports INCOMPLETE — NOT_CONFIGURED stays acceptable ONLY for an optional
  // capability of a VERIFIED installation.
  const installed = sections.some((s) => s.name === "installation" && s.state === "VERIFIED");
  const worst = !installed || sections.some((s) => !OK_STATES.has(s.state));
  const lines = [worst ? "RESULT: INCOMPLETE — at least one capability is not verified" : "RESULT: OK"];
  for (const s of sections) lines.push(`[${s.state.padEnd(14)}] ${s.name}: ${s.detail}`);
  return lines.join("\n");
}

async function main(argv) {
  const asJson = argv.includes("--json");
  const sections = await doctor({});
  if (asJson) console.log(JSON.stringify({ generatedAt: new Date().toISOString(), sections }, null, 2));
  else console.log(renderHuman(sections));
  // An uninstalled host never exits 0: "NOT_CONFIGURED by design" only means a
  // capability the SELECTED option does not ship (Ghost/Office) or an optional
  // router — not the product as a whole.
  const installed = sections.some((s) => s.name === "installation" && s.state === "VERIFIED");
  if (!installed) return 1;
  return sections.some((s) => !OK_STATES.has(s.state)) ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
