// Architecture maps: Memory and Harness & AI orchestra.
// Lane-based layout: nodes live in measured DOM lanes and the SVG wiring is
// computed from their real rectangles, so nothing overlaps or clips at any
// width. Narrow boards switch to a vertical flow. No data is fetched here; the
// content describes the deployed architecture (ticket 799 state, 2026-10-26).
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

const TONES = {cyan:'#26e6ff', purple:'#b483ff', green:'#3dffb0', amber:'#ffc35a', red:'#ff6680', blue:'#5b9bff'};

const MEMORY_LEGEND = {cyan:'Retrieval & index', purple:'Capture & review', green:'Stores', amber:'Lifecycle', red:'Gates', blue:'Sources & consumers'};
const ORCHESTRA_LEGEND = {purple:'Operator & fabric', cyan:'Grounding & output', green:'Worker seats', amber:'Hooks & observability', red:'Gates', blue:'Pools'};

const MEMORY_VIEWS = {
  brain: {
    label: 'Brain map',
    title: 'Human-style memory map',
    summary: 'A simplified, brain-inspired view of the memory system. The left side gathers experience, the center applies checks, and the right side returns useful recall. Use this for orientation before opening the denser flow diagrams.',
    stats: [['2 stores', 'History + knowledge'], ['Checked', 'Before promotion'], ['Explicit', 'Recall only'], ['Operator', 'Still validates']],
    lanes: ['Experience', 'Filter', 'Stores', 'Recall', 'Use'],
    nodes: [
      {id:'experience', col:0, tone:'blue', kicker:'Input', title:'Experience', sub:'Sessions, docs and code create raw memory material.', bullets:['Sessions explain what happened.', 'Docs and source explain what is true now.']},
      {id:'capture', col:1, tone:'purple', kicker:'Encode', title:'Capture & review', sub:'Important history is captured; proposed lessons are reviewed.', bullets:['Each capture path must preserve its own single-writer policy.', 'Conversation review proposes but does not auto-promote.']},
      {id:'memorycore', col:2, tone:'green', kicker:'Left memory', title:'Tencent MemoryCore', sub:'Temporal history: turns, records and summaries.', bullets:['Good for previous context and chronology.', 'Not the source of truth for code or runtime state.']},
      {id:'concepts', col:2, tone:'green', kicker:'Right memory', title:'RepoQL concepts', sub:'Durable rules, principles and knowledge.', bullets:['Useful lessons are stored with category and evidence.', 'Lineage is kept when knowledge changes.']},
      {id:'gates', col:3, tone:'red', kicker:'Decision', title:'Safety & relevance gates', sub:'Receipts, relevance, duplicate and reviewer checks.', bullets:['High-risk changes require extra gates.', 'Unresolved or duplicate concept writes are refused.']},
      {id:'recall', col:3, tone:'cyan', kicker:'Recall', title:'RepoQL + explicit recall', sub:'Retrieve grounded code and only the memory that was asked for.', bullets:['RepoQL answers where and what.', 'MemoryCore answers what happened before.']},
      {id:'agents', col:4, tone:'blue', kicker:'Output', title:'Agents & operator', sub:'Use retrieved knowledge, then create the next round of evidence.', bullets:['The loop closes with new sessions and new docs.']},
    ],
    edges: [['experience','capture','encode'],['capture','memorycore','history'],['capture','concepts','candidate lessons'],['memorycore','recall','history recall'],['concepts','recall','durable guidance'],['gates','recall','allowed context'],['recall','agents','grounded work'],['agents','experience','new evidence','loop']],
    callouts: [
      {tone:'blue', title:'Think of two memory systems', items:['MemoryCore is like episodic memory: what happened and when.', 'RepoQL concepts are like semantic memory: rules and durable knowledge.']},
      {tone:'red', title:'Why the middle gates matter', items:['Helpful memory still needs evidence and scope before it becomes durable.', 'A recalled memory is context, not permission to skip current verification.']},
      {tone:'cyan', title:'Use this page in order', items:['Start with this brain map.', 'Then open Flow or Recall paths for the exact source-defined mechanics.']},
    ],
  },
  overview: {
    label: 'Flow',
    title: 'End-to-end memory system',
    summary: 'How work becomes durable, governed knowledge — and how agents get it back. RepoQL is authoritative for code and documentation; MemoryCore is supplementary history that is recalled explicitly, never injected ambiently.',
    stats: [['RepoQL', 'Authoritative retrieval'], ['MemoryCore', 'Temporal history'], ['Scoped', 'Capture writers'], ['Explicit', 'Recall model']],
    lanes: ['Sources', 'Capture & governance', 'Stores', 'Retrieval', 'Consumers'],
    nodes: [
      {id:'sessions', col:0, tone:'blue', kicker:'Source', title:'Agent sessions', sub:'Recorded agent and worker sessions. Each capture source must be verified from its own receipts.', bullets:['Parent and child sessions are both read.','Delegated child-session user briefs are excluded from capture.','Assistant outcomes are retained.'], refs:['opencode.db','kit run logs']},
      {id:'hub', col:0, tone:'blue', kicker:'Source', title:'Hub documentation', sub:'Canonical docs, issues, runbooks and the journal.', bullets:['Live state and runbooks are the operational truth.','The journal has one write path (fleet-log).'], refs:['documentation/','journal/events.jsonl']},
      {id:'code', col:0, tone:'blue', kicker:'Source', title:'Source & imports', sub:'Workspace tree plus registered GitHub and local imports.', bullets:['Indexed in place by the single production RepoQL host.','Watcher keeps changed files fresh.'], refs:['configured workspace root','rql import list']},
      {id:'capture', col:1, tone:'purple', kicker:'Capture', title:'MemoryCore capture', sub:'Single-writer timer: snapshot, filter, batch, write.', bullets:['WAL-safe read-only snapshot of the session database.','Admission filter excludes delegated child-session user directives.','Every tick emits a done receipt with written, repaired, failed and excluded counters.'], refs:['tencent-capture.timer','capture-consumer.mjs']},
      {id:'review', col:1, tone:'purple', kicker:'Review', title:'Conversation review', sub:'Proposes candidate concepts from reviewed sessions.', bullets:['Proposals are advisory: preflight-passed or needs-source-verification.','Nothing is promoted automatically; local source verification is required.'], refs:['oc-capture-review.timer','reviewed-sessions.jsonl']},
      {id:'broker', col:1, tone:'red', kicker:'Gate', title:'Governed concept capture', sub:'Dry-run, relevance and duplicate checks before any write.', bullets:['Relevance globs must resolve against the index (UNRESOLVED_RELEVANCE otherwise).','Duplicate names are refused; same-name updates preserve lineage.','Capsules are contextual unless genuinely universal.'], refs:['knowledge_capture','concept-capture.mjs']},
      {id:'memorycore', col:2, tone:'green', kicker:'Store', title:'Tencent MemoryCore', sub:'Temporal memory: L0 turns, L1 records, L2/L3 summaries.', bullets:['Identity-scoped records with preserved timestamps and references.','Supplementary to RepoQL — useful for “what happened”, not for source truth.'], refs:['agent-memory','L0 · L1 · L2 · L3']},
      {id:'concepts', col:2, tone:'green', kicker:'Store', title:'Concept store', sub:'Wisdom, principles, rules, shapes and knowledge capsules.', bullets:['Each capsule carries an invariant, why, relevance and verification span.','Superseded capsules keep their lineage instead of being silently rewritten.','TTL forces periodic re-verification.'], refs:['.repoql/concepts/','concept:///']},
      {id:'index', col:2, tone:'cyan', kicker:'Index', title:'RepoQL index', sub:'Files, symbols, relationships and semantic search.', bullets:['One configured RepoQL host; health is not coverage.','Concepts are indexed alongside the code they describe.'], refs:['repoql-host.service','rql host status']},
      {id:'rql', col:3, tone:'cyan', kicker:'Retrieve', title:'RepoQL retrieval', sub:'explore → read → query, with cited spans.', bullets:['Authoritative for code, configuration and documentation.','`rql concept hints <file>` returns bounded relevant capsules before an edit.'], refs:['rql explore','rql read','rql concept hints']},
      {id:'recall', col:3, tone:'purple', kicker:'Recall', title:'Explicit memory recall', sub:'Identity-scoped, bounded, on request only.', bullets:['L1 top 5, then L0 top 3 only when L1 has no hit (~1,500 tokens).','Via the agent-memory CLI or the kit’s stage-gated context pack.','No ambient MemoryCore injection into interactive sessions.'], refs:['agent-memory <id> recall']},
      {id:'gates', col:3, tone:'red', kicker:'Gate', title:'Receipt & reviewer gates', sub:'Lookup receipts, reviewer and credential checks on mutation.', bullets:['Source edits need a matching RepoQL lookup receipt; task reports are exempt.','Gated mutations need a fresh code-reviewer pass.','Credential-shaped values never enter tool calls or files.'], refs:['capability-profile.js']},
      {id:'agents', col:4, tone:'blue', kicker:'Consumers', title:'Agents & operator', sub:'Interactive agents, delegated workers, persistent bots and the dashboard.', bullets:['Act on verified context within their gates.','Their outcomes become new sessions — the loop closes.'], refs:['Agent sessions','Worker receipts','Bot identities']},
    ],
    edges: [
      ['sessions','capture','transcripts'], ['sessions','review','reviewed sessions'], ['hub','index','indexed'], ['code','index','indexed'],
      ['capture','memorycore','L0 / L1 rows'], ['review','broker','advisory proposals'], ['broker','concepts','governed write'], ['concepts','index','reindexed'],
      ['index','rql','query'], ['memorycore','recall','identity-scoped'], ['rql','agents','verified context'], ['recall','agents','bounded history'], ['gates','agents','mutation checks'],
      ['agents','sessions','new outcomes','loop'],
    ],
    callouts: [
      {tone:'cyan', title:'Authority order', items:['Rules: AGENTS.md. State: hub and live probes. Code: RepoQL, then source.','MemoryCore history is supplementary and may be incomplete.','Health of the index is not proof of coverage.']},
      {tone:'purple', title:'What gets captured', items:['Assistant outcomes and parent-session turns.','Not delegated child-session user briefs — they are excluded at admission.','External review only proposes; it never promotes.']},
      {tone:'amber', title:'Keeping memory clean', items:['Concept capture refuses duplicates and unresolvable relevance.','Universal scope is reserved for genuinely universal rules.','Superseded knowledge keeps lineage instead of disappearing.']},
    ],
  },
  capture: {
    label: 'Capture pipeline',
    title: 'MemoryCore capture pipeline',
    summary: 'One writer per capture path; the illustrated legacy tick snapshots session history safely, admits only what should become memory, writes idempotently and publishes a receipt that can be audited.',
    stats: [['1', 'Writer'], ['WAL-safe', 'Snapshot'], ['Idempotent', 'Rows'], ['Receipted', 'Every tick']],
    lanes: ['Trigger', 'Read', 'Admit', 'Persist', 'Verify'],
    nodes: [
      {id:'timer', col:0, tone:'amber', kicker:'Trigger', title:'Capture timer', sub:'Periodic tick; the only MemoryCore writer.', bullets:['No second writer, mirror or database.','Status and failures are read from the unit, not assumed.'], refs:['tencent-capture.timer']},
      {id:'snapshot', col:1, tone:'blue', kicker:'Read', title:'Session snapshot', sub:'WAL-safe read-only snapshot of the captured source store; other capture adapters have separate receipts.', bullets:['Never reads a half-written database page.','Parent and child sessions are both visible to the filter.'], refs:['legacy opencode.db']},
      {id:'admit', col:2, tone:'red', kicker:'Admission', title:'Admission filter', sub:'Excludes delegated child-session user directives.', bullets:['Child assistant outcomes are retained.','Legacy records already captured remain recallable.','Exclusion counters include rescans; they are not unique-message counts.']},
      {id:'redact', col:2, tone:'red', kicker:'Safety', title:'Redaction', sub:'Credential-shaped values never reach memory.', bullets:['Secrets are reported by shape and location only.']},
      {id:'batch', col:3, tone:'purple', kicker:'Write', title:'Batch & dedupe', sub:'Stable identities make every write idempotent.', bullets:['Re-running a tick repairs instead of duplicating.','Timestamps and references are preserved.']},
      {id:'l0', col:3, tone:'green', kicker:'Layer', title:'L0 · raw turns', sub:'Source-faithful conversation rows.'},
      {id:'l1', col:3, tone:'green', kicker:'Layer', title:'L1 · records', sub:'Extracted, identity-scoped memory records.'},
      {id:'l23', col:3, tone:'green', kicker:'Layer', title:'L2 / L3 · summaries', sub:'Higher-order summaries produced downstream.'},
      {id:'receipt', col:4, tone:'cyan', kicker:'Verify', title:'Tick receipt', sub:'units · written · repaired · failures · excluded', bullets:['Acceptance reads these counters, never narrative claims.','A failed tick is reported, not retried in a loop.'], refs:['journalctl -u tencent-capture']},
    ],
    edges: [
      ['timer','snapshot','tick'], ['snapshot','admit','candidate turns'], ['admit','redact','admitted'], ['redact','batch','clean rows'],
      ['batch','l0','write'], ['l0','l1','extract'], ['l1','l23','summarise'], ['batch','receipt','counters'], ['admit','receipt','exclusions'],
    ],
    callouts: [
      {tone:'purple', title:'Single writer', items:['Capture is automatic; agents never duplicate its writes.','Interactive sessions do not write MemoryCore directly.']},
      {tone:'red', title:'Admission, not deletion', items:['Excluded child-session briefs are never written.','Previously captured legacy rows are retained, not purged.']},
      {tone:'cyan', title:'Evidence', items:['Each tick’s done event is the acceptance record.','Zero failures across natural ticks is the health signal.']},
    ],
  },
  retrieval: {
    label: 'Retrieval',
    title: 'How an agent grounds a task',
    summary: 'Retrieval is explicit and ordered. Agents discover with RepoQL, confirm exact spans, check live state for anything operational, and only then consult memory history — within a fixed token budget.',
    stats: [['RepoQL first', 'Code & docs'], ['Live probes', 'Current state'], ['≈1,500', 'Recall tokens'], ['Cited', 'Context']],
    lanes: ['Task', 'Lookup', 'Sources', 'Context', 'Act'],
    nodes: [
      {id:'task', col:0, tone:'blue', kicker:'Start', title:'Task or prompt', sub:'Operator request, kit stage or scheduled job.'},
      {id:'explore', col:1, tone:'cyan', kicker:'Discover', title:'Explore & vocabulary', sub:'Ranked candidates and the repo’s real names.', refs:['rql explore','discover_vocabulary']},
      {id:'read', col:1, tone:'cyan', kicker:'Confirm', title:'Read & query', sub:'Exact spans, structure and SQL over the graph.', refs:['rql read','rql query']},
      {id:'hints', col:1, tone:'cyan', kicker:'Guide', title:'Concept hints', sub:'Bounded relevant capsules for an exact target.', refs:['rql concept hints']},
      {id:'probe', col:1, tone:'amber', kicker:'Verify', title:'Live probes', sub:'Service, host and config state checked directly.', refs:['ssh <dashboard host>','systemctl','docker inspect']},
      {id:'recall', col:1, tone:'purple', kicker:'History', title:'Memory recall', sub:'Only when history matters; identity-scoped.', refs:['agent-memory recall']},
      {id:'index', col:2, tone:'cyan', kicker:'Source', title:'RepoQL index', sub:'Workspace and imports.'},
      {id:'concepts', col:2, tone:'green', kicker:'Source', title:'Concept store', sub:'Invariants with verification spans.'},
      {id:'live', col:2, tone:'amber', kicker:'Source', title:'Running systems', sub:'The deployed truth.'},
      {id:'memorycore', col:2, tone:'green', kicker:'Source', title:'MemoryCore', sub:'L1 top 5, then L0 top 3.'},
      {id:'pack', col:3, tone:'purple', kicker:'Compose', title:'Grounded context', sub:'Cited evidence, ranked by authority.', bullets:['Source and live state outrank history.','Gaps are stated, not filled with guesses.']},
      {id:'act', col:4, tone:'red', kicker:'Act', title:'Gated action', sub:'Edits pass receipt, reviewer and credential gates.'},
    ],
    edges: [
      ['task','explore','search'], ['task','probe','operational state'], ['task','recall','when history matters'], ['explore','read','verify'], ['read','hints','before editing'],
      ['explore','index','candidates'], ['read','index','exact spans'], ['hints','concepts','relevant capsules'], ['probe','live','inspect'], ['recall','memorycore','bounded recall'],
      ['index','pack','cited evidence'], ['concepts','pack','guidance'], ['live','pack','current truth'], ['memorycore','pack','supplementary'], ['pack','act','grounded'],
    ],
    callouts: [
      {tone:'cyan', title:'Relevance ≠ proof', items:['Ranking finds candidates; a parser edge is observed structure.','Verified behaviour means reading source and testing the running system.']},
      {tone:'purple', title:'Bounded history', items:['Recall is opt-in and identity-scoped.','Packs are reused rather than re-queried.']},
      {tone:'red', title:'Then the gates', items:['Perfect context still passes the mutation gates.','Good grounding reduces mistakes; gates protect the edges.']},
    ],
  },
  lifecycle: {
    label: 'Governance',
    title: 'Change & knowledge lifecycle',
    summary: 'Every material change follows the same path: prove the source, pass the gates, apply through sanctioned writers, record the outcome, and retire anything it supersedes.',
    stats: [['3', 'Independent gates'], ['Guarded', 'Config writes'], ['Receipted', 'Closeout'], ['Lineage', 'On supersede']],
    lanes: ['Propose', 'Check', 'Apply', 'Record', 'Retire'],
    nodes: [
      {id:'proposal', col:0, tone:'blue', kicker:'Start', title:'Change proposal', sub:'Code, config or new durable knowledge.'},
      {id:'receipt', col:1, tone:'red', kicker:'Gate', title:'RepoQL receipt gate', sub:'Source edits require a matching lookup.', bullets:['Pure task reports under work/ are exempt and audited as such.','The exemption never forges a lookup receipt.']},
      {id:'reviewer', col:1, tone:'red', kicker:'Gate', title:'Reviewer gate', sub:'Fresh code-reviewer pass (≤ 90 min) naming exact paths.'},
      {id:'credential', col:1, tone:'red', kicker:'Gate', title:'Credential gate', sub:'Blocks secrets in tool calls, files and logs.'},
      {id:'guard', col:2, tone:'amber', kicker:'Apply', title:'Guarded config writer', sub:'Configuration changes require the approved guarded writer and readback evidence.', bullets:['A deferred result is not an applied change.','Service restarts require the approved guarded procedure.'], refs:['Config change receipts','Guarded restart procedure']},
      {id:'capture', col:2, tone:'purple', kicker:'Apply', title:'Governed capture', sub:'concept_add · doc_edit · doc_append', refs:['knowledge_capture']},
      {id:'docs', col:3, tone:'cyan', kicker:'Record', title:'Hub runbook & issue', sub:'Behaviour, evidence and untested recovery noted.'},
      {id:'journal', col:3, tone:'cyan', kicker:'Record', title:'Journal OUTCOME / LESSON', sub:'One non-duplicate entry per outcome.', refs:['fleet-log']},
      {id:'closeout', col:3, tone:'green', kicker:'Receipt', title:'Closeout receipt', sub:'The real receipt is reported — failure is not PASS.', refs:['fleet-agent-closeout']},
      {id:'retire', col:4, tone:'amber', kicker:'Lifecycle', title:'Supersession', sub:'Old capsules keep lineage; TTL triggers re-verification.'},
    ],
    edges: [
      ['proposal','receipt','source edit'], ['proposal','reviewer','gated mutation'], ['proposal','credential','every call'],
      ['receipt','capture','verified source'], ['reviewer','guard','approved'], ['credential','guard','clean'],
      ['guard','docs','deployed'], ['capture','docs','documented'], ['docs','journal','outcome'], ['journal','closeout','evidence'], ['capture','retire','supersedes'],
    ],
    callouts: [
      {tone:'red', title:'Gates are independent', items:['Passing one gate never clears another.','A report exemption is not source verification.']},
      {tone:'amber', title:'Deferred is not applied', items:['Guard exit 2 leaves the live file unchanged.','Detached one-shot rollouts avoid keeping a session artificially active.']},
      {tone:'green', title:'Closeout is evidence', items:['Hub, runbook, journal and receipt are updated together.','Rollback paths are documented and marked untested until exercised.']},
    ],
  },
};

