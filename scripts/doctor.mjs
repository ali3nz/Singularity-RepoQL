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
  readState as readInstallerState,
} from "./install-claude-code.mjs";
import { callMemoryCore, loadGhostMemoryConfig } from "../ghost/ghost-memory.mjs";
import { isAdministrativeKey, readAdministrativeKey } from "./runtime-proofs.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_STATE_FILE = join(ROOT, "data/claude-code-integration.json");
const OK_STATES = new Set(["VERIFIED", "NOT_CONFIGURED"]);
const section = (name, state, detail = "", extra = {}) => ({ name, state, detail, ...extra });

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

  // ── extraction router + provider ladder ───────────────────────────────────
  {
    const port = Number(env.EXTRACTION_FAILOVER_PORT || 8430);
    const base = String(env.EXTRACTION_FAILOVER_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, "");
    let h = null;
    try {
      const r = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(4000) });
      h = r.ok ? await r.json().catch(() => null) : null;
    } catch { h = null; }
    if (!h || h.status !== "ok") {
      out.push(section("extraction-router", "NOT_CONFIGURED", `no failover router answers at ${base}/health — start compose/extraction-failover.compose.yml when extraction failover is required`));
    } else if (h.inject) {
      out.push(section("extraction-router", "FAILED", `the router still carries the TEST injection knob (${h.inject}) — recreate it without EXTRACTION_FAILOVER_INJECT`));
    } else if (Array.isArray(h.ladder) && h.ladder.length >= 2) {
      out.push(section("extraction-router", "VERIFIED", `router alive; ladder has ${h.ladder.length} provider(s) (${h.ladder.join(", ")}); attempts ${h.attempts || 0}, failovers ${h.failovers || 0}`));
    } else {
      out.push(section("extraction-router", "DEGRADED", `router alive with ${h.ladder?.length || 0} provider(s) — a controlled fallback needs TWO providers (scripts/runtime-proofs.mjs proves the pair)`));
    }
  }

  // ── last verified recall (ordinary-session evidence; the gate's own probe) ─
  try {
    const r = await probeOrdinarySessionRecall();
    out.push(section("ordinary-session-recall", r.ok ? "VERIFIED" : (r.state === "HOLD" ? "NOT_CONFIGURED" : r.state), r.detail.slice(0, 240)));
  } catch (e) {
    out.push(section("ordinary-session-recall", "DEGRADED", `recall evidence unreadable: ${String(e?.message || e).slice(0, 120)}`));
  }

  // ── Ghost / Claude Office — only rows the SELECTED option ships ────────────
  if (selectedOption === "2" || selectedOption === "4") {
    const ghostCfg = env.GHOST_MEMORY_CONFIG || join(ROOT, "data/opencode/config/product-secrets/ghost.json");
    out.push(section("ghost", existsSync(ghostCfg) ? "VERIFIED" : "INCOMPLETE",
      existsSync(ghostCfg) ? `ghost configuration present (${ghostCfg})` : `option ${selectedOption} selected but the ghost configuration is missing (${ghostCfg})`));
    const officeCfg = env.SINGULARITY_OFFICE_CONFIG || join(ROOT, "data/opencode/config/product-secrets/office.json");
    out.push(section("claude-office", existsSync(officeCfg) ? "VERIFIED" : "INCOMPLETE",
      existsSync(officeCfg) ? `office configuration present (${officeCfg})` : `option ${selectedOption} selected but the office configuration is missing (${officeCfg})`));
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
