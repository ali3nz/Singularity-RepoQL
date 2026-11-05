#!/usr/bin/env node
// bundle-classification.mjs — ONE explicit classification of every shipped
// component file, driving the four installation options.
//
// Why this exists: the installer, the attach flow and the doctor each used to
// decide what "option 2/4" ships with their own ad-hoc lists. A file added to
// a Ghost or Office directory could therefore reach an option that must not
// carry it (or fail to reach one that must). This module is the single table:
//
//   core      — every option (1, 2, 3, 4)
//   ghost     — options 2 and 4 only
//   office    — options 2 and 4 only
//   dashboard — OPT-IN adjunct: shipped in the package, installed by no option
//               unless the operator asks for it (the doctor never claims it)
//
// Contract:
//   - `classifyBundleFile()` returns null for an UNKNOWN path. Callers must
//     treat null as a hard error (an unclassified file can silently ship with
//     the wrong variant), never as "core".
//   - `assertVariantExactSet()` checks both directions: option 1/3 must carry
//     no Ghost/Office artifact, option 2/4 must carry all of them.
//   - `auditComponentSet()` walks the shipped tree and reports unclassified
//     files, so a new file cannot land without an explicit decision.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const COMPONENT = Object.freeze({ CORE: "core", GHOST: "ghost", OFFICE: "office", DASHBOARD: "dashboard" });

/** Components a package may carry but no installation option installs by default. */
export const OPT_IN_COMPONENTS = Object.freeze([COMPONENT.DASHBOARD]);

/** The four options, expressed as the components each one ships. */
export const VARIANT_COMPONENTS = Object.freeze({
  1: Object.freeze([COMPONENT.CORE]),
  2: Object.freeze([COMPONENT.CORE, COMPONENT.GHOST, COMPONENT.OFFICE]),
  3: Object.freeze([COMPONENT.CORE]),
  4: Object.freeze([COMPONENT.CORE, COMPONENT.GHOST, COMPONENT.OFFICE]),
});

/**
 * Ordered rules, FIRST MATCH WINS. Specific component paths come before the
 * broad core prefixes, so a file inside a Ghost/Office directory can never
 * fall through to core by accident.
 */