const ORCHESTRA_MODES = {
  solo: {
    label: 'Solo',
    title: 'Solo mode',
    summary: 'Single-agent execution with the same retrieval plane, safety rails and telemetry as the larger modes. No hidden “light mode” shortcuts.',
    stats: [['1', 'Worker'], ['Inline', 'Self-check'], ['Direct', 'Chat topology'], ['Focused', 'Best for']],
    lanes: ['Brief', 'Ground', 'Execute', 'Guard', 'Deliver'],
    nodes: [
      {id:'operator', col:0, tone:'purple', kicker:'Input', title:'Operator', sub:'Sets the task and the outcome.'},
      {id:'retrieval', col:1, tone:'cyan', kicker:'Grounding', title:'RepoQL + memory', sub:'Verified knowledge and bounded history.'},
      {id:'solo', col:2, tone:'green', kicker:'Worker', title:'Solo agent', sub:'One primary agent executes the task.'},
      {id:'hooks', col:3, tone:'amber', kicker:'Hooks', title:'Hooks', sub:'Telemetry, notifications and chat delivery.', bullets:['Task telemetry and run history.','Agent Chat ingestion and delivery.','Knowledge-capture handoff after completion.']},
      {id:'gates', col:3, tone:'red', kicker:'Gates', title:'Gates', sub:'Lease, deploy-intent and mutation checks.', bullets:['Resource lease before shared-state changes.','Deploy intent before sensitive targets.','Dangerous-asset review when risk is high.']},
      {id:'output', col:4, tone:'cyan', kicker:'Output', title:'Result + capture', sub:'Answer, telemetry and durable learning.'},
    ],
    edges: [['operator','retrieval','brief'],['retrieval','solo','context'],['solo','hooks','events'],['solo','gates','mutate?'],['hooks','output','telemetry'],['gates','output','approved path']],
    callouts: [
      {tone:'amber', title:'Hooks in Solo', items:['Task telemetry and run history.','Agent Chat delivery.','Capture handoff after work completes.']},
      {tone:'red', title:'Gates in Solo', items:['Resource lease before shared-state changes.','Deploy intent before sensitive targets.','Dangerous-asset review when risk is high.']},
      {tone:'cyan', title:'Why Solo matters', items:['Simplest path for small jobs.','Same observability surface as larger modes.']},
    ],
  },
  duo: {
    label: 'Dual',
    title: 'Dual worker mode',
    summary: 'Two implementation workers operate under the coordinator. Review and consultation are separate evidence gates, not implementation seats. This is a source diagram, not live run health.',
    stats: [['2', 'Implementation seats'], ['Gated', 'Review lane'], ['Per-session', 'Mailboxes'], ['Dual', 'Mode name']],
    lanes: ['Brief', 'Ground', 'Implement', 'Coordinate', 'Guard', 'Deliver'],
    nodes: [
      {id:'operator', col:0, tone:'purple', kicker:'Input', title:'Operator', sub:'Briefs the work and the mode.'},
      {id:'retrieval', col:1, tone:'cyan', kicker:'Grounding', title:'RepoQL + memory', sub:'Shared verified context for both seats.'},
      {id:'alpha', col:2, tone:'green', kicker:'Seat', title:'Worker alpha', sub:'First implementation seat.'},
      {id:'beta', col:2, tone:'green', kicker:'Seat', title:'Worker beta', sub:'Second seat for safely parallel work.'},
      {id:'chat', col:3, tone:'purple', kicker:'Bus', title:'Agent Chat bus', sub:'Durable mailboxes, live feed, immediate delivery.', bullets:['Each active session has its own mailbox identity.','Oldest-first contiguous batches; only surfaced IDs are acknowledged.']},
      {id:'hooks', col:4, tone:'amber', kicker:'Hooks', title:'Hooks', sub:'Pre/postflight, telemetry, capture.'},
      {id:'gates', col:4, tone:'red', kicker:'Gates', title:'Gates', sub:'Lease, deploy intent, doc and asset gates.'},
      {id:'output', col:5, tone:'cyan', kicker:'Output', title:'Result + memory', sub:'Answer plus durable knowledge updates.'},
    ],
    edges: [['operator','retrieval','brief'],['retrieval','alpha','shared context'],['retrieval','beta','shared context'],['alpha','chat','delegate'],['beta','chat','reply'],['chat','hooks','events'],['chat','gates','risky action'],['hooks','output','telemetry'],['gates','output','approved path']],
    callouts: [
      {tone:'purple', title:'Delivery', items:['Agent sessions and worker sessions coordinate through verified delivery contracts.','Immediate notification reduces waiting between turns.']},
      {tone:'amber', title:'Hooks', items:['Task metadata and run telemetry.','Session registration and delivery mirroring.','Memory and docs capture after completion.']},
      {tone:'red', title:'Gates', items:['High-risk changes need more than the chat bus.','RepoQL stays the primary retrieval layer in every mode.']},
    ],
  },
  quad: {
    label: 'Quad',
    title: 'Quad mode',
    summary: 'Four implementation seats: alpha and beta are managed write-capable subscription workers; gamma and delta are managed Luna reply-text seats for self-contained tasks or optional verification.',
    stats: [['4', 'Implementation seats'], ['Alpha · beta', 'Write seats'], ['Gamma · delta', 'Reply seats'], ['Explicit', 'Selection']],
    lanes: ['Brief', 'Ground', 'Implement', 'Coordinate', 'Guard', 'Execute & deliver'],
    nodes: [
      {id:'operator', col:0, tone:'purple', kicker:'Input', title:'Operator', sub:'Sets objective and constraints.'},
      {id:'retrieval', col:1, tone:'cyan', kicker:'Grounding', title:'RepoQL + memory', sub:'Common context for every seat.'},
      {id:'alpha', col:2, tone:'green', kicker:'Lead seat', title:'Worker alpha', sub:'Managed subscription seat, write-capable.'},
      {id:'beta', col:2, tone:'green', kicker:'Seat', title:'Worker beta', sub:'Second managed subscription seat.'},
      {id:'gamma', col:2, tone:'amber', kicker:'Seat', title:'Worker gamma', sub:'Luna reply-text task or verification.'},
      {id:'delta', col:2, tone:'amber', kicker:'Seat', title:'Worker delta', sub:'Luna reply-text task or verification.'},
      {id:'chat', col:3, tone:'purple', kicker:'Fabric', title:'Agent Chat fabric', sub:'Cross-agent messaging and feed.'},
      {id:'hooks', col:4, tone:'amber', kicker:'Hooks', title:'Hooks', sub:'Wiring, telemetry, notifications, capture.'},
      {id:'gates', col:4, tone:'red', kicker:'Gates', title:'Gates', sub:'Lease, deploy intent, asset and doc gates.'},
      {id:'pools', col:5, tone:'blue', kicker:'Pools', title:'Worker execution pools', sub:'Every requested seat requires a validated execution transport before it can run.'},
      {id:'output', col:5, tone:'cyan', kicker:'Output', title:'Approved result', sub:'Answer, audit trail and captured learning.'},
    ],
    edges: [['operator','retrieval','brief'],['retrieval','alpha','grounding'],['alpha','beta','delegate'],['beta','gamma','optional parallel work'],['gamma','delta','optional parallel work'],['beta','chat','updates'],['gamma','chat','findings'],['delta','chat','advice'],['chat','hooks','events'],['chat','gates','risky ops'],['hooks','pools','execute / notify'],['gates','output','approved changes'],['pools','output','results']],
    callouts: [
      {tone:'green', title:'Seat contract', items:['Alpha and beta have workspace write access.','Gamma and delta are reply-text seats, not dedicated reviewers.','Failed required assignments block; optional ones may degrade to findings.']},
      {tone:'amber', title:'Hooks & gates', items:['Hooks make the system observable.','Gates make it trustworthy.']},
      {tone:'blue', title:'Pools', items:['Verify every execution transport before enabling its assigned seats.','Custom mode is separate: up to ten implementation seats, at most four from the designated pool.']},
    ],
  },
  custom: {
    label: 'Custom',
    title: 'Custom orchestra roster',
    summary: 'Explicitly selected roster of up to ten implementation seats. At most four can be assigned to one designated worker pool. Other seats need verified execution transports. Fixed modes retain their own contracts.',
    stats: [['10 max', 'Implementation seats'], ['4 max', 'Designated worker pool'], ['6', 'Other seats in a full roster'], ['Unchanged', 'Review gates']],
    lanes: ['Request', 'Ground', 'Allocate', 'Implement', 'Review', 'Report'],
    nodes: [
      {id:'operator', col:0, tone:'purple', kicker:'Request', title:'Operator / Super', sub:'Requests a concrete custom roster; no invented workers.'},
      {id:'retrieval', col:1, tone:'cyan', kicker:'Context', title:'RepoQL + relevant recall', sub:'Source and session-specific evidence before dispatch.'},
      {id:'roster', col:2, tone:'amber', kicker:'Guard', title:'Roster validation', sub:'Hard maximum ten seats, four in the designated worker pool, with provider and budget checks.'},
      {id:'pool-primary', col:3, tone:'green', kicker:'Pool', title:'Designated pool (0 to 4)', sub:'Explicitly requested workers, subject to existing lease and budget controls.'},
      {id:'other', col:3, tone:'blue', kicker:'Pool', title:'Other seats (0 to 10)', sub:'Seats using other validated execution transports, within the overall ten-seat limit.'},
      {id:'review', col:4, tone:'red', kicker:'Gate', title:'Existing planner, review and acceptance', sub:'Same premium/free model routing and approval stages as other modes.'},
      {id:'output', col:5, tone:'cyan', kicker:'Evidence', title:'Status, results and memory', sub:'Verified delivery receipts, telemetry and governed learning.'},
    ],
    edges: [['operator','retrieval','task'],['retrieval','roster','grounded'],['roster','pool-primary','explicit seats'],['roster','other','supported seats'],['pool-primary','review','evidence'],['other','review','evidence'],['review','output','verdict']],
    callouts: [
      {tone:'red', title:'Hard limits', items:['At most ten implementation seats per custom run.','At most four workers from the designated pool; overrides do not raise the cap.','Unavailable execution transports block their seats rather than bypassing gates.']},
      {tone:'amber', title:'Separate fixed modes', items:['Solo, Dual, Quad and fixed Super modes keep their existing contracts.','Larger custom rosters must be requested explicitly.','Direct dispatch requires a validated launch integration.']},
    ],
  },
  super: {
    label: 'Super',
    title: 'Super mode',
    summary: 'Fixed Super mode coordinates one or two managed seats. A separate custom roster supports up to ten when launch and worker transports are verified. Review gates and monitoring are not additional worker seats.',
    stats: [['1–2', 'Managed seats'], ['In-chamber', 'Director'], ['Not used', 'Gamma / delta'], ['Explicit', 'Selection']],
    embedMemory: true,
    lanes: ['Brief & ground', 'Direct', 'Seats & review', 'Fabric', 'Hooks & gates', 'Observe & deliver'],
    nodes: [
      {id:'operator', col:0, tone:'purple', kicker:'Input', title:'Operator', sub:'Starts a high-value or high-risk objective.'},
      {id:'retrieval', col:0, tone:'cyan', kicker:'Grounding', title:'RepoQL + memory', sub:'Unified knowledge plane with history.'},
      {id:'coord', col:1, tone:'green', kicker:'Director', title:'Coordinator / Super', sub:'Plans, briefs, verifies — not a worker seat.', bullets:['Owns the plan and the final verdict.','Verifies what workers return; a claim is not evidence.']},
      {id:'alpha', col:2, tone:'green', kicker:'Seat', title:'Alpha managed seat', sub:'Operator-selected implementation seat.'},
      {id:'beta', col:2, tone:'green', kicker:'Seat', title:'Beta (optional)', sub:'Second managed seat when selected.'},
      {id:'review', col:2, tone:'red', kicker:'Gate', title:'Review / consult', sub:'A capability, not a third worker.'},
      {id:'deploy', col:2, tone:'red', kicker:'Gate', title:'Deploy gate', sub:'Deployment preconditions.'},
      {id:'chat', col:3, tone:'purple', kicker:'Fabric', title:'Agent Chat fabric', sub:'Message bus, feed and delivery.'},
      {id:'pools', col:3, tone:'blue', kicker:'Pools', title:'External pools', sub:'Legacy fixed Super mode has α/β only; a separate custom roster supports up to ten seats after cutover.'},
      {id:'hooks', col:4, tone:'amber', kicker:'Hooks', title:'Hooks', sub:'Pre/postflight, telemetry, capture, office sync.'},
      {id:'gates', col:4, tone:'red', kicker:'Gates', title:'Gates', sub:'Lease, deploy intent, asset and capture gates.'},
      {id:'ghost', col:5, tone:'cyan', kicker:'Persistent', title:'Ghost agent', sub:'Long-running monitoring and delegated tasks.'},
      {id:'audit', col:5, tone:'amber', kicker:'Observe', title:'Telemetry + audit', sub:'Runs, usage, events and performance.'},
      {id:'memory', col:5, tone:'purple', kicker:'Capture', title:'Memory architecture', sub:'MemoryCore history + RepoQL knowledge.'},
      {id:'output', col:5, tone:'cyan', kicker:'Output', title:'Trusted outcome', sub:'Verified answer and reusable learning.'},
    ],
    edges: [['operator','retrieval','brief'],['retrieval','coord','grounding'],['coord','alpha','delegate'],['coord','beta','optional'],['coord','review','when needed'],['coord','deploy','deploy check'],['alpha','chat','work updates'],['beta','chat','updates'],['review','gates','verdict'],['deploy','gates','preconditions'],['pools','chat','identities'],['chat','hooks','events'],['hooks','ghost','persistent work'],['hooks','audit','telemetry'],['gates','audit','review trail'],['audit','memory','capture triggers'],['memory','output','durable context'],['ghost','output','live state']],
    callouts: [
      {tone:'green', title:'Super as configured', items:['Fixed Super mode supports one or two seats; custom mode supports a larger roster by explicit selection.','Gamma and delta are not Super seats; no free split is allocated.','Consultation, gates, telemetry and memory are not counted as workers.']},
      {tone:'purple', title:'Embedded memory', items:['Super depends on the same memory plane as every mode.','See the Memory architecture page for the full pipeline.']},
      {tone:'amber', title:'Hooks and gates', items:['Hooks = operational glue and observability.','Gates = mutation safety and policy enforcement.']},
    ],
  },
};

