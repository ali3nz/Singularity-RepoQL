// plan-cache.mjs — reuse approved plans ONLY on identical state fingerprint.
// fingerprint = SHA256(schemaVersion + normalized task + target + risk +
// confidentiality + evidenceManifestDigest + relevant file sha256s).
// A cache hit skips the plan gate call; any relevant state change = replan.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { GATE_SCHEMA } from "./gate-parser.mjs";

const CACHE_VERSION = 3; // ticket 085 D15: fingerprint now includes policy identity + tool contracts (invalidates all v2 entries conservatively)

// V3.2 §5.9: the old fingerprint covered orchestration metadata (task text,
// kit config hashes) but NOT the target project's state — so a repeated task
// could reuse an approved plan after the target changed underneath it. This
// helper folds lightweight target state into the fingerprint: git HEAD +
// status --porcelain hash for git targets, a bounded file manifest (path +
// sha256, newest-first, max 200 files) for non-git targets. No worktree, no
// full-repo hashing.
export function targetStateFingerprint(targetPath, { maxFiles = 200 } = {}) {
  const h = createHash("sha256");
  try {
    // Git path: HEAD + porcelain digest.
    const head = spawnSync("git", ["-C", targetPath, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5000 });
    if (head.status === 0 && head.stdout?.trim()) {
      const st = spawnSync("git", ["-C", targetPath, "status", "--porcelain"], { encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
      const porcelain = (st.stdout ?? "");
      const dirtyHash = createHash("sha256").update(porcelain).digest("hex").slice(0, 16);
      h.update(`git:${head.stdout.trim()}:${dirtyHash}\n`);
      // Relevant changed-file hashes. Ticket 085 D15: the old cap of 50 dirty
      // files permitted false reuse in a heavily-dirty tree — hash ALL dirty
      // files up to a conservative 500-file bound instead (path+content).
      const files = porcelain.split("\n").map((l) => l.slice(3).trim()).filter(Boolean).slice(0, 500);
      for (const f of files) {
        try { h.update(`${f}:${createHash("sha256").update(readFileSync(join(targetPath, f))).digest("hex")}\n`); } catch { h.update(`${f}:unreadable\n`); }
      }
      return h.digest("hex");
    }
  } catch { /* git missing or failed — fall through to manifest */ }
  // Non-git: bounded file manifest (skip runs/, backups/, node_modules/, .git/).
  try {
    const SKIP = new Set(["node_modules", ".git", "runs", "backups", ".repoql"]);
    const out = [];
    const walk = (dir, depth) => {
      if (depth > 4 || out.length >= maxFiles) return;
      let ents = [];
      try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (out.length >= maxFiles) return;
        if (e.name.startsWith(".") && e.name !== ".") continue;
        if (SKIP.has(e.name)) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.isFile()) {
          try {
            const s = statSync(p);
            out.push({ p, m: s.mtimeMs, size: s.size });
          } catch { /* skip */ }
        }
      }
    };
    walk(targetPath, 0);
    out.sort((a, b) => b.m - a.m); // newest first = most relevant
    for (const f of out.slice(0, maxFiles)) {
      try { h.update(`${f.p}:${createHash("sha256").update(readFileSync(f.p)).digest("hex")}\n`); } catch { h.update(`${f.p}:unreadable\n`); }
    }
    return h.digest("hex");
  } catch (e) {
    return `unavailable:${String(e.message ?? e).slice(0, 60)}`;
  }
}

export function planFingerprint({ task, target, risk, confidential, evidenceManifest, fileHashes = [], targetPath = null, policySha256 = "", toolContractSha256 = "" }) {
  const normTask = String(task ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const h = createHash("sha256");
  h.update(GATE_SCHEMA + "\n");
  h.update(CACHE_VERSION + "\n");
  h.update(normTask + "\n");
  h.update(JSON.stringify(target ?? {}) + "\n");
  h.update(String(risk ?? "") + "\n");
  h.update(String(!!confidential) + "\n");
  h.update(String(evidenceManifest?.digest ?? "") + "\n");
  for (const fh of fileHashes) h.update(`${fh.path}:${fh.sha256}\n`);
  // Ticket 085 D15: canonical rules/policy identity + planner/prompt/tool
  // contract identity participate in the fingerprint. A rules edit, config
  // change, or protocol change now invalidates cached plans (conservative).
  h.update(`policy:${policySha256}\n`);
  h.update(`tools:${toolContractSha256}\n`);
  // V3.2 §5.9: target state participates in the fingerprint. A changed HEAD
  // or dirty relevant file => different fingerprint => replan (never reuse a
  // stale approved plan across target mutations).
  if (targetPath && existsSync(targetPath)) {
    h.update(`target:${targetStateFingerprint(targetPath)}\n`);
  }
  return h.digest("hex");
}

export class PlanCache {
  constructor(runsDir) {
    this.file = join(runsDir, "plan-cache.json");
    mkdirSync(runsDir, { recursive: true });
  }
  _load() {
    try { return JSON.parse(readFileSync(this.file, "utf8")); } catch { return { entries: {} }; }
  }
  _save(c) {
    const tmp = this.file + ".tmp-" + process.pid;
    writeFileSync(tmp, JSON.stringify(c, null, 2) + "\n");
    renameSync(tmp, this.file);
  }
  lookup(fingerprint) {
    const c = this._load().entries[fingerprint];
    if (!c) return null;
    if (c.schema !== GATE_SCHEMA) return null;
    if (c.verdict !== "APPROVED" || c.planSignoff !== "APPROVED") return null;
    return c; // caller must independently re-verify writesAllowed()
  }
  store(fingerprint, gate, engine) {
    if (gate?.verdict !== "APPROVED" || gate?.planSignoff !== "APPROVED") return false;
    const c = this._load();
    c.entries[fingerprint] = {
      ...gate,
      engine,
      fingerprint,
      storedAt: new Date().toISOString(),
      schema: GATE_SCHEMA,
    };
    // keep it bounded: newest 200 entries
    const keys = Object.keys(c.entries);
    if (keys.length > 200) {
      keys.sort((a, b) => (c.entries[a].storedAt < c.entries[b].storedAt ? -1 : 1));
      for (const k of keys.slice(0, keys.length - 200)) delete c.entries[k];
    }
    this._save(c);
    return true;
  }
  // drop stale entries cheaply (optional call at coordinator start)
  prune(maxAgeH = 24 * 7) {
    const c = this._load();
    const cutoff = Date.now() - maxAgeH * 3600_000;
    let n = 0;
    for (const [k, v] of Object.entries(c.entries)) {
      if (Date.parse(v.storedAt) < cutoff) { delete c.entries[k]; n++; }
    }
    if (n) this._save(c);
    return n;
  }
}
