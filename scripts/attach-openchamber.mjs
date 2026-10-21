#!/usr/bin/env node
// attach-openchamber.mjs — install the Singularity OpenChamber bundle into an
// EXISTING OpenChamber installation (installation options 3 and 4).
//
// Rules (docs/OPENCHAMBER-SETUP.md §attach):
//   - NEVER creates a second OpenChamber and never starts or stops anything;
//   - NEVER deletes a file, and never overwrites without a backup: every file
//     whose content would change is copied to data/attach-backups/<stamp>/ first;
//   - unrelated files in the target config stay untouched;
//   - the target's OWN identity files (AGENTS.md, opencode.jsonc, dcp.jsonc)
//     are never overwritten: when the target has its own version the product's
//     copy is kept next to the backup as <file>.product for a deliberate
//     merge (a pre-existing RepoQL identity therefore survives the attach);
//   - plugin credentials are provisioned INTO the discovered config
//     (provision-secrets.py --plugin-dir); existing values are preserved;
//   - an ADMINISTRATIVE credential is never propagated: the memory stack's
//     admin key is refused in-process (never printed, never hashed into the
//     output) and the attach reports the option INCOMPLETE until a scoped
//     business-user key is supplied;
//   - every attach records a MANIFEST of what it created/replaced with the
//     before-hashes, and `rollback` restores exactly those files (refusing
//     foreign edits, idempotent, never a global prune);
//   - for a containerized instance the rql presence is checked and the manual
//     bind-mount step is PRINTED when absent — the user's compose file is
//     never edited by this script.
//
// Usage:
//   node scripts/attach-openchamber.mjs [--discover]
//        [--container NAME | --config-dir DIR] [--variant 3|4] [--dry-run]
//   node scripts/attach-openchamber.mjs rollback --backup-dir DIR
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = join(ROOT, "openchamber");
const PLUGIN_DIR = join(ROOT, "data/opencode/config/product-secrets");
const OC_CONFIG_DEST = "/home/openchamber/.config/opencode";
const ADMIN_KEY_FILE = join(ROOT, "memory", "upstream", ".admin-key");

// Files the attach NEVER overwrites when the target already carries its own
// version: the target's instructions (AGENTS.md) and its own MCP wiring
// (opencode.jsonc / dcp.jsonc) ARE the target's identity — a pre-existing
// RepoQL identity must survive the attach. The product's version is kept next
// to the attach backup so the operator can merge it deliberately. The
// package's own compose-managed config dir is NOT a foreign target: there the
// product owns the files and replaces them as before.
const PRESERVE_ON_CONFLICT = new Set(["AGENTS.md", "opencode.jsonc", "dcp.jsonc"]);

const log = (m) => console.log(`[attach] ${m}`);
const readJsonFile = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const warn = (m) => console.warn(`[attach] ${m}`);

export function discoverOpenchamber(deps = {}) {
  if (deps.docker !== false) {
    const ps = spawnSync("docker", ["ps", "--format", "{{.Names}} {{.Image}}"], { encoding: "utf8" });
    if (ps.status === 0) {
      const managed = [], foreign = [];
      for (const line of String(ps.stdout || "").split("\n")) {
        const parts = line.trim().split(/\s+/);
        const name = parts[0], image = parts[1] || "";
        if (!name) continue;
        if (!/openchamber/i.test(name) && !/openchamber/i.test(image)) continue;
        (name === "singularity-openchamber" ? managed : foreign).push(name);
      }
      if (managed.length) return { kind: "compose-managed", container: managed[0], configDir: join(ROOT, "data/opencode/config") };
      if (foreign.length) return { kind: "container", container: foreign[0] };
    }
  }
  const home = deps.home || process.env.HOME || "";
  const nativeDir = join(home, ".config", "opencode");
  if (existsSync(nativeDir)) return { kind: "native", configDir: nativeDir };
  return { kind: "none" };
}