// ------------------------------------------------------------------ geometry
const BOARD_PAD = 22, LANE_GAP = 34, MIN_LANE = 138;

function bezierPoint(p, t) {
  const u = 1 - t;
  return {
    x: u*u*u*p[0].x + 3*u*u*t*p[1].x + 3*u*t*t*p[2].x + t*t*t*p[3].x,
    y: u*u*u*p[0].y + 3*u*u*t*p[1].y + 3*u*t*t*p[2].y + t*t*t*p[3].y,
  };
}

// Pure routing used by the renderer and the regression tests.
export function routeWire(a, b, {sameLane = false, vertical = false, loop = false, bounds = null} = {}) {
  let p;
  if (loop) {
    if (!vertical) {
      const y = bounds?.h ? bounds.h - 24 : Math.max(a.y + a.h, b.y + b.h) + 30;
      p = [{x:a.cx, y:a.y + a.h}, {x:a.cx, y}, {x:b.cx, y}, {x:b.cx, y:b.y + b.h}];
    } else {
      const x = (bounds?.w ?? Math.max(a.x + a.w, b.x + b.w) + 30) - 8;
      p = [{x:a.x + a.w, y:a.cy}, {x, y:a.cy}, {x, y:b.cy}, {x:b.x + b.w, y:b.cy}];
    }
  } else {
    const horizontal = vertical ? sameLane : !sameLane;
    if (horizontal) {
      const s = Math.sign(b.cx - a.cx) || 1;
      const x1 = s > 0 ? a.x + a.w : a.x, x2 = s > 0 ? b.x : b.x + b.w;
      const k = Math.max(26, Math.abs(x2 - x1) * 0.5);
      p = [{x:x1, y:a.cy}, {x:x1 + s*k, y:a.cy}, {x:x2 - s*k, y:b.cy}, {x:x2, y:b.cy}];
    } else {
      const s = Math.sign(b.cy - a.cy) || 1;
      const y1 = s > 0 ? a.y + a.h : a.y, y2 = s > 0 ? b.y : b.y + b.h;
      const k = Math.max(20, Math.abs(y2 - y1) * 0.5);
      p = [{x:a.cx, y:y1}, {x:a.cx, y:y1 + s*k}, {x:b.cx, y:y2 - s*k}, {x:b.cx, y:y2}];
    }
  }
  const f = (n) => n.toFixed(1);
  return {d:`M${f(p[0].x)} ${f(p[0].y)} C${f(p[1].x)} ${f(p[1].y)} ${f(p[2].x)} ${f(p[2].y)} ${f(p[3].x)} ${f(p[3].y)}`, mid:bezierPoint(p, 0.5), points:p};
}

