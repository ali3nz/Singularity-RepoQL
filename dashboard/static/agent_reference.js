// Agent Roles reference. The roster is read live from Pi Chamber's agent
// definitions (/api/agents-control/pi-roster); the role summaries below are
// editorial descriptions keyed by agent name.
const ROLES = {
  super: ['Director', 'Primary engineering director. Plans scoped tasks, verifies evidence and requests authorised orchestration.'],
  general: ['General', 'General-purpose helper for ordinary implementation. Escalates high-risk or complex work to the proper coordinator.'],
  duo: ['Coordinator', 'Works with a senior partner on a two-worker approach, keeping the existing review discipline.'],
  'code-reviewer': ['Review', 'Reviews actual changes against requirements and evidence. Suggestions never turn a valid result into a blocker.'],
  explore: ['Research', 'Finds relevant files, symbols, references and exact source spans for a task.'],
  thinker: ['Reasoning', 'Works through difficult decisions and names a discriminating test when evidence is incomplete.'],
  board: ['Advisory', 'Chairs the personal Board of Advisors for financial, legal, tax and other advisory decisions.'],
};
const ORDER = ['super', 'general', 'duo', 'board', 'explore', 'thinker', 'code-reviewer'];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const card = (a) => {
  const [kind, role] = ROLES[a.name] || ['Agent', a.description || 'No description provided.'];
  return `<article class="ar-card">
    <header><h3>${esc(a.name)}</h3><span class="ar-kind">${esc(kind)}</span></header>
    <p>${esc(role)}</p>
    <dl>
      <div><dt>Model</dt><dd title="${esc(a.model)}">${esc(a.model_name || '—')}</dd></div>
      <div><dt>Provider</dt><dd>${esc(a.provider || '—')}</dd></div>
      <div><dt>Thinking</dt><dd>${esc(a.thinking || 'default')}</dd></div>
    </dl>
  </article>`;
};

export function renderAgentReferencePage() {
  return `<section class="arch-hero cs-hero ar-hero">
    <div class="arch-hero-copy"><span class="arch-eyebrow">Reference · Agents</span><h1>Agent roles</h1>
      <p>The agents defined in Pi Chamber and what each one is for. The roster and model settings are read live; the role descriptions are written guidance.</p></div>
    <div class="cs-hero-side"><nav class="cs-jump" aria-label="Related">
      <a href="#/harness/agents">Agent control</a><a href="#/agentchat">Agent Lounge</a><a href="#/architecture/orchestra">Orchestration</a></nav></div>
  </section>
  <section class="cheat-section" id="ar-roster"><h2>Pi Chamber agents <span class="ar-count" id="ar-count"></span></h2>
    <div class="ar-grid" id="ar-grid" aria-live="polite"><p class="small muted">Loading agents…</p></div>
    <p class="small muted ar-foot">Edit models and thinking levels in Agent control. Role descriptions do not grant authority; each agent's own prompt and the fleet rules apply.</p>
  </section>`;
}

export async function bindAgentReferencePage() {
  const grid = document.getElementById('ar-grid');
  if (!grid) return;
  try {
    const r = await fetch('/api/agents-control/pi-roster', {cache: 'no-store'});
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const list = (data.agents || []).slice().sort((x, y) => {
      const i = ORDER.indexOf(x.name), j = ORDER.indexOf(y.name);
      return (i < 0 ? 99 : i) - (j < 0 ? 99 : j) || x.name.localeCompare(y.name);
    });
    if (!document.getElementById('ar-grid')) return;
    grid.innerHTML = list.length ? list.map(card).join('') : '<p class="small muted">No agents found in Pi Chamber.</p>';
    const c = document.getElementById('ar-count');
    if (c) c.textContent = `· ${list.length}`;
  } catch (err) {
    grid.innerHTML = `<p class="small muted">Could not load the agent roster (${esc(err.message)}).</p>`;
  }
}
