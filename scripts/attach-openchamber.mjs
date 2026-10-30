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
import { classifyBundleFile, variantIncludesComponent } from "./bundle-classification.mjs";

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
// ── managed policy block (AGENTS.md) ────────────────────────────────────────
// The target's AGENTS.md is its identity: the attach NEVER overwrites it. It
// merges ONE versioned, deterministic block and leaves every byte outside the
// markers alone. A malformed block (duplicate/mismatched markers) is a refusal,
// not a rewrite — the operator's file stays exactly as it was.
export const MANAGED_BEGIN = "<!-- singularity:managed:begin v1 -->";
export const MANAGED_END = "<!-- singularity:managed:end v1 -->";
export const MANAGED_POLICY = [
  "## Singularity managed policy",
  "",
  "This block is owned by the Singularity installer. Do not edit inside the markers.",
  "",
  "- Report product issues ONLY through RepoQL: search the repository first, then",
  "  record the finding in the project's issue tracker. Never report a product",
  "  issue in agent chat, logs, docs or code comments.",
  "- RepoQL is the first-step retrieval tool; treat its index as authoritative and",
  "  the conversation history as supplementary.",
  "- Keep this installation's configuration and credentials in its own config",
  "  directory; never copy them into a project checkout.",
].join("\n");

const countOf = (hay, needle) => hay.split(needle).length - 1;
const managedBlockText = (body = MANAGED_POLICY) => `${MANAGED_BEGIN}\n${String(body).trimEnd()}\n${MANAGED_END}`;
const blockShaOf = (body = MANAGED_POLICY) => createHash("sha256").update(managedBlockText(body)).digest("hex");

/**
 * Merge the managed block into an existing AGENTS.md.
 * @returns {{ok:boolean, action:"append"|"update"|"unchanged"|"refuse", text:string, reason?:string}}
 */
export function mergeManagedBlock(existing, { body = MANAGED_POLICY } = {}) {
  const text = String(existing ?? "");
  const begins = countOf(text, MANAGED_BEGIN);
  const ends = countOf(text, MANAGED_END);
  if (begins === 0 && ends === 0) {
    const sep = text.length === 0 ? "" : text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    return { ok: true, action: "append", text: `${text}${sep}${managedBlockText(body)}` };
  }
  if (begins !== 1 || ends !== 1) {
    return { ok: false, action: "refuse", text, reason: `malformed managed block (${begins} begin / ${ends} end markers) — the file was not modified` };
  }
  const i = text.indexOf(MANAGED_BEGIN);
  const j = text.indexOf(MANAGED_END);
  if (j < i) return { ok: false, action: "refuse", text, reason: "malformed managed block (end marker before begin marker) — the file was not modified" };
  const next = `${text.slice(0, i)}${managedBlockText(body)}${text.slice(j + MANAGED_END.length)}`;
  return next === text ? { ok: true, action: "unchanged", text } : { ok: true, action: "update", text: next };
}

/** Remove ONLY the managed block; every byte outside the markers is preserved. */
export function stripManagedBlock(text) {
  const s = String(text ?? "");
  const begins = countOf(s, MANAGED_BEGIN);
  const ends = countOf(s, MANAGED_END);
  if (begins === 0 && ends === 0) return { ok: true, removed: false, text: s };
  if (begins !== 1 || ends !== 1) return { ok: false, removed: false, text: s, reason: `malformed managed block (${begins} begin / ${ends} end markers)` };
  const i = s.indexOf(MANAGED_BEGIN);
  const j = s.indexOf(MANAGED_END);
  if (j < i) return { ok: false, removed: false, text: s, reason: "malformed managed block (end before begin)" };
  let head = s.slice(0, i);
  const tail = s.slice(j + MANAGED_END.length);
  // undo exactly the separator this attach inserts before the block
  if (tail === "" && head.endsWith("\n\n")) head = head.slice(0, -1);
  return { ok: true, removed: true, text: head + tail };
}

// ── JSONC merge (comment-preserving) ────────────────────────────────────────
// A target's opencode.jsonc carries the user's comments, ordering and a
// pre-existing RepoQL identity. This merge NEVER re-serialises: it validates
// the file, then splices only MISSING keys into the existing text. Comments,
// ordering, formatting and every present value are preserved byte-for-byte.
// If the file cannot be parsed — or a splice cannot be placed safely — the
// merge REFUSES and the caller reports INCOMPLETE instead of "success".