export function tourOrder(view) {
  return [...view.nodes].map((n, i) => ({n, i})).sort((a, b) => a.n.col - b.n.col || a.i - b.i).map(({n}) => n);
}

// ------------------------------------------------------------------ markup
function nodeHTML(node, selectedId) {
  const on = node.id === selectedId;
  return `<button type="button" class="workflow-node arch-node tone-${esc(node.tone)}${on ? ' active' : ''}" data-node-id="${esc(node.id)}" aria-pressed="${on}" style="--tone:${TONES[node.tone] || TONES.cyan}">
    <span class="arch-node-kicker"><i aria-hidden="true"></i>${esc(node.kicker)}</span>
    <span class="arch-node-title">${esc(node.title)}</span>
    <span class="arch-node-sub">${esc(node.sub)}</span>
  </button>`;
}

function boardHTML(view, selectedId) {
  const lanes = view.lanes.map((lane, i) => `
    <div class="arch-lane">
      <div class="arch-lane-label"><span>${String(i + 1).padStart(2, '0')}</span>${esc(lane)}</div>
      <div class="arch-lane-nodes">${view.nodes.filter((n) => n.col === i).map((n) => nodeHTML(n, selectedId)).join('')}</div>
    </div>`).join('');
  return `<svg class="arch-wires" aria-hidden="true"></svg>
    <div class="arch-lanes" style="--lanes:${view.lanes.length}">${lanes}</div>
    <div class="arch-wire-labels" aria-hidden="true"></div>`;
}

