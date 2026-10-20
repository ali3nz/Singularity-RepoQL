#!/usr/bin/env node
// attach-openchamber.mjs — install the Singularity OpenChamber bundle into an
// EXISTING OpenChamber installation (installation options 3 and 4).
//
// Rules (docs/OPENCHAMBER-SETUP.md §attach):
//   - NEVER creates a second OpenChamber and never starts or stops anything;
//   - NEVER deletes a file, and never overwrites without a backup: every file
//     whose content would change is copied to data/attach-backups/<stamp>/ first;
//   - unrelated files in the target config stay untouched;
//   - plugin credentials are provisioned INTO the discovered config
//     (provision-secrets.py --plugin-dir); existing values are preserved;
//   - for a containerized instance the rql presence is checked and the manual
//     bind-mount step is PRINTED when absent — the user's compose file is
//     never edited by this script.
//
// Usage:
//   node scripts/attach-openchamber.mjs [--discover]
//        [--container NAME | --config-dir DIR] [--variant 3|4] [--dry-run]
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = join(ROOT, "openchamber");
const PLUGIN_DIR = join(ROOT, "data/opencode/config/product-secrets");
const OC_CONFIG_DEST = "/home/openchamber/.config/opencode";

const log = (m) => console.log(`[attach] ${m}`);
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
export function planBundleFiles(configDir, srcRoot = BUNDLE) {
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
        plan.push({ rel: r, src: s, dst: d, status, prevSha: curSha, prevMode: existsSync(d) ? statSync(d).mode & 0o777 : null });
      }
    }
  };
  walk(srcRoot, configDir, "");
  return plan;
}

import { createHash } from "node:crypto";
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

export function applyBundle(plan, configDir, { dryRun }) {
  const backupDir = join(ROOT, "data", "attach-backups", new Date().toISOString().replace(/[:.]/g, "-"));
  const changed = [];
  for (const f of plan) {
    if (f.status === "present") { log(`unchanged  ${f.rel}`); continue; }
    if (dryRun) { log(`(dry run) ${f.status.padEnd(7)} ${f.rel}`); continue; }
    mkdirSync(dirname(f.dst), { recursive: true });
    let backupPath = null;
    if (f.status === "replace") {
      mkdirSync(backupDir, { recursive: true });
      backupPath = join(backupDir, f.rel.replace(/\//g, "__"));
      mkdirSync(dirname(backupPath), { recursive: true });
      copyFileSync(f.dst, backupPath);
      try { import("node:fs").then(({ chmodSync }) => chmodSync(backupPath, 0o600)); } catch { /* best effort */ }
    }
    copyFileSync(f.src, f.dst);
    log(`${f.status.padEnd(7)} ${f.rel}${backupPath ? ` (backup: ${backupPath})` : ""}`);
    changed.push({ rel: f.rel, status: f.status, backupPath });
  }
  return { changed, backupDir: changed.length ? backupDir : null };
}

async function main(argv) {
  const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
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

  const plan = planBundleFiles(configDir);
  applyBundle(plan, configDir, { dryRun });

  const pluginDir = join(configDir, "product-secrets");
  if (!dryRun) {
    mkdirSync(pluginDir, { recursive: true });
    const args = ["scripts/provision-secrets.py", "--plugin-dir", pluginDir, "--variant", variant];
    if (variant === "4" && withGhost) args.push("--with-ghost");
    const pr = spawnSync("python3", args, { cwd: ROOT, encoding: "utf8" });
    log(pr.stdout?.trim() || "provision-secrets produced no output");
    if (pr.status !== 0) {
      warn(`credential provisioning exited ${pr.status} — ${(pr.stderr || "").trim().split("\n").slice(-2).join(" | ")}`);
      return 3;
    }
  }

  if (target.kind === "container" || target.kind === "compose-managed") {
    const rql = spawnSync("docker", ["exec", target.container, "rql", "--version"], { encoding: "utf8" });
    if (rql.status === 0) log(`rql ${String(rql.stdout || "").trim()} available inside ${target.container}`);
    else warn(`rql is NOT runnable inside ${target.container} — add compose/repoql.override.yml to ITS compose file (bind-mount the WSL2 Linux rql binary) and recreate the container yourself; this script never edits your compose (docs/REPOQL-SETUP.md).`);
  }
  log("attach complete. Restart the target OpenChamber instance yourself to load the plugins — this script never restarts it.");
  return 0;
}

export { main as attachMain };
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