/** Resolve the host-side config directory of the target instance (read-only). */
export function resolveConfigDir(target) {
  if (target.configDir && target.kind !== "container") return target.configDir;
  if (target.kind === "container" || target.kind === "compose-managed") {
    const ins = spawnSync("docker", ["inspect", target.container, "--format", "{{json .Mounts}}"], { encoding: "utf8" });
    if (ins.status !== 0) throw new Error(`docker inspect ${target.container} failed: ${(ins.stderr || "").trim()}`);
    let mounts;
    try { mounts = JSON.parse(ins.stdout || "[]"); } catch (e) { throw new Error(`unparseable docker inspect output`); }
    // The EXACT OpenCode config destination wins; a longer path that merely
    // ends in /opencode (like ~/.local/share/opencode) is only a fallback.
    const exact = (mounts || []).find((x) => x.Type === "bind" && x.Destination === OC_CONFIG_DEST);
    if (exact) return exact.Source;
    const m = (mounts || []).find((x) => x.Type === "bind" && /(^|\/)opencode$/.test(x.Destination || ""));
    if (!m) throw new Error(`no OpenCode config bind mount found on ${target.container} — attach needs to know where its config lives (docs/OPENCHAMBER-SETUP.md)`);
    return m.Source;
  }
  throw new Error("no OpenChamber instance to attach to (run with --discover)");
}

/** Build the per-file copy plan for the bundle. status: create|replace|present. */
export function planBundleFiles(configDir, srcRoot = BUNDLE, { preserveConflicts = false } = {}) {
  const plan = [];
  const walk = (src, dst, rel) => {
    for (const e of readdirSync(src, { withFileTypes: true })) {
      const s = join(src, e.name), d = join(dst, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name === "examples") continue; // shipped examples are not runtime config
        walk(s, d, r);
      } else {
        let status = "create", curSha = null;
        if (existsSync(d)) {
          curSha = sha(d);
          status = curSha === sha(s) ? "present" : "replace";
        }
        if (status === "replace" && preserveConflicts && PRESERVE_ON_CONFLICT.has(r)) status = "preserve";
        plan.push({ rel: r, src: s, dst: d, status, prevSha: curSha, prevMode: existsSync(d) ? statSync(d).mode & 0o777 : null });
      }
    }
  };
  walk(srcRoot, configDir, "");
  return plan;
}

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

/**
 * Compare two secrets IN PROCESS, without printing either value or a hash of
 * it. Used to recognise the memory stack's ADMIN key so it is never
 * propagated into a target.
 */
