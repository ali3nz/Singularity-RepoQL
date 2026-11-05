// Ghost's real telemetry and schedule controls, mounted directly within RepoQL.
// The same hub also powers Ghost's optional standalone HTML page.
import {ghostFetch} from './api.js';
import {mountGhostTasks} from './tasks.js';
import {dayKeyInZone, weekDays, occurrencesForDay} from './schedule_model.mjs';

export function mountGhost(root) {
  let disposed = false;
  let pollTimer = null;
  let latest = null;
  let displayed = null;
  let paused = false;
  let filter = 'all';
  let networkError = false;
  let page = 0;
  const pageSize = 6;
  let activitySignature = '';
  let activityRun = null;
  let calendarSelectedDay = null;
  let calendarWeekOffset = 0;
  let calendarSignature = '';
  let draftPlans = [];
  let draftPlansFresh = false;
  let lastStale = true;

  const $ = id => root.querySelector(`#${id}`);
  const text = (id, value) => { const node = $(id); if (node) node.textContent = value; };
  const pageHost = root.host ? root.host : document.documentElement;

  function applyTheme(theme) {
    const safe = theme === 'neon' ? 'neon' : 'classic';
    pageHost.dataset.theme = safe;
    if ($('theme-picker')) $('theme-picker').value = safe;
    return safe;
  }
  try { applyTheme(localStorage.getItem('ghost-theme')); } catch { applyTheme('classic'); }
  if ($('theme-picker')) {
    $('theme-picker').onchange = () => {
      const theme = applyTheme($('theme-picker').value);
      try { localStorage.setItem('ghost-theme', theme); } catch {}
    };
  }

  // Work identity text is shown in the hero. A compact summary elsewhere is optional.
  for (const [id, cls] of [['work-title', 'work-identity'], ['work-detail', 'work-detail']]) {
    if (!$(id)) {
      const p = document.createElement('p');
      p.id = id;
      p.className = cls;
      root.querySelector('.hero .model').before(p);
    }
  }

  const ago = ms => {
    if (ms == null || !Number.isFinite(ms)) return 'Not observed';
    let s = Math.max(0, Math.floor(ms / 1000));
    return s < 60 ? `${s}s ago`
      : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s ago`
      : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
  };
  const duration = ms => {
    let s = Math.max(0, Math.floor(ms / 1000));
    return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map(x => String(x).padStart(2, '0')).join(':');
  };
  const fmtWhen = ms => ms ? `${new Date(ms).toLocaleTimeString('en-GB', {timeZone: 'Pacific/Auckland', hour: '2-digit', minute: '2-digit', hour12: false})} NZ` : '—';
  const fmtDay = iso => {
    const d = iso ? new Date(`${iso}T00:00:00`) : null;
    return d && !isNaN(d) ? d.toLocaleDateString('en-US', {weekday: 'short', day: '2-digit', month: 'short'}) : String(iso);
  };

  const descriptions = {
    working: ['Working', 'ACTIVE', 'An attributed Ghost model run is alive. Progress below reflects real model-call advancement, not connection heartbeats.'],
    retrying: ['Rate-limit retry', 'RETRYING', 'Ghost is still running. The provider recently rate-limited a request; Ghost is retrying the same model.'],
    waiting: ['Awaiting inference', 'PENDING', 'A native conversation has an unanswered turn, but no attributed model process was observed in this snapshot. This does not prove a stall.'],
    idle: ['Standing by', 'IDLE', 'The observed native conversations are settled and no attributed Ghost model run is active.'],
    unknown: ['Telemetry unavailable', 'UNVERIFIED', 'Fresh, complete telemetry is unavailable. Previous events are historical, not proof of current activity.'],
  };

  function renderWorkIdentity(data, stale) {
    const run = (data.runs || [])[0];
    const pending = (data.sessions || []).find(s => s.state === 'pending');
    const recent = (data.sessions || [])[0];
    const owner = run?.owner;
    let title = '';
    let detail = '';

    if (stale) {
      title = 'Work identity unavailable';
      detail = 'Waiting for fresh telemetry.';
    } else if (run && owner?.title) {
      title = `${owner.kind === 'schedule' ? 'Scheduled job' : owner.kind === 'conversation' ? 'Conversation' : owner.kind === 'transport' ? 'Backend' : 'Task'} · ${owner.title}`;
      detail = owner.source || 'Attributed task metadata';
    } else if (run) {
      const waiting = (data.sessions || []).filter(s => s.state === 'pending');
      title = waiting.length
        ? `Active native ${waiting.length === 1 ? 'conversation' : 'conversations'} · ${waiting.map(s => s.title || 'Untitled conversation').join(' / ')}`
        : 'Background work · origin not yet attributed';
      detail = waiting.length
        ? 'Native chats are active; the backend run has not been causally linked to a specific chat.'
        : 'No matching native conversation or scheduled-job identity has been verified.';
    } else if (pending) {
      title = `Conversation · ${pending.title || 'Untitled conversation'}`;
      detail = 'Native conversation has an unanswered turn. Provider inference has not been verified in this snapshot.';
    } else {
      title = recent ? `Last conversation · ${recent.title || 'Untitled conversation'}` : 'No active work observed';
      detail = 'No active conversation or attributed background inference in this snapshot.';
    }

    text('work-title', title);
    text('work-detail', detail);
    text('work-title-summary', title);
    text('work-detail-summary', detail);
  }

  const names = {
    request: ['INFERENCE', 'Model request started', 'Observed provider call; not a completed task.'],
    rate_limit: ['HTTP 429', 'Provider rate limit · retry scheduled', 'Same model retained; no automatic fallback.'],
    recovered: ['RECOVERED', 'Provider request recovered', 'A previously retried request succeeded.'],
    timeout: ['TIMEOUT', 'Explicit provider timeout', 'Reported by provider retry telemetry, not inferred from duration.'],
    connection_failure: ['NETWORK', 'Provider connection failure', 'Explicit retry classification.'],
    provider_error: ['PROVIDER', 'Provider error', 'Explicit retry classification.'],
    exhausted: ['FAILED', 'Provider retry policy exhausted', 'Request-level failure; whole-turn outcome may differ.'],
  };

  function renderMemory(memory, stale) {
    const box = $('memory-stats');
    if (!box) return;
    box.replaceChildren();
    if (!memory || stale) {
      box.textContent = 'Memory metadata unavailable or stale.';
      return;
    }
    for (const group of memory.groups || []) {
      const row = document.createElement('div');
      row.className = 'drow';
      const label = document.createElement('span');
      label.textContent = group.label;
      const value = document.createElement('strong');
      value.textContent = group.state === 'unavailable'
        ? 'Unavailable'
        : `${group.state === 'partial' ? 'At least ' : ''}${Number(group.files).toLocaleString()} files · ${(group.bytes / 1048576).toFixed(2)} MiB`;
      row.append(label, value);
      box.append(row);
    }
    text('memory-note', `Stored file metadata · observed ${new Date(memory.observedAt).toLocaleString()}. Counts include archives and are not context tokens, recall quality, or unique facts.`);
  }

  function renderCalendar(data, stale) {
    const cal = data.calendar;
    const chip = $('calendar-state');
    const banner = $('calendar-banner');
    const week = $('calendar-week');
    const box = $('calendar-entries');
    const ST = {
      completed: ['RAN · OK', 'Completed — verified'],
      failed: ['FAILED', 'Failed on this date'],
      missed: ['NOT RUN', 'Missed — lock held'],
      running: ['RUNNING', 'Running now'],
      upcoming: ['UPCOMING', 'Not started yet'],
      unknown: ['UNVERIFIED', 'Outcome not verified'],
    };
    const today = dayKeyInZone();
    const days = weekDays(today, calendarWeekOffset);
    if (!calendarSelectedDay || !days.includes(calendarSelectedDay)) calendarSelectedDay = days.includes(today) ? today : days[0];
    const realEntries = cal && Array.isArray(cal.entries) ? cal.entries : [];
    const dayReal = day => realEntries.filter(e => e.nzDate === day).slice().sort((a, b) => (a.startMs || 0) - (b.startMs || 0));
    const dayDraft = day => occurrencesForDay(draftPlans, day);
    const signature = JSON.stringify([cal?.observedAt, cal?.ok, cal?.truncated, realEntries, stale, today, days[0], calendarSelectedDay, draftPlans, draftPlansFresh]);
    if (signature === calendarSignature) return;
    calendarSignature = signature;
    const agenda = dayReal(calendarSelectedDay);
    const drafts = dayDraft(calendarSelectedDay);
    const count = {};
    for (const item of agenda) count[item.outcome] = (count[item.outcome] || 0) + 1;

    text('calendar-summary', `${agenda.length} observed scheduled · ${drafts.length} planning draft${drafts.length === 1 ? '' : 's'} · ${fmtDay(calendarSelectedDay)}`);
    text('calendar-week-label', `${fmtDay(days[0])} – ${fmtDay(days[6])}`);
    if (chip) {
      chip.textContent = !cal ? 'SCHEDULE UNAVAILABLE' : stale ? 'HISTORICAL · OBSERVER STALE'
        : cal.ok ? (cal.source === 'live' ? 'LIVE' : `CACHED ${fmtWhen(cal.observedAt)}`) : 'STALE · READ FAILED';
      if (cal?.truncated) chip.textContent += ' · TRUNCATED';
      chip.className = `control-chip${!cal || !cal.ok ? ' red' : stale || cal.source !== 'live' ? ' amber' : ''}`;
    }

    if (banner) {
      const fails = (count.failed || 0) + (count.missed || 0);
      banner.hidden = fails === 0;
      banner.replaceChildren();
      if (fails) {
        const strong = document.createElement('strong'); strong.textContent = String(fails);
        const label = document.createElement('span'); label.textContent = `${count.failed || 0} failed · ${count.missed || 0} missed on ${fmtDay(calendarSelectedDay)}`;
        banner.append(strong, label);
      }
    }

    if (week) {
      week.replaceChildren();
      for (const day of days) {
        const events = dayReal(day);
        const plans = dayDraft(day);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `week-day${day === calendarSelectedDay ? ' active' : ''}`;
        button.setAttribute('aria-pressed', String(day === calendarSelectedDay));
        button.onclick = () => { calendarSelectedDay = day; calendarSignature = ''; renderCalendar(data, stale); };
        const top = document.createElement('div'); top.className = 'wk-top';
        const left = document.createElement('div');
        const title = document.createElement('b'); title.textContent = fmtDay(day).split(',')[0];
        const sub = document.createElement('small'); sub.textContent = day === today ? 'Today' : day;
        left.append(title, sub);
        const counter = document.createElement('span'); counter.className = 'count';
        counter.textContent = `${events.length} live · ${plans.length} draft`;
        top.append(left, counter);
        const hint = document.createElement('small');
        hint.textContent = events[0]?.title || plans[0]?.title || 'Nothing planned';
        button.append(top, hint);
        week.append(button);
      }
    }

    if (box) {
      box.replaceChildren();
      if (!agenda.length && !drafts.length) {
        const empty = document.createElement('div'); empty.className = 'empty';
        empty.textContent = !cal ? 'The live schedule is unavailable; no drafts for this day.' : !cal.ok
          ? 'Schedule read failed; no drafts for this day.' : 'No observed jobs or drafts for this day.';
        box.append(empty);
      }
      const items = [
        ...agenda.map(e => ({type: 'real', e, time: e.allDay ? '' : e.startMs ? fmtWhen(e.startMs) : '—'})),
        ...drafts.map(e => ({type: 'draft', e, time: e.time || '—'})),
      ].sort((a, b) => a.time.localeCompare(b.time));
      for (const {type, e, time} of items) {
        const meta = ST[e.outcome] || ST.unknown;
        const row = document.createElement('div'); row.className = `cal-entry ${type === 'draft' ? 'draft' : (e.outcome || 'unknown')}`;
        const when = document.createElement('div'); when.className = 'cal-times'; when.textContent = type === 'draft' ? `${time} NZ` : e.allDay ? 'All day' : time;
        const title = document.createElement('div'); title.className = 'cal-title'; title.textContent = e.title || '(untitled)';
        const badge = document.createElement('span'); badge.className = 'cal-chip';
        badge.textContent = type === 'draft' ? 'DRAFT ONLY' : meta[0];
        badge.title = type === 'draft' ? 'Not active. This does not create a Ghost scheduler job.' : meta[1] + (e.note ? ` · ${e.note}` : '');
        if (type === 'draft') {
          const note = document.createElement('small'); note.className = 'draft-note';
          note.textContent = `${e.recurrence || 'once'} · Not scheduled for execution`;
          title.append(note);
        }
        row.append(when, title, badge);
        box.append(row);
      }
    }

    text('calendar-note', `${!cal || !cal.ok ? 'Real schedule unavailable. ' : stale ? 'Real schedule snapshot stale. ' : 'Real schedule based on observed entries. '}${draftPlansFresh ? 'Drafts are private plans, not runnable jobs.' : 'Draft status unavailable or stale; do not infer activation.'}`);
    text('calendar-range', `NZ time · ${calendarSelectedDay}${cal?.observedAt ? ` · observed ${fmtWhen(cal.observedAt)}` : ''}`);
  }

  function renderActivity(activity, stale) {
    const box = $('activity-scroll');
    if (!box) return;
    const items = (activity?.items || []).slice(-80);
    const state = stale ? 'HISTORICAL' : activity?.state === 'ok' ? 'LIVE' : activity?.state === 'retained' ? 'RECENT' : activity?.state === 'idle' ? 'IDLE' : 'UNAVAILABLE';
    text('activity-state', state);
    text('activity-note', `${stale ? 'Historical snapshot — not current activity. ' : activity?.note || 'Display only · private thought traces are not published. '}${activity?.truncated ? 'Some activity or details were omitted (bounded feed).' : ''} · Expand a tool for redacted details.`);
    const signature = JSON.stringify([activity?.run, items, state]);
    if (signature === activitySignature) return;
    activitySignature = signature;
    const sameRun = activityRun === activity?.run;
    const top = box.scrollTop || 0;
    const follow = !sameRun || box.scrollHeight - box.clientHeight - top < 35;
    const open = new Set(Array.from(box.children || []).filter(e => e.open).map(e => e.dataset.key));
    activityRun = activity?.run;
    box.replaceChildren();
    for (const [index, item] of items.entries()) {
      const tool = item.kind === 'tool';
      const row = document.createElement(tool ? 'details' : 'div');
      row.className = `activity-entry ${tool ? item.state : ''}`;
      row.dataset.key = item.id || String(index);
      if (tool) row.open = sameRun && open.has(row.dataset.key);
      const label = document.createElement(tool ? 'summary' : 'div');
      label.textContent = tool ? `${item.name} · ${item.state}` : item.kind === 'thinking' ? 'Thinking…' : item.text || 'Agent update';
      row.append(label);
      if (tool) {
        for (const field of ['input', 'output', 'error']) {
          if (typeof item[field] === 'string' && item[field]) {
            const heading = document.createElement('span'); heading.className = 'activity-label'; heading.textContent = field.toUpperCase();
            const pre = document.createElement('pre'); pre.textContent = item[field];
            row.append(heading, pre);
          }
        }
      }
      if (item.truncated) {
        const note = document.createElement('small');
        note.textContent = 'Detail truncated';
        row.append(note);
      }
      box.append(row);
    }
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = stale ? 'No activity in this historical snapshot.' : activity?.state === 'idle' ? 'No active Ghost turn observed.' : 'No verified display activity available yet.';
      box.append(empty);
    }
    if (follow) box.scrollTop = box.scrollHeight; else box.scrollTop = top;
  }

  function renderLog() {
    const events = (displayed || []).filter(e => filter === 'all' || (filter === 'retry' && e.kind === 'rate_limit') || (filter === 'error' && ['timeout', 'connection_failure', 'provider_error', 'exhausted'].includes(e.kind)));
    page = Math.min(page, Math.max(0, Math.ceil(events.length / pageSize) - 1));
    const visible = events.slice(page * pageSize, (page + 1) * pageSize);
    const log = $('logs');
    if (!log) return;
    log.replaceChildren();
    for (const e of visible) {
      const n = names[e.kind];
      if (!n) continue;
      const row = document.createElement('div'); row.className = `event ${e.kind}`;
      const t = document.createElement('time'); t.textContent = new Date(e.at).toLocaleTimeString([], {hour12: false}); t.dateTime = new Date(e.at).toISOString();
      const kind = document.createElement('span'); kind.className = 'kind'; kind.textContent = n[0];
      const message = document.createElement('div'); message.className = 'message'; message.textContent = n[1];
      const sub = document.createElement('small'); sub.textContent = `${n[2]} · …${e.run.slice(-8)}${e.seq ? ` / #${e.seq}` : ''}`;
      message.append(sub);
      row.append(t, kind, message);
      log.append(row);
    }
    if (!events.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = filter === 'error' ? 'No explicit errors in the retained log.' : filter === 'retry' ? 'No rate-limit retries in the retained log.' : 'No captured provider events yet. The observer does not invent activity.';
      log.append(e);
    }
    text('eventCount', events.length ? `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, events.length)} / ${events.length}` : '0 events');
    text('feedState', paused ? 'FEED PAUSED / STATUS STILL LIVE' : networkError ? 'CONNECTION LOST / HISTORICAL EVENTS' : 'READ-ONLY / SANITIZED EVENTS');
    if ($('newer')) $('newer').disabled = page === 0;
    if ($('older')) $('older').disabled = (page + 1) * pageSize >= events.length;
  }

  function render() {
    if (!latest) return;
    const now = Date.now();
    const age = now - latest.generatedAt;
    const stale = latest.collector !== 'ok' || !Number.isFinite(age) || age > 45000 || age < -5000 || latest.stale || networkError;
    lastStale = stale;
    const state = stale ? 'unknown' : latest.state;
    const desc = descriptions[state] || descriptions.unknown;

    text('state', desc[0]);
    text('phase', desc[1]);
    text('statuscopy', desc[2]);
    if ($('hero')) $('hero').className = `hero ${state === 'retrying' ? 'warning' : state === 'unknown' ? 'unknown' : ''}`.trim();
    if ($('connection')) $('connection').className = `connection ${stale ? 'offline' : 'live'}`;
    text('connectionText', stale ? 'Telemetry unavailable or stale' : 'Live observer · refreshes automatically');
    if ($('notice')) $('notice').hidden = !stale;
    text('notice', networkError ? 'Connection to the status page failed. Showing historical data; current Ghost activity is not verified.' : latest.error || 'The telemetry snapshot is stale. Current Ghost activity is not verified.');

    const runs = latest.runs || [];
    const r = runs[0];
    const pending = (latest.sessions || []).find(s => s.state === 'pending');
    const start = r?.started || pending?.started;
    text('elapsed', !stale && start ? duration(now - start) : '—');
    text('elapsedScope', r ? (r.transport === 'freebuff' ? 'Freebuff Ghost turn' : 'Managed run') : pending ? 'Native conversation' : 'No observed active turn');
    text('model', stale ? 'Not verified' : r?.model || (pending?.selectedModel ? `Selected: ${pending.selectedModel} · inference not verified` : 'No active provider run'));

    const last = Math.max(0, ...runs.map(x => x.lastProgress || 0));
    text('progress', !stale && last ? ago(now - last) : '—');
    const managed = runs.filter(x => x.transport !== 'freebuff');
    const retries = managed.reduce((n, x) => n + x.retries, 0);
    text('retries', stale ? '—' : managed.length ? String(retries) : 'Not observed');
    text('retryHint', managed.length ? `Managed HTTP 429 · ${managed.reduce((n, x) => n + x.retries15m, 0)} in the last 15 minutes` : 'Freebuff retry telemetry is not collected');
    text('timeouts', latest.timeout?.state === 'observed' ? `${latest.timeout.count} observed` : 'Not observed');
    if ($('timeouts')) $('timeouts').className = `duration ${latest.timeout?.state === 'observed' ? 'red' : ''}`.trim();
    text('deadline', r?.deadline === 'none' ? 'None' : 'Not reported');
    text('deadlineHint', r?.deadline === 'none' ? 'No fixed Step-5 inference cutoff' : 'No active policy evidence');
    text('collector', stale ? 'Stale data' : 'Healthy');
    text('snapshotAge', Number.isFinite(age) ? ago(age) : 'Not reported');
    text('runCount', stale ? 'Not verified' : `${runs.length} active`);
    const recovery = (latest.events || []).find(e => e.kind === 'recovered');
    text('recovery', recovery ? ago(now - recovery.at) : 'Not observed');
    text('coverage-note', latest.sources?.freebuff?.state === 'ok'
      ? 'Managed and Freebuff sources observed. Heartbeats are never presented as progress, and native chat ownership is never guessed from timing.'
      : 'Freebuff attribution is unavailable or unverified. Other observed runs remain visible; missing provider evidence is not the same as idle.');
    text('updated', `Snapshot ${latest.generatedAt ? new Date(latest.generatedAt).toLocaleTimeString() : 'unavailable'} · auto-refresh 5s`);

    const sessions = $('sessions');
    if (sessions) {
      sessions.replaceChildren();
      for (const s of latest.sessions || []) {
        const row = document.createElement('div'); row.className = 'session';
        const name = document.createElement('div'); name.textContent = s.title || 'Untitled conversation';
        const sub = document.createElement('small'); sub.textContent = `…${s.id.slice(-10)}${s.lastEvent ? ` · ${new Date(s.lastEvent).toLocaleTimeString()}` : ''}`;
        name.append(sub);
        const status = document.createElement('span'); status.textContent = stale ? 'Not verified' : s.state === 'pending' ? 'Pending' : s.outcome || s.state; status.className = s.state === 'pending' ? 'amber' : 'cyan';
        row.append(name, status); sessions.append(row);
      }
      if (!sessions.children.length) {
        const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'No native conversations observed.'; sessions.append(e);
      }
    }

    renderWorkIdentity(latest, stale);
    renderMemory(latest.memory, stale);
    renderCalendar(latest, stale);
    renderActivity(latest.activity, stale);
    if (!paused) displayed = latest.events || [];
    renderLog();
  }

  const pager = document.createElement('span');
  pager.className = 'pager';
  for (const [id, label] of [['newer', '← Newer'], ['older', 'Older →']]) {
    const b = document.createElement('button');
    b.className = 'button';
    b.id = id;
    b.textContent = label;
    pager.append(b);
  }
  const logFoot = root.querySelector('.logfoot');
  if (logFoot && logFoot.lastElementChild) logFoot.lastElementChild.replaceWith(pager);

  const pauseButton = () => {
    if ($('pause')) $('pause').setAttribute('aria-pressed', String(paused));
    text('pause', paused ? 'Resume feed' : 'Pause feed');
  };
  if ($('older')) $('older').onclick = () => { paused = true; page += 1; pauseButton(); renderLog(); };
  if ($('newer')) $('newer').onclick = () => { page = Math.max(0, page - 1); renderLog(); };
  if ($('pause')) $('pause').onclick = () => { paused = !paused; if (!paused) page = 0; pauseButton(); render(); };
  for (const b of root.querySelectorAll('[data-filter]')) {
    b.onclick = () => {
      filter = b.dataset.filter;
      page = 0;
      for (const x of root.querySelectorAll('[data-filter]')) x.setAttribute('aria-pressed', String(x === b));
      renderLog();
    };
  }
  if ($('activity-latest')) $('activity-latest').onclick = () => { const box = $('activity-scroll'); if (box) box.scrollTop = box.scrollHeight; };

  async function poll() {
    if (disposed) return;
    try {
      const r = await ghostFetch('/api/ghost/status', {cache: 'no-store', signal: AbortSignal.timeout(10000)});
      if (r.status === 401) {
        networkError = true;
        text('connectionText', 'Session expired · sign in again');
        if ($('notice')) $('notice').hidden = false;
        text('notice', 'Your login has expired. Reload this page to sign in again.');
        if (latest) render();
        return;
      }
      if (!r.ok) throw new Error('status');
      latest = await r.json();
      if (disposed) return;
      networkError = false;
      render();
    } catch {
      if (disposed) return;
      networkError = true;
      if (latest) render();
      else {
        if ($('connection')) $('connection').className = 'connection offline';
        text('connectionText', 'Telemetry unavailable');
        if ($('notice')) $('notice').hidden = false;
        text('notice', 'Cannot reach fresh telemetry. No Ghost state is assumed.');
      }
    } finally {
      if (!disposed) pollTimer = setTimeout(poll, 5000);
    }
  }

  const clockTimer = setInterval(() => {
    if (disposed) return;
    text('clock', `${new Date().toLocaleTimeString([], {hour12: false})} LOCAL`);
    if (latest) render();
  }, 1000);

  const navigateCalendar = delta => {
    calendarWeekOffset = Math.max(-52, Math.min(52, calendarWeekOffset + delta));
    calendarSelectedDay = null;
    calendarSignature = '';
    if (latest) renderCalendar(latest, lastStale);
  };
  if ($('calendar-prev')) $('calendar-prev').onclick = () => navigateCalendar(-1);
  if ($('calendar-next')) $('calendar-next').onclick = () => navigateCalendar(1);
  if ($('calendar-today')) $('calendar-today').onclick = () => {
    calendarWeekOffset = 0; calendarSelectedDay = dayKeyInZone(); calendarSignature = '';
    if (latest) renderCalendar(latest, lastStale);
  };
  if ($('calendar-plan-day')) $('calendar-plan-day').onclick = () => {
    const form = $('plan-form');
    const existing = $('plan-id')?.value || $('plan-title')?.value?.trim() || $('plan-prompt')?.value?.trim();
    if (existing) {
      text('plan-note', 'An edit is in progress. Save or clear the existing draft before choosing a new day.');
    } else if ($('plan-date')) {
      $('plan-date').value = calendarSelectedDay || dayKeyInZone();
    }
    if (form) form.scrollIntoView({behavior: 'smooth', block: 'center'});
    $('plan-title')?.focus();
  };

  pauseButton();
  poll();
  const stopTasks = mountGhostTasks(root, ghostFetch, (plans, verified) => {
    draftPlans = plans;
    draftPlansFresh = verified;
    calendarSignature = '';
    if (latest) renderCalendar(latest, lastStale);
  });
  return () => {
    disposed = true;
    clearInterval(clockTimer);
    clearTimeout(pollTimer);
    stopTasks();
  };
}