const RULES = [
  // ── Ghost ────────────────────────────────────────────────────────────────
  { component: COMPONENT.GHOST, test: (p) => p === "openchamber/agents/ghost.md" },
  { component: COMPONENT.GHOST, test: (p) => [
    "native/windows/ghost_scheduler_host.py",
    "native/windows/ghost_task_scheduler.ps1",
    "native/windows/manage_ghost_scheduler.ps1",
    "native/windows/test_ghost_scheduler_host.py",
  ].includes(p) },
  { component: COMPONENT.GHOST, test: (p) => /^openchamber\/plugins\/product-ghost\//.test(p) },
  { component: COMPONENT.GHOST, test: (p) => /^ghost\//.test(p) },
  { component: COMPONENT.GHOST, test: (p) => /^systemd\/ghost-/.test(p) },
  { component: COMPONENT.GHOST, test: (p) => /^compose\/ghost[.-]/.test(p) },
  { component: COMPONENT.GHOST, test: (p) => /^dashboard\/static\/ghost\//.test(p) || p === "dashboard/ghost_bridge.py" || p === "native/desktop-bridge/src/ghost.rs" || p === "dashboard/native_ghost.py" || p === "dashboard/test_native_ghost.py" },
  // ── Office ───────────────────────────────────────────────────────────────
  { component: COMPONENT.OFFICE, test: (p) => /^openchamber\/plugins\/product-office\//.test(p) },
  { component: COMPONENT.OFFICE, test: (p) => /^office\//.test(p) },
  { component: COMPONENT.OFFICE, test: (p) => /^systemd\/office-/.test(p) },
  { component: COMPONENT.OFFICE, test: (p) => /^compose\/office[.-]/.test(p) },
  { component: COMPONENT.OFFICE, test: (p) => p === "scripts/orch_chat_office.py" },
  { component: COMPONENT.OFFICE, test: (p) => /^native\/gui-plugins\/openchamber\/singularity-office(?:\.test)?\.mjs$/.test(p) || p === "native/desktop-bridge/src/office.rs" || p === "dashboard/office_bridge.py" },
  // ── Dashboard (opt-in adjunct; native Windows variants always include it) ─
  { component: COMPONENT.DASHBOARD, test: (p) => /^dashboard\//.test(p) },
  // ── Core (explicit prefixes; anything else is UNCLASSIFIED on purpose) ────
  { component: COMPONENT.CORE, test: (p) => /^native\//.test(p) || ["WINDOWS_GUI_PORT_STATUS.md", "WINDOWS_NATIVE_RELEASE_PROGRESS_20261029.md", "WINDOWS_NATIVE_RELEASE_MILESTONE6_20261029.md", "WINDOWS_NATIVE_RELEASE_MILESTONE7_20261029.md", "WINDOWS_NATIVE_RELEASE_MILESTONE8_20261029.md", "WINDOWS_NATIVE_RELEASE_MILESTONE9_20261029.md", "WINDOWS_NATIVE_RELEASE_MILESTONE10_20261029.md"].includes(p) },
  { component: COMPONENT.CORE, test: (p) => /^\.github\//.test(p) },
  { component: COMPONENT.CORE, test: (p) => /^bin\//.test(p) },
  { component: COMPONENT.CORE, test: (p) => /^connectors\//.test(p) },
  { component: COMPONENT.CORE, test: (p) => /^repoql-feedback\//.test(p) },
  { component: COMPONENT.CORE, test: (p) => /^harness\//.test(p) },
  { component: COMPONENT.CORE, test: (p) => /^adapters\//.test(p) },
  { component: COMPONENT.CORE, test: (p) => /^compose\//.test(p) },
  { component: COMPONENT.CORE, test: (p) => /^docs\//.test(p) },
  { component: COMPONENT.CORE, test: (p) => /^memory\//.test(p) },
  { component: COMPONENT.CORE, test: (p) => /^openchamber\//.test(p) },
  { component: COMPONENT.CORE, test: (p) => /^orchestration\//.test(p) },
  { component: COMPONENT.CORE, test: (p) => /^scripts\//.test(p) },
  { component: COMPONENT.CORE, test: (p) => /^systemd\//.test(p) },
  { component: COMPONENT.CORE, test: (p) => /^templates\//.test(p) },
  { component: COMPONENT.CORE, test: (p) => /^tests\//.test(p) },
  {
    component: COMPONENT.CORE,
    test: (p) => /^(AGENTS|INSTRUCTIONS|CHANGELOG)\.md$|^(LICENSE|README\.md|MANIFEST\.json|SHA256SUMS|THIRD_PARTY_NOTICES\.md|\.gitignore)$/.test(p),
  },
];

/** Component-bearing runtime credentials (provisioned per option, never shipped whole). */
export const CREDENTIAL_COMPONENTS = Object.freeze({
  "memory.json": COMPONENT.CORE,
  "selflearn.json": COMPONENT.CORE,
  "ghost.json": COMPONENT.GHOST,
  "office.json": COMPONENT.OFFICE,
});

/** Directories the shipped tree is walked from (explicit; no blind tree crawl). */
const WALK_ROOTS = [
  ".github", "adapters", "bin", "compose", "connectors", "dashboard", "docs", "native",
  "ghost", "harness", "memory", "office", "openchamber", "orchestration",
  "scripts", "systemd", "templates", "tests",
];
// Runtime/derived directories are never part of the shipped set.
const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", "runs", "target"]);
const ROOT_FILES = [
  ".gitignore", "AGENTS.md", "CHANGELOG.md", "INSTRUCTIONS.md", "LICENSE",
  "MANIFEST.json", "README.md", "SHA256SUMS", "THIRD_PARTY_NOTICES.md", "WINDOWS_GUI_PORT_STATUS.md", "WINDOWS_NATIVE_RELEASE_PROGRESS_20261029.md", "WINDOWS_NATIVE_RELEASE_MILESTONE6_20261029.md", "WINDOWS_NATIVE_RELEASE_MILESTONE7_20261029.md", "WINDOWS_NATIVE_RELEASE_MILESTONE8_20261029.md", "WINDOWS_NATIVE_RELEASE_MILESTONE9_20261029.md", "WINDOWS_NATIVE_RELEASE_MILESTONE10_20261029.md",
];

/**
 * Classify one repository-relative path.
 * @returns {{component: string, rule: string} | null} null = UNKNOWN (caller must fail).
 */
export function classifyBundleFile(rel) {
  const p = String(rel || "").replace(/^\.\//, "").replace(/\\/g, "/");
  if (!p) return null;
  const idx = RULES.findIndex((r) => r.test(p));
  if (idx < 0) return null;
  return { component: RULES[idx].component, rule: `rule#${idx}` };
}

/** Is this component part of the option? Accepts "1".."4" or 1..4. */
export function variantIncludesComponent(variant, component) {
  const list = VARIANT_COMPONENTS[String(variant)];
  if (!list) throw new Error(`unknown installation option: ${variant} (expected 1..4)`);
  return list.includes(component);
}

/** Split a file list into components; `unclassified` stays explicit. */
export function partitionBundleFiles(files) {
  const out = { [COMPONENT.CORE]: [], [COMPONENT.GHOST]: [], [COMPONENT.OFFICE]: [], [COMPONENT.DASHBOARD]: [], unclassified: [] };
  for (const rel of files || []) {
    const c = classifyBundleFile(rel);
    if (!c) { out.unclassified.push(rel); continue; }
    out[c.component].push(rel);
  }
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}

/** The exact files an option INSTALLS, from the full shipped set. */
export function variantFileSet(files, variant) {
  const parts = partitionBundleFiles(files);
  const wanted = VARIANT_COMPONENTS[String(variant)];
  if (!wanted) throw new Error(`unknown installation option: ${variant} (expected 1..4)`);
  // opt-in components (the dashboard) are shipped, never installed by an option
  return wanted.filter((c) => !OPT_IN_COMPONENTS.includes(c)).flatMap((c) => parts[c]).sort();
}

/**
 * The shipped SET is complete and classified for this option:
 *   - an unclassified shipped file is a problem (it would ship silently);
 *   - option 2/4 must actually carry Ghost and Office payload (not an empty set).
 * A core-only option legitimately *ships* no Ghost/Office files, so their
 * presence in the tree is not a problem here — the installed direction is
 * checked by `assertInstalledSet()`.
 */
export function assertVariantExactSet(allFiles, variant) {
  const parts = partitionBundleFiles(allFiles);
  const wanted = VARIANT_COMPONENTS[String(variant)];
  if (!wanted) return { ok: false, included: [], excluded: [], problems: [`unknown installation option: ${variant}`] };
  const included = variantFileSet(allFiles, variant);
  const problems = [];
  if (parts.unclassified.length) {
    problems.push(`unclassified shipped file(s) — assign an explicit component: ${parts.unclassified.join(", ")}`);
  }
  for (const c of wanted) {
    if (!parts[c].length) problems.push(`option ${variant} must ship ${c} files but the set is empty`);
  }
  const excluded = allFiles.filter((f) => !included.includes(f)).sort();
  return { ok: problems.length === 0, included, excluded, problems, counts: { core: parts.core.length, ghost: parts.ghost.length, office: parts.office.length, dashboard: parts.dashboard.length } };
}

/**
 * The INSTALLED set is exactly what the option allows — the hard assertion:
 *   - option 1/3 carrying any Ghost/Office file is a violation (leak);
 *   - option 2/4 missing any Ghost/Office file is a violation (incomplete).
 */
export function assertInstalledSet(installedFiles, variant) {
  const parts = partitionBundleFiles(installedFiles);
  const wanted = VARIANT_COMPONENTS[String(variant)];
  if (!wanted) return { ok: false, problems: [`unknown installation option: ${variant}`], leaked: [], missing: [] };
  const problems = [];
  if (parts.unclassified.length) {
    problems.push(`unclassified installed file(s): ${parts.unclassified.join(", ")}`);
  }
  const leaked = [];
  for (const c of [COMPONENT.GHOST, COMPONENT.OFFICE, ...OPT_IN_COMPONENTS]) {
    if (!wanted.includes(c) && parts[c].length) {
      leaked.push(...parts[c]);
      problems.push(`option ${variant} must not install ${c} files (${parts[c].length} leaked: ${parts[c].slice(0, 3).join(", ")})`);
    }
  }
  const missing = [];
  for (const c of wanted) {
    if (c !== COMPONENT.CORE && !parts[c].length) {
      missing.push(c);
      problems.push(`option ${variant} must install ${c} files but none are present`);
    }
  }
  return { ok: problems.length === 0, problems, leaked: leaked.sort(), missing };
}

/** Files the option must NOT carry (hard exclusion assertion for options 1/3). */
export function excludedForVariant(allFiles, variant) {
  const included = new Set(variantFileSet(allFiles, variant));
  return (allFiles || []).filter((f) => !included.has(f)).sort();
}

/** Walk the shipped tree (explicit roots only) and return repository-relative paths. */
export function walkShippedFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(join(dir, e.name), r);
      } else out.push(r);
    }
  };
  for (const d of WALK_ROOTS) if (existsSync(join(root, d))) walk(d, d);
  for (const f of ROOT_FILES) if (existsSync(join(root, f))) out.push(f);
  return out.sort();
}

/** Report any component file whose declared component contradicts the option. */
export function auditComponentSet(root, variant) {
  const files = walkShippedFiles(root);
  const res = assertVariantExactSet(files, variant);
  const included = new Set(res.included);
  const installedFiles = files.filter((f) => included.has(f));
  const installed = assertInstalledSet(installedFiles, variant);
  return {
    ...res,
    ok: res.ok && installed.ok,
    problems: [...res.problems, ...installed.problems],
    installedFiles,
    leaked: installed.leaked,
    missing: installed.missing,
    // credential components are decided by the same table, not a second list
    credentials: Object.entries(CREDENTIAL_COMPONENTS)
      .filter(([, c]) => VARIANT_COMPONENTS[String(variant)].includes(c))
      .map(([name, c]) => ({ name, component: c })),
  };
}