/** Mask comments and string bodies to spaces, preserving offsets and newlines. */
export function maskJsonc(text) {
  const s = String(text ?? "");
  const out = [];
  let state = "normal";
  for (let i = 0; i < s.length; i++) {
    const c = s[i], n = s[i + 1];
    if (state === "normal") {
      if (c === "/" && n === "/") { out.push("  "); i++; state = "line"; continue; }
      if (c === "/" && n === "*") { out.push("  "); i++; state = "block"; continue; }
      if (c === '"') { out.push('"'); state = "string"; continue; }
      out.push(c); continue;
    }
    if (state === "line") {
      if (c === "\n") { out.push("\n"); state = "normal"; } else out.push(" ");
      continue;
    }
    if (state === "block") {
      if (c === "*" && n === "/") { out.push("  "); i++; state = "normal"; continue; }
      out.push(c === "\n" ? "\n" : " "); continue;
    }
    // string body
    if (c === "\\") { out.push("  "); i++; continue; }
    if (c === '"') { out.push('"'); state = "normal"; continue; }
    out.push(c === "\n" ? "\n" : " ");
  }
  return out.join("");
}

/**
 * Comment-stripped, JSON.parse-compatible text: comments become spaces (offsets
 * preserved) and JSONC trailing commas are dropped. String contents are NEVER
 * touched, so a "//" or "," inside a value is not mistaken for syntax.
 */
function jsoncToJson(text) {
  const s = String(text ?? "");
  let out = "", state = "normal";
  for (let i = 0; i < s.length; i++) {
    const c = s[i], n = s[i + 1];
    if (state === "normal") {
      if (c === "/" && n === "/") { out += "  "; i++; state = "line"; continue; }
      if (c === "/" && n === "*") { out += "  "; i++; state = "block"; continue; }
      if (c === ",") {
        let k = i + 1;
        while (k < s.length && /\s/.test(s[k])) k++;
        if (s[k] === "}" || s[k] === "]") { out += " "; continue; } // JSONC trailing comma
      }
      if (c === '"') state = "string";
      out += c; continue;
    }
    if (state === "line") {
      if (c === "\n") { out += "\n"; state = "normal"; } else out += " ";
      continue;
    }
    if (state === "block") {
      if (c === "*" && n === "/") { out += "  "; i++; state = "normal"; continue; }
      out += c === "\n" ? "\n" : " "; continue;
    }
    if (c === "\\") { out += s.slice(i, i + 2); i++; continue; }
    if (c === '"') state = "normal";
    out += c;
  }
  return out;
}

/** Public: parse a JSONC document (comments + trailing commas) without mutating it. */
export const parseJsonc = (text) => JSON.parse(jsoncToJson(text));

const matchBrace = (masked, open) => {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "{") depth++;
    else if (masked[i] === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
};

/** Find `"key"` at a given brace depth inside [from, to); returns value span. */
function findKey(masked, key, { from = 0, to = masked.length, depth = 1 } = {}) {
  let d = 0;
  for (let i = from; i < to; i++) {
    const c = masked[i];
    if (c === "{" || c === "[") { d++; continue; }
    if (c === "}" || c === "]") { d--; continue; }
    if (c !== '"' || d !== depth) continue;
    const endQuote = masked.indexOf('"', i + 1);
    if (endQuote < 0) return null;
    const name = masked.slice(i + 1, endQuote);
    let k = endQuote + 1;
    while (k < to && /\s/.test(masked[k])) k++;
    if (masked[k] !== ":") { i = endQuote; continue; }
    if (name !== key) { i = endQuote; continue; }
    let v = k + 1;
    while (v < to && /\s/.test(masked[v])) v++;
    let valueEnd;
    if (masked[v] === "{" || masked[v] === "[") {
      const close = masked[v] === "{" ? matchBrace(masked, v) : (() => { let dep = 0; for (let z = v; z < masked.length; z++) { if (masked[z] === "[") dep++; else if (masked[z] === "]") { dep--; if (!dep) return z; } } return -1; })();
      if (close < 0) return null;
      valueEnd = close + 1;
    } else {
      let z = v;
      while (z < to && !/[,\n}]/.test(masked[z])) z++;
      valueEnd = z;
    }
    return { keyStart: i, valueStart: v, valueEnd };
  }
  return null;
}