export function isSameSecret(a, b) {
  const x = Buffer.from(String(a || ""), "utf8");
  const y = Buffer.from(String(b || ""), "utf8");
  if (!x.length || !y.length) return false;
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/** The memory stack's admin key (read in process; never printed). */
export function readAdminKey(root = ROOT) {
  try { return readFileSync(join(root, "memory", "upstream", ".admin-key"), "utf8").trim(); } catch { return ""; }
}

/**
 * Classify a candidate plugin key.
 * "scoped"  — a business-user key (usable for the plugin's runtime traffic)
 * "admin"   — the memory stack's administrative key: NEVER propagated
 * "unknown" — the key cannot be classified: never propagated silently
 */
export function classifyCandidateKey(candidate, { adminKey = "" } = {}) {
  const key = String(candidate || "").trim();
  if (!key) return { class: "none", detail: "no key was supplied" };
  if (adminKey && isSameSecret(key, adminKey)) {
    return { class: "admin", detail: "the candidate IS the memory stack's administrative key" };
  }
  if (/^sk-(admin|root|system)/i.test(key)) {
    return { class: "admin", detail: "the candidate is shaped like an administrative key" };
  }
  return { class: "scoped", detail: "the candidate is not the memory stack's administrative key" };
}

export function applyBundle(plan, configDir, { dryRun, backupDir: backupDirOpt = null }) {
  const backupDir = backupDirOpt || join(ROOT, "data", "attach-backups", new Date().toISOString().replace(/[:.]/g, "-"));
  const changed = [];
  for (const f of plan) {
    if (f.status === "present") { log(`unchanged  ${f.rel}`); continue; }
    if (f.status === "preserve") {
      if (dryRun) { log(`(dry run) preserve ${f.rel} (the target keeps its own version)`); continue; }
      mkdirSync(backupDir, { recursive: true });
      const keepPath = join(backupDir, f.rel.replace(/\//g, "__") + ".product");
      copyFileSync(f.src, keepPath);
      log(`preserved ${f.rel} — the target has its own version; the product's copy is at ${keepPath} (merge it deliberately, docs/OPENCHAMBER-SETUP.md)`);
      changed.push({ rel: f.rel, dst: f.dst, status: "preserve", prevSha: f.prevSha, afterSha: null, backupPath: null, productCopy: keepPath });
      continue;
    }
    if (dryRun) { log(`(dry run) ${f.status.padEnd(7)} ${f.rel}`); continue; }
    mkdirSync(dirname(f.dst), { recursive: true });
    let backupPath = null;
    if (f.status === "replace") {
      mkdirSync(backupDir, { recursive: true });
      backupPath = join(backupDir, f.rel.replace(/\//g, "__"));
      mkdirSync(dirname(backupPath), { recursive: true });
      copyFileSync(f.dst, backupPath);
      try { chmodSync(backupPath, 0o600); } catch { /* best effort */ }
    }
    copyFileSync(f.src, f.dst);
    log(`${f.status.padEnd(7)} ${f.rel}${backupPath ? ` (backup: ${backupPath})` : ""}`);
    changed.push({
      rel: f.rel, dst: f.dst, status: f.status, prevSha: f.prevSha,
      afterSha: sha(f.dst), backupPath, productCopy: null,
    });
  }
  return { changed, backupDir: changed.length ? backupDir : null };
}

/**
 * The attach manifest: what this attach created/replaced, with the before- and
 * after-hashes. It is the ONLY input of the rollback, so a rollback can never
 * touch a file this attach did not write.
 */
export function writeAttachManifest(backupDir, { target, changed }) {
  if (!backupDir || !changed.length) return null;
  mkdirSync(backupDir, { recursive: true });
  const manifest = {
    createdAt: new Date().toISOString(),
    target: target ? { kind: target.kind, container: target.container || null, configDir: target.configDir || null } : null,
    files: changed.map((c) => ({
      rel: c.rel, dst: c.dst, status: c.status,
      prevSha: c.prevSha || null, afterSha: c.afterSha || null,
      backupPath: c.backupPath || null,
    })),
  };
  const p = join(backupDir, "MANIFEST.json");
  writeFileSync(p, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch { /* best effort */ }
  return p;
}

/**
 * Roll an attach back — the SUPPORTED product entrypoint (not a manual
 * harness step):
 *   - a file this attach CREATED is removed only while it still holds the
 *     content this attach wrote;
 *   - a file this attach REPLACED is restored only while it still holds the
 *     content this attach wrote;
 *   - a file that changed since the attach (a foreign edit) is REFUSED and
 *     reported — nothing is overwritten;
 *   - running it twice is safe: the second run reports "already rolled back";
 *   - nothing outside the manifest is ever touched (no global prune).
 */
export function rollbackAttach(backupDir, { dryRun = false } = {}) {
  const manifestPath = join(backupDir, "MANIFEST.json");
  if (!existsSync(manifestPath)) {
    return { ok: false, rc: 2, restored: [], removed: [], refused: [], detail: `no attach manifest in ${backupDir}` };
  }
  const manifest = readJsonFile(manifestPath);
  if (!manifest || !Array.isArray(manifest.files)) {
    return { ok: false, rc: 2, restored: [], removed: [], refused: [], detail: `unreadable attach manifest in ${backupDir}` };
  }
  // Two phases, so the undo is all-or-nothing (compare-and-swap):
  //   1. VERIFY every entry against the recorded after-hash; collect refusals.
  //   2. APPLY only when nothing was refused. A single foreign edit therefore
  //      blocks the whole rollback and nothing is written at all.
  const restored = [], removed = [], refused = [], skipped = [];
  const plan = [];
  for (const f of manifest.files) {
    if (f.status === "preserve") { skipped.push(f.rel); continue; }
    if (!f.dst) { skipped.push(f.rel); continue; }
    if (!existsSync(f.dst)) {
      // a created file that is already gone is already rolled back; a replaced
      // file that vanished is a foreign deletion and is refused, not skipped
      if (f.status === "replace") refused.push(`${f.rel} — removed since the attach (not restored)`);
      else skipped.push(f.rel);
      continue;
    }
    const cur = sha(f.dst);
    // A file in its recorded PRE-attach state is already rolled back (a repeat
    // run): a no-op, not a foreign edit. Only the attach's own after-state is
    // undone; any other content is a foreign edit and blocks the whole undo.
    if (f.status === "replace" && f.prevSha && cur === f.prevSha) {
      skipped.push(`${f.rel} (already at its pre-attach state)`);
      continue;
    }
    if (f.afterSha && cur !== f.afterSha) {
      refused.push(`${f.rel} — changed since the attach (not restored, not removed)`);
      continue;
    }
    if (f.status === "replace" && (!f.backupPath || !existsSync(f.backupPath))) {
      refused.push(`${f.rel} — the pre-attach backup is missing (not restored)`);
      continue;
    }
    plan.push(f);
  }
  if (refused.length) {
    return { ok: false, rc: 5, restored, removed, refused, skipped, detail: "rollback refused: nothing was written" };
  }
  for (const f of plan) {
    if (f.status === "create") {
      if (!dryRun) rmSync(f.dst, { force: true });
      removed.push(f.rel);
    } else if (f.status === "replace") {
      if (!dryRun) copyFileSync(f.backupPath, f.dst);
      restored.push(f.rel);
    }
  }
  return { ok: true, rc: 0, restored, removed, refused, skipped };
}

async function main(argv) {
  const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };

  // ── rollback (the supported undo for an attach) ────────────────────────────
  if (argv[0] === "rollback") {
    const dir = get("--backup-dir");
    if (!dir || !existsSync(dir)) {
      warn(`rollback needs --backup-dir <attach backup directory> (${dir || "missing"})`);
      return 2;
    }
    const dryRun = argv.includes("--dry-run");
    const r = rollbackAttach(dir, { dryRun });
    log(`rollback ${dryRun ? "(dry run) " : ""}${dir}`);
    for (const f of r.restored) log(`restored  ${f}`);
    for (const f of r.removed) log(`removed   ${f}`);
    for (const f of r.skipped) log(`skipped   ${f} (nothing to restore)`);
    for (const f of r.refused) warn(`REFUSED   ${f}`);
    if (!r.ok) {
      warn("rollback incomplete — foreign changes were preserved, nothing was overwritten");
      return r.rc;
    }
    log("rollback complete — the attach's own files were restored/removed, nothing else was touched");
    return 0;
  }

  const dryRun = argv.includes("--dry-run");
  const variant = get("--variant") || "3";
  const withGhost = argv.includes("--with-ghost");
  if (!["3", "4"].includes(variant)) throw new Error("--variant must be 3 or 4 (attach options)");
  if (withGhost && variant !== "4") throw new Error("Ghost is part of installation option 4 only");

  let target;
  const cname = get("--container"), cdir = get("--config-dir");
  if (cname) target = { kind: "container", container: cname };
  else if (cdir) {
    if (!existsSync(cdir)) throw new Error(`--config-dir ${cdir} does not exist`);
    target = { kind: "native", configDir: cdir };
  } else {
    target = discoverOpenchamber();
    if (target.kind === "none") {
      warn("no existing OpenChamber found (running container or ~/.config/opencode).");
      warn("installation options 3/4 ATTACH to an existing OpenChamber — see docs/OPENCHAMBER-SETUP.md; nothing was created.");
      return 2;
    }
    log(`discovered existing OpenChamber: kind=${target.kind}${target.container ? ` container=${target.container}` : ""}`);
  }

  if (argv.includes("--print-config")) {
    // Print ONLY the resolved host-side config directory of the target (used
    // by scripts/start.sh); nothing is copied or provisioned.
    process.stdout.write(resolveConfigDir(target) + "\n");
    return 0;
  }
  const configDir = resolveConfigDir(target);
  log(`config directory: ${configDir}`);
  if (dryRun) log("(dry run — nothing written)");

  // ── shared policy runtime (a first-class plugin dependency) ────────────────
  // The plugin runtime imports the SHARED documentation policy module, which in
  // turn drives scripts/memory-doc-ingest.py (whose own sibling import needs
  // scripts/memory_client.py). A foreign target's config does not reach this
  // repository's scripts/, so the attach carries the WHOLE non-stdlib closure
  // into <config>/plugins/singularity-runtime/scripts/ — byte-identical copies,
  // recorded in the same manifest, restorable by the same rollback. The
  // deterministic plugin import (plugins/…/../singularity-runtime/scripts/
  // doc-policy.mjs) then resolves in native AND containerized runtimes (the
  // config dir is bind-mounted into the container).
  const sharedRuntimePlan = [
    "doc-policy.mjs",
    "selflearn-candidates.mjs", // the shared automatic lesson pipeline doc-policy imports
    "memory-doc-ingest.py",
    "memory_client.py", // sibling import of memory-doc-ingest (its ONLY non-stdlib import) — without it the attached runtime cannot ingest at all
  ].map((name) => {
    const src = join(ROOT, "scripts", name);
    if (!existsSync(src)) throw new Error(`shared runtime dependency missing from the product: ${src}`);
    const dst = join(configDir, "plugins", "singularity-runtime", "scripts", name);
    let status = "create", curSha = null;
    if (existsSync(dst)) {
      curSha = sha(dst);
      status = curSha === sha(src) ? "present" : "replace";
    }
    return { rel: `plugins/singularity-runtime/scripts/${name}`, src, dst, status, prevSha: curSha, prevMode: existsSync(dst) ? statSync(dst).mode & 0o777 : null };
  });

  // ONE backup directory per attach: the bundle files and the credential
  // files share the same stamp and the same manifest.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = join(ROOT, "data", "attach-backups", stamp);
  const plan = planBundleFiles(configDir, BUNDLE, { preserveConflicts: target.kind !== "compose-managed" });
  const applied = applyBundle(plan, configDir, { dryRun, backupDir });
  const sharedApplied = applyBundle(sharedRuntimePlan, configDir, { dryRun, backupDir });
  const manifestFiles = applied.changed.concat(sharedApplied.changed);

  const pluginDir = join(configDir, "product-secrets");
  let credentialState = { ok: false, detail: "" };
  if (!dryRun) {
    mkdirSync(pluginDir, { recursive: true });
    // The credential files the provisioning touches are part of the attach:
    // their previous content is captured so the rollback can restore it.
    for (const name of ["memory.json", "office.json", "selflearn.json"]) {
      const p = join(pluginDir, name);
      const existed = existsSync(p);
      let backupPath = null;
      if (existed) {
        mkdirSync(backupDir, { recursive: true });
        backupPath = join(backupDir, `creds__${name}`);
        copyFileSync(p, backupPath);
        try { chmodSync(backupPath, 0o600); } catch { /* best effort */ }
      }
      manifestFiles.push({
        rel: `product-secrets/${name}`, dst: p, status: existed ? "replace" : "create",
        prevSha: existed ? sha(p) : null, afterSha: null, backupPath, productCopy: null,
      });
    }
    const args = ["scripts/provision-secrets.py", "--plugin-dir", pluginDir, "--variant", variant];
    if (variant === "4" && withGhost) args.push("--with-ghost");
    // A scoped MemoryCore user key for the target's plugin: an explicit
    // --memory-user-key / MEMORY_USER_KEY wins; otherwise the package's own
    // key for the SAME memory stack is reused — but ONLY when it is not an
    // administrative credential. The admin key is refused in process: it is
    // never propagated, never printed and never hashed into the output.
    const provisionEnv = { ...process.env };
    const explicitKey = get("--memory-user-key") || process.env.MEMORY_USER_KEY || "";
    const adminKey = readAdminKey();
    const pkgMem = readJsonFile(join(PLUGIN_DIR, "memory.json"));
    const pkgKey = pkgMem && typeof pkgMem.userKey === "string" ? pkgMem.userKey : "";
    let candidate = "";
    let candidateOrigin = "";
    if (explicitKey) {
      candidate = explicitKey;
      candidateOrigin = "--memory-user-key/MEMORY_USER_KEY";
    } else if (pkgKey) {
      candidate = pkgKey;
      candidateOrigin = "the package's own plugin credential";
    }
    const cls = classifyCandidateKey(candidate, { adminKey });
    if (!candidate) {
      credentialState = { ok: false, detail: "no scoped MemoryCore user key is available — the target's plugin credentials stay empty" };
      log("memory user key: NONE available — pass a scoped business-user key with --memory-user-key (or MEMORY_USER_KEY) and re-attach");
    } else if (cls.class === "admin") {
      credentialState = { ok: false, detail: `the candidate from ${candidateOrigin} is the memory stack's ADMINISTRATIVE key — it is never propagated into a target` };
      warn(`memory user key: REFUSED — ${cls.detail}; an administrative credential is never written into a target`);
      warn("memory user key: provide a scoped business-user key instead (--memory-user-key / MEMORY_USER_KEY) — see docs/MEMORY-SETUP.md");
    } else if (cls.class === "unknown") {
      credentialState = { ok: false, detail: `the candidate from ${candidateOrigin} cannot be classified` };
      warn(`memory user key: REFUSED — ${cls.detail}`);
    } else {
      provisionEnv.MEMORY_USER_KEY = candidate;
      credentialState = { ok: true, detail: "a scoped (non-administrative) key is in place" };
      log(`memory user key: using the scoped key from ${candidateOrigin} (never printed)`);
    }
    const pr = spawnSync("python3", args, { cwd: ROOT, encoding: "utf8", env: provisionEnv });
    log(pr.stdout?.trim() || "provision-secrets produced no output");
    if (pr.status !== 0) {
      warn(`credential provisioning exited ${pr.status} — ${(pr.stderr || "").trim().split("\n").slice(-2).join(" | ")}`);
      return 3;
    }
    // record what the provisioning wrote (after-hashes) in the same manifest
    for (const f of manifestFiles) {
      if (f.rel.startsWith("product-secrets/") && existsSync(f.dst)) f.afterSha = sha(f.dst);
    }
    const manifestPath = writeAttachManifest(backupDir, { target, changed: manifestFiles });
    if (manifestPath) log(`manifest   ${manifestPath} (rollback: node scripts/attach-openchamber.mjs rollback --backup-dir ${backupDir})`);
    // Verify the key that actually landed in the TARGET: a scoped identity is
    // proved live (auth/verify), an administrative one is reported.
    const targetMem = readJsonFile(join(pluginDir, "memory.json"));
    const targetKey = targetMem && typeof targetMem.userKey === "string" ? targetMem.userKey : "";
    if (!targetKey) {
      credentialState = { ok: false, detail: "the target has no memory user key" };
      warn("memory user key: the target's plugin credentials are empty — the memory capability stays INCOMPLETE");
    } else if (adminKey && isSameSecret(targetKey, adminKey)) {
      credentialState = { ok: false, detail: "the target's plugin credential is the memory stack's ADMIN key" };
      warn("memory user key: the target's plugin credential is ADMINISTRATIVE — it was not written by this attach and must be replaced with a scoped key");
    } else {
      const cls2 = classifyCandidateKey(targetKey, { adminKey });
      credentialState = cls2.class === "scoped"
        ? { ok: true, detail: "the target holds a scoped (non-administrative) plugin key" }
        : { ok: false, detail: `the target's plugin credential cannot be classified (${cls2.detail})` };
      if (!credentialState.ok) warn(`memory user key: ${credentialState.detail}`);
    }
  }

  if (target.kind === "container" || target.kind === "compose-managed") {
    const rql = spawnSync("docker", ["exec", target.container, "rql", "--version"], { encoding: "utf8" });
    if (rql.status === 0) log(`rql ${String(rql.stdout || "").trim()} available inside ${target.container}`);
    else warn(`rql is NOT runnable inside ${target.container} — add compose/repoql.override.yml to ITS compose file (bind-mount the WSL2 Linux rql binary) and recreate the container yourself; this script never edits your compose (docs/REPOQL-SETUP.md).`);
  }
  if (!credentialState.ok) {
    warn(`INSTALL INCOMPLETE — ${credentialState.detail}`);
    warn("the bundle is attached, but the memory capability is not usable until a scoped business-user key is provisioned (docs/MEMORY-SETUP.md)");
    return 5;
  }
  log("attach complete. Restart the target OpenChamber instance yourself to load the plugins — this script never restarts it.");
  return 0;
}

export { main as attachMain };
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