function legendHTML(legend, view) {
  const used = new Set(view.nodes.map((n) => n.tone));
  return Object.entries(legend).filter(([tone]) => used.has(tone))
    .map(([tone, label]) => `<span class="arch-legend-item" style="--tone:${TONES[tone]}"><i></i>${esc(label)}</span>`).join('');
}

function statsHTML(view) {
  return (view.stats || []).map(([value, label]) => `<div class="arch-stat"><strong>${esc(value)}</strong><span>${esc(label)}</span></div>`).join('');
}

function inspectorHTML(view, node) {
  if (!node) return '';
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const flow = (dir) => view.edges.filter(([a, b]) => (dir === 'in' ? b : a) === node.id).map(([a, b, label]) => {
    const other = byId.get(dir === 'in' ? a : b);
    return other ? `<button type="button" class="arch-flow-link" data-goto="${esc(other.id)}" style="--tone:${TONES[other.tone]}"><i></i><span>${esc(other.title)}</span><em>${esc(label || '')}</em></button>` : '';
  }).join('');
  const incoming = flow('in'), outgoing = flow('out');
  const bullets = (node.bullets || []).map((b) => `<li>${esc(b)}</li>`).join('');
  const refs = (node.refs || []).map((r) => `<code>${esc(r)}</code>`).join('');
  const embed = view.embedMemory && node.id === 'memory' ? `<a class="arch-embed-link" href="#/architecture/memory">Open the memory architecture →</a>` : '';
  return `<div class="arch-insp" style="--tone:${TONES[node.tone] || TONES.cyan}">
    <div class="arch-insp-main">
    <div class="arch-insp-kicker"><i></i>${esc(node.kicker)} · ${esc(view.lanes[node.col] || '')}</div>
    <h2>${esc(node.title)}</h2>
    <p class="arch-insp-lead">${esc(node.sub)}</p>
    ${bullets ? `<ul class="arch-insp-list">${bullets}</ul>` : ''}
    ${refs ? `<div class="arch-insp-section"><h3>Components</h3><div class="arch-refs">${refs}</div></div>` : ''}
    ${embed}
    </div>
    <div class="arch-insp-flow">
      <div class="arch-insp-section"><h3>Receives from</h3>${incoming || '<p class="arch-none">Entry point</p>'}</div>
      <div class="arch-insp-section"><h3>Sends to</h3>${outgoing || '<p class="arch-none">Terminal stage</p>'}</div>
    </div>
  </div>`;
}

