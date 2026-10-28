// consult-affinity.mjs — V3.5.1 (ticket 161, Sol CONFIRMED, consult Run 130):
// deterministic topic-affinity matcher for Discord thread reuse across
// consult sessions. Display-level sharing ONLY — consult sessions stay
// isolated (ticket 115 rule preserved verbatim; this module NEVER attaches
// turns, never merges sessions, only decides which existing thread a new
// session's case.json points at).
//
// Sol's precedence contract (consult Run 130, 2026-09-29):
//   - new consult HAS an issueNumber  -> match ONLY candidates with the
//     exact same issueNumber. Topic text is NEVER consulted: a different
//     issue number must not be overridden by an identical topic string
//     (Sol's "biggest trap"), and an issue-carrying new consult must not
//     fall back to topic matching against issue-less candidates.
//   - new consult has NO issueNumber  -> match ONLY issue-less candidates
//     whose normalized topic equals the new topic exactly (deterministic;
//     NO fuzzy/semantic similarity — a merely similar topic must NOT match).
//   - among matching candidates: newest first, first one that actually
//     carries a discord.threadId wins. Matches without a threadId are
//     skipped, never treated as reasons to look further down the chain.
//   - window: candidates older than `windowDays` (default 14) are invisible.
//   - any malformed candidate record is skipped, never fatal (fail-open by
//     construction; the kit additionally try/catches the whole lookup).
//
// Archived threads: reuse is allowed (Discord auto-unarchives on post —
// bridge housekeeping doc; Sol Q3). Deleted threads are handled by the
// kit's probe step, not here — this module is pure and offline.

const DEFAULT_WINDOW_DAYS = 14;

// Strip ONLY the canonical title scaffolding the kit/bridge themselves add
// (V3.4.1 "Run NNN |" / "Issue NNN |" prefixes, trailing "— duo consult
// <id-slug>" suffix), then lowercase + collapse whitespace. No punctuation
// stripping, no stop-word removal, no stemming (Sol: deterministic only).
export function normalizeTopic(topic) {
  let t = String(topic ?? "");
  t = t.normalize("NFKC").toLowerCase().trim();
  t = t.replace(/^\s*run\s+\d{1,4}\s*\|\s*/i, "");
  t = t.replace(/^\s*issue\s+\d{1,4}\s*\|\s*/i, "");
  t = t.replace(/\s*[—–-]\s*duo\s+consult\b.*$/i, "");
  t = t.replace(/\s+/g, " ").trim();
  // Drop a wrapping quote pair left over from a quoted brief.
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

function issueNumOf(x) {
  if (typeof x === "number" && Number.isInteger(x) && x > 0) return x;
  if (typeof x === "string" && /^\d+$/.test(x.trim())) return parseInt(x, 10);
  return null;
}

// topicAffinityMatch(newConsult, candidates, opts) -> { matchedId, threadId, reason } | null
//   newConsult: { id, issueNumber, topic }
//   candidates: [{ id, mtimeMs, issueNumber, threadId, topic }] (recent-first
//               ordering is applied internally by mtimeMs; callers may pre-sort)
//   opts: { windowDays, now }
// PURE: no fs, no network, no clock (opts.now, default fixed epoch 0 window
// math uses Date.now() ONLY when opts.now is absent — selftests pass now).
export function topicAffinityMatch(newConsult, candidates, opts = {}) {
  const windowDays = Number.isFinite(opts.windowDays) && opts.windowDays > 0 ? opts.windowDays : DEFAULT_WINDOW_DAYS;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const newIssue = issueNumOf(newConsult?.issueNumber);
  const newTopic = normalizeTopic(newConsult?.topic);
  const selfId = String(newConsult?.id ?? "");

  const viable = (c) => {
    if (!c || String(c.id ?? "") === selfId) return false; // never self-match
    if (typeof c.mtimeMs !== "number" || now - c.mtimeMs > windowDays * 86_400_000) return false; // window
    const tid = c.threadId == null ? null : String(c.threadId);
    if (!tid || !/^\d{5,}$/.test(tid)) return false; // no usable stored thread
    const cIssue = issueNumOf(c.issueNumber);
    if (newIssue != null) return cIssue === newIssue; // exact issue identity ONLY
    return cIssue == null && newTopic.length > 0 && normalizeTopic(c.topic) === newTopic; // issue-less exact topic
  };

  const hits = (Array.isArray(candidates) ? candidates : [])
    .filter(viable)
    .sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0)); // newest first

  if (hits.length === 0) return null;
  const m = hits[0];
  return {
    matchedId: String(m.id),
    threadId: String(m.threadId),
    reason: newIssue != null ? `same-issue:${newIssue}` : "same-topic-exact",
    matchedIssueNumber: issueNumOf(m.issueNumber),
  };
}

// The single pointer message posted into a reused thread (Sol: one deduped
// pointer line; title unchanged). Keep it one line, no @mentions.
export function buildAffinityPointer(newSessionId, matchedSessionId, topic) {
  const t = normalizeTopic(topic).slice(0, 80);
  const topicPart = t ? ` — ${t}` : "";
  return `↪ New consult session \`${newSessionId}\` joined this topic thread (matched: \`${matchedSessionId}\`${topicPart}). Sessions stay isolated — this is display-level thread reuse only.`;
}

// Dedupe key for pointer posts (Sol pin 12: never emit duplicate pointer
// messages for the same newly created session).
export function pointerDedupeKey(newSessionId, threadId) {
  return `${String(newSessionId)}:${String(threadId)}`;
}

export { DEFAULT_WINDOW_DAYS };