/**
 * Insert the desired integration keys that are MISSING from an existing JSONC
 * document, preserving comments, ordering and every present value.
 * @returns {{ok:boolean, text:string, inserted:string[], reason?:string, action:string}}
 */
export function mergeJsoncIntegration(existing, desired) {
  const text = String(existing ?? "");
  const keys = Object.keys(desired || {});
  if (!keys.length) return { ok: true, text, inserted: [], action: "unchanged" };
  if (!text.trim()) {
    const body = JSON.stringify(desired, null, 2);
    return { ok: true, text: `${body}\n`, inserted: keys, action: "create" };
  }
  let parsed;
  try { parsed = JSON.parse(jsoncToJson(text)); } catch {
    return { ok: false, text, inserted: [], action: "refuse", reason: "the target file is not parseable JSONC — refuse rather than rewrite it (no comments were deleted)" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, text, inserted: [], action: "refuse", reason: "the target file is not a JSON object — refuse rather than rewrite it" };
  }
  const masked = maskJsonc(text);
  const rootOpen = masked.indexOf("{");
  const rootClose = rootOpen >= 0 ? matchBrace(masked, rootOpen) : -1;
  if (rootOpen < 0 || rootClose < 0) {
    return { ok: false, text, inserted: [], action: "refuse", reason: "the target file has no single root object — refuse rather than rewrite it" };
  }
  const inserted = [];
  let out = text;
  // nested first (a later top-level insert does not shift the mcp span we found)
  if (desired.mcp && typeof desired.mcp === "object" && parsed.mcp && typeof parsed.mcp === "object") {
    const mcpSpan = findKey(masked, "mcp", { from: rootOpen, to: rootClose + 1, depth: 1 });
    if (mcpSpan && masked[mcpSpan.valueStart] === "{") {
      const mcpOpen = mcpSpan.valueStart;
      const mcpClose = matchBrace(masked, mcpOpen);
      const missing = Object.keys(desired.mcp).filter((k) => !(k in parsed.mcp));
      if (missing.length && mcpClose >= 0) {
        const indent = detectIndent(text, mcpOpen, mcpClose) + "  ";
        const snippet = missing.map((k) => `${indent}${JSON.stringify(k)}: ${JSON.stringify(desired.mcp[k], null, 2).replace(/\n/g, `\n${indent}`)}`).join(",\n");
        const inner = masked.slice(mcpOpen + 1, mcpClose);
        const hasMembers = /[^\s,]/.test(inner);
        const at = mcpClose;
        const add = `${hasMembers ? "," : ""}\n${snippet}`;
        out = out.slice(0, at) + add + out.slice(at);
        inserted.push(...missing.map((k) => `mcp.${k}`));
      }
    }
  }
  // then any missing top-level keys
  const missingTop = keys.filter((k) => !(k in parsed));
  if (missingTop.length) {
    const m2 = maskJsonc(out);
    const open2 = m2.indexOf("{");
    const close2 = matchBrace(m2, open2);
    if (open2 < 0 || close2 < 0) return { ok: false, text, inserted: [], action: "refuse", reason: "root object lost while merging — refuse" };
    const baseIndent = detectIndent(out, open2, close2);
    const snippet = missingTop.map((k) => `${baseIndent}${JSON.stringify(k)}: ${JSON.stringify(desired[k]).replace(/\n/g, "")}`).join(",\n");
    const inner = m2.slice(open2 + 1, close2);
    const hasMembers = /[^\s,]/.test(inner);
    out = `${out.slice(0, close2)}${hasMembers ? "," : ""}\n${snippet}\n${out.slice(close2)}`;
    inserted.push(...missingTop);
  }
  // final safety: the merged text must STILL parse and must contain every key
  let after;
  try { after = JSON.parse(jsoncToJson(out)); } catch {
    return { ok: false, text, inserted: [], action: "refuse", reason: "the merged result would not parse — refused, original kept" };
  }
  for (const k of keys) if (!(k in after)) return { ok: false, text, inserted: [], action: "refuse", reason: `key ${k} could not be inserted safely — refused, original kept` };
  return { ok: true, text: out, inserted, action: inserted.length ? "insert" : "unchanged" };
}