function calloutsHTML(view) {
  return (view.callouts || []).map((c) => `<article class="workflow-callout arch-callout" style="--tone:${TONES[c.tone] || TONES.cyan}">
    <h3>${esc(c.title)}</h3><ul>${(c.items || []).map((item) => `<li>${esc(item)}</li>`).join('')}</ul></article>`).join('');
}

function pageHTML({eyebrow, title, intro, tabsId, tabsLabel, views, defaultKey}) {
  const tabs = Object.entries(views).map(([key, v]) => `<button type="button" role="tab" class="arch-tab" id="${tabsId}-${key}" data-view="${key}" value="${key}" aria-selected="${key === defaultKey}" tabindex="${key === defaultKey ? 0 : -1}">${esc(v.label)}</button>`).join('');
  return `
  <section class="workflow-page arch-page">
    <header class="arch-hero">
      <div class="arch-hero-copy">
        <span class="arch-eyebrow">${esc(eyebrow)}</span>
        <h1>${esc(title)}</h1>
        <p>${esc(intro)}</p>
      </div>
      <div class="arch-hero-stats" data-arch-stats></div>
    </header>
    <div class="arch-toolbar">
      <div class="arch-tabs" role="tablist" aria-label="${esc(tabsLabel)}" id="${tabsId}">${tabs}</div>
      <div class="arch-legend" data-arch-legend aria-label="Colour legend"></div>
    </div>
    <div class="arch-view-head"><h2 data-arch-title></h2><p data-arch-summary></p></div>
    <div class="arch-stage">
      <div class="workflow-viewport arch-board" role="group" aria-label="Interactive architecture map. Select a stage to inspect it." tabindex="0" data-workflow-canvas></div>
      <aside class="arch-inspector" data-workflow-inspector aria-live="polite"></aside>
    </div>
    <div class="workflow-stepper arch-walk" data-stage-navigator>
      <button type="button" class="btn" data-step-prev aria-label="Previous stage">← Previous</button>
      <div class="arch-walk-mid">
        <div class="arch-dots" data-step-dots aria-hidden="true"></div>
        <span data-step-status role="status" aria-live="polite">Loading stages…</span>
      </div>
      <button type="button" class="btn arch-play" data-step-play aria-pressed="false">▶ Guided tour</button>
      <button type="button" class="btn primary" data-step-next aria-label="Next stage">Next →</button>
    </div>
    <section class="workflow-callouts arch-callouts" data-workflow-callouts></section>
  </section>`;
}

// ------------------------------------------------------------------ behaviour
let activeBinding = null;

