/* Scheduled-task pause/resume. Reuses the authenticated /api/control socket.
   Nothing is changed without an explicit confirmation and a unique request id. */
export function mountGhostTasks(root, ghostFetch) {
  'use strict';
  const $ = id => root.querySelector(`#${id}`);
  // Two independent sources feed the note, and neither hides the other:
  //  - actionNote: the outcome of the last pause/resume attempt (refused, outcome-unknown
  //    or success). It is kept across polls and replaced only by a newer action.
  //  - the refresh warning (unavailable or stale), derived from the latest poll. It is
  //    shown next to any action outcome and clears on the next good poll.
  let state = null, connected = false, lastAt = 0, busy = false, disposed = false;
  let actionNote = '', actionError = false;
  // Must stay byte-identical to SCOPE_NOTE in control.py (test_taskguard.py asserts it).
  const SCOPE_NOTE = 'Pause blocks scheduled runs that have not started yet. Work already running keeps going, including its own retries; nothing is cancelled. A guarded step inside a chain that has not started yet can be refused, and the chain then continues with its later steps. Timers stay enabled; resume applies to the next scheduled occurrence.';
  const UNAVAILABLE_NOTE = 'Task control state is unavailable. No pause state is claimed and controls are disabled until fresh state returns.';
  const STALE_NOTE = 'Control state is stale or unavailable. No action is offered until fresh state returns.';
  const active = () => connected && !busy && Date.now() - lastAt < 60000;
  const text = (id, value) => { const node = $(id); if (node) node.textContent = value; };
  const short = id => '…' + String(id).slice(-10);
  const localTime = value => {
    if (!value) return null;
    const date = typeof value === 'number' ? new Date(value) : new Date(String(value).replace(/^@/, ''));
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString([], {hour12: false});
  };
  const chip = (label, kind) => {
    const node = document.createElement('span');
    node.className = 'task-chip ' + kind;
    node.textContent = label;
    return node;
  };
  // The refresh warning for the latest poll: '' when the state is fresh and usable.
  function warningFor(data, fresh) {
    if (!data) return UNAVAILABLE_NOTE;
    if (!data.ok) return data.message || UNAVAILABLE_NOTE;
    if (!fresh) return STALE_NOTE;
    return '';
  }
  function showNote() {
    const data = state && state.tasks;
    const fresh = connected && Date.now() - lastAt < 60000;
    const warning = warningFor(data, fresh);
    const parts = [warning, actionNote].filter(Boolean);
    const value = parts.length ? parts.join(' ') : (data && data.message) || SCOPE_NOTE;
    text('tasks-note', value);
    const node = $('tasks-note');
    if (node) node.className = 'tasks-note' + (warning || actionError ? ' error' : '');
  }
  function setAction(value, error) {
    actionNote = value;
    actionError = error;
    showNote();
  }
  function randomId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }
  function render() {
    const box = $('task-list');
    const data = state && state.tasks;
    const fresh = connected && Date.now() - lastAt < 60000;
    text('tasks-state', !data || !fresh ? 'CONTROLS UNAVAILABLE' : !data.ok ? 'STATUS UNAVAILABLE' : 'LIVE');
    showNote();
    if (!box) return;
    box.replaceChildren();
    if (!data || !data.ok) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Scheduled task state could not be verified. No action is offered.';
      box.append(empty);
      return;
    }
    const valid = active();
    const paused = data.tasks.filter(t => t.paused).length;
    if (fresh) text('tasks-state', paused ? 'PAUSED ' + paused + ' OF ' + data.tasks.length : 'ALL SCHEDULED');
    for (const task of data.tasks) {
      const row = document.createElement('div');
      row.className = 'task-row ' + task.state;
      row.dataset.task = task.id;
      const main = document.createElement('div');
      main.className = 'task-main';
      const title = document.createElement('div');
      title.className = 'task-title';
      const name = document.createElement('b');
      name.textContent = task.label;
      title.append(name);
      if (task.paused) title.append(chip('PAUSED', 'paused'));
      if (task.running) title.append(chip('RUNNING', 'running'));
      if (task.failed && !task.running) title.append(chip('LAST FAILED', 'failed'));
      if (task.skipped && !task.paused) title.append(chip('LAST SKIPPED', 'muted'));
      if (task.state === 'unknown') title.append(chip('UNVERIFIED', 'muted'));
      if (!task.guardInstalled) title.append(chip('NOT ENFORCED', 'failed'));
      if (task.timerActive === false) title.append(chip('NO TIMER', 'muted'));
      const detail = document.createElement('div');
      detail.className = 'task-detail';
      detail.textContent = task.pauseNote ? task.detail + ' ' + task.pauseNote : task.detail;
      const meta = document.createElement('div');
      meta.className = 'task-meta';
      const guardNote = !task.guardInstalled ? (task.guardDropin ? 'guard present but not loaded' : 'guard not installed') : '';

      const schedule = task.schedule ? 'schedule ' + task.schedule : 'schedule read unavailable';
      const next = task.nextAt ? 'next ' + task.nextAt : 'no next fire';
      const last = task.lastRunAt ? 'last run ' + localTime(task.lastRunAt) : 'no completed run recorded';
      const result = task.lastResult ? 'result ' + task.lastResult : '';
      const skip = task.lastSkipped ? 'skipped ' + localTime(task.lastSkipped.at) + ' (' + task.lastSkipped.reason + ')' : '';
      meta.textContent = [task.timer, schedule, next, last, result, skip, guardNote].filter(Boolean).join(' · ');
      if (task.paused && task.pausedSince) {
        const pausedAt = document.createElement('div');
        pausedAt.className = 'task-meta';
        pausedAt.textContent = 'paused ' + localTime(task.pausedSince) + ' by ' + (task.pausedBy || 'operator') +
          (task.running ? ' · work already running keeps going (not cancelled)' : '');
        main.append(title, detail, meta, pausedAt);
      } else {
        main.append(title, detail, meta);
      }
      const action = document.createElement('div');
      action.className = 'task-action';
      const button = document.createElement('button');
      button.className = 'button' + (task.paused ? '' : ' danger');
      button.textContent = task.paused ? 'Resume' : 'Pause';
      button.disabled = !valid || !task.guardInstalled;
      button.title = task.guardInstalled ? '' : 'The systemd guard is not installed; refusing an unenforced pause.';
      button.onclick = () => act(task, task.paused ? 'resume-task' : 'pause-task');
      action.append(button);
      if (task.prompts && task.prompts.length) {
        const promptButton = document.createElement('button');
        promptButton.className = 'button';
        promptButton.textContent = 'Prompt';
        promptButton.disabled = !valid;
        promptButton.title = 'View and edit this task’s prompt. Saves are versioned; history is kept.';
        promptButton.onclick = () => openPrompt(task);
        action.append(promptButton);
      } else {
        const noPrompt = chip('NO PROMPT', 'muted');
        noPrompt.title = task.promptNote || 'This task has no agent prompt to edit.';
        action.append(noPrompt);
      }
      row.append(main, action);
      box.append(row);
    }
  }
  async function refresh() {
    if(disposed)return;
    try {
      const response = await ghostFetch('/api/ghost/control', {cache: 'no-store', signal: AbortSignal.timeout(25000)});
      if (!response.ok) throw Error('control');
      const next = await response.json();
      if (!next || next.ok !== true || !next.tasks) throw Error('control');
      if(disposed)return;
      state = next;
      connected = true;
      lastAt = Date.now();
      render();
    } catch {
      if(disposed)return;
      connected = false;
      render();
    }
  }
  function confirmAction(title, copy) {
    return new Promise(resolve => {
      const dialog = $('task-confirm');
      if (!dialog || typeof dialog.showModal !== 'function') return resolve(false);
      text('task-confirm-title', title);
      text('task-confirm-message', copy);
      let done = false;
      const finish = value => {
        if (done) return;
        done = true;
        dialog.close();
        $('task-confirm-yes').onclick = null;
        $('task-confirm-cancel').onclick = null;
        dialog.oncancel = null;
        resolve(value);
      };
      $('task-confirm-yes').onclick = () => finish(true);
      $('task-confirm-cancel').onclick = () => finish(false);
      dialog.oncancel = event => { event.preventDefault(); finish(false); };
      dialog.showModal();
      $('task-confirm-cancel').focus();
    });
  }
  async function act(task, action) {
    if (!active()) return;
    const pause = action === 'pause-task';
    const title = (pause ? 'Pause ' : 'Resume ') + task.label + '?';
    const copy = pause
      ? SCOPE_NOTE + (task.pauseNote ? ' ' + task.pauseNote : '')
      : 'Resume lets the next scheduled occurrence start. Occurrences missed while paused are not replayed.';
    if (!await confirmAction(title, copy)) return;
    busy = true;
    render();
    setAction((pause ? 'Pausing ' : 'Resuming ') + task.label + '…', false);
    const request = {action, task: task.id, confirm: true, requestId: randomId()};
    try {
      const response = await ghostFetch('/api/ghost/control', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-Ghost-Control': '1'},
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(70000),
      });
      const body = await response.json();
      if (!response.ok || !body.ok) {
        setAction((body.error || 'Action refused') + '. Refresh before retrying.', true);
      } else {
        setAction(body.message || 'Task updated.', false);
      }
    } catch {
      setAction('Action not confirmed. Refresh and inspect the task state; do not blindly repeat a continuation.', true);
    } finally {
      busy = false;
      await refresh();
    }
  }
  // --- task prompts --------------------------------------------------------
  let promptView = null; // {taskId, entryId}
  let promptDiscardArmed = false;
  function promptTask() { return (state?.tasks || []).find(t => t.id === promptView?.taskId) || null; }
  function promptEntries() { const task = promptTask(); return task && Array.isArray(task.prompts) ? task.prompts : []; }
  function promptEntry() { return promptEntries().find(p => p.id === promptView?.entryId) || promptEntries()[0] || null; }
  function setPromptStatus(message, error) { const node = $('prompt-status'); if (!node) return; node.textContent = message || ''; node.className = 'prompt-status' + (error ? ' error' : ''); }
  function promptConfirmed() { const input = $('prompt-confirm-input'); const word = $('prompt-confirm-word'); return Boolean(input && word && input.value.trim() === word.textContent.trim()); }
  function updatePromptSave() { const save = $('prompt-save'); if (save) save.disabled = !promptConfirmed() || busy; }
  function resetPromptConfirm() { const input = $('prompt-confirm-input'); if (input) input.value = ''; promptDiscardArmed = false; updatePromptSave(); }
  function promptDirty() { const entry = promptEntry(); const area = $('prompt-text'); return Boolean(entry && area && area.value !== (entry.text || '')); }
  function promptCount() {
    const entry = promptEntry(); const area = $('prompt-text'); const node = $('prompt-count');
    if (!node || !entry || !area) return;
    const n = area.value.length;
    node.textContent = n + ' / ' + entry.maxChars + ' characters' + (n > entry.maxChars ? ' — over the limit; the save will be refused' : '');
    node.className = 'prompt-count' + (n > entry.maxChars ? ' error' : '');
  }
  function renderPromptDialog() {
    const task = promptTask(); if (!task) return;
    const entries = promptEntries(); const entry = promptEntry();
    const tabs = $('prompt-tabs');
    if (tabs) {
      tabs.replaceChildren(); tabs.hidden = entries.length < 2;
      for (const item of entries) {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'prompt-tab' + (entry && item.id === entry.id ? ' active' : '');
        tab.textContent = item.label;
        tab.onclick = () => { if (!promptView) return; promptView.entryId = item.id; resetPromptConfirm(); renderPromptDialog(); };
        tabs.append(tab);
      }
    }
    const area = $('prompt-text');
    if (area) { area.value = entry ? (entry.text || '') : ''; area.disabled = !entry || !active(); }
    text('prompt-meta', entry
      ? 'revision ' + entry.rev + (entry.updatedAt ? ' · updated ' + localTime(entry.updatedAt) + ' by ' + (entry.by || 'unknown') : '') + (entry.onDisk ? '' : ' · file text differs from the recorded revision')
      : 'No prompt for this task.');
    text('prompt-help', entry
      ? ((entry.placeholders && entry.placeholders.length ? 'Placeholders: ' + entry.placeholders.map(p => '{{' + p + '}}').join(', ') + ' (rendered at run time). ' : 'No placeholders allowed. ') + 'Max ' + entry.maxChars + ' characters. The shared policy preamble stays in code and is not editable here.')
      : '');
    const history = $('prompt-history');
    if (history) {
      history.replaceChildren();
      const rows = entry ? (entry.history || []).filter(r => r.rev !== entry.rev) : [];
      history.hidden = !rows.length;
      if (rows.length) {
        const label = document.createElement('div');
        label.className = 'prompt-history-label';
        label.textContent = 'History — restore writes the old text as a new revision';
        history.append(label);
        for (const rev of rows) {
          const row = document.createElement('div'); row.className = 'prompt-history-row';
          const info = document.createElement('span');
          info.textContent = 'r' + String(rev.rev).padStart(4, '0') + ' · ' + (rev.at ? localTime(rev.at) : '') + ' · ' + (rev.by || 'unknown') + (rev.note ? ' · ' + rev.note : '');
          const restore = document.createElement('button');
          restore.type = 'button'; restore.className = 'button'; restore.textContent = 'Restore';
          restore.disabled = !active() || busy;
          restore.onclick = () => restorePrompt(rev.rev);
          row.append(info, restore);
          history.append(row);
        }
      }
    }
    promptCount();
    updatePromptSave();
  }
  function openPrompt(task) {
    const dialog = $('prompt-dialog');
    if (!dialog || typeof dialog.showModal !== 'function' || !task.prompts || !task.prompts.length) return;
    promptView = {taskId: task.id, entryId: task.prompts[0].id};
    text('prompt-title', 'Prompt — ' + task.label);
    text('prompt-confirm-word', task.id);
    resetPromptConfirm(); setPromptStatus('', false);
    renderPromptDialog();
    dialog.showModal();
  }
  function closePrompt() { const dialog = $('prompt-dialog'); if (dialog?.open) dialog.close(); promptView = null; promptDiscardArmed = false; }
  function closePromptRequested() {
    if (promptDirty() && !promptDiscardArmed) { promptDiscardArmed = true; setPromptStatus('Unsaved changes: close again to discard them.', true); return; }
    closePrompt();
  }
  async function postControl(payload) {
    const response = await ghostFetch('/api/ghost/control', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-Ghost-Control': '1'},
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(70000),
    });
    let body = null;
    try { body = await response.json(); } catch { /* non-JSON refusal */ }
    if (!response.ok || !body || body.ok !== true) throw new Error((body && body.error) || ('HTTP ' + response.status));
    return body;
  }
  async function savePrompt() {
    const task = promptTask(); const entry = promptEntry(); const area = $('prompt-text');
    if (!task || !entry || !area || !active()) return;
    if (!promptConfirmed()) { setPromptStatus('Type ' + task.id + ' to confirm the save.', true); return; }
    busy = true; updatePromptSave(); setPromptStatus('Saving prompt…', false);
    try {
      const body = await postControl({action: 'set-prompt', task: task.id, prompt: entry.id, text: area.value, confirm: true, requestId: randomId()});
      setAction(body.message || 'Prompt saved.', false);
      busy = false;
      closePrompt();
      await refresh();
    } catch (error) {
      setPromptStatus('Save refused: ' + (error.message || 'unknown error') + '. Nothing was written.', true);
      busy = false; updatePromptSave();
    }
  }
  async function restorePrompt(rev) {
    const task = promptTask(); const entry = promptEntry();
    if (!task || !entry || !active()) return;
    const label = 'r' + String(rev).padStart(4, '0');
    if (!await confirmAction('Restore prompt revision ' + label + '?', 'The current text stays in history; this writes ' + label + ' as a new revision.')) return;
    busy = true; updatePromptSave(); setPromptStatus('Restoring ' + label + '…', false);
    try {
      const body = await postControl({action: 'revert-prompt', task: task.id, prompt: entry.id, rev, confirm: true, requestId: randomId()});
      setAction(body.message || 'Prompt revision restored.', false);
      busy = false;
      closePrompt();
      await refresh();
    } catch (error) {
      setPromptStatus('Restore refused: ' + (error.message || 'unknown error') + '. Nothing was written.', true);
      busy = false; updatePromptSave();
    }
  }
  {
    const dialog = $('prompt-dialog');
    if (dialog) {
      $('prompt-cancel').onclick = closePromptRequested;
      $('prompt-save').onclick = savePrompt;
      const confirmInput = $('prompt-confirm-input');
      if (confirmInput) confirmInput.oninput = updatePromptSave;
      const area = $('prompt-text');
      if (area) area.oninput = promptCount;
      dialog.addEventListener('cancel', event => { event.preventDefault(); closePromptRequested(); });
    }
  }
  const interval=setInterval(refresh, 20000);
  refresh();
  return ()=>{disposed=true;clearInterval(interval);const dialog=$('task-confirm');if(dialog?.open)dialog.close();const prompt=$('prompt-dialog');if(prompt?.open)prompt.close();};
}