/** Indentation of the first member inside a brace span (falls back to 2 spaces). */
function detectIndent(text, open, close) {
  const inner = text.slice(open + 1, close);
  const m = inner.match(/\n([ \t]+)\S/);
  return m ? m[1] : "  ";
}


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

/**
 * Build the per-file copy plan for the bundle.
 * status: create | replace | present | merge-policy | merge-jsonc | namespace | conflict | preserve
 *
 * `variant` (1..4) drives the classification table: options 1/3 never see a
 * Ghost or Office file, so the attach cannot leak them. An unclassified bundle
 * file is a hard error, never a silent copy.
 */
export function planBundleFiles(configDir, srcRoot = BUNDLE, { preserveConflicts = false, variant = null } = {}) {
  const plan = [];
  const allows = (bundleRel) => {
    if (variant == null) return true;
    const c = classifyBundleFile(bundleRel);
    if (!c) throw new Error(`unclassified bundle file: ${bundleRel} — add an explicit component to scripts/bundle-classification.mjs`);
    return variantIncludesComponent(variant, c.component);
  };
  const walk = (src, dst, rel) => {
    for (const e of readdirSync(src, { withFileTypes: true })) {
      const s = join(src, e.name), d = join(dst, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name === "examples") continue; // shipped examples are not runtime config
        walk(s, d, r);
      } else {
        if (!allows(srcRoot === BUNDLE ? `openchamber/${r}` : r)) continue;
        let status = "create", curSha = null, finalDst = d, namespacedFrom = null;
        if (existsSync(d)) {
          curSha = sha(d);
          if (curSha === sha(s)) status = "present";
          else if (!preserveConflicts) status = "replace";
          else if (r === "AGENTS.md") status = "merge-policy";
          else if (r === "opencode.jsonc" || r === "dcp.jsonc") status = "merge-jsonc";
          else if (/^(agents|skills)\//.test(r)) {
            // A foreign agent/skill with the same name is PRESERVED. Ours lands
            // under a deterministic, discovery-compatible name: OpenCode loads
            // every *.md in agents/, so singularity-<name>.md is discovered
            // (an ".md.product" suffix would not be).
            namespacedFrom = r;
            finalDst = join(dirname(d), `singularity-${e.name}`);
            if (existsSync(finalDst)) status = sha(finalDst) === sha(s) ? "present" : "conflict";
            else status = "namespace";
          } else status = "replace"; // every other bundle file keeps the documented replace-with-backup behaviour
        }
        plan.push({
          rel: r, src: s, dst: finalDst, status, prevSha: namespacedFrom ? null : curSha,
          prevMode: existsSync(finalDst) ? statSync(finalDst).mode & 0o777 : null,
          namespacedFrom,
        });
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

/** Integration keys this attach is allowed to add to a foreign target's JSONC. */
const INTEGRATION_KEYS = Object.freeze({ "opencode.jsonc": ["mcp", "plugin"], "dcp.jsonc": [] });

/** The integration values come from the SHIPPED product file, never a second copy. */
export function bundleIntegrationKeys(rel, root = BUNDLE) {
  const keys = INTEGRATION_KEYS[rel] || [];
  if (!keys.length) return {};
  const p = join(root, rel);
  let desired = {};
  if (existsSync(p)) {
    try {
      const parsed = JSON.parse(jsoncToJson(readFileSync(p, "utf8")));
      for (const k of keys) if (k in parsed) desired[k] = parsed[k];
    } catch { /* unreadable product file: fall through to the explicit minimum */ }
  }
  if (!desired.mcp && keys.includes("mcp")) {
    desired.mcp = { repoql: { type: "local", command: ["/usr/local/bin/rql", "mcp"], enabled: true } };
  }
  if (!desired.plugin && keys.includes("plugin") && existsSync(p)) {
    // a product file without a plugin entry contributes nothing to merge
    delete desired.plugin;
  }
  return desired;
}

export function applyBundle(plan, configDir, { dryRun, backupDir: backupDirOpt = null }) {
  const backupDir = backupDirOpt || join(ROOT, "data", "attach-backups", new Date().toISOString().replace(/[:.]/g, "-"));
  const changed = [];
  const refused = [];
  const backupOf = (f) => {
    mkdirSync(backupDir, { recursive: true });
    const backupPath = join(backupDir, f.rel.replace(/\//g, "__"));
    mkdirSync(dirname(backupPath), { recursive: true });
    copyFileSync(f.dst, backupPath);
    try { chmodSync(backupPath, 0o600); } catch { /* best effort */ }
    return backupPath;
  };
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
    if (f.status === "conflict") {
      // A foreign file already occupies the deterministic namespaced name.
      // Overwriting it would destroy another tool's agent: refuse, keep data.
      refused.push(`${f.rel} — ${f.dst} already exists with different content (foreign agent/skill was NOT overwritten)`);
      continue;
    }
    if (f.status === "merge-policy" || f.status === "merge-jsonc") {
      const before = readFileSync(f.dst, "utf8");
      const merged = f.status === "merge-policy"
        ? mergeManagedBlock(before)
        : mergeJsoncIntegration(before, bundleIntegrationKeys(f.rel));
      if (!merged.ok) { refused.push(`${f.rel} — ${merged.reason}`); continue; }
      if (merged.action === "unchanged") { log(`unchanged  ${f.rel} (integration already present; user values kept)`); continue; }
      if (dryRun) { log(`(dry run) merge    ${f.rel} (${f.status === "merge-policy" ? "managed block" : `keys ${merged.inserted.join(", ")}`})`); continue; }
      const backupPath = backupOf(f);
      writeFileSync(f.dst, merged.text);
      log(`merged   ${f.rel}${f.status === "merge-jsonc" ? ` (added ${merged.inserted.join(", ") || "nothing"}; comments kept)` : " (managed block)"} (backup: ${backupPath})`);
      changed.push({
        rel: f.rel, dst: f.dst, status: "merge",
        mergeKind: f.status === "merge-policy" ? "policy" : "jsonc",
        inserted: merged.inserted || [], blockSha: f.status === "merge-policy" ? blockShaOf() : null,
        prevSha: f.prevSha, afterSha: sha(f.dst), backupPath, productCopy: null,
      });
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
    log(`${f.status === "namespace" ? "namespaced" : f.status.padEnd(7)} ${f.rel}${f.namespacedFrom ? ` → ${f.dst} (foreign ${f.rel} preserved)` : ""}${backupPath ? ` (backup: ${backupPath})` : ""}`);
    changed.push({
      rel: f.rel, dst: f.dst, status: f.status, namespacedFrom: f.namespacedFrom || null,
      prevSha: f.prevSha, afterSha: sha(f.dst), backupPath, productCopy: null,
    });
  }
  return { changed, refused, backupDir: changed.length ? backupDir : null };
}

/**
 * The attach manifest: what this attach created/replaced, with the before- and
 * after-hashes. It is the ONLY input of the rollback, so a rollback can never
 * touch a file this attach did not write.
 */
export function writeAttachManifest(backupDir, { target, changed, variant = null }) {
  if (!backupDir || !changed.length) return null;
  mkdirSync(backupDir, { recursive: true });
  const manifest = {
    createdAt: new Date().toISOString(),
    // The installation option this attach performed. The doctor uses this
    // record to select options 3/4 on a host with no Claude Code install.
    variant: variant == null ? null : String(variant),
    target: target ? { kind: target.kind, container: target.container || null, configDir: target.configDir || null } : null,
    // ownership ledger: which product file landed under which namespaced name
    namespaceMap: Object.fromEntries(changed.filter((c) => c.namespacedFrom).map((c) => [c.namespacedFrom, c.dst])),
    files: changed.map((c) => ({
      rel: c.rel, dst: c.dst, status: c.status,
      namespacedFrom: c.namespacedFrom || null,
      mergeKind: c.mergeKind || null, inserted: c.inserted || [], blockSha: c.blockSha || null,
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
    const replaceLike = f.status === "replace" || f.status === "merge";
    if (!existsSync(f.dst)) {
      // a created file that is already gone is already rolled back; a replaced
      // file that vanished is a foreign deletion and is refused, not skipped
      if (replaceLike) refused.push(`${f.rel} — removed since the attach (not restored)`);
      else skipped.push(f.rel);
      continue;
    }
    const cur = sha(f.dst);
    // A file in its recorded PRE-attach state is already rolled back (a repeat
    // run): a no-op, not a foreign edit. Only the attach's own after-state is
    // undone; any other content is a foreign edit and blocks the whole undo.
    if (replaceLike && f.prevSha && cur === f.prevSha) {
      skipped.push(`${f.rel} (already at its pre-attach state)`);
      continue;
    }
    if (f.afterSha && cur !== f.afterSha) {
      // A managed policy BLOCK can still be undone when the user only appended
      // content outside it: strip the block, keep every appended byte.
      if (f.status === "merge" && f.mergeKind === "policy") {
        const live = readFileSync(f.dst, "utf8");
        const liveSha = createHash("sha256").update(managedBlockText()).digest("hex");
        if (f.blockSha && liveSha === f.blockSha) {
          const stripped = stripManagedBlock(live);
          if (stripped.ok && stripped.removed) { plan.push({ ...f, blockOnly: true, blockText: stripped.text }); continue; }
        }
        refused.push(`${f.rel} — changed since the attach (managed block was edited; not removed)`);
        continue;
      }
      refused.push(`${f.rel} — changed since the attach (not restored, not removed)`);
      continue;
    }
    if (replaceLike && (!f.backupPath || !existsSync(f.backupPath))) {
      refused.push(`${f.rel} — the pre-attach backup is missing (not restored)`);
      continue;
    }
    plan.push(f);
  }
  if (refused.length) {
    return { ok: false, rc: 5, restored, removed, refused, skipped, detail: "rollback refused: nothing was written" };
  }
  for (const f of plan) {
    if (f.blockOnly) {
      if (!dryRun) writeFileSync(f.dst, f.blockText);
      restored.push(`${f.rel} (managed block removed; user content kept)`);
    } else if (f.status === "create" || f.status === "namespace") {
      if (!dryRun) rmSync(f.dst, { force: true });
      removed.push(f.rel);
    } else if (f.status === "replace" || f.status === "merge") {
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
  // The plugin runtime imports the SHARED documentation policy module, which
  // imports BOTH selflearn-candidates.mjs and doc-ingest-node.mjs. The legacy
  // memory-doc-ingest.py separately imports sibling memory_client.py.
  // A foreign target's config does not reach this
  // repository's scripts/, so the attach carries the WHOLE non-stdlib closure
  // into <config>/plugins/singularity-runtime/scripts/ — byte-identical copies,
  // recorded in the same manifest, restorable by the same rollback. The
  // deterministic plugin import (plugins/…/../singularity-runtime/scripts/
  // doc-policy.mjs) then resolves in native AND containerized runtimes (the
  // config dir is bind-mounted into the container).
  const sharedRuntimePlan = [
    "doc-policy.mjs",
    "selflearn-candidates.mjs", // the shared automatic lesson pipeline doc-policy imports
    "doc-ingest-node.mjs", // required direct import of doc-policy: missing it silently disables shared discovery
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
  const plan = planBundleFiles(configDir, BUNDLE, { preserveConflicts: target.kind !== "compose-managed", variant });
  const applied = applyBundle(plan, configDir, { dryRun, backupDir });
  const sharedApplied = applyBundle(sharedRuntimePlan, configDir, { dryRun, backupDir });
  const manifestFiles = applied.changed.concat(sharedApplied.changed);
  const refusals = applied.refused.concat(sharedApplied.refused || []);
  if (refusals.length) {
    // A conflict or a malformed managed block is never "fixed" by rewriting:
    // the target's data is preserved and the option is reported INCOMPLETE.
    for (const r of refusals) warn(`REFUSED   ${r}`);
    writeAttachManifest(backupDir, { target, changed: manifestFiles, variant });
    warn(`INSTALL INCOMPLETE — ${refusals.length} file(s) could not be merged safely; nothing was overwritten`);
    warn("resolve the conflict by hand (or remove the foreign file) and re-run the attach — the operation is idempotent");
    return 5;
  }

  const pluginDir = join(configDir, "product-secrets");
  let credentialState = { ok: false, detail: "" };
  if (!dryRun) {
    mkdirSync(pluginDir, { recursive: true });
    // The credential files the provisioning touches are part of the attach:
    // their previous content is captured so the rollback can restore it.
    // Option 4 also carries Ghost: its target identity file is derived and
    // recorded here, so rollback removes/restores it like every other file.
    const credentialNames = ["memory.json", "office.json", "selflearn.json"];
    if (variant === "4") credentialNames.push("ghost.json");
    for (const name of credentialNames) {
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
    // provision-secrets.py ALSO writes package-level files (secrets/*.env)
    // outside the target config dir. They belong to this attach: capture their
    // pre-state now and record them in the same manifest, so the supported
    // rollback removes a generated file (or restores a replaced one).
    const external = [];
    for (const name of variant === "4" ? ["claude-office.env", ...(withGhost ? ["ghost.env"] : [])] : []) {
      const dst = join(ROOT, "secrets", name);
      const existed = existsSync(dst);
      let backupPath = null;
      if (existed) {
        mkdirSync(backupDir, { recursive: true });
        backupPath = join(backupDir, `pkg__${name}`);
        copyFileSync(dst, backupPath);
        try { chmodSync(backupPath, 0o600); } catch { /* best effort */ }
      }
      external.push({ rel: `package-secrets/${name}`, dst, status: existed ? "replace" : "create", prevSha: existed ? sha(dst) : null, afterSha: null, backupPath, productCopy: null });
    }
    const pr = spawnSync("python3", args, { cwd: ROOT, encoding: "utf8", env: provisionEnv });
    log(pr.stdout?.trim() || "provision-secrets produced no output");
    const finishManifest = () => {
      // Option 4 carries Ghost: derive the TARGET's ghost.json from its own
      // memory.json, exactly as ghost/setup-ghost.sh does for the package
      // config (same service, Ghost ids). The key is copied within the target
      // and is never printed.
      if (variant === "4") {
        const mem = readJsonFile(join(pluginDir, "memory.json"));
        if (mem && mem.baseUrl && mem.userKey) {
          writeFileSync(join(pluginDir, "ghost.json"), JSON.stringify({
            baseUrl: mem.baseUrl,
            authPrefix: mem.authPrefix || "Bearer ",
            serviceId: mem.serviceId || "openchamber",
            userKey: mem.userKey,
            ghostTeamId: mem.ghostTeamId || "ghost-companion",
            ghostUserId: mem.ghostUserId || "pilot-operator",
            ghostAgentId: mem.ghostAgentId || "ghost",
          }, null, 2) + "\n", { mode: 0o600 });
          log("ghost.json: derived the target's Ghost memory identity from its memory.json (never printed)");
        } else {
          warn("ghost.json: the target has no usable memory identity — Ghost wiring stays INCOMPLETE");
        }
      }
      // Record only the external files this run actually changed.
      for (const e of external) {
        if (!existsSync(e.dst)) { if (e.backupPath) rmSync(e.backupPath, { force: true }); continue; }
        const now = sha(e.dst);
        if (e.prevSha === now) { if (e.backupPath) rmSync(e.backupPath, { force: true }); continue; }
        e.afterSha = now;
        manifestFiles.push(e);
      }
      // record what the provisioning wrote (after-hashes) in the same manifest
      for (const f of manifestFiles) {
        if (f.rel.startsWith("product-secrets/") && existsSync(f.dst)) f.afterSha = sha(f.dst);
      }
      return writeAttachManifest(backupDir, { target, changed: manifestFiles, variant });
    };
    if (pr.status !== 0) {
      warn(`credential provisioning exited ${pr.status} — ${(pr.stderr || "").trim().split("\n").slice(-2).join(" | ")}`);
      // Record what WAS written, so the supported rollback can undo it.
      finishManifest();
      return 3;
    }
    const manifestPath = finishManifest();
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