function bindArchitecture(views, tabsId, defaultKey, legend) {
  activeBinding?.dispose();
  const root = document;
  const tabs = root.getElementById(tabsId);
  const board = root.querySelector('[data-workflow-canvas]');
  const inspector = root.querySelector('[data-workflow-inspector]');
  const callouts = root.querySelector('[data-workflow-callouts]');
  const nav = root.querySelector('[data-stage-navigator]');
  if (!tabs || !board) return null;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  let key = defaultKey, selectedId = null, timer = null, frame = 0, disposed = false;
  const view = () => views[key];

  function wire() {
    if (disposed || !board.isConnected) return;
    const v = view();
    const br = board.getBoundingClientRect();
    if (!br.width) return;
    const vertical = board.classList.contains('is-vertical');
    const rect = (id) => {
      const el = board.querySelector(`[data-node-id="${CSS.escape(id)}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const x = r.left - br.left, y = r.top - br.top;
      return {x, y, w:r.width, h:r.height, cx:x + r.width / 2, cy:y + r.height / 2};
    };
    const byId = new Map(v.nodes.map((n) => [n.id, n]));
    const linked = new Set();
    let paths = '', pulses = '', labels = '';
    const placed = [];
    v.edges.forEach(([from, to, label, flag], i) => {
      const a = rect(from), b = rect(to);
      if (!a || !b) return;
      const src = byId.get(from), dst = byId.get(to);
      const hot = Boolean(selectedId) && (from === selectedId || to === selectedId);
      if (hot) linked.add(from === selectedId ? to : from);
      const route = routeWire(a, b, {sameLane: src.col === dst.col, vertical, loop: flag === 'loop', bounds: {w: br.width, h: br.height}});
      const tone = TONES[src.tone] || TONES.cyan;
      const cls = `arch-wire${hot ? ' hot' : ''}${selectedId && !hot ? ' dim' : ''}${flag === 'loop' ? ' loop' : ''}`;
      paths += `<path id="arch-w-${i}" class="${cls}" d="${route.d}" style="--tone:${tone}" marker-end="url(#arch-arrow-${hot ? src.tone : 'base'})"/>`;
      if (!reduced && (!selectedId || hot)) {
        const dur = hot ? 1.6 + (i % 3) * 0.25 : 3.4 + (i % 5) * 0.45;
        pulses += `<circle class="arch-pulse${hot ? ' hot' : ''}" r="${hot ? 3.2 : 2.1}" fill="${tone}"><animateMotion dur="${dur}s" begin="-${((i * 0.83) % dur).toFixed(2)}s" repeatCount="indefinite"><mpath href="#arch-w-${i}"/></animateMotion></circle>`;
      }
      if (hot && label) {
        // Keep labels inside the board and nudge apart any that would collide.
        const w = label.length * 6.4 + 18;
        let x = Math.min(Math.max(route.mid.x, w / 2 + 4), br.width - w / 2 - 4), y = route.mid.y;
        for (let tries = 0; tries < 6 && placed.some((p) => Math.abs(p.x - x) < (p.w + w) / 2 + 4 && Math.abs(p.y - y) < 20); tries++) y += 22;
        placed.push({x, y, w});
        labels += `<span class="arch-wire-label" style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px;--tone:${tone}">${esc(label)}</span>`;
      }
    });
    const markers = [...Object.entries(TONES), ['base', '#5f86b0']].map(([name, c]) => `<marker id="arch-arrow-${name}" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path d="M1 1.4 L9 5 L1 8.6 Z" fill="${c}"/></marker>`).join('');
    const svg = board.querySelector('.arch-wires');
    svg.setAttribute('viewBox', `0 0 ${br.width.toFixed(0)} ${br.height.toFixed(0)}`);
    svg.innerHTML = `<defs>${markers}<filter id="arch-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><g class="arch-wire-layer">${paths}</g><g class="arch-pulse-layer" filter="url(#arch-glow)">${pulses}</g>`;
    board.querySelector('.arch-wire-labels').innerHTML = labels;
    board.querySelectorAll('.arch-node').forEach((el) => {
      el.classList.toggle('linked', linked.has(el.dataset.nodeId));
      el.classList.toggle('faded', Boolean(selectedId) && el.dataset.nodeId !== selectedId && !linked.has(el.dataset.nodeId));
    });
  }

  function layoutMode() {
    const v = view();
    const need = v.lanes.length * MIN_LANE + (v.lanes.length - 1) * LANE_GAP + BOARD_PAD * 2;
    board.classList.toggle('is-vertical', board.clientWidth < need);
  }

  function schedule() { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { layoutMode(); wire(); }); }

  function select(id, {scroll = false} = {}) {
    const v = view();
    selectedId = v.nodes.some((n) => n.id === id) ? id : tourOrder(v)[0]?.id;
    board.querySelectorAll('.arch-node').forEach((el) => {
      const on = el.dataset.nodeId === selectedId;
      el.classList.toggle('active', on); el.setAttribute('aria-pressed', String(on));
    });
    const node = v.nodes.find((n) => n.id === selectedId);
    inspector.innerHTML = inspectorHTML(v, node);
    inspector.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => { stopTour(); select(b.dataset.goto, {scroll: true}); }));
    const order = tourOrder(v), pos = order.findIndex((n) => n.id === selectedId);
    if (nav) {
      nav.querySelector('[data-step-status]').textContent = `${pos + 1} of ${order.length} · ${node?.title || 'Stage'}`;
      nav.querySelector('[data-step-prev]').disabled = pos <= 0;
      nav.querySelector('[data-step-next]').disabled = pos >= order.length - 1;
      nav.querySelector('[data-step-dots]').innerHTML = order.map((n, i) => `<i class="${i === pos ? 'on' : i < pos ? 'past' : ''}" style="--tone:${TONES[n.tone]}"></i>`).join('');
    }
    if (scroll) board.querySelector(`[data-node-id="${CSS.escape(selectedId)}"]`)?.scrollIntoView({block:'nearest', inline:'nearest', behavior: reduced ? 'auto' : 'smooth'});
    schedule();
  }

  function render() {
    const v = view();
    root.querySelector('[data-arch-stats]').innerHTML = statsHTML(v);
    root.querySelector('[data-arch-legend]').innerHTML = legendHTML(legend, v);
    root.querySelector('[data-arch-title]').textContent = v.title;
    root.querySelector('[data-arch-summary]').textContent = v.summary;
    board.innerHTML = boardHTML(v, selectedId);
    callouts.innerHTML = calloutsHTML(v);
    tabs.querySelectorAll('[data-view]').forEach((t) => { const on = t.dataset.view === key; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; });
    layoutMode();
    select(selectedId);
  }

  function step(delta) {
    const order = tourOrder(view()), pos = order.findIndex((n) => n.id === selectedId);
    const next = order[pos + delta];
    if (next) select(next.id, {scroll: true});
    return Boolean(next);
  }
  function stopTour() {
    clearInterval(timer); timer = null;
    const play = nav?.querySelector('[data-step-play]');
    if (play) { play.setAttribute('aria-pressed', 'false'); play.textContent = '▶ Guided tour'; }
  }
  function startTour() {
    const order = tourOrder(view());
    if (order.findIndex((n) => n.id === selectedId) >= order.length - 1) select(order[0].id);
    const play = nav.querySelector('[data-step-play]');
    play.setAttribute('aria-pressed', 'true'); play.textContent = '❚❚ Pause tour';
    timer = setInterval(() => { if (!board.isConnected || !step(1)) stopTour(); }, 3200);
  }

  board.addEventListener('click', (e) => { const b = e.target.closest('[data-node-id]'); if (b) { stopTour(); select(b.dataset.nodeId); } });
  board.addEventListener('keydown', (e) => {
    if (e.target !== board) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); stopTour(); step(1); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); stopTour(); step(-1); }
  });
  tabs.addEventListener('click', (e) => {
    const t = e.target.closest('[data-view]'); if (!t || t.dataset.view === key) return;
    stopTour(); key = t.dataset.view; selectedId = null; render();
  });
  tabs.addEventListener('keydown', (e) => {
    if (!['ArrowRight', 'ArrowLeft'].includes(e.key)) return;
    const all = [...tabs.querySelectorAll('[data-view]')], i = all.findIndex((t) => t.dataset.view === key);
    const next = all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length];
    next.focus(); next.click(); e.preventDefault();
  });
  nav?.querySelector('[data-step-prev]')?.addEventListener('click', () => { stopTour(); step(-1); });
  nav?.querySelector('[data-step-next]')?.addEventListener('click', () => { stopTour(); step(1); });
  nav?.querySelector('[data-step-play]')?.addEventListener('click', () => (timer ? stopTour() : startTour()));
  const ro = new ResizeObserver(schedule);
  ro.observe(board);
  document.fonts?.ready?.then(schedule);
  render();
  activeBinding = {dispose() { disposed = true; stopTour(); ro.disconnect(); cancelAnimationFrame(frame); }};
  return activeBinding;
}

