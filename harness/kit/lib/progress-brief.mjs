// lib/progress-brief.mjs — ADHD-friendly human-facing progress presentation
// (hub ticket 191 plan §22-24; capability addition, ZERO gate behaviour change).
//
// Scope rule (§22): this module only ADDS a compact operator-facing brief.
// It NEVER replaces or compresses the technical evidence surfaces — status
// files, evidence packs, diffs, test logs, migration evidence, Sol gate
// outputs all stay full-fidelity. Pure formatter: no IO, no dispatch.
//
// Shapes (plan §23/§24):
//   progress: Stage N of M / Done / Current / Next
//   failure:  Blocked / Failed / Expected / Observed / Current / Next
const cap = (s, n) => { s = String(s ?? ""); return s.length <= n ? s : s.slice(0, n - 1) + "…"; };
const clean = (s) => cap(String(s ?? "").replace(/\s+/g, " ").trim(), 160);

// ---- progress brief (plan §23) ----------------------------------------------
// inputs: stage (current stage number or label), totalStages, done[], current,
// next[]. Renders status-first, numbered next-actions when present.
export function renderProgressBrief({ stage = null, totalStages = null, done = [], current = null, next = [] } = {}) {
  const L = [];
  const stageTxt = stage != null && totalStages != null ? `Stage ${stage} of ${totalStages}` : stage != null ? `Stage ${stage}` : "In progress";
  L.push(stageTxt);
  L.push("Done:");
  if (done.length) for (const d of done) L.push(`- ${clean(d)}`);
  else L.push("- (nothing yet)");
  L.push("Current:");
  L.push(`- ${clean(current) || "(working)"}`);
  if (next.length) {
    L.push("Next:");
    next.forEach((n, i) => L.push(`${next.length > 1 ? `${i + 1}. ` : "- "}${clean(n)}`));
  }
  return L.join("\n");
}

// ---- failure brief (plan §24) -------------------------------------------------
// Concrete failure wording: what failed, what was expected, what was observed,
// where the trace continues, what happens next. Full evidence stays elsewhere.
export function renderFailureBrief({ failed = null, expected = null, observed = null, current = null, next = [] } = {}) {
  const L = ["Blocked."];
  L.push("Failed:");
  L.push(`- ${clean(failed) || "(unspecified failure)"}`);
  if (expected != null) { L.push("Expected:"); L.push(`- ${clean(expected)}`); }
  if (observed != null) { L.push("Observed:"); L.push(`- ${clean(observed)}`); }
  L.push("Current:");
  L.push(`- ${clean(current) || "(tracing)"}`);
  if (next.length) {
    L.push("Next:");
    next.forEach((n, i) => L.push(`${next.length > 1 ? `${i + 1}. ` : "- "}${clean(n)}`));
  }
  return L.join("\n");
}

// ---- adapter: worker-digest buildDigest() output -> progress brief ------------
// Read-only composition over the existing digest (no new run-state reads).
export function briefFromDigest(d) {
  const done = [];
  for (const w of d?.workers ?? []) {
    for (const p of w?.progress ?? []) done.push(`${w.id}: ${p}`);
    const finished = (w?.todos ?? []).filter((t) => t.done).map((t) => t.text);
    for (const t of finished.slice(-2)) done.push(`${w.id}: done — ${t}`);
  }
  const next = [];
  for (const w of d?.workers ?? []) {
    for (const t of (w?.todos ?? []).filter((t) => !t.done).slice(0, 2)) next.push(`${w.id}: ${t.text}`);
  }
  const anyBlocked = (d?.workers ?? []).some((w) => w?.status === "blocked");
  const total = d?.totalPhases ?? null;
  return renderProgressBrief({
    stage: d?.currentPhase ?? null,
    totalStages: total,
    done: done.slice(-3),
    current: anyBlocked ? "a worker is blocked — see status file for the blocker" : `phase ${d?.currentPhase ?? "?"} in progress`,
    next: next.slice(0, 3),
  });
}
