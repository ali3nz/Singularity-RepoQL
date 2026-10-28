// lib/memory-orchestra/context.mjs — MemOS gap-closure addendum (2026-10-23)
// directive §8 contract + design §2 packet layer. Builds the bounded context
// packet a hook consumer may inject: ranked excerpts + evidence ids + locator
// (origin, revision, layer, scope, validity, verification) under a byte
// budget. Nothing here rewrites stored memory (§22: query-time synthesis stays
// TEMPORARY and separate from stored memory; the packet carries an assembly
// stamp, never an authority assertion). Dedupe of already-injected content
// within one execution stage is the hook consumer's call via
// fingerprintPacket(); the planner/fusion layer never re-injects the same info.

// P0 fix (2026-10-23): judgePacket/judgeExpandedCancellation were referenced
// without ever being imported, so EVERY buildVerdict call threw and every hook
// returned HOOK_THROW (the whole advisory path was dead while flags read ON).
import { judgePacket, judgeExpandedCancellation } from "./answerability.mjs";

export const PACKET_BUDGET_DEFAULT_BYTES = 1500; // ≈375 tokens FAST default

// Bound an excerpt for packet emission (no silent exit; truncation flagged).
function boundExcerpt(text, maxBytes) {
  const s = String(text ?? "");
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return { text: s, truncated: false };
  const cut = s.slice(0, Math.max(0, maxBytes));
  return { text: cut, truncated: true };
}

export function buildPacket({ verdict, budgetBytes = PACKET_BUDGET_DEFAULT_BYTES } = {}) {
  const cs = Array.isArray(verdict?.fused?.candidates) ? verdict.fused.candidates : [];
  const metaHeader = `packet:${verdict?.plan?.hook ?? "hook"} intent:${verdict?.plan?.intent ?? "universal"} state:${verdict?.state ?? "INSUFFICIENT"}`;
  const lines = [metaHeader];
  let bytes = Buffer.byteLength(metaHeader, "utf8") + 2;
  const entries = [];
  for (const c of cs) {
    // The locator is emitted in full: a truncated path is not resolvable.
    // When it is long, the surrounding display fields are what get dropped.
    const locator = c.evidenceLocator ? ` @${String(c.evidenceLocator)}` : "";
    const rev = c.sourceRevision && locator.length <= 200 ? ` rev=${String(c.sourceRevision).slice(0, 14)}` : "";
    const head = `[cand ${c.id.slice(0, 24)} ch=${c.channel}${c.exact ? " EXACT" : ""}${(c.corroboratedBy?.length ?? 0) ? ` corr:${c.corroboratedBy.map((x) => x.channel).join("/")}` : ""} src=${c.origin}${locator} v=${c.validity}${rev}]`;
    const room = budgetBytes - bytes - Buffer.byteLength(head + "\n", "utf8");
    if (room <= 80) break; // keep provenance-complete, drop silently-contentless adds
    const ex = boundExcerpt(c.claimText, Math.min(1000, room));
    if (!ex.text.trim()) break;
    const acceptance =
      verdict?.state === "CONFLICTED" && verdict?.conflicts?.[0]?.candidates?.some((x) => x.id === c.id)
        ? "\n        [CONFLICT WARNING — verify against RepoQL equality before acting]"
        : "";
    const block = `${head}\n${ex.text}${ex.truncated ? "[…]" : ""}${acceptance}\nverdict=${verdict?.state ?? "INSUFFICIENT"}`;
    const b = Buffer.byteLength(block, "utf8");
    if (bytes + b > budgetBytes) break;
    bytes += b;
    entries.push({ id: c.id, channel: c.channel, origin: c.origin, locator: c.evidenceLocator, validity: c.validity, verification: c.verification ?? null, evidBytes: b });
    lines.push(block);
  }
  if (verdict?.missing?.length) lines.push(`[missing evidence dims: ${verdict.missing.join(", ")} — ${verdict?.targetedExpansion ? `expand channel ${verdict.targetedExpansion}` : "budget exhausted; report uncertainty"}]`);
  return {
    text: lines.join("\n"),
    bytesUsed: bytes,
    budgetBytes,
    entries,
    fingerprint: fingerprint(lines.join("") + verdict?.state),
  };
}

// Stable stage-scope packet fingerprint: a hook consumer records received
// fingerprints and refuses a packet whose fingerprint equals one already
// injected in the same execution stage (§17 no-repeat rule).
export function fingerprintPacket(text) {
  return fingerprint(text ?? "");
}
function fingerprint(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return ((h >>> 0) >>> 0).toString(16).padStart(8, "0");
}

// One-stop entry: fuse (already done by caller) + judge + bound. Returns the
// complete orchestrator verdict, the packet, and the hook policy — ready for
// a call site. LLM refine is DEEP-only and bound-injected.
export async function buildVerdict({ hook, query, scope, fused, judge = null, expandFn = null, budgetBytes } = {}) {
  let verdict = {};
  const fsFlags = (await import("./flags.mjs")).flags();
  const tier = (await import("./planner.mjs")).TIERS;
  const deep = Boolean(expandFn && tier[hook === "DECISION_REPAIR" ? "DEEP" : "DEEP"]);
  const allowLlm = deep && typeof judge === "function" && fsFlags.fusion; // judge rides the fusion channel only (flag-gated)
  const planIntent = await intentPlan(hook, query, scope);
  const first = judgePacket({ plan: { intent: planIntent }, fused });
  // P0 fix (2026-10-24): judgePacket returns a VERDICT, not the candidate set.
  // buildPacket reads verdict.fused.candidates, so without re-attaching it every
  // hook answered ok:true with a header-only packet (bytes=44) and no evidence.
  let fusedForPacket = fused;
  if (first.state === "PARTIAL" && typeof expandFn === "function" && first.targetedExpansion) {
    const expanded = await expandFn(first.targetedExpansion); // caller-owned, budgeted
    verdict = judgeExpandedCancellation({ intent: planIntent }, expanded);
    verdict.round = 2;
    if (expanded?.candidates?.length) fusedForPacket = expanded;
  } else {
    verdict = first;
  }
  verdict.fused = fusedForPacket;
  verdict.budgetMs = await Promise.resolve(250);
  if (allowLlm) verdict = await llmRefine(verdict, { judge, tier: "DEEP" });
  const packet = buildPacket({ verdict, budgetBytes: budgetBytes ?? PACKET_BUDGET_DEFAULT_BYTES });
  return { ...verdict, packet, hook, query };
}

// Re-normalize intent from a stored plan (avoids circular planner import cost).
async function intentPlan(hook, query, scope) {
  const p = await import("./planner.mjs");
  return p.plan({ hook, query, scope }).intent ?? "what-happened";
}
