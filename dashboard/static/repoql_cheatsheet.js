// Documentation-derived guidance; consult help:/// for the installed binary's exact syntax.
import {renderCheatCategoryGuide} from './repoql_guidance.js';
// Source: https://github.com/RepoQL/RepoQL/tree/main/plugins/repoql/skills
const skills = [
 ['effective-repoql','Find the best RepoQL workflow','Use when searching unfamiliar code, choosing between tools, or composing addresses and queries.','Ask the agent to use RepoQL to locate a behaviour, read the implementation and cite evidence.'],
 ['effective-markdown','Write verifiable documents','Use before writing reference docs, runbooks, decision records and concept explanations.','Ask for a concise, evidence-backed document with clear scope and actionable examples.'],
 ['research','Investigate with evidence','Use before exploring an uncertain technical question.','Ask for an evidence-led investigation with source references before conclusions.'],
 ['findings','Summarise an investigation','Use when research must become a concrete decision or findings report.','Ask the agent to summarise discovered facts, implications and their evidence.'],
 ['north-star','Define desired outcomes','Use when clarifying what a new capability should achieve.','Ask for testable outcomes without prescribing implementation.'],
 ['flow','Map a multi-stage process','Use when documenting actors, events, handoffs and failure paths.','Ask for a flow describing current behaviour and decision points.'],
 ['system-design','Describe architecture and contracts','Use for material system changes where interfaces need review.','Ask for a scoped design explaining components, boundaries and trade-offs.'],
 ['plan','Plan one implementable increment','Use to turn an approved design into testable work.','Ask for one concrete increment with acceptance checks and rollback considerations.'],
 ['odad','Choose appropriate preparation','Use before work when the right level of investigation and documentation is unclear.','Ask ODAD to decide which preparation, if any, the current change requires.'],
 ['monitoring-repoql','Track indexing without poll loops','Use while waiting for a host operation, import or indexing gate.','Use `rql monitor` for event-driven readiness and an exit status.'],
 ['troubleshooting-repoql','Diagnose host and indexing problems','Use when indexing, searches, imports, tool access or performance behave unexpectedly.','Start by checking `rql host status --json --all` and the reported upstream error.'],
 ['installing-connectors','Install existing source connectors','Use when a supported connector already exists for an external system.','Inspect available connectors, configure credentials privately and verify imported records.'],
 ['writing-connectors','Create or repair source connectors','Use when an external source has no suitable connector or an existing connector is faulty.','Define source fields, the imported file shape, secrets boundary and incremental refresh.'],
 ['using-uplinks','Query shared remote indexes','Use when an agent needs RepoQL sources hosted on another machine.','Connect to an authorised uplink and explicitly scope queries to its sources.'],
 ['mermaid-diagrams','Draw relationships in docs','Use when a diagram clarifies branches or dependencies better than prose.','Ask for a Mermaid diagram accompanying a technical document.'],
 ['skill-builder','Develop new agent skills','Use when building or improving agent instructions that encode specialised know-how.','State the observed need, draft a focused skill and test its triggering conditions.'],
 ['statusline-builder','Build Claude Code status widgets','Use when configuring RepoQL-aware status displays in Claude Code.','Choose context, cost, host and indexing widgets and verify their source metrics.'],
];
const tools = [
 ['discover_vocabulary','Find the project’s own terms','Start here when you know the behaviour but not the project vocabulary.','rql discover-vocabulary --help','https://repoql.com/docs/tools/discover-vocabulary/'],
 ['explore','Find likely files and declarations','Rank candidates by text and meaning. Results are leads, not proof.','rql explore --help','https://repoql.com/docs/tools/explore/'],
 ['read','Inspect the exact code and relationships','Use URI patterns and views such as structure, content, references or concepts.','rql read "file:///src/** => structure" --token-budget 1500','https://repoql.com/docs/tools/read/'],
 ['query','Count, filter and join indexed facts','Execute DuckDB SQL against Files, Functions, Types and graph tables.','rql query "DESCRIBE Files"','https://repoql.com/docs/tools/query/'],
 ['explain','Generate a source-cited explanation','Cloud inference may require login; verify important claims by reading the cited code.','rql explain --help','https://repoql.com/docs/tools/explain/'],
 ['capture_concept','Save a reusable lesson','Capture one invariant, explain why it matters, scope its relevance and attach verification evidence.','rql concept --help','https://repoql.com/docs/tools/capture-concept/'],
 ['watch','Observe a program as telemetry','Start a program with instrumentation and query spans, logs, metrics and process resources.','rql watch -- python3 -c "print(1)"','https://repoql.com/docs/tools/watch/'],
 ['monitor','Wait for a host operation','Streams progress and returns a status code; prefer to repeated sleeps.','rql monitor --help','https://repoql.com/docs/tools/watch/'],
 ['import','Bring another source into the host','Import local folders, repositories or connector-backed sources; inspect indexing afterwards.','rql import list --json','https://repoql.com/docs/'],
 ['dashboard','Open the official RepoQL UI','Opening RepoQL Control Panel automatically obtains the official login from the installed RepoQL CLI. No user-entered token is needed.','rql dashboard','https://repoql.com/docs/where-it-runs/'],
];
function e(s) {return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function code(s) {return `<div class="cs-cmd"><code class="cheat-command">${e(s)}</code><button type="button" class="cs-copy" data-copy="${e(s)}" aria-label="Copy command">Copy</button></div>`;}
const loop = [
  ['01','explore','Find candidates','Describe the behaviour; get ranked files and symbols. Leads, not proof.','rql explore "where are capture receipts written"'],
  ['02','read','Confirm the source','Read exact spans, structure, references or concepts for the candidates.','rql read "file:///src/** => structure" --token-budget 1500'],
  ['03','query','Measure the graph','Count, filter and join indexed facts with DuckDB SQL.','rql query "DESCRIBE Files"'],
  ['04','capture_concept','Keep the lesson','Save one invariant with why, relevance globs and verification evidence.','rql concept --help'],
];
const fleet = [
  ['RepoQL first for code','Rules come from AGENTS.md, live state from the hub and probes; code and docs from RepoQL, then source.'],
  ['Lookups are receipted','Source edits need a matching RepoQL lookup receipt. Pure task reports under work/ are exempt and audited.'],
  ['Hints before edits','`rql concept hints <file>` returns the bounded capsules relevant to an exact target.'],
  ['Health ≠ coverage','One configured RepoQL host. A healthy host does not prove a path is indexed — check imports.'],
  ['Capture is governed','Use knowledge_capture: dry-run first; duplicates and unresolved relevance are refused.'],
  ['Memory is explicit','MemoryCore recall is opt-in and identity-scoped (~1,500 tokens) — never a substitute for source.'],
];
const addressing = [
  ['file:///','This workspace'],['github:// · git:// · s3://','Imported sources'],['concept:///','Stored concepts'],['help:///','The installed manual — final authority for version-specific syntax'],
];
const views = ['structure','content','references','concepts','history','blame','lint','coverage'];
const decisions = [
  ['I don’t know the codebase term', 'discover_vocabulary', 'Learn the repository’s own names before guessing file paths.'],
  ['Where is this behaviour implemented?', 'explore', 'Find likely files and symbols. Search matches are leads.'],
  ['What does this function actually do?', 'read', 'Inspect its source, declaration and references.'],
  ['How many files, functions or relationships?', 'query', 'Ask an exact SQL question over the indexed tables.'],
  ['Explain this flow across several files', 'explain', 'Get a cited synthesis, then independently inspect crucial claims.'],
  ['What did we learn that should persist?', 'capture_concept', 'Capture a durable invariant, not session trivia or a fixable bug.'],
];
const prompts = [
  ['Find a bug', 'Use RepoQL to discover the name of the request handler, explore the likely source, then read the exact condition that rejects requests. Cite the code before proposing a fix.'],
  ['Scope a change', 'Use RepoQL to find all callers of the component and read their contracts. Identify which indexed relationships are supported and what still needs a runtime test.'],
  ['Reuse past lessons', 'Read the RepoQL concepts relevant to the target files before editing. Explain which rules apply, and verify any fact-backed knowledge against current source.'],
  ['Preserve a new lesson', 'Check for an existing matching concept. If the lesson is durable, classify it and capture one invariant with appropriate scope and verification. Report whether the capture was saved, checked or held.'],
];
export function renderRepoqlCheatSheet() {
  return `<section class="arch-hero cs-hero">
    <div class="arch-hero-copy"><span class="arch-eyebrow">RepoQL · Reference</span><h1>RepoQL cheat sheet</h1>
      <p>Find with <strong>explore</strong>, confirm with <strong>read</strong>, measure with <strong>query</strong>, keep what you learn with <strong>capture_concept</strong>. RepoQL is a shared source index — it finds and proves structure, but it does not replace reading code or testing the running system.</p></div>
    <div class="cs-hero-side">
      <nav class="cs-jump" aria-label="Sections">${[['start','Start here'],['loop','Core loop'],['fleet','Fleet rules'],['tools','Tools'],['concepts','Memory types'],['skills','Skills'],['addressing','Addressing']].map(([id,label])=>`<button type="button" data-jump="cs-${id}">${label}</button>`).join('')}</nav>
      <a class="btn" target="_blank" rel="noopener noreferrer" href="https://repoql.com/docs/">Official documentation ↗</a>
    </div></section>

  <section class="cheat-section" id="cs-start"><h2>Start here: what should I use?</h2>
    <p class="cs-lead">RepoQL is the host's index of files, declarations and supported relationships. It helps agents find code and retrieve relevant memory. <strong>Search does not prove behaviour</strong>: use source, tests and runtime observations for confirmation.</p>
    <div class="cs-decisions">${decisions.map(([question,tool,why])=>`<article><span>${e(question)}</span><code>${e(tool)}</code><p>${e(why)}</p></article>`).join('')}</div>
    <h3 class="cs-subtitle">Ask your agent in plain language</h3><div class="cs-prompts">${prompts.map(([title,prompt])=>`<article class="cs-prompt"><strong>${e(title)}</strong><p>${e(prompt)}</p>${code(prompt)}</article>`).join('')}</div>
    <p class="small muted">Agent tool names and CLI commands are not interchangeable. See the <a href="https://repoql.com/docs/" target="_blank" rel="noopener noreferrer">official workflow guide</a> and search <code>help:///</code> in your installed RepoQL version for exact arguments.</p>
  </section>

  <section class="cheat-section" id="cs-loop"><h2>The core loop</h2>
    <div class="cs-loop">${loop.map(([n,tool,title,text,cmd])=>`<article class="cs-step"><div class="cs-step-head"><span>${n}</span><code>${e(tool)}</code></div><h3>${e(title)}</h3><p>${e(text)}</p>${code(cmd)}</article>`).join('')}</div>
    <div class="cs-health"><span class="cs-label">Before you trust results</span>${code('rql host status --json --all')}${code('rql import list --json')}</div>
  </section>

  <section class="cheat-section" id="cs-fleet"><h2>How this fleet uses RepoQL</h2>
    <div class="cs-fleet">${fleet.map(([title,text])=>`<article><h3>${e(title)}</h3><p>${e(text).replace(/`([^`]+)`/g,'<code>$1</code>')}</p></article>`).join('')}</div>
  </section>

  <section class="cheat-section" id="cs-tools"><h2>Tools</h2>
    <div class="cs-tools">${tools.map(([name,description,detail,command,url])=>`<article class="cs-tool"><div class="cs-tool-head"><code>${e(name)}</code><a href="${e(url)}" rel="noopener noreferrer" target="_blank" aria-label="${e(name)} documentation">Docs ↗</a></div><h3>${e(description)}</h3><p>${e(detail)}</p>${code(command)}</article>`).join('')}</div>
  </section>

  <section class="cheat-section" id="cs-concepts"><h2>Concepts and memory categories</h2>
    <div class="block cs-concept-intro"><p>A <strong>Concept</strong> is a Markdown record under <code>.repoql/concepts/</code> with an invariant and explanation. Concepts is the umbrella collection; Principles, Wisdom, Rules, Shapes and Knowledge are its five categories in your installed Harness.</p>
      <ol class="cs-life"><li><b>Discover:</b> an agent encounters a useful reusable lesson, or Harness conversation review proposes a candidate.</li><li><b>Evaluate:</b> select a category, relevance (where applicable) and evidence; apply confidence, duplicate and conflict gates.</li><li><b>Capture:</b> eligible candidates reach the gated RepoQL publisher; held and rejected proposals are not published.</li><li><b>Retrieve:</b> RepoQL surfaces matching concepts when relevant files are explored or read. A universal principle is not file-scoped.</li><li><b>Recheck:</b> verifiable claims can be revalidated as evidence ages; a saved file alone does not prove successful verification.</li></ol>
      <p class="small muted">RepoQL does <strong>not</strong> automatically convert every conversation into a concept. This fleet's Harness reviews eligible terminal conversations; auto-promotion is gated and can be disabled. The <a href="https://repoql.com/docs/concepts/" target="_blank" rel="noopener noreferrer">official lifecycle documentation</a> explains RepoQL capture and revalidation.</p>
    </div>
    ${renderCheatCategoryGuide()}
    <div class="cs-memory-actions"><a class="btn" href="#/knowledge/all">Browse saved concepts →</a><a class="btn ghost" href="#/knowledge/connections">Explore concept Connections →</a></div>
  </section>

  <section class="cheat-section" id="cs-skills"><div class="cs-skills-head"><div><h2>Plugin skills <span class="tag">${skills.length}</span></h2><p class="small muted">The skills in the public <code>plugins/repoql/skills</code> directory. Skills are reusable agent instructions, not server tools; availability depends on your agent and plugin version.</p></div>
    <input id="cheat-search" class="input" type="search" placeholder="Filter skills…" aria-label="Filter RepoQL skills"></div>
    <div id="cheat-skills" class="cs-skills">${skills.map(([name,description,when,use])=>`<article class="cheat-skill cs-skill" data-search="${e((name+' '+description+' '+when+' '+use).toLowerCase())}"><div class="cs-tool-head"><code>${e(name)}</code><a href="https://github.com/RepoQL/RepoQL/tree/main/plugins/repoql/skills/${e(name)}" target="_blank" rel="noopener noreferrer" aria-label="${e(name)} source">Source ↗</a></div><h3>${e(description)}</h3><p><b>When</b> ${e(when)}</p><p class="cs-how"><b>How</b> ${e(use).replace(/`([^`]+)`/g,'<code>$1</code>')}</p></article>`).join('')}</div>
    <p class="small muted cs-empty" id="cheat-empty" hidden>No skills match that filter.</p>
  </section>

  <section class="cheat-section" id="cs-addressing"><h2>Addressing &amp; views</h2>
    <div class="cs-address">
      <div class="block"><table class="cs-table"><tbody>${addressing.map(([scheme,what])=>`<tr><td><code>${e(scheme)}</code></td><td>${e(what)}</td></tr>`).join('')}</tbody></table>
        <p class="small">Append <code>=&gt; view</code> to any read: ${views.map(v=>`<code>${v}</code>`).join(' ')} — names can differ between versions.</p></div>
      <div class="block">${code('rql read "file:///src/** => concepts" --token-budget 2000')}${code('rql read "concept:///rule/** => structure" --token-budget 2000')}${code('rql read "help:/// => tree: folders" --token-budget 1000')}</div>
    </div>
    <div class="cs-evidence"><strong>Rule of evidence</strong> Relevance ranking is discovery. A parser edge is observed structure. Verified behaviour means reading the source and testing the running system.</div>
    <p class="small"><a target="_blank" rel="noopener noreferrer" href="https://repoql.com/docs/addressing/">Address grammar ↗</a> · <a target="_blank" rel="noopener noreferrer" href="https://repoql.com/docs/tools/read/">Read views ↗</a></p>
  </section>`;
}
export function bindRepoqlCheatSheet() {
  const search = document.getElementById('cheat-search');
  search?.addEventListener('input',()=>{
    const query = search.value.toLowerCase().trim();
    let shown = 0;
    document.querySelectorAll('#cheat-skills .cheat-skill').forEach(card=>{
      card.hidden = !card.dataset.search.includes(query);
      if (!card.hidden) shown++;
    });
    const empty = document.getElementById('cheat-empty'); if (empty) empty.hidden = shown > 0;
  });
  document.querySelectorAll('.cs-jump [data-jump]').forEach(b=>b.addEventListener('click',()=>document.getElementById(b.dataset.jump)?.scrollIntoView({behavior:'smooth',block:'start'})));
  document.querySelectorAll('[data-copy]').forEach(b=>b.addEventListener('click',async()=>{
    try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent='Copied'; } catch { b.textContent='Select'; }
    setTimeout(()=>{b.textContent='Copy'},1400);
  }));
}
export const repoqlSkillCount = skills.length;
