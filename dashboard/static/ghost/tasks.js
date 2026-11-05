/* Scheduled-task pause/resume, private planning drafts, and verified native schedules. */
export function mountGhostTasks(root, ghostFetch, onPlansChange = () => {}) {
  const $ = id => root.querySelector(`#${id}`);
  const text = (id, value) => { const node = $(id); if (node) node.textContent = value; };
  let state = null;
  let connected = false;
  let lastAt = 0;
  let busy = false;
  let disposed = false;
  let actionNote = '';
  let actionError = false;
  let plansState = null;
  let plansConnected = false;
  let plansAt = 0;
  let plannerNote = '';
  let plannerError = false;
  let schedulerState = null;
  let schedulerConnected = false;
  let schedulerAt = 0;
  let schedulerNote = '';
  let schedulerError = false;
  let activationPending = null;

  // Must stay byte-identical to SCOPE_NOTE in control.py (test_taskguard.py asserts it).
  const SCOPE_NOTE = 'Pause blocks scheduled runs that have not started yet. Work already running keeps going, including its own retries; nothing is cancelled. A guarded step inside a chain that has not started yet can be refused, and the chain then continues with its later steps. Timers stay enabled; resume applies to the next scheduled occurrence.';
  const UNAVAILABLE_NOTE = 'Task control state is unavailable. No pause state is claimed and controls are disabled until fresh state returns.';
  const STALE_NOTE = 'Control state is stale or unavailable. No action is offered until fresh state returns.';
  const DRAFT_SCOPE = 'Draft plans are private operator planning records. Saving or editing a draft never changes a registered Ghost schedule.';

  const active = () => connected && !busy && Date.now() - lastAt < 60000;
  const plannerActive = () => plansConnected && !busy && Date.now() - plansAt < 120000;
  const schedulerFresh = () => schedulerConnected && schedulerState?.ok === true && schedulerState?.verified === true && Date.now() - schedulerAt < 120000;
  const scheduleCapability = name => schedulerFresh() && schedulerState?.capabilities?.schedule?.[name] === true;
  const scheduledForDraft = id => schedulerFresh()
    ? ((schedulerState?.schedules || []).find(item => item.draftId === id) || null)
    : null;
  const short = id => `…${String(id).slice(-10)}`;
  const localTime = value => {
    if (!value) return null;
    const date = typeof value === 'number' ? new Date(value) : new Date(String(value).replace(/^@/, ''));
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString([], {hour12: false});
  };
  const chip = (label, kind) => {
    const node = document.createElement('span');
    node.className = `task-chip ${kind}`;
    node.textContent = label;
    return node;
  };

  function randomId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }

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
    if (node) node.className = `tasks-note${warning || actionError ? ' error' : ''}`;
  }

  function showPlannerNote() {
    const fresh = plansConnected && Date.now() - plansAt < 120000;
    const warning = !plansState ? 'Draft schedule data is unavailable.' : !fresh ? 'Draft schedule data is stale; refresh before relying on it.' : '';
    const note = [warning, plannerNote].filter(Boolean).join(' ') || DRAFT_SCOPE;
    text('plan-note', note);
    const node = $('plan-note');
    if (node) node.className = `plan-note${warning || plannerError ? ' error' : ''}`;
  }

  function showSchedulerNote() {
    const age = Date.now() - schedulerAt;
    let warning = '';
    if (!schedulerConnected || !schedulerState?.ok) warning = 'Native Task Scheduler readback is unavailable. No registered schedule is assumed.';
    else if (!schedulerState.verified) warning = 'Task Scheduler readback could not be verified. Schedule actions are disabled.';
    else if (age >= 120000) warning = 'Task Scheduler readback is stale. Refresh before relying on schedule state.';
    const value = [warning, schedulerNote].filter(Boolean).join(' ') || 'Registered schedules come from the authenticated Windows Task Scheduler readback. Draft edits do not change an existing schedule.';
    text('scheduler-note', value);
    const node = $('scheduler-note');
    if (node) node.className = `scheduler-note${warning || schedulerError ? ' error' : ''}`;
  }

  function setAction(value, error) {
    actionNote = value;
    actionError = error;
    showNote();
  }
  function setPlannerStatus(value, error) {
    plannerNote = value;
    plannerError = error;
    showPlannerNote();
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
    if (fresh) text('tasks-state', paused ? `PAUSED ${paused} OF ${data.tasks.length}` : 'ALL SCHEDULED');
    for (const task of data.tasks) {
      const row = document.createElement('div');
      row.className = `task-row ${task.state}`;
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
      detail.textContent = task.pauseNote ? `${task.detail} ${task.pauseNote}` : task.detail;

      const meta = document.createElement('div');
      meta.className = 'task-meta';
      const guardNote = !task.guardInstalled ? (task.guardDropin ? 'guard present but not loaded' : 'guard not installed') : '';
      const schedule = task.schedule ? `schedule ${task.schedule}` : 'schedule read unavailable';
      const next = task.nextAt ? `next ${task.nextAt}` : 'no next fire';
      const last = task.lastRunAt ? `last run ${localTime(task.lastRunAt)}` : 'no completed run recorded';
      const result = task.lastResult ? `result ${task.lastResult}` : '';
      const skip = task.lastSkipped ? `skipped ${localTime(task.lastSkipped.at)} (${task.lastSkipped.reason})` : '';
      meta.textContent = [task.timer, schedule, next, last, result, skip, guardNote].filter(Boolean).join(' · ');
      main.append(title, detail, meta);
      if (task.paused && task.pausedSince) {
        const pausedAt = document.createElement('div');
        pausedAt.className = 'task-meta';
        pausedAt.textContent = `paused ${localTime(task.pausedSince)} by ${task.pausedBy || 'operator'}${task.running ? ' · work already running keeps going (not cancelled)' : ''}`;
        main.append(pausedAt);
      }

      const action = document.createElement('div');
      action.className = 'task-action';
      const button = document.createElement('button');
      button.className = `button${task.paused ? '' : ' danger'}`;
      button.textContent = task.paused ? 'Resume' : 'Pause';
      button.disabled = !valid || !task.guardInstalled;
      button.title = task.guardInstalled ? '' : 'The systemd guard is not installed; refusing an unenforced pause.';
      button.onclick = () => act(task, task.paused ? 'resume-task' : 'pause-task');
      action.append(button);
      if (task.prompts && task.prompts.length) {
        const promptButton = document.createElement('button');
        promptButton.className = 'button secondary';
        promptButton.textContent = 'Edit prompt';
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

  function planSummary(plan) {
    return `${plan.date} · ${plan.time} · ${plan.recurrence} · ${plan.timezone || 'Pacific/Auckland'}`;
  }

  function clearPlannerForm() {
    if ($('plan-form')) $('plan-form').reset();
    if ($('plan-id')) $('plan-id').value = '';
    if ($('plan-revision')) $('plan-revision').value = '';
    const dateInput = $('plan-date');
    if (dateInput && !dateInput.value) {
      dateInput.value = new Intl.DateTimeFormat('en-CA', {timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date());
    }
  }

  function fillPlannerForm(plan) {
    if ($('plan-id')) $('plan-id').value = plan.id;
    if ($('plan-revision')) $('plan-revision').value = String(plan.revision || '');
    if ($('plan-title')) $('plan-title').value = plan.title || '';
    if ($('plan-date')) $('plan-date').value = plan.date || '';
    if ($('plan-time')) $('plan-time').value = plan.time || '';
    if ($('plan-recurrence')) $('plan-recurrence').value = plan.recurrence || 'once';
    if ($('plan-prompt')) $('plan-prompt').value = plan.prompt || '';
  }

  function renderPlans() {
    const box = $('plan-list');
    if (!box) return;
    box.replaceChildren();
    showPlannerNote();
    if (!plansState || plansState.ok !== true) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Draft plans are unavailable right now.';
      box.append(empty);
      return;
    }
    const rows = (plansState.plans || []).slice().sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No draft plans saved yet.';
      box.append(empty);
      return;
    }
    for (const plan of rows) {
      const row = document.createElement('div');
      row.className = 'plan-row';
      const main = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'plan-title';
      const name = document.createElement('b');
      name.textContent = plan.title;
      const draft = document.createElement('span');
      draft.className = 'task-chip muted';
      draft.textContent = 'DRAFT';
      title.append(name, draft);
      const detail = document.createElement('div');
      detail.className = 'plan-detail';
      detail.textContent = plan.prompt;
      const meta = document.createElement('div');
      meta.className = 'plan-meta';
      meta.textContent = `${planSummary(plan)} · draft revision ${plan.revision || 1} · ${short(plan.id)}`;
      main.append(title, detail, meta);
      const actions = document.createElement('div');
      actions.className = 'plan-actions';
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'button secondary';
      edit.textContent = 'Edit';
      edit.disabled = busy || !plannerActive();
      edit.onclick = () => fillPlannerForm(plan);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'button danger';
      remove.textContent = 'Delete';
      remove.disabled = busy || !plannerActive();
      remove.onclick = () => deletePlan(plan);
      const preview = document.createElement('button');
      preview.type = 'button';
      preview.className = 'button';
      const scheduled = scheduledForDraft(plan.id);
      const updatePending = scheduled && scheduled.draftRevision !== plan.revision;
      preview.textContent = scheduled ? (updatePending ? 'Review schedule update' : 'Registered') : 'Review & activate';
      preview.title = scheduled
        ? (updatePending ? 'Review this exact draft revision, then update the registered schedule.' : 'This draft revision is already registered and read back from Task Scheduler.')
        : 'Review this exact draft revision before registering a Windows schedule.';
      const operation = scheduled ? 'update' : 'register';
      preview.disabled = busy || !plannerActive() || !scheduleCapability(operation) || (scheduled && !updatePending);
      preview.onclick = () => reviewActivation(plan, scheduled);
      actions.append(edit, preview, remove);
      row.append(main, actions);
      box.append(row);
    }
  }

  function renderSchedules() {
    const box = $('scheduler-list');
    showSchedulerNote();
    const chipNode = $('scheduler-state');
    if (chipNode) {
      chipNode.textContent = !schedulerConnected || !schedulerState?.ok ? 'UNAVAILABLE'
        : !schedulerFresh() ? 'STALE / UNVERIFIED'
        : schedulerState.schedules.length ? `${schedulerState.schedules.length} VERIFIED`
        : 'NO REGISTERED JOBS';
    }
    if (!box) return;
    box.replaceChildren();
    if (!schedulerFresh()) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'The native Task Scheduler readback is unavailable, stale, or unverified. No execution state is assumed.';
      box.append(empty);
      return;
    }
    const rows = schedulerState.schedules;
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No registered Ghost schedules were found for this Windows user.';
      box.append(empty);
      return;
    }
    for (const schedule of rows) {
      const row = document.createElement('div');
      const running = schedule.enabled === true && schedule.status === 'active';
      row.className = `schedule-row${running ? ' active' : ' inactive'}`;
      const main = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'schedule-title';
      const name = document.createElement('b');
      name.textContent = schedule.title;
      const status = document.createElement('span');
      status.className = `task-chip ${running ? 'running' : 'muted'}`;
      status.textContent = running ? 'ACTIVE' : (schedule.enabled ? String(schedule.status || 'UNKNOWN').toUpperCase() : 'DISABLED');
      title.append(name, status);
      const detail = document.createElement('div');
      detail.className = 'schedule-detail';
      detail.textContent = `${schedule.date} · ${schedule.time} · ${schedule.recurrence} · ${schedule.timezone}`;
      const meta = document.createElement('div');
      meta.className = 'schedule-meta';
      meta.textContent = `job ${short(schedule.jobId)} · schedule revision ${schedule.revision} · draft revision ${schedule.draftRevision} · prompt revision ${schedule.promptRevision} · ${schedule.missedRunPolicy}`;
      main.append(title, detail, meta);

      const actions = document.createElement('div');
      actions.className = 'schedule-actions';
      const plan = plansConnected && Date.now() - plansAt < 120000
        ? (plansState?.plans || []).find(item => item.id === schedule.draftId)
        : null;
      const update = document.createElement('button');
      update.type = 'button';
      update.className = 'button secondary';
      update.textContent = plan && plan.revision > schedule.draftRevision ? 'Review update' : 'Update from draft';
      update.title = !plan ? 'The linked draft is unavailable. Create or restore a draft before updating.'
        : plan.revision <= schedule.draftRevision ? 'Save a newer draft revision before updating this schedule.'
        : 'Review the new draft revision and independently verify the updated Task Scheduler job.';
      update.disabled = busy || !running || !plan || plan.revision <= schedule.draftRevision || !scheduleCapability('update');
      update.onclick = () => reviewActivation(plan, schedule);

      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'button danger';
      cancel.textContent = 'Cancel schedule';
      cancel.title = 'Remove this registered schedule after confirming. Work already running is not stopped.';
      cancel.disabled = busy || !scheduleCapability('cancel');
      cancel.onclick = () => cancelSchedule(schedule);
      actions.append(update, cancel);
      row.append(main, actions);
      box.append(row);
    }
  }

  async function refreshTasks() {
    try {
      const response = await ghostFetch('/api/ghost/control', {cache: 'no-store', signal: AbortSignal.timeout(25000)});
      if (!response.ok) throw new Error('control');
      const next = await response.json();
      if (!next || next.ok !== true || !next.tasks) throw new Error('control');
      state = next;
      connected = true;
      lastAt = Date.now();
    } catch {
      connected = false;
    }
  }

  async function refreshPlans() {
    try {
      const response = await ghostFetch('/api/ghost/plans', {cache: 'no-store', signal: AbortSignal.timeout(25000)});
      if (!response.ok) throw new Error('plans');
      const next = await response.json();
      if (!next || next.ok !== true || !Array.isArray(next.plans)) throw new Error('plans');
      plansState = next;
      plansConnected = true;
      plansAt = Date.now();
    } catch {
      plansConnected = false;
    } finally {
      if (!disposed) onPlansChange(plansState?.plans || [], plansConnected && Date.now() - plansAt < 120000);
    }
  }

  async function refreshScheduler() {
    try {
      const response = await ghostFetch('/api/ghost/scheduler', {cache: 'no-store', signal: AbortSignal.timeout(25000)});
      if (!response.ok) throw new Error('scheduler');
      const next = await response.json();
      if (!next || next.ok !== true || next.verified !== true || !Array.isArray(next.schedules)
          || !next.capabilities || !next.capabilities.schedule) throw new Error('scheduler');
      schedulerState = next;
      schedulerConnected = true;
      schedulerAt = Date.now();
    } catch {
      schedulerConnected = false;
    }
  }

  async function refresh() {
    if (disposed) return;
    await Promise.allSettled([refreshTasks(), refreshPlans(), refreshScheduler()]);
    if (disposed) return;
    render();
    renderPlans();
    renderSchedules();
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
    const title = `${pause ? 'Pause ' : 'Resume '}${task.label}?`;
    const copy = pause ? `${SCOPE_NOTE}${task.pauseNote ? ` ${task.pauseNote}` : ''}` : 'Resume lets the next scheduled occurrence start. Occurrences missed while paused are not replayed.';
    if (!await confirmAction(title, copy)) return;
    busy = true;
    render();
    renderPlans();
    setAction(`${pause ? 'Pausing ' : 'Resuming '}${task.label}…`, false);
    const request = {action, task: task.id, confirm: true, requestId: randomId()};
    try {
      const response = await ghostFetch('/api/ghost/control', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-Ghost-Control': '1'},
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(70000),
      });
      const body = await response.json();
      if (!response.ok || !body.ok) setAction(`${body.error || 'Action refused'}. Refresh before retrying.`, true);
      else setAction(body.message || 'Task updated.', false);
    } catch {
      setAction('Action not confirmed. Refresh and inspect the task state; do not blindly repeat a continuation.', true);
    } finally {
      busy = false;
      await refresh();
    }
  }

  async function postControl(payload) {
    const response = await ghostFetch('/api/ghost/control', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-Ghost-Control': '1'},
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(70000),
    });
    let body = null;
    try { body = await response.json(); } catch {}
    if (!response.ok || !body || body.ok !== true) throw new Error((body && body.error) || (`HTTP ${response.status}`));
    return body;
  }

  async function postPlan(payload, method = 'POST') {
    const response = await ghostFetch('/api/ghost/plans', {
      method,
      headers: {'Content-Type': 'application/json', 'X-Ghost-Control': '1'},
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
    let body = null;
    try { body = await response.json(); } catch {}
    if (!response.ok || !body || body.ok !== true) throw new Error((body && body.error) || (`HTTP ${response.status}`));
    return body;
  }

  async function postScheduler(payload) {
    const response = await ghostFetch('/api/ghost/scheduler', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-Ghost-Control': '1'},
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(70000),
    });
    let body = null;
    try { body = await response.json(); } catch {}
    if (!response.ok || !body || body.ok !== true || body.readbackVerified !== true) {
      throw new Error((body && body.error) || (`HTTP ${response.status}`));
    }
    return body;
  }

  async function savePlan(event) {
    event?.preventDefault?.();
    const title = $('plan-title')?.value?.trim() || '';
    const prompt = $('plan-prompt')?.value?.trim() || '';
    const date = $('plan-date')?.value || '';
    const time = $('plan-time')?.value || '';
    const recurrence = $('plan-recurrence')?.value || 'once';
    const id = $('plan-id')?.value || '';
    const revision = $('plan-revision')?.value ? Number($('plan-revision').value) : null;
    if (!plannerActive()) {
      setPlannerStatus('Draft storage is unavailable. Refresh the schedule before saving.', true);
      return;
    }
    if (!title || !prompt || !date || !time) {
      setPlannerStatus('Title, date, time, and prompt are required before saving a draft.', true);
      return;
    }
    busy = true;
    render();
    renderPlans();
    setPlannerStatus(id ? 'Saving draft changes…' : 'Saving draft…', false);
    const payload = {action: 'save-draft', title, prompt, date, time, recurrence, confirm: true, requestId: randomId()};
    if (id) { payload.id = id; payload.expectedRevision = revision; }
    try {
      const body = await postPlan(payload, 'POST');
      setPlannerStatus(body.message || 'Draft saved. It is not an executable job.', false);
      clearPlannerForm();
    } catch (error) {
      setPlannerStatus(`Draft save refused: ${error.message || 'unknown error'}. Nothing was activated.`, true);
    } finally {
      busy = false;
      await refresh();
    }
  }

  async function reviewActivation(plan, existingSchedule = null) {
    if (!plannerActive() || !plan || !schedulerFresh()) {
      setPlannerStatus('Activation is unavailable until the draft and native Task Scheduler readback are fresh.', true);
      return;
    }
    const action = existingSchedule ? 'update-schedule' : 'register-schedule';
    if (!scheduleCapability(existingSchedule ? 'update' : 'register')) {
      setPlannerStatus('The native Ghost host does not currently report this scheduler action as available.', true);
      return;
    }
    if (existingSchedule && (existingSchedule.draftId !== plan.id || existingSchedule.draftRevision >= plan.revision)) {
      setPlannerStatus('The selected draft is not a newer revision of this registered schedule. Refresh before continuing.', true);
      return;
    }
    const dialog = $('activation-dialog');
    if (!dialog || typeof dialog.showModal !== 'function') return;
    busy = true;
    renderPlans();
    renderSchedules();
    activationPending = null;
    text('activation-title', existingSchedule ? 'Review schedule update' : 'Review task activation');
    text('activation-status', 'Preparing a fresh, revision-checked preview…');
    const confirm = $('activation-confirm');
    if (confirm) {
      confirm.disabled = true;
      confirm.textContent = existingSchedule ? 'Update schedule' : 'Activate schedule';
    }
    try {
      const body = await postPlan({
        action: 'activation-preview', id: plan.id,
        expectedRevision: plan.revision, confirm: true, requestId: randomId(),
      });
      if (body.executionAvailable !== false || body.preview?.schedulerRegistered !== false || body.preview?.executionAuthorized !== false) {
        throw new Error('activation_contract_unexpected');
      }
      const area = $('activation-json');
      if (area) area.value = JSON.stringify(body.preview, null, 2);
      activationPending = {
        action, draftId: plan.id, expectedDraftRevision: plan.revision,
        previewSha256: body.preview.sha256,
        jobId: existingSchedule?.jobId || null,
        expectedRevision: existingSchedule?.revision || null,
        openedAt: Date.now(),
      };
      if (confirm) {
        confirm.disabled = false;
        confirm.textContent = existingSchedule ? 'Confirm schedule update' : 'Confirm activation';
      }
      text('activation-status', existingSchedule
        ? `Review the new draft revision ${plan.revision}. Confirming will update job ${short(existingSchedule.jobId)} and wait for fresh Task Scheduler readback.`
        : `Review draft revision ${plan.revision}. Confirming will register a Windows schedule and wait for fresh Task Scheduler readback.`);
      dialog.showModal();
    } catch (error) {
      setPlannerStatus(`Activation review refused: ${error.message || 'unknown error'}. Refresh the draft before retrying.`, true);
      activationPending = null;
    } finally {
      busy = false;
      renderPlans();
      renderSchedules();
    }
  }

  async function confirmActivation() {
    const pending = activationPending;
    if (!pending) return;
    if (!plannerActive() || !schedulerFresh() || Date.now() - pending.openedAt >= 120000) {
      activationPending = null;
      const button = $('activation-confirm');
      if (button) button.disabled = true;
      text('activation-status', 'The preview or scheduler readback is stale. Close this review, refresh, and prepare a new preview.');
      return;
    }
    busy = true;
    const button = $('activation-confirm');
    if (button) button.disabled = true;
    renderPlans();
    renderSchedules();
    schedulerNote = pending.action === 'update-schedule'
      ? 'Updating the registered job. Waiting for independent Task Scheduler readback…'
      : 'Registering the job. Waiting for independent Task Scheduler readback…';
    schedulerError = false;
    showSchedulerNote();
    text('activation-status', schedulerNote);
    const request = {
      action: pending.action,
      draftId: pending.draftId,
      expectedDraftRevision: pending.expectedDraftRevision,
      previewSha256: pending.previewSha256,
      confirm: true,
      requestId: randomId(),
    };
    if (pending.action === 'update-schedule') {
      request.jobId = pending.jobId;
      request.expectedRevision = pending.expectedRevision;
    }
    activationPending = null;
    try {
      const result = await postScheduler(request);
      const label = pending.action === 'update-schedule' ? 'updated' : 'registered';
      const message = `Schedule ${label} and verified from Task Scheduler readback · job ${short(result.jobId)} · scheduler revision ${result.revision}.`;
      schedulerNote = message;
      schedulerError = false;
      text('activation-status', message);
    } catch (error) {
      const message = `Scheduler action not confirmed from fresh readback (${error.message || 'unknown error'}). Refresh and inspect the registered schedule before trying again.`;
      schedulerNote = message;
      schedulerError = true;
      text('activation-status', message);
    } finally {
      busy = false;
      await refresh();
    }
  }

  async function cancelSchedule(schedule) {
    if (!schedulerFresh() || !scheduleCapability('cancel') || !schedule) return;
    if (!await confirmAction(`Cancel schedule “${schedule.title}”?`, 'This removes the registered future schedule after a verified readback. Work that is already running is not stopped.')) return;
    busy = true;
    renderPlans();
    renderSchedules();
    schedulerNote = `Cancelling job ${short(schedule.jobId)}…`;
    schedulerError = false;
    showSchedulerNote();
    try {
      const result = await postScheduler({
        action: 'cancel-schedule', jobId: schedule.jobId,
        expectedRevision: schedule.revision, confirm: true, requestId: randomId(),
      });
      schedulerNote = `Schedule cancellation verified. Job ${short(result.jobId)} is absent from Task Scheduler readback; running work was not stopped.`;
      schedulerError = false;
    } catch (error) {
      schedulerNote = `Cancellation is not confirmed (${error.message || 'unknown error'}). Refresh and inspect Task Scheduler readback before retrying.`;
      schedulerError = true;
    } finally {
      busy = false;
      await refresh();
    }
  }

  async function deletePlan(plan) {
    if (!plannerActive()) return;
    if (!await confirmAction(`Delete draft “${plan.title}”?`, 'This removes only the planning draft. Any separately registered Ghost schedule remains unchanged and must be cancelled from Registered Ghost schedules.')) return;
    busy = true;
    render();
    renderPlans();
    setPlannerStatus(`Deleting draft ${plan.title}…`, false);
    try {
      const body = await postPlan({action: 'delete-draft', id: plan.id, expectedRevision: plan.revision, confirm: true, requestId: randomId()}, 'DELETE');
      setPlannerStatus(body.message || 'Draft removed.', false);
      if (($('plan-id')?.value || '') === plan.id) clearPlannerForm();
    } catch (error) {
      setPlannerStatus(`Delete refused: ${error.message || 'unknown error'}.`, true);
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
  function setPromptStatus(message, error) { const node = $('prompt-status'); if (!node) return; node.textContent = message || ''; node.className = `prompt-status${error ? ' error' : ''}`; }
  function promptConfirmed() { const input = $('prompt-confirm-input'); const word = $('prompt-confirm-word'); return Boolean(input && word && input.value.trim() === word.textContent.trim()); }
  function updatePromptSave() { const save = $('prompt-save'); if (save) save.disabled = !promptConfirmed() || busy; }
  function resetPromptConfirm() { const input = $('prompt-confirm-input'); if (input) input.value = ''; promptDiscardArmed = false; updatePromptSave(); }
  function promptDirty() { const entry = promptEntry(); const area = $('prompt-text'); return Boolean(entry && area && area.value !== (entry.text || '')); }
  function promptCount() {
    const entry = promptEntry(); const area = $('prompt-text'); const node = $('prompt-count');
    if (!node || !entry || !area) return;
    const n = area.value.length;
    node.textContent = `${n} / ${entry.maxChars} characters${n > entry.maxChars ? ' — over the limit; the save will be refused' : ''}`;
    node.className = `prompt-count${n > entry.maxChars ? ' error' : ''}`;
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
        tab.className = `prompt-tab${entry && item.id === entry.id ? ' active' : ''}`;
        tab.textContent = item.label;
        tab.onclick = () => { if (!promptView) return; if (promptDirty()) { setPromptStatus('Save or discard the edited prompt before switching tabs.', true); return; } promptView.entryId = item.id; resetPromptConfirm(); renderPromptDialog(); };
        tabs.append(tab);
      }
    }
    const area = $('prompt-text');
    if (area) { area.value = entry ? (entry.text || '') : ''; area.disabled = !entry || !active(); }
    text('prompt-meta', entry
      ? `revision ${entry.rev}${entry.updatedAt ? ` · updated ${localTime(entry.updatedAt)} by ${entry.by || 'unknown'}` : ''}${entry.onDisk ? '' : ' · file text differs from the recorded revision'}`
      : 'No prompt for this task.');
    text('prompt-help', entry
      ? `${entry.placeholders && entry.placeholders.length ? `Placeholders: ${entry.placeholders.map(p => `{{${p}}}`).join(', ')} (rendered at run time). ` : 'No placeholders allowed. '}Max ${entry.maxChars} characters. The shared policy preamble stays in code and is not editable here.`
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
          info.textContent = `r${String(rev.rev).padStart(4, '0')} · ${rev.at ? localTime(rev.at) : ''} · ${rev.by || 'unknown'}${rev.note ? ` · ${rev.note}` : ''}`;
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
    text('prompt-title', `Prompt — ${task.label}`);
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
  async function savePrompt() {
    const task = promptTask(); const entry = promptEntry(); const area = $('prompt-text');
    if (!task || !entry || !area || !active()) return;
    if (!promptConfirmed()) { setPromptStatus(`Type ${task.id} to confirm the save.`, true); return; }
    busy = true; updatePromptSave(); setPromptStatus('Saving prompt…', false);
    try {
      const body = await postControl({action: 'set-prompt', task: task.id, prompt: entry.id, text: area.value, confirm: true, requestId: randomId()});
      setAction(body.message || 'Prompt saved.', false);
      busy = false;
      closePrompt();
      await refresh();
    } catch (error) {
      setPromptStatus(`Save refused: ${error.message || 'unknown error'}. Nothing was written.`, true);
      busy = false; updatePromptSave();
    }
  }
  async function restorePrompt(rev) {
    const task = promptTask(); const entry = promptEntry();
    if (!task || !entry || !active()) return;
    const label = `r${String(rev).padStart(4, '0')}`;
    if (!await confirmAction(`Restore prompt revision ${label}?`, `The current text stays in history; this writes ${label} as a new revision.`)) return;
    busy = true; updatePromptSave(); setPromptStatus(`Restoring ${label}…`, false);
    try {
      const body = await postControl({action: 'revert-prompt', task: task.id, prompt: entry.id, rev, confirm: true, requestId: randomId()});
      setAction(body.message || 'Prompt revision restored.', false);
      busy = false;
      closePrompt();
      await refresh();
    } catch (error) {
      setPromptStatus(`Restore refused: ${error.message || 'unknown error'}. Nothing was written.`, true);
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
    if ($('activation-close')) $('activation-close').onclick = () => {
      activationPending = null;
      const button = $('activation-confirm'); if (button) button.disabled = true;
      $('activation-dialog')?.close();
    };
    if ($('activation-confirm')) $('activation-confirm').onclick = confirmActivation;
    $('activation-dialog')?.addEventListener('cancel', () => {
      activationPending = null;
      const button = $('activation-confirm'); if (button) button.disabled = true;
    });
    if ($('activation-copy')) $('activation-copy').onclick = async () => {
      const content = $('activation-json')?.value;
      if (!content) return;
      try {
        await navigator.clipboard.writeText(content);
        text('activation-status', 'Preview copied. No scheduler action was performed.');
      } catch {
        text('activation-status', 'Clipboard unavailable. Select the proposal text and copy manually.');
      }
    };
    if ($('plan-form')) $('plan-form').addEventListener('submit', savePlan);
    if ($('plan-reset')) $('plan-reset').onclick = () => { clearPlannerForm(); setPlannerStatus('', false); };
  }

  clearPlannerForm();
  const interval = setInterval(refresh, 20000);
  refresh();
  return () => {
    disposed = true;
    clearInterval(interval);
    const dialog = $('task-confirm'); if (dialog?.open) dialog.close();
    const prompt = $('prompt-dialog'); if (prompt?.open) prompt.close();
    const activation = $('activation-dialog'); if (activation?.open) activation.close();
  };
}
