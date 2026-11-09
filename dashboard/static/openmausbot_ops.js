// Shared OpenMausBot operations: Now, Calendar, Needs attention, Run history.
// Read-only. OpenMausBot stays the authority for bots and routines; this view
// only displays /api/openmausbot/ops, which reads OpenMausBot's own files.
// Scheduled occurrences and execution records are shown as different things,
// and missing data is never presented as healthy.
const TABS = [
  ['now', 'Now', '/openmausbot'],
  ['calendar', 'Calendar', '/openmausbot/calendar'],
  ['attention', 'Needs attention', '/openmausbot/attention'],
  ['history', 'Run history', '/openmausbot/history'],
];
const POLL_MS = 60_000;
const LOCAL_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();
const OCC = {
  scheduled: ['Scheduled', 'blue', 'Planned; the time has not arrived yet.'],
  ran: ['Run recorded', 'green', 'OpenMausBot kept a completed run record for this occurrence.'],
  failed: ['Run failed', 'red', 'OpenMausBot kept a failed run record for this occurrence.'],
  running: ['In progress', 'amber', 'A run record exists and has not finished.'],
  queued: ['Queued', 'blue', 'OpenMausBot recorded a queued run.'],
  waiting: ['Waiting', 'amber', 'OpenMausBot recorded a waiting run.'],
  cancelled: ['Cancelled', 'gray', 'OpenMausBot recorded a cancelled run.'],
  missed: ['Missed', 'red', 'OpenMausBot recorded a missed run.'],
  unknown_status: ['Unknown state', 'gray', 'The run record has an unrecognised state.'],
  no_record: ['No run record', 'amber', 'No matching record was kept. This is not proof the run was missed.'],
  unknown: ['Older than log', 'gray', 'Older than the run log OpenMausBot keeps, so it cannot be checked.'],
};
const RUNSTATE = {completed: ['Completed', 'green'], failed: ['Failed', 'red']};

// ---- time helpers (all display and window maths happen in the chosen zone) ----
function zoneParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-CA', {timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'});
  const o = {};
  for (const p of f.formatToParts(ms)) o[p.type] = p.value;
  return o;
}
function zoneOffset(ms, tz) {
  const p = zoneParts(ms, tz);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}