// ------------------------------------------------------------------ pages
// Plain-language orientation precedes the interactive source diagrams. All links are
// existing hash routes. These pages describe design, not live runtime health.
const memoryGuide = `<section class="arch-guide" aria-label="Memory explained">
  <h2>Why this matters</h2>
  <p>Memory helps an agent recover relevant previous decisions without treating old conversations as current facts. RepoQL points to code, documents and verified concepts. Tencent MemoryCore holds supplementary conversation history. The two answer different questions.</p><p class="arch-note"><strong>Coverage note:</strong> Different session and bot sources may have separate capture adapters and memory identities. Verify each capture path with its own receipts; a registered identity alone does not prove that conversations were captured.</p>
  <div class="arch-guide-grid">
    <article><h3>What is stored?</h3><p><strong>L0</strong> holds individual turns. <strong>L1</strong> holds useful extracted records. <strong>L2 and L3</strong> provide broader summaries. A summary is context, not proof that a system still behaves the same way.</p></article>
    <article><h3>What happens automatically?</h3><p>A scheduled capture process collects eligible session history. A separate review process can propose lasting RepoQL concepts. A proposed concept is not automatically accepted into the authoritative knowledge store.</p></article>
    <article><h3>What do I control?</h3><p>Use the memory graph to explore relationships, Tencent Control to inspect memory records, Concepts for durable rules, and Harness for run evidence. Agent recall is requested explicitly when earlier history matters.</p></article>
  </div>
  <section class="memory-brain" aria-label="Brain style memory summary">
    <div class="memory-brain-head"><div><h3>The memory system as a human-style brain</h3><p>The left side gathers experiences, the centre decides what is safe and durable, and the right side gives agents grounded recall. This is a simplified mental model first; the tabbed diagrams below show the exact source-defined flows.</p></div><span class="pill purple">Begin here</span></div>
    <div class="memory-brain-shell">
      <svg class="memory-brain-anatomy" aria-hidden="true" viewBox="0 0 1000 620" preserveAspectRatio="xMidYMid meet" focusable="false">
        <defs><radialGradient id="memory-brain-shade"><stop offset="0" stop-color="var(--purple)" stop-opacity=".09"/><stop offset="1" stop-color="var(--cyan)" stop-opacity=".018"/></radialGradient></defs>
        <path class="memory-brain-half" d="M495 80 C435 33 342 30 275 69 C202 48 141 86 123 147 C65 164 50 222 81 270 C50 337 81 391 140 409 C151 470 206 513 268 505 C314 563 405 549 459 504 C490 469 503 412 489 365 Z"/>
        <path class="memory-brain-half" d="M505 80 C565 33 658 30 725 69 C798 48 859 86 877 147 C935 164 950 222 919 270 C950 337 919 391 860 409 C849 470 794 513 732 505 C686 563 595 549 541 504 C510 469 497 412 511 365 Z"/>
        <g class="memory-brain-folds">
          <path d="M240 103 C208 134 263 173 212 207 C170 240 197 281 248 297"/>
          <path d="M327 89 C290 131 354 173 322 213 C295 250 337 276 368 291"/>
          <path d="M418 104 C389 151 432 199 401 239 C385 262 402 294 445 305"/>
          <path d="M158 313 C212 306 198 369 250 385 C297 395 276 454 316 477"/>
          <path d="M335 338 C286 363 331 399 379 409 C411 417 390 467 424 484"/>
          <path d="M760 103 C792 134 737 173 788 207 C830 240 803 281 752 297"/>
          <path d="M673 89 C710 131 646 173 678 213 C705 250 663 276 632 291"/>
          <path d="M582 104 C611 151 568 199 599 239 C615 262 598 294 555 305"/>
          <path d="M842 313 C788 306 802 369 750 385 C703 395 724 454 684 477"/>
          <path d="M665 338 C714 363 669 399 621 409 C589 417 610 467 576 484"/>
        </g>
        <path class="memory-brain-fissure" d="M500 76 C483 130 517 185 498 248 C480 321 520 375 499 448 C487 481 503 501 499 527"/>
      </svg>
      <article class="memory-brain-node capture"><span class="label">Input + encoding</span><strong>Capture & review</strong><p>Sessions, docs and source are filtered into memory candidates.</p><ul><li>Single writer timer</li><li>Conversation review proposes lessons</li></ul></article>
      <article class="memory-brain-node memorycore"><span class="label">Episodic memory</span><strong>Tencent MemoryCore</strong><p>Stores what happened before: turns, records and summaries.</p></article>
      <article class="memory-brain-node concepts"><span class="label">Semantic memory</span><strong>RepoQL concepts</strong><p>Stores durable rules and reusable knowledge with lineage.</p></article>
      <article class="memory-brain-node index"><span class="label">Current truth</span><strong>RepoQL index</strong><p>Grounds agents in live code, docs, symbols and relationships.</p></article>
      <article class="memory-brain-node gates"><span class="label">Executive control</span><strong>Safety & relevance gates</strong><p>Receipts, relevance, duplicate detection and reviewer checks stop bad memory from spreading.</p></article>
      <article class="memory-brain-node recall"><span class="label">Recall</span><strong>Explicit recall only</strong><p>Memory is requested when needed; it is never ambiently injected into every conversation.</p></article>
      <article class="memory-brain-node output"><span class="label">Action</span><strong>Agents & operator</strong><p>Use grounded recall, then generate fresh evidence, docs and outcomes for the next cycle.</p></article>
    </div>
    <div class="memory-brain-paths">
      <div class="memory-brain-path"><strong>Capture path</strong><p>Experience → filter → MemoryCore history or candidate durable knowledge.</p></div>
      <div class="memory-brain-path"><strong>Governance path</strong><p>Every durable lesson is checked for scope, duplicates, evidence and policy before it can stick.</p></div>
      <div class="memory-brain-path"><strong>Recall path</strong><p>RepoQL retrieves current truth first; MemoryCore history supplements only when earlier context matters.</p></div>
    </div>
  </section>
  <p class="arch-note"><strong>Legend:</strong> Blue = source or consumer · Purple = capture or recall · Green = stores · Cyan = index or retrieval · Amber = lifecycle · Red = required checks. Diagram labels describe the captured source, not verified live availability.</p>
  <nav class="arch-guide-links" aria-label="Memory actions"><a href="#/unified/graph">Live Memory Graph</a><a href="#/unified/tencent">Tencent Control Panel</a><a href="#/knowledge/all">Concepts</a><a href="#/harness">Harness</a></nav>
</section>`;
const orchestraGuide = `<section class="arch-guide" aria-label="Orchestration explained">
  <h2>From request to acceptance</h2>
  <p>A coordinator assigns work while specialist workers produce evidence. A reviewer judges actual changes and test results. The flow can pause or fail at any gate. A completed step does not automatically mean approval.</p><p class="arch-note"><strong>Availability note:</strong> The diagrams describe intended contracts, not live worker availability. Custom dispatch and all execution transports require independent validation.</p>
  <ol class="arch-steps"><li><strong>Request</strong><span>Define the outcome and scope.</span></li><li><strong>Plan</strong><span>Choose workers and review requirements.</span></li><li><strong>Implement</strong><span>Workers change the authorized source.</span></li><li><strong>Validate</strong><span>Check code, tests and runtime evidence.</span></li><li><strong>Review</strong><span>Assess changes against the requirement.</span></li><li><strong>Accept</strong><span>Record the result or the remaining blocker.</span></li></ol>
  <p class="arch-note"><strong>Modes:</strong> Solo has one implementation seat, Dual two, Quad four, and the explicit Custom roster has up to ten with at most four from the designated worker pool. Remaining seats require supported transports. Consultation and review are separate gates, not worker seats. These limits do not prove live capacity.</p>
  <nav class="arch-guide-links" aria-label="Orchestration actions"><a href="#/harness">Harness Control Center</a><a href="#/harness/agents">Live Agents</a><a href="#/harness/runs">Execution History</a><a href="#/kanban">Kanban</a><a href="#/agentchat">Agent Chat</a></nav>
</section>`;
export function renderMemoryArchitecturePage() {
  return memoryGuide + pageHTML({eyebrow:'Architecture · Memory', title:'How memory works',
    intro:'Follow capture, review and recall. The diagram shows the source-defined design; use the controls below for live observations.',
    tabsId:'memory-view-mode', tabsLabel:'Memory view', views:MEMORY_VIEWS, defaultKey:'brain'});
}
export function bindMemoryArchitecturePage() { return bindArchitecture(MEMORY_VIEWS, 'memory-view-mode', 'brain', MEMORY_LEGEND); }

export function renderOrchestraWorkflowPage() {
  return orchestraGuide + pageHTML({eyebrow:'Architecture · Orchestration', title:'Harness & AI orchestra',
    intro:'Explore worker modes and the gates between a request and acceptance. The diagrams are a source snapshot, not a view of live run state.',
    tabsId:'orchestra-mode', tabsLabel:'Operating mode', views:ORCHESTRA_MODES, defaultKey:'duo'});
}
export function bindOrchestraWorkflowPage() { return bindArchitecture(ORCHESTRA_MODES, 'orchestra-mode', 'duo', ORCHESTRA_LEGEND); }

export const __workflowAudit = {routeWire, tourOrder, memoryViews: MEMORY_VIEWS, orchestraModes: ORCHESTRA_MODES, tones: TONES};
