// Read-only teaching content shared by RepoQL's cheat sheet and knowledge pages.
// Capture behaviour is based on the deployed Harness snapshot's
// conversation-review.mjs and concept-capture.mjs, not an inferred RepoQL default.
export const CATEGORY_GUIDES = Object.freeze({
  principle: {
    title: 'Principles', short: 'Universal invariants that guide every agent, regardless of the file being edited.',
    agent: 'Before selecting an approach, reviewing a plan or deciding whether an action is acceptable. A principle applies across the entire repository, not just one directory.',
    automatic: 'The audited conversation-review route does not automatically publish Principles. It maps unsupported review categories to Rules. Agents may explicitly submit a Principle through the gated capture interface when the claim truly applies everywhere.',
    contract: 'No relevance, verification or TTL. Universal by definition. Keep it timeless and independent of implementation details.',
    example: 'Require real evidence before accepting a claimed test result.',
    label: 'Universal', color: '#4cfcbe',
  },
  wisdom: {
    title: 'Wisdom', short: 'A reusable lesson or judgment learned through experience, not a changing fact.',
    agent: 'When relevant files or workflows benefit from a previous hard-won lesson, or when an investigation teaches a general approach worth keeping.',
    automatic: 'At an eligible terminal conversation review, the Harness may classify a durable lesson as Wisdom. It can publish only after its evidence, confidence, duplicate and conflict gates pass, and automatic promotion is enabled.',
    contract: 'Relevance globs required. No verification or TTL for this category. Avoid session-specific anecdotes and time-sensitive facts.',
    example: 'A search result identifies candidates; reading source establishes the claim.',
    label: 'Lesson', color: '#b18aff',
  },
  rule: {
    title: 'Rules', short: 'Concrete, scoped constraints or guardrails future agent work must obey.',
    agent: 'Before changing files in the relevant scope, at planning and review gates, and when a known failure pattern could recur.',
    automatic: 'The Harness may propose a Rule after a qualifying conversation review or implementation-invariant capture. Verified durable, non-conflicting candidates can pass through the single gated publisher; rejected or uncertain proposals are held.',
    contract: 'Relevance globs required. Verification and TTL may both be omitted, or supplied together when the constraint depends on current source evidence.',
    example: 'When changing the JSON reader, test the literal payload sent by the caller.',
    label: 'Guardrail', color: '#69a8ff',
  },
  shape: {
    title: 'Shapes', short: 'A recurring structural pattern or recognisable layout of a system, workflow or component.',
    agent: 'When navigating an unfamiliar subsystem or recognising the same structural arrangement across relevant files. Check real source before generalising from the pattern.',
    automatic: 'The audited conversation-review route does not automatically publish Shapes. An agent can explicitly propose one through the gated capture interface after demonstrating the recurring structure.',
    contract: 'Relevance globs required. Verification and TTL are optional as a pair when the shape describes facts that can change.',
    example: 'A connector has a fetch stage, a normalisation stage and an indexed output boundary.',
    label: 'Pattern', color: '#ffd27b',
  },
  knowledge: {
    title: 'Knowledge', short: 'Source-backed architecture facts, decisions and file maps that can become outdated.',
    agent: 'When answering how the current system is wired, locating authoritative implementations or planning changes against current contracts.',
    automatic: 'The Harness can propose Knowledge after a qualifying conversation review, but that route lacks the required verification anchors by default and holds the candidate. Publication needs independently supplied evidence and a successful gated capture.',
    contract: 'Relevance, verification sources and TTL days are all required. Revalidation can flag stale evidence; saved does not mean verified.',
    example: 'The agent mailbox ledger is written by the relay before a notification is emitted.',
    label: 'Verifiable fact', color: '#39eaff',
  },
});

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const categoryLinks = Object.entries(CATEGORY_GUIDES).map(([key,g]) =>
  `<a href="#/knowledge/${key}" style="--kg-tone:${g.color}"><span class="kg-chip-dot"></span><strong>${escapeHtml(g.title)}</strong><span>${escapeHtml(g.label)}</span></a>`).join('');