function dayStart(ymd, tz) {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - zoneOffset(guess, tz);
  t = guess - zoneOffset(t, tz);
  return t;
}
const ymdOf = (ms, tz) => { const p = zoneParts(ms, tz); return `${p.year}-${p.month}-${p.day}`; };
function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function weekStart(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(ymd, -((dow + 6) % 7));
}
const fmt = (ms, tz, opts) => new Intl.DateTimeFormat('en-GB', {timeZone: tz, ...opts}).format(ms);
const hm = (ms, tz) => fmt(ms, tz, {hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
const dayLabel = (ymd, tz) => fmt(dayStart(ymd, tz) + 12 * 3600_000, tz, {weekday: 'short', day: 'numeric', month: 'short'});
const dateTime = (ms, tz) => (ms ? fmt(ms, tz, {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}) : '—');
function rel(ms, now) {
  const s = Math.round((ms - now) / 1000), a = Math.abs(s);
  const t = a < 90 ? `${a}s` : a < 5400 ? `${Math.round(a / 60)} min` : a < 129600 ? `${Math.round(a / 3600)} h` : `${Math.round(a / 86400)} d`;
  return s >= 0 ? `in ${t}` : `${t} ago`;
}
function dur(a, b) {
  if (!a || !b || b < a) return '—';
  const s = Math.round((b - a) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`;
}

export async function viewOpenMausOps({app, api, pageHead, esc, current, tab = 'now', params = {}, setCleanup,
  includeGhost = true, workspaceHref = '#/openmausbot/chat'}) {
  const tzChoices = [...new Set([LOCAL_TZ, 'Pacific/Auckland', 'UTC'])];
  const ui = {
    bot: !includeGhost && params.bot === 'ghost' ? 'all' : params.bot || 'all',
    tz: tzChoices.includes(params.tz) ? params.tz : LOCAL_TZ,
    view: params.view === 'day' ? 'day' : 'week',
    date: /^\d{4}-\d{2}-\d{2}$/.test(params.date || '') ? params.date : null,
    more: 25,
  };
  let data = null, lastGood = null, loadError = null, ghostSnap = null, timer = null, busy = false;

  const baseRoute = () => (TABS.find((t) => t[0] === tab) || TABS[0])[2];
  const queryString = () => {
    const q = new URLSearchParams();
    if (ui.bot !== 'all') q.set('bot', ui.bot);
    if (ui.tz !== LOCAL_TZ) q.set('tz', ui.tz);
    if (tab === 'calendar') { if (ui.view !== 'week') q.set('view', ui.view); if (ui.date) q.set('date', ui.date); }
    const s = q.toString();
    return s ? '?' + s : '';
  };
  const tabHref = (path) => '#' + path + (ui.bot !== 'all' ? '?bot=' + encodeURIComponent(ui.bot) : '')
    + (ui.tz !== LOCAL_TZ ? (ui.bot !== 'all' ? '&' : '?') + 'tz=' + encodeURIComponent(ui.tz) : '');
  const remember = () => { try { history.replaceState(null, '', '#' + baseRoute() + queryString()); } catch { /* ignore */ } };
  if (!includeGhost && (params.bot === 'ghost' || params.tab === 'ghost')) remember();

  const botId = () => {
    if (!data) return null;
    if (ui.bot === 'all') return null;
    if (includeGhost && ui.bot === 'ghost') return data.ghost_bot_id || null;
    return ui.bot;
  };
  const bots = () => new Map((data?.bots || []).map((b) => [b.id, b]));
  const routines = () => new Map((data?.routines || []).map((r) => [r.id, r]));
  const wantBot = (id) => { const b = botId(); return !b || id === b; };
  const safeColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(c || '') ? c : 'var(--muted)');
  const botChip = (id) => {
    const b = bots().get(id);
    return `<span class="ops-bot"><i style="background:${safeColor(b?.color)}"></i>${esc(b ? b.name : id ? id.slice(0, 8) + ' (not in roster)' : 'unknown bot')}</span>`;
  };
  const pill = (tone, text, title) => `<span class="pill ${tone}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;

  // ---- window to fetch ----
  const windowFor = () => {
    const tz = ui.tz;
    if (tab === 'calendar') {
      const anchor = ui.date || ymdOf(Date.now(), tz);
      const first = ui.view === 'day' ? anchor : weekStart(anchor);
      const days = ui.view === 'day' ? 1 : 7;
      return {from: dayStart(first, tz), to: dayStart(addDays(first, days), tz), first, days};
    }
    const now = Date.now();
    return {from: now - 14 * 86400_000, to: now + 7 * 86400_000};
  };

  async function load() {
    if (busy) return;
    busy = true;
    const w = windowFor();
    try {
      const d = await api(`/api/openmausbot/ops?from=${w.from}&to=${w.to}`, {timeoutMs: 15000});
      if (!current()) return;
      if (d.error) throw new Error(d.message || d.error);
      data = lastGood = d; loadError = null;
      if (includeGhost && tab === 'now' && data.ghost_bot_id && (!botId() || botId() === data.ghost_bot_id)) {
        try {
          const g = await api('/api/ghost/status', {timeoutMs: 8000});
          ghostSnap = g && typeof g === 'object' ? g : null;
        } catch { ghostSnap = {unavailable: true}; }
      }
    } catch (error) {
      if (!current()) return;
      loadError = error.message || 'unavailable';
      data = lastGood;
    } finally { busy = false; }
    if (current()) render();
  }

  // ---- shared chrome ----
  function chrome(body) {
    const opts = (data?.bots || []).slice().sort((a, b) => a.name.localeCompare(b.name));
    const ghost = includeGhost ? data?.ghost_bot_id : null;
    const sel = ui.bot === 'ghost' && ghost ? ghost : ui.bot;
    const nav = TABS.map(([key, label, path]) =>
      `<a href="${esc(tabHref(path))}" ${key === tab ? 'aria-current="page"' : ''}>${esc(label)}${key === 'attention' && data ? attentionBadge() : ''}</a>`).join('');
    return `<header class="omb-ops-head"><div class="omb-ops-title"><h1>OpenMausBot operations</h1><p class="muted">What is running, scheduled, needs you, and ran.</p></div>`
      + `<a class="omb-open-btn" href="${esc(workspaceHref)}" aria-label="Open OpenMausBots: chat with your bots and manage routines"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="4" y="7" width="16" height="13" rx="4"/><circle cx="9" cy="13.5" r="1.2" fill="currentColor"/><circle cx="15" cy="13.5" r="1.2" fill="currentColor"/><path d="M12 7V4.5"/></svg><span>Open</span></a></header>`
      + `<nav class="ops-tabs" aria-label="Operations views">${nav}</nav>
      <div class="ops-toolbar">
        <label>Bot <select id="ops-bot" aria-label="Filter by bot">
          <option value="all">All bots (${opts.length})</option>
          ${opts.map((b) => `<option value="${esc(b.id)}" ${b.id === sel ? 'selected' : ''}>${esc(b.name)}${b.id === ghost ? ' ★' : ''}</option>`).join('')}
        </select></label>
        <label>Timezone <select id="ops-tz" aria-label="Display timezone">
          ${tzChoices.map((z) => `<option ${z === ui.tz ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select></label>
        <button class="btn small" id="ops-refresh" type="button">Refresh</button>
        <span class="muted small" id="ops-age">${data ? 'Updated ' + esc(fmt(data.generated_at, ui.tz, {hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'})) : ''}</span>
      </div>` + sourceBanner() + body + `<p class="omb-ops-foot muted small"><a href="#/openmausbot/fleet">Bot fleet status</a> · also under Diagnostics</p>`;
  }
  function attentionBadge() {
    const n = (data.attention || []).filter((a) => wantBot(a.bot_id)).length;
    return n ? ` <span class="ops-count">${n}</span>` : '';
  }
  function sourceBanner() {
    const out = [];
    if (loadError) out.push(`<div class="ops-note red" role="alert"><strong>Could not refresh.</strong> ${esc(loadError)}${lastGood ? ` Showing the last good data from ${esc(dateTime(lastGood.generated_at, ui.tz))}; it may be out of date.` : ' Nothing below is verified.'}</div>`);
    if (data) {
      for (const s of Object.values(data.sources || {})) {
        if (s.state !== 'ok') out.push(`<div class="ops-note red" role="alert"><strong>${esc(s.label)} is unavailable.</strong> Nothing derived from it is shown as healthy.</div>`);
        else if (s.stale) out.push(`<div class="ops-note amber"><strong>${esc(s.label)} looks stale</strong> — not rewritten for ${Math.round(s.age_seconds / 60)} min.</div>`);
      }
      if (includeGhost && ui.bot === 'ghost' && !data.ghost_bot_id) out.push('<div class="ops-note amber">Ghost\'s native bot id could not be read, so all bots are shown.</div>');
    }
    return out.join('');
  }
  const emptyState = (title, text) => `<div class="ops-empty"><strong>${esc(title)}</strong><span>${esc(text)}</span></div>`;

  // ---- Now ----
  function viewNow() {
    const now = Date.now(), rmap = routines(), tz = ui.tz;
    const running = (data.now.running || []).filter((r) => wantBot(r.bot_id));
    const up = (data.now.upcoming || []).filter((u) => wantBot(u.bot_id)).slice(0, 10);
    const mine = (data.routines || []).filter((r) => wantBot(r.bot_id));
    const enabled = mine.filter((r) => r.enabled).length;
    const recent = (data.runs || []).filter((r) => wantBot(r.bot_id)).slice(0, 5);
    const ghostId = includeGhost ? data.ghost_bot_id : null;
    const showGhost = ghostId && (!botId() || botId() === ghostId);
    const runRow = (r) => `<li class="ops-row run">${botChip(r.bot_id)}<span class="ops-rel">${esc(rel(r.started_at || r.created_at, now))}</span>
      <span class="ops-main">${esc(r.routine_name || 'Run')}</span><span class="ops-sub">Started ${esc(dateTime(r.started_at || r.created_at, tz))} · ${esc(r.trigger)}</span></li>`;
    const upRow = (u) => { const r = rmap.get(u.routine_id); return `<li class="ops-row up">${botChip(u.bot_id)}<span class="ops-rel">${esc(rel(u.at, now))}</span>
      <span class="ops-main">${esc(r?.name || u.routine_id)}</span><span class="ops-sub"><time datetime="${new Date(u.at).toISOString()}">${esc(dateTime(u.at, tz))}</time></span></li>`; };
    const recRow = (r) => `<li class="ops-row rec">${botChip(r.bot_id)}<span class="ops-rel">${pill((RUNSTATE[r.status] || [])[1] || 'amber', (RUNSTATE[r.status] || [r.status || 'Unknown'])[0])}</span>
      <span class="ops-main">${esc(r.routine_name || 'Run')}</span><span class="ops-sub">${esc(dateTime(r.started_at || r.created_at, tz))}</span></li>`;
    let ghost = '';
    if (showGhost) {
      let line;
      if (!ghostSnap || ghostSnap.unavailable) line = pill('amber', 'Unavailable') + ' <span class="muted small">Ghost\'s runner snapshot could not be read. This says nothing about whether his jobs ran.</span>';
      else {
        const age = Date.now() - (ghostSnap.generatedAt || 0);
        const stale = ghostSnap.collector !== 'ok' || !Number.isFinite(age) || age > 120000;
        const active = (ghostSnap.runs || []).length;
        line = (stale ? pill('amber', 'Stale') : pill(active ? 'blue' : 'green', active ? `${active} active` : 'Idle'))
          + ` <span class="muted small">Ghost runner snapshot · a separate source from the routine record${stale ? ' · not fresh, treat as unknown' : ''}</span>`;
      }
      ghost = `<section class="ops-card"><h2>Ghost's downstream runner</h2><p class="ops-line">${line}</p>
        <p class="muted small">Ghost's routines only <em>start</em> a job and read it back. A completed routine run means the dispatch turn finished, not that the job did.</p></section>`;
    }
    return `<div class="ops-grid">
      <section class="ops-card"><h2>Running now</h2>${running.length ? `<ul class="ops-list">${running.map(runRow).join('')}</ul>` : emptyState('Nothing in progress', 'OpenMausBot has no unfinished run record' + (botId() ? ' for this bot.' : '.'))}</section>
      <section class="ops-card"><h2>Coming up</h2>${up.length ? `<ul class="ops-list">${up.map(upRow).join('')}</ul>` : emptyState('Nothing scheduled', 'No enabled routine has a future run time' + (botId() ? ' for this bot.' : '.'))}</section>
      ${ghost}
      <section class="ops-card"><h2>Latest runs</h2>${recent.length ? `<ul class="ops-list">${recent.map(recRow).join('')}</ul>
        <p><a href="${esc(tabHref('/openmausbot/history'))}">All run history →</a></p>` : emptyState('No runs kept', 'OpenMausBot has no run records for this selection.')}</section>
      <section class="ops-card"><h2>Routines</h2><p class="ops-big">${enabled}<span class="muted small"> enabled of ${mine.length}</span></p>
        <p class="muted small">Blocked or queued work and pending approvals are not reported by OpenMausBot's files, so they are not shown here rather than shown as zero.</p>
        <p><a href="${esc(tabHref('/openmausbot/calendar'))}">Open the calendar →</a></p></section>
    </div>`;
  }

  // ---- Calendar ----
  function viewCalendar() {
    const w = windowFor(), tz = ui.tz, now = Date.now(), rmap = routines();
    const days = [];
    for (let i = 0; i < w.days; i++) days.push(addDays(w.first, i));
    const today = ymdOf(now, tz);
    const byDay = new Map(days.map((d) => [d, []]));
    for (const o of data.occurrences || []) {
      if (!wantBot(o.bot_id)) continue;
      const k = ymdOf(o.at, tz);
      if (byDay.has(k)) byDay.get(k).push(o);
    }
    const col = days.map((d) => {
      const list = byDay.get(d);
      const items = list.length ? list.map((o) => {
        const r = rmap.get(o.routine_id), st = OCC[o.state] || OCC.unknown;
        return `<li class="ops-occ ${st[1]}"><time datetime="${new Date(o.at).toISOString()}">${esc(hm(o.at, tz))}</time>
          <span class="ops-main">${esc(r?.name || 'Routine')}</span>${botChip(o.bot_id)}${pill(st[1], st[0], st[2])}</li>`;
      }).join('') : '<li class="ops-none">Nothing scheduled</li>';
      return `<section class="ops-day${d === today ? ' today' : ''}" aria-label="${esc(dayLabel(d, tz))}"><h3>${esc(dayLabel(d, tz))}${d === today ? ' <span class="ops-count">today</span>' : ''}</h3><ul>${items}</ul></section>`;
    }).join('');
    const tzs = new Set((data.routines || []).filter((r) => r.enabled && wantBot(r.bot_id)).map((r) => r.timezone).filter(Boolean));
    const off = (data.routines || []).filter((r) => !r.enabled && wantBot(r.bot_id));
    const shift = ui.view === 'day' ? 1 : 7;
    const title = ui.view === 'day' ? dayLabel(w.first, tz) : `${dayLabel(w.first, tz)} – ${dayLabel(days[days.length - 1], tz)}`;
    return `<div class="ops-calbar">
        <div class="ops-seg" role="group" aria-label="Range">
          <button type="button" data-view="day" aria-pressed="${ui.view === 'day'}">Day</button>
          <button type="button" data-view="week" aria-pressed="${ui.view === 'week'}">Week</button></div>
        <button type="button" class="btn small" data-shift="-${shift}" aria-label="Previous ${ui.view}">←</button>
        <strong class="ops-range">${esc(title)}</strong>
        <button type="button" class="btn small" data-shift="${shift}" aria-label="Next ${ui.view}">→</button>
        <button type="button" class="btn small" data-today="1">Today</button></div>
      <p class="muted small">Times shown in <strong>${esc(tz)}</strong>${tzs.size ? '; routines are scheduled in ' + esc([...tzs].join(', ')) : ''}.
        Each entry is a <em>scheduled occurrence</em>; its badge shows whether OpenMausBot kept a matching <em>run record</em>.</p>
      ${data.occurrences_truncated ? '<div class="ops-note amber">Too many occurrences to list; showing the earliest.</div>' : ''}
      <div class="ops-week ${ui.view}">${col}</div>
      ${off.length ? `<details class="ops-card"><summary>${off.length} disabled routine${off.length === 1 ? '' : 's'} (not on the calendar)</summary>
        <ul class="ops-list">${off.map((r) => `<li>${botChip(r.bot_id)}<span class="ops-main">${esc(r.name)}</span><span class="muted small">${esc(r.cron || r.schedule_type || '')}</span></li>`).join('')}</ul></details>` : ''}`;
  }

  // ---- Needs attention ----
  function viewAttention() {
    const tz = ui.tz;
    const list = (data.attention || []).filter((a) => wantBot(a.bot_id));
    const labels = {failed_run: 'Failed run', overdue_next_run: 'Schedule not advancing', orphan_routine: 'Orphan routine',
      schedule_unreadable: 'Unreadable schedule', stale_source: 'Stale data'};
    const body = list.length ? `<ul class="ops-attn">${list.map((a) => `<li class="${a.kind === 'stale_source' ? 'amber' : a.kind === 'failed_run' ? 'red' : 'amber'}">
        <div>${pill(a.kind === 'failed_run' ? 'red' : 'amber', labels[a.kind] || a.kind)} ${a.bot_id ? botChip(a.bot_id) : ''}</div>
        <p class="ops-main">${esc(a.text)}</p>
        <span class="muted small">${a.at ? esc(dateTime(a.at, tz)) + ' · ' : ''}source: ${esc(a.source)}</span></li>`).join('')}</ul>`
      : emptyState('No confirmed problems', 'Nothing in the data OpenMausBot kept is failed or inconsistent' + (botId() ? ' for this bot.' : '.'));
    return `${body}
      <div class="ops-note"><strong>What this cannot see.</strong> Pending approvals and blocked or queued work are not reported by OpenMausBot's files. A missed run is only flagged when it is certain; a gap in the run log or an outage is never counted as one.</div>`;
  }

  // ---- Run history ----
  function viewHistory() {
    const tz = ui.tz, rmap = routines();
    const all = (data.runs || []).filter((r) => wantBot(r.bot_id));
    const shown = all.slice(0, ui.more);
    const rows = shown.map((r) => {
      const st = RUNSTATE[r.status] || [r.status || 'Unknown', 'amber'];
      const rn = rmap.get(r.routine_id);
      return `<tr><td data-l="When"><time>${esc(dateTime(r.started_at || r.created_at, tz))}</time></td>
        <td data-l="Bot">${botChip(r.bot_id)}</td>
        <td data-l="Routine" class="ops-main">${esc(r.routine_name || rn?.name || 'Run')}</td>
        <td data-l="Trigger">${esc(r.trigger)}${r.manual ? ' (manual)' : ''}</td>
        <td data-l="Result">${pill(st[1], st[0])}${r.outcome ? ` <span class="muted small">${esc(r.outcome)}</span>` : ''}</td>
        <td data-l="Took">${esc(dur(r.started_at, r.finished_at))}</td>
        <td data-l="Output">${r.thread_id ? `<a href="#/openmausbot/chat" title="Thread ${esc(r.thread_id)}">Open in OpenMausBot</a>` : '<span class="muted small">—</span>'}</td></tr>`;
    }).join('');
    const h = data.history || {};
    return `${all.length ? `<div class="ops-tablewrap"><table class="ops-table"><thead><tr>
        <th>When</th><th>Bot</th><th>Routine</th><th>Trigger</th><th>Result</th><th>Took</th><th>Output</th></tr></thead><tbody>${rows}</tbody></table></div>
        ${all.length > shown.length ? `<p><button class="btn small" id="ops-more" type="button">Show more (${all.length - shown.length} left)</button></p>` : ''}`
      : emptyState('No runs kept', 'OpenMausBot has no run records for this selection.')}
      <p class="muted small">${esc(h.note || '')} ${h.kept_runs != null ? `${h.kept_runs} runs kept${h.oldest_kept_at ? ', oldest ' + esc(dateTime(h.oldest_kept_at, tz)) : ''}.` : ''}
      “Completed” is the routine turn only; a job that routine started has its own result.</p>`;
  }

  function render() {
    if (!current()) return;
    const prevFocus = document.activeElement?.id;
    let body;
    if (!data) body = loadError ? '' : '<div class="loading" role="status">Loading operations…</div>';
    else if (data.sources.routines.state !== 'ok') body = emptyState('Routine data unavailable', 'Calendar, history and attention cannot be shown until OpenMausBot\'s routine file is readable again.');
    else body = tab === 'calendar' ? viewCalendar() : tab === 'attention' ? viewAttention() : tab === 'history' ? viewHistory() : viewNow();
    app.innerHTML = `<div class="ops" data-tab="${esc(tab)}">${chrome(body)}</div>`;
    bind();
    if (prevFocus) app.querySelector('#' + CSS.escape(prevFocus))?.focus({preventScroll: true});
  }

  function bind() {
    const q = (s) => app.querySelector(s);
    q('#ops-bot')?.addEventListener('change', (e) => { ui.bot = e.target.value; remember(); render(); });
    q('#ops-tz')?.addEventListener('change', (e) => { ui.tz = e.target.value; remember(); tab === 'calendar' ? load() : render(); });
    q('#ops-refresh')?.addEventListener('click', () => load());
    q('#ops-more')?.addEventListener('click', () => { ui.more += 25; render(); });
    app.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => { ui.view = b.dataset.view; remember(); load(); }));
    app.querySelectorAll('[data-shift]').forEach((b) => b.addEventListener('click', () => {
      const w = windowFor();
      ui.date = addDays(ui.date || ymdOf(Date.now(), ui.tz), Number(b.dataset.shift)); void w; remember(); load();
    }));
    q('[data-today]')?.addEventListener('click', () => { ui.date = null; remember(); load(); });
  }

  // ---- polling: bounded, paused when hidden, stopped on route change ----
  const tick = () => { if (!document.hidden && current()) load(); };
  timer = setInterval(tick, POLL_MS);
  const onVis = () => { if (!document.hidden && data && Date.now() - data.generated_at > POLL_MS) load(); };
  document.addEventListener('visibilitychange', onVis);
  setCleanup?.(() => { clearInterval(timer); document.removeEventListener('visibilitychange', onVis); });

  app.innerHTML = `<div class="ops">${pageHead('OpenMausBot operations', 'Loading…')}<div class="loading" role="status">Loading operations…</div></div>`;
  await load();
}
