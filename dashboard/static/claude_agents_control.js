// Native Windows Claude Code editor. No Dockerhost paths and no MCP secrets.
function readField(raw, key) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] || '';
  const line = front.split(/\r?\n/).find(x => x.startsWith(key + ':'));
  return line ? line.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, '') : '';
}
function writeField(raw, key, value) {
  if (!/^---\r?\n/.test(raw) || !/^---\r?\n[\s\S]*?\r?\n---/.test(raw)) throw Error('Invalid frontmatter');
  const lines = raw.split(/\r?\n/);
  const end = lines.indexOf('---', 1);
  if (end < 2) throw Error('Invalid frontmatter');
  const entry = lines.findIndex((line, index) => index > 0 && index < end && line.startsWith(key + ':'));
  // JSON double-quoted scalar is valid YAML and preserves punctuation safely.
  const encoded = value ? `${key}: ${JSON.stringify(value)}` : '';
  if (entry > 0) {if (encoded) lines[entry] = encoded; else lines.splice(entry, 1);}
  else if (encoded) lines.splice(end, 0, encoded);
  return lines.join('\n');
}
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export async function mountClaudeAgentsControl(host, api) {
  host.innerHTML = `<div class="page-head"><h1>Agents Control</h1><p class="muted">Native Claude Code agents and MCP registrations</p></div>
    <section class="block"><h2>Agents</h2><p class="muted small">Edits apply to installed Singularity agent definitions. Other agents are never overwritten.</p>
    <label class="ac-field" for="claude-agent-filter">Search installed agents</label>
    <input id="claude-agent-filter" type="search" class="input" placeholder="Agent, model or description" style="width:100%;max-width:480px;margin:8px 0 12px" autocomplete="off">
    <div id="claude-agent-summary" class="muted small" role="status"></div>
    <div id="claude-agent-rows">Loading installed agents…</div></section>
    <section class="block" id="claude-agent-editor" hidden><h2 id="claude-agent-title">Agent</h2>
    <p class="muted small">Raw Claude Code Markdown. Changes take effect on a subsequent delegation or session, not retroactively.</p>
    <div class="ac-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:12px 0">
      <label>Model <span style="display:flex;gap:6px"><input id="claude-agent-model" class="input" placeholder="Inherit session model" style="width:100%"><button type="button" class="btn small" id="claude-model-pick">Choose</button></span></label>
      <label>Reasoning effort <select id="claude-agent-effort" class="select" style="width:100%"><option value="">Inherit</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="max">Max, if supported</option></select></label>
      <label>Tools <input id="claude-agent-tools" class="input" placeholder="Read, Grep, Glob" style="width:100%"></label>
      <label>Permissions <select id="claude-agent-permissionMode" class="select" style="width:100%"><option value="">Not set (Claude default)</option><option value="default">default</option><option value="plan">plan (read-only planning)</option><option value="acceptEdits">acceptEdits</option><option value="dontAsk">dontAsk</option></select></label>
    </div>
    <p class="muted small">Only non-escalating permission modes are accepted here; bypassPermissions and auto are refused rather than silently dropped.</p>
    <label>Description <input id="claude-agent-description" class="input" style="width:100%"></label>
    <p class="muted small">Model choices are configured aliases and values already used by installed agents, not an online provider catalogue. Claude Code validates support at runtime.</p>
    <textarea id="claude-agent-content" rows="20" spellcheck="false" style="width:100%;font-family:monospace" aria-label="Claude Code agent definition"></textarea>
    <div style="display:flex;gap:10px;align-items:center;margin-top:12px;flex-wrap:wrap"><button type="button" class="btn" id="claude-agent-save">Save agent</button>
    <span id="claude-agent-message" role="status" aria-live="polite"></span></div>
    <details style="margin-top:16px"><summary>Recent local backups</summary><p class="muted small">Restoring writes the selected revision back through the same validated save path and keeps the current definition as a backup. The next delegation is not verified from here.</p><div id="claude-agent-backups"></div></details></section>
    <dialog id="claude-model-dialog" style="border:1px solid var(--border, #888);border-radius:12px;max-width:min(94vw,500px);width:100%;padding:18px;background:var(--surface,#222);color:inherit">
      <h3>Choose Claude Code model</h3><input type="search" class="input" id="claude-model-search" placeholder="Filter models" style="width:100%;margin:8px 0">
      <div id="claude-model-options" style="max-height:55vh;overflow:auto;display:grid;gap:6px"></div>
      <button class="btn" type="button" id="claude-model-close" style="margin-top:12px">Cancel</button>
    </dialog>
    <section class="block"><h2>Rules and hooks</h2><p class="muted small">Installed configuration inventory only. Presence does not prove a rule or hook ran. No rule or hook commands are exposed.</p><div id="claude-policy-rows">Loading…</div></section>
    <section class="block"><h2>MCP integrations</h2><p class="muted small">Configured entries only. Connection health, tools and credentials require independent local verification. Secrets are never displayed.</p>
    <div id="claude-mcp-rows">Loading MCP configuration…</div></section>`;
  const rows = host.querySelector('#claude-agent-rows');
  const mcps = host.querySelector('#claude-mcp-rows');
  const editor = host.querySelector('#claude-agent-editor');
  const content = host.querySelector('#claude-agent-content');
  const message = host.querySelector('#claude-agent-message');
  const filter = host.querySelector('#claude-agent-filter');
  const summary = host.querySelector('#claude-agent-summary');
  const backups = host.querySelector('#claude-agent-backups');
  const dialog = host.querySelector('#claude-model-dialog');
  const fields = Object.fromEntries(['model','effort','tools','description','permissionMode'].map(k => [k, host.querySelector('#claude-agent-' + k)]));
  const updateFields = () => {for (const [key,node] of Object.entries(fields)) node.value = readField(content.value, key);};
  for (const [key,node] of Object.entries(fields)) node.addEventListener('change', () => {
    try {content.value = writeField(content.value, key, node.value.trim());message.textContent = '';}
    catch(e) {message.textContent = e.message;}
  });
  content.addEventListener('input', updateFields);
  let current = null;
  const renderBackups = (items) => {
    const list = Array.isArray(items) ? items : [];
    backups.innerHTML = list.length ? `<ul>${list.map(b => `<li><code>${escape((b.revisionPrefix || '').slice(0, 12))}</code> · ${escape(b.savedAt || '')} · ${Number(b.bytes) || 0} bytes <button class="btn small" type="button" data-restore-agent="${escape(b.revisionPrefix || '')}">Restore</button></li>`).join('')}</ul>` : '<p class="muted small">No previous edits saved by this dashboard.</p>';
    backups.querySelectorAll('[data-restore-agent]').forEach(button => button.addEventListener('click', async () => {
      if (!current) return;
      const prefix = button.dataset.restoreAgent;
      if (typeof confirm === 'function' && !confirm(`Restore ${current.name} from backup ${prefix}? The current definition is kept as a backup first.`)) return;
      message.textContent = 'Restoring…';
      try {
        const result = await api('/api/claude/agents/restore',{method:'POST',body:{name:current.name,backup:prefix,revision:current.revision,confirm:true}});
        const detail = await api('/api/claude/agents/detail?name=' + encodeURIComponent(current.name));
        current = detail;
        content.value = detail.content;
        renderBackups(detail.backups);
        updateFields();
        message.textContent = result.restored ? 'Restored. Verify a new Claude Code delegation to confirm loading.' : 'No changes.';
      } catch(e) { message.textContent = 'Not restored: ' + e.message; }
    }));
  };
  const agents = await api('/api/claude/agents');
  const knownModels = [...new Set(['', 'sonnet', 'opus', 'haiku', ...(agents.agents || []).map(a => a.model).filter(Boolean)])];
  const modelSearch = host.querySelector('#claude-model-search');
  const modelOptions = host.querySelector('#claude-model-options');
  const showModelOptions = () => {
    const q = modelSearch.value.toLowerCase().trim();
    const options = knownModels.filter(m => !q || (m || 'inherit').toLowerCase().includes(q));
    modelOptions.innerHTML = options.map(m => `<button class="btn" type="button" data-model="${escape(m)}" style="text-align:left;max-width:100%">${escape(m || 'Inherit session model')}</button>`).join('') || '<p>No configured model matches. Enter a model directly in the editor.</p>';
  };
  host.querySelector('#claude-model-pick').addEventListener('click', () => {
    if (!current) return;
    modelSearch.value = '';
    showModelOptions();
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else { message.textContent = 'Enter a model directly in the editor.'; }
  });
  host.querySelector('#claude-model-close').addEventListener('click', () => dialog.close());
  modelSearch.addEventListener('input', showModelOptions);
  modelOptions.addEventListener('click', (event) => {
    const choice = event.target.closest('[data-model]');
    if (!choice || !current) return;
    fields.model.value = choice.dataset.model;
    try { content.value = writeField(content.value, 'model', choice.dataset.model); message.textContent = ''; dialog.close(); }
    catch (e) {message.textContent = e.message;}
  });
  if (!rows.isConnected) return;
  rows.innerHTML = agents.available ? `<div class="table-wrap"><table class="data"><thead><tr><th>Agent</th><th>Description</th><th>Model</th><th>Action</th></tr></thead><tbody>${agents.agents.map(a=>
    `<tr data-agent-search="${escape([a.name, a.description, a.model].filter(Boolean).join(' ').toLowerCase())}"><td class="mono">${escape(a.name)}</td><td>${escape(a.description || (a.managed ? 'Definition unavailable' : 'User managed'))}</td><td>${escape(a.model || 'Inherited')}</td><td>${a.editable ? `<button class="btn small" data-edit-agent="${escape(a.name)}">Edit</button>` : 'External or unavailable'}</td></tr>`).join('')}</tbody></table></div>` : `<p class="muted">${escape(agents.reason)}</p>`;
  const visibleAgents = () => {
    const q = filter.value.trim().toLowerCase();
    let shown = 0;
    rows.querySelectorAll('[data-agent-search]').forEach(row => {
      const visible = !q || row.dataset.agentSearch.includes(q);
      row.hidden = !visible;
      if (visible) shown++;
    });
    summary.textContent = agents.available ? `${shown} of ${(agents.agents || []).length} installed agent(s) shown` : 'Agents unavailable';
  };
  filter.addEventListener('input', visibleAgents);
  visibleAgents();
  rows.querySelectorAll('[data-edit-agent]').forEach(button => button.addEventListener('click', async () => {
    message.textContent = '';
    try {
      const a = await api('/api/claude/agents/detail?name=' + encodeURIComponent(button.dataset.editAgent));
      if (!editor.isConnected) return;
      current = a;
      content.value = a.content;
      renderBackups(a.backups);
      updateFields();
      host.querySelector('#claude-agent-title').textContent = a.name;
      editor.hidden = false;
      editor.scrollIntoView({behavior:'smooth',block:'start'});
    } catch(e) { message.textContent = e.message; editor.hidden = false; }
  }));
  host.querySelector('#claude-agent-save').addEventListener('click', async () => {
    if (!current) return;
    message.textContent = 'Saving…';
    try {
      const result = await api('/api/claude/agents/save',{method:'POST',body:{name:current.name,content:content.value,revision:current.revision,confirm:true}});
      current.revision = result.revision;
      current.content = content.value;
      message.textContent = result.saved ? 'Saved. Verify a new Claude Code delegation to confirm loading.' : 'No changes.';
    } catch(e) { message.textContent = 'Not saved: ' + e.message; }
  });
  const policyHost = host.querySelector('#claude-policy-rows');
  try {
    const policy = await api('/api/claude/policy');
    if (policyHost.isConnected) {
      const ruleNames = (policy.rules || []).map(r => `<li>${escape(r.scope)}: ${escape(r.name)}</li>`).join('');
      const hookEvents = (policy.hooks || []).map(h => `<li>${escape(h.scope)}: ${escape(h.event)} · ${Number(h.groups) || 0} configured group(s)</li>`).join('');
      policyHost.innerHTML = `<p>${(policy.rules || []).length} rule file(s), ${(policy.hooks || []).length} hook event registration(s). Not runtime verified.</p>
        <details><summary>Rule filenames</summary><ul>${ruleNames || '<li>None found</li>'}</ul></details>
        <details><summary>Hook events</summary><ul>${hookEvents || '<li>None found</li>'}</ul></details>`;
    }
  } catch(e) { if (policyHost.isConnected) policyHost.textContent = 'Rules and hooks inventory unavailable: ' + e.message; }
  const inv = await api('/api/claude/mcps');
  if (!mcps.isConnected) return;
  const entries = inv.servers || [];
  const required = inv.required || {};
  const requiredRows = Object.entries(required).map(([key, value]) =>
    `<tr><td>${escape(key)}</td><td>${escape(value.requirement || '')}</td><td>${escape(value.status === 'configured' ? 'configured' : value.status === 'not_verified' ? 'not verified' : 'missing')}${value.reason ? ' <span class="muted small">(' + escape(value.reason) + ')</span>' : ''}</td><td>${(value.servers || []).map(escape).join(', ') || (value.unknownWrappers || []).map(n => escape(n) + ' (unrecognised)').join(', ') || '—'}</td></tr>`).join('');
  mcps.innerHTML = `<p>${entries.length} configured MCP registration${entries.length === 1 ? '' : 's'} (connection state not tested).</p>
    <div class="table-wrap"><table class="data"><thead><tr><th>Required integration</th><th>Requirement</th><th>Configuration</th><th>Matched entries</th></tr></thead><tbody>${requiredRows || '<tr><td colspan="4">Requirement map unavailable.</td></tr>'}</tbody></table></div>
    <div class="table-wrap"><table class="data"><thead><tr><th>Server</th><th>Scope</th><th>Connection</th></tr></thead><tbody>
    ${entries.map(s=>`<tr><td>${escape(s.name)}</td><td>${escape(s.scope)}</td><td>Not tested</td></tr>`).join('') || '<tr><td colspan="3">No registrations were found in the inspected configuration files.</td></tr>'}</tbody></table></div>
    <p class="muted small">Required: RepoQL (official plugin or MCP), Kanzo, MemoryCore (RepoQL connector) and a paired local OpenMausBot. Configuration inventory does not prove tool availability.</p>`;
}