export function renderKnowledgeGuide(category = 'all') {
  if (category === 'all') return `<section class="kg-guide" aria-label="About RepoQL concepts">
    <div class="kg-guide-heading"><div><span class="kg-kicker">UNDERSTAND YOUR INDEX</span><h2>What is a Concept?</h2></div><a href="#/repoql/cheat-sheet">How to use RepoQL →</a></div>
    <p>A <strong>concept</strong> is a source-controlled Markdown memory in <code>.repoql/concepts/</code>, not a sixth memory category. The five categories below describe <em>what is stored</em>. An agent reads relevant memories while investigating or changing code; the Harness may propose new ones when its learning gates permit.</p>
    <div class="kg-category-links" aria-label="Browse concept categories">${categoryLinks}</div>
    <p><strong>When agents use it:</strong> before deciding an approach, before editing a scoped area, and when a previous investigation already answered the question. <strong>When the Harness creates candidates:</strong> after an eligible conversation review or an explicit gated capture, never on its own initiative. <strong>Capture requirements:</strong> a non-principle needs relevance globs; source-backed claims need verification and a TTL.</p>
    <p><strong>Retrieval is not injection:</strong> relevant capsules surface at read time for the matching paths only, and MemoryCore recall stays separate and opt-in. <strong>Capture, publication and retrieval are three different states:</strong> a candidate is a proposal, publication needs its gates and evidence, and retrieval only surfaces something already published.</p>
    <p class="kg-fineprint"><strong>Automatic does not mean unconditional:</strong> candidate review → evidence and duplicate/conflict checks → gated capture → RepoQL's response. A held proposal is not a saved concept, and a saved concept is not necessarily verified.</p>
  </section>`;
  if (category === 'uncategorised') return `<section class="kg-guide"><div class="kg-guide-heading"><div><span class="kg-kicker">RECORD METADATA</span><h2>Uncategorised records</h2></div><a href="#/knowledge/all">All concepts →</a></div><p>Records whose category is missing or unrecognised in the index. This is <strong>not</strong> a capture category and the Harness does not intentionally create it. Inspect the record's source and metadata before assigning a type.</p>
    <div class="kg-guide-columns"><article><h3>When an agent uses it</h3><p>To find records that still need classifying, not to look for guidance: an unclassified record has no verified category contract.</p></article><article><h3>When the Harness creates it</h3><p>It does not create these deliberately. A record lands here when its category is missing or unrecognised at index time.</p></article><article><h3>Capture requirements</h3><p>Re-file the record under a real category with the evidence that category requires; do not use this as a dumping ground.</p></article></div>
    <p class="kg-fineprint">Retrieval, publication and capture stay distinct here too: a record being listed does not mean it was published as a concept, and retrieval still only surfaces it for matching paths.</p></section>`;
  const guide = Object.hasOwn(CATEGORY_GUIDES, category) ? CATEGORY_GUIDES[category] : null;
  if (!guide) return '';
  return `<section class="kg-guide" style="--kg-tone:${guide.color}" aria-label="About ${escapeHtml(guide.title)}">
    <div class="kg-guide-heading"><div><span class="kg-kicker">REPOQL MEMORY TYPE · ${escapeHtml(guide.label.toUpperCase())}</span><h2>What are ${escapeHtml(guide.title)}?</h2></div><a href="#/knowledge/all">Compare all categories →</a></div>
    <p class="kg-summary">${escapeHtml(guide.short)}</p>
    <div class="kg-guide-columns"><article><h3>When an agent uses it</h3><p>${escapeHtml(guide.agent)}</p></article><article><h3>When the Harness creates it</h3><p>${escapeHtml(guide.automatic)}</p></article><article><h3>Capture requirements</h3><p>${escapeHtml(guide.contract)}</p></article></div>
    <p class="kg-example"><strong>Example:</strong> ${escapeHtml(guide.example)}</p>
    <p class="kg-fineprint">These describe the reviewed Harness capture path, not an assurance that a capture happened in production. Retrieval is separate: it is path-scoped at read time and never injected into every message, MemoryCore recall stays opt-in, and a listed capsule does not prove its checker passed. <a href="#/repoql/cheat-sheet">See the workflow and source documentation →</a></p>
  </section>`;
}

export function renderCheatCategoryGuide() {
  return `<div class="cs-category-guide"><p><strong>Concepts</strong> is the collection. Choose the category by what the agent needs to remember, not by who discovered it. Select a category to browse stored records.</p>
    <div class="kg-category-links">${categoryLinks}</div>
    <div class="cs-guide-table-wrap"><table class="cs-guide-table"><thead><tr><th>Type</th><th>When agents use it</th><th>When Harness creates it</th><th>Capture contract</th></tr></thead><tbody>${Object.entries(CATEGORY_GUIDES).map(([key,g])=>`<tr><th><a href="#/knowledge/${key}">${escapeHtml(g.title)}</a></th><td>${escapeHtml(g.agent)}</td><td>${escapeHtml(g.automatic)}</td><td>${escapeHtml(g.contract)}</td></tr>`).join('')}</tbody></table></div>
    <p class="kg-fineprint">Category rules shown here reflect the bundled Harness concept-capture interface. The official public RepoQL page documents a smaller category set; consult your installed <code>help:///tools/capture-concept.md</code> for version-specific behaviour.</p></div>`;
}
