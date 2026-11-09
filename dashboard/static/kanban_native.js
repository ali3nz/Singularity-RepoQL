// Native RepoQL view of the existing Kanzo board. Kanzo remains the only task store.
// The existing authenticated same-origin /embed/kanzo/ proxy remains the only transport.
const BASE = '/embed/kanzo/api';
const STAGE_LABEL = {backlog:'Backlog', todo:'To do', doing:'In progress', review:'Review', done:'Closed'};
const STAGE_ORDER = ['backlog','todo','doing','review','done'];
const text = value => String(value ?? '');
const el = (tag, className, content) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = text(content);
  return node;
};
const makeButton = (name, className, click) => {
  const button = el('button',className,name);
  button.type = 'button';
  button.addEventListener('click',click);
  return button;
};
const label = stage => STAGE_LABEL[stage] || stage;
const goodId = value => Number.isSafeInteger(value) && value > 0;
const taskSort = (a,b) => Number(a.position ?? 0) - Number(b.position ?? 0) || a.id-b.id;

export function mountNativeKanban(root, api, options={}) {
  let board = null, lastFocused = null, timer = null, active = true;
  let userSelectedStage = false, initialBoard = true, dirtyCheck = null, saving = false;
  let project = 'all', stage = 'queue', search = '', showAllDone = false, detailId = null;
  const movingTasks = new Set();
  let requestSerial = 0;
  let deepTask = goodId(options.initialTaskId) ? options.initialTaskId : null;
  const visibleLimit = new Map();
  const state = el('p','kn-status','Connecting to Kanzo…');
  state.setAttribute('role','status'); state.setAttribute('aria-live','polite');
  const toolbar = el('div','kn-toolbar');
  const results = el('div','kn-results');
  const kpiNav = el('nav','kn-kpis'); kpiNav.setAttribute('aria-label','Jump to a stage');
  const filterToggle = makeButton('Filters','kn-button kn-quiet kn-filter-toggle',()=>{
    const open = root.classList.toggle('kn-filters-open');
    filterToggle.setAttribute('aria-expanded',String(open));
  });
  filterToggle.setAttribute('aria-expanded','false');
  const laneNav = el('nav','kn-lanes'); laneNav.setAttribute('aria-label','Task stage shortcuts');
  const actions = el('div','kn-actions');
  const projectSelect = el('select','kn-select'); projectSelect.setAttribute('aria-label','Project');
  const searchField = el('input','kn-search'); searchField.type='search'; searchField.placeholder='Search tasks'; searchField.setAttribute('aria-label','Search Kanzo tasks');
  const stageSelect = el('select','kn-select kn-stage-select'); stageSelect.setAttribute('aria-label','Workflow stage');
  const doneCheckbox = el('input'); doneCheckbox.type='checkbox'; doneCheckbox.id='kn-done-all';
  const doneLabel = el('label','kn-done-label'); doneLabel.htmlFor='kn-done-all'; doneLabel.append(doneCheckbox, document.createTextNode(' All completed'));
  const refresh = makeButton('Refresh','kn-button kn-quiet',()=>refreshBoard({quiet:false}));
  const clearFilters = makeButton('Clear filters','kn-button kn-quiet kn-clear-filters',()=>{
    project='all'; stage='queue'; search=''; searchField.value=''; userSelectedStage=true; visibleLimit.clear(); render(); searchField.focus();
  });
  const newTask = makeButton('+ New task','kn-button kn-primary',()=>openNew());
  const original = el('a','kn-button kn-quiet','Full Kanzo'); original.href='/embed/kanzo/'; original.target='_blank'; original.rel='noopener noreferrer';
  toolbar.append(projectSelect,searchField,stageSelect,doneLabel,clearFilters);
  actions.append(newTask,refresh,original,filterToggle);
  const head = el('div','kn-head');
  const heading = el('div','kn-heading'); heading.append(el('h2',null,'Task board'),state);
  head.append(heading,actions);
  root.replaceChildren(kpiNav,head,toolbar,laneNav,results);
  const modal = el('dialog','kn-dialog');
  modal.setAttribute('aria-label','Kanzo task editor');
  root.append(modal);
  function status(message,error=false) {state.textContent=message; state.classList.toggle('kn-error',error);}
  function safeStages() {return board?.statuses?.filter(s=>typeof s==='string'&&STAGE_ORDER.includes(s)) || ['todo','doing','review','done'];}
  function projectOptions() {
    const projects=Array.isArray(board?.projects)?board.projects:[];
    projectSelect.replaceChildren(new Option('All projects','all'),...projects.filter(p=>typeof p.slug==='string').map(p=>new Option(p.name||p.slug,p.slug)));
    if (![...projectSelect.options].some(o=>o.value===project)) project='all';
    projectSelect.value=project;
    const stages=safeStages();
    stageSelect.replaceChildren(new Option('Work queue','queue'),new Option('All stages','all'),new Option('Active work','active'),...stages.map(s=>new Option(label(s),s)));
    if (!['all','active','queue',...stages].includes(stage)) stage='queue';
    stageSelect.value=stage;
    laneNav.replaceChildren();
    const baseTasks=(Array.isArray(board.tasks)?board.tasks:[]).filter(t=>(project==='all'||t.project===project)&&(!search||[t.title,t.description,t.project,t.id,...(Array.isArray(t.tags)?t.tags:[])].join(' ').toLocaleLowerCase().includes(search)));
    for (const [value,name] of [['queue','Work queue'],['active','Active'],['all','All'],...stages.map(s=>[s,label(s)])]) {
      const count=value==='all'?baseTasks.length:value==='queue'?baseTasks.filter(t=>['todo','doing','review'].includes(t.status)).length:value==='active'?baseTasks.filter(t=>['doing','review'].includes(t.status)).length:baseTasks.filter(t=>t.status===value).length;
      const older=value==='done' && project==='all' && !search && !showAllDone ? Number(board?.done_hidden)||0 : 0;
      const chip=makeButton(`${name} · ${count}${older?` (+${older} older)`:''}`,'kn-lane'+(stage===value?' selected':''),()=>{stage=value;userSelectedStage=true;visibleLimit.clear();render();});
      chip.dataset.stage=value;
      chip.setAttribute('aria-pressed',String(stage===value));
      chip.setAttribute('aria-label',`${name}: ${count} task${count===1?'':'s'}`);
      laneNav.append(chip);
    }
  }
  function selectedTasks() {
    const tasks=Array.isArray(board?.tasks)?board.tasks:[];
    return tasks.filter(t=>goodId(t.id)&&typeof t.title==='string'&&typeof t.status==='string'&&
      (project==='all'||t.project===project)&&
      (stage==='all'||t.status===stage||(stage==='active'&&['doing','review'].includes(t.status))||(stage==='queue'&&['todo','doing','review'].includes(t.status)))&&
      (!search||[t.title,t.description,t.project,t.id,...(Array.isArray(t.tags)?t.tags:[])].join(' ').toLocaleLowerCase().includes(search)));
  }
  // Stage transitions update Kanzo only. A Kanzo work claim is a distinct operation.
  async function moveTask(t, nextStage) {
    if (!goodId(t.id) || movingTasks.has(t.id) || t.status===nextStage) return;
    if (['review','done'].includes(nextStage) && !window.confirm(`Move ${t.project}#${t.id} to ${label(nextStage)}? This updates the real Kanzo board.`)) return;
    movingTasks.add(t.id);
    try {
      status(`Checking ${t.project}#${t.id}…`);
      const latest=await api(`${BASE}/tasks/${t.id}`);
      if (!active || latest?.task?.status!==t.status) throw Error('Task stage changed in Kanzo; refresh before moving it.');
      status(`Moving ${t.project}#${t.id}…`);
      await api(`${BASE}/tasks/${t.id}/move`,{method:'POST',body:{status:nextStage}});
      const persisted=await api(`${BASE}/tasks/${t.id}`);
      if (!active || persisted?.task?.status!==nextStage) {
        throw Error('Kanzo did not confirm the new task stage. Refresh and investigate before treating this as In progress or Closed.');
      }
      await refreshBoard({quiet:false});
    } catch(error) { if(active) status(readError(error),true); }
    finally { movingTasks.delete(t.id); }
  }
  function commentCount(n) {
    const wrap=el('span','kn-comment-count');
    const icon=document.createElementNS('http://www.w3.org/2000/svg','svg');
    icon.setAttribute('viewBox','0 0 16 16'); icon.setAttribute('aria-hidden','true'); icon.setAttribute('focusable','false');
    const bubble=document.createElementNS('http://www.w3.org/2000/svg','path');
    bubble.setAttribute('d','M3 3.5h10a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H7.2L4.6 13v-2.4H3a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z');
    bubble.setAttribute('fill','none'); bubble.setAttribute('stroke','currentColor'); bubble.setAttribute('stroke-width','1.3'); bubble.setAttribute('stroke-linejoin','round');
    icon.append(bubble);
    wrap.append(icon,document.createTextNode(`${n} comment${n===1?'':'s'}`));
    return wrap;
  }
  function taskCard(t) {
    const wrapper=el('div','kn-task-row');
    const card=makeButton('','kn-task',()=>openTask(t.id));
    card.dataset.id=String(t.id);
    card.draggable=true;
    card.addEventListener('dragstart',event=>{
      if(!event.dataTransfer)return;
      event.dataTransfer.setData('application/x-repoql-kanzo-task',String(t.id));
      event.dataTransfer.effectAllowed='move';
    });
    const top=el('div','kn-task-top');
    top.append(el('span','kn-key',`${t.project}#${t.id}`));
    if(t.human) top.append(el('span','kn-human','Human'));
    const title=el('strong','kn-task-title',t.title);
    card.dataset.stage=t.status;
    const summary=el('p','kn-task-description',t.description||'');
    const bottom=el('div','kn-task-bottom');
    if(t.comments) bottom.append(commentCount(t.comments));
    (Array.isArray(t.tags)?t.tags:[]).slice(0,2).forEach(tag=>bottom.append(el('span','kn-tag',tag)));
    card.append(top,title,summary,bottom);
    wrapper.append(card);
    const next=t.status==='todo'?'doing':t.status==='doing'?'review':null;
    if(next && stage==='queue') {
      const advance=makeButton(next==='doing'?'Move to In progress':'Move to Review','kn-task-advance',()=>moveTask(t,next));
      advance.setAttribute('aria-label',`${next==='doing'?'Move to In progress':'Move to Review'}: ${t.title}`);
      wrapper.append(advance);
    }
    return wrapper;
  }
  function render() {
    if (!active || !root.isConnected || !board) return;
    const oldFocused = document.activeElement?.closest?.('.kn-task')?.dataset.id;
    projectOptions();
    const rows=selectedTasks().sort(taskSort);
    const allTasks=(Array.isArray(board.tasks)?board.tasks:[]).filter(t=>goodId(t.id));
    const hiddenDone=Math.max(0,Number(board.done_hidden)||0);
    const scoped=allTasks.filter(t=>(project==='all'||t.project===project)&&(!search||[t.title,t.description,t.project,t.id,...(Array.isArray(t.tags)?t.tags:[])].join(' ').toLocaleLowerCase().includes(search)));
    const count=s=>scoped.filter(t=>t.status===s).length;
    const kpiDefs=[['all','Total',scoped.length,'kpi-all'],['doing','In progress',count('doing'),'kpi-doing'],['review','Review',count('review'),'kpi-review'],['done','Closed',count('done'),'kpi-done']];
    kpiNav.replaceChildren(...kpiDefs.map(([value,name,n,cls])=>{
      const b=makeButton('',`kn-kpi ${cls}`+(stage===value?' selected':''),()=>{stage=value;userSelectedStage=true;visibleLimit.clear();render();results.scrollIntoView({block:'start',behavior:'smooth'});});
      b.append(el('strong',null,n),el('span',null,name));
      b.setAttribute('aria-pressed',String(stage===value));
      b.setAttribute('aria-label',`${name}: ${n} task${n===1?'':'s'}. Show ${name.toLowerCase()}`);
      return b;
    }));
    clearFilters.hidden = project==='all' && stage==='queue' && !search;
    results.replaceChildren();
    const activeCount=rows.filter(t=>['doing','review'].includes(t.status)).length;
    const stages=stage==='queue' ? (activeCount?['doing','review','todo']:['todo']).filter(s=>safeStages().includes(s))
      :safeStages().filter(s=>stage==='all'||stage===s||(stage==='active'&&['doing','review'].includes(s)));
    if(!rows.length){
      results.className='kn-results kn-focused';
      const blank=el('div','kn-empty');
      blank.append(el('h3',null,stage==='queue'?'No work queued':'No matching tasks'));
      if(stage==='queue' && !search && project==='all') {
        blank.append(el('p',null,'No tasks are currently in To do, In progress or Review. Backlog and completed work are kept separate.'));
        if(count('backlog')) blank.append(makeButton(`View backlog · ${count('backlog')}`,'kn-button kn-primary',()=>{stage='backlog';userSelectedStage=true;render();}));
      }
      else if (search || stage!=='all' || project!=='all') blank.append(el('p',null,'Nothing matches your current filters.'),makeButton('Show work queue','kn-button kn-primary',()=>clearFilters.click()));
      else {
        blank.append(el('p',null,'There are no tasks on this board yet.'));
        if(board.projects.length) blank.append(makeButton('Create task','kn-button kn-primary',openNew));
      }
      if(hiddenDone && !showAllDone) blank.append(makeButton(`Include ${hiddenDone} older completed tasks`,'kn-button kn-quiet',()=>{doneCheckbox.checked=true;showAllDone=true;refreshBoard({quiet:false});}));
      results.append(blank);return;
    }
    results.className='kn-results '+(stage==='queue'?'kn-queue':(['all','active'].includes(stage)?'kn-columns':'kn-focused'));
    results.classList.toggle('kn-queue-has-active',activeCount>0);
    for (const s of stages) {
      const column=el('section','kn-column'); column.dataset.stage=s;
      const tasks=rows.filter(t=>t.status===s);
      column.addEventListener('dragover',event=>{
        if(!Array.from(event.dataTransfer?.types||[]).includes('application/x-repoql-kanzo-task'))return;
        event.preventDefault();event.dataTransfer.dropEffect='move';column.classList.add('kn-drop-target');
      });
      column.addEventListener('dragleave',event=>{if(!column.contains(event.relatedTarget))column.classList.remove('kn-drop-target');});
      column.addEventListener('drop',async event=>{
        event.preventDefault();column.classList.remove('kn-drop-target');
        const id=Number(event.dataTransfer?.getData('application/x-repoql-kanzo-task'));
        const task=board?.tasks.find(t=>t.id===id);
        if(!goodId(id)||!task||task.status===s)return;
        await moveTask(task,s);
      });
      const title=el('header','kn-column-head');
      const textWrap=el('div','kn-column-title');
      textWrap.append(el('h3',null,label(s)),el('span','kn-count',tasks.length));
      title.append(textWrap);
      if(!results.querySelector('.kn-column-new')){const nb=makeButton('+','kn-column-new',()=>openNew());nb.setAttribute('aria-label','New task');nb.append(el('span',null,'New'));title.append(nb);}
      column.append(title);
      const list=el('div','kn-cards');
      const pageSize=matchMedia('(max-width:760px)').matches?20:40;
      const limit=visibleLimit.get(s)||pageSize;
      tasks.slice(0,limit).forEach(t=>list.append(taskCard(t)));
      if(tasks.length>limit) {
        const more=makeButton(`Show more · ${tasks.length-limit} remaining`,'kn-button kn-more-tasks',()=>{visibleLimit.set(s,limit+pageSize);render();});
        list.append(more);
      }
      if(!tasks.length) list.append(el('p','kn-column-empty',s==='doing'?'Nothing in progress':s==='review'?'Nothing in review':'No tasks'));
      column.append(list);results.append(column);
    }
    // Replace two empty full-width columns with one concise, factual status panel.
    if(stage==='queue' && !activeCount) {
      const idle=el('section','kn-idle-activity');
      idle.setAttribute('aria-label','Active workflow status');
      const icon=el('span','kn-idle-dot'); icon.setAttribute('aria-hidden','true');
      const copy=el('div','kn-idle-copy');
      copy.append(el('strong',null,'No tasks in progress or review'),
        el('span',null,'Ready work is shown above. Stage changes reflect Kanzo task status, not agent ownership.'));
      idle.append(icon,copy);results.append(idle);
    }
    if(oldFocused) {
      const nextFocus=[...results.querySelectorAll('.kn-task')].find(c=>c.dataset.id===oldFocused);
      if(nextFocus) nextFocus.focus({preventScroll:true});
    }
  }
  function readError(e) {return e?.message || 'Kanzo request failed';}
  async function refreshBoard({quiet=true}={}) {
    if (!active || !root.isConnected) return;
    const seq=++requestSerial;
    if(!quiet) status('Refreshing tasks…');
    try {
      const payload=await api(`${BASE}/board?project=all${showAllDone?'&done=all':''}`);
      if(!active||!root.isConnected||seq!==requestSerial) return;
      if(!payload||!Array.isArray(payload.tasks)||!Array.isArray(payload.projects)||!Array.isArray(payload.statuses)) throw Error('Unexpected Kanzo board response');
      const unchanged=quiet && board && typeof board.changes==='string' && typeof payload.changes==='string'
        && board.changes===payload.changes && (Number(board.done_hidden)||0)===(Number(payload.done_hidden)||0);
      board=payload;
      // Work queue is the same default on desktop and mobile; completed tasks never crowd it.
      initialBoard=false; if(!unchanged) render();
      if(deepTask !== null) {
        const target=deepTask;deepTask=null;
        // Deep links do not modify a board or claim: Kanzo validates the ID.
        void openTask(target);
      }
      const hidden=Number(payload.done_hidden)||0;
      status(`Kanzo synced · ${new Date().toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}${hidden&&!showAllDone?` · ${hidden} older completed tasks excluded`:''}`);
    } catch(e) {if(active&&root.isConnected&&seq===requestSerial) status(`Refresh failed · ${readError(e)}${board?' · showing last loaded board':''}`,true);}
  }
  function modalClose(){
    if(saving) return;
    if(dirtyCheck?.() && !window.confirm('Discard unsaved task changes?')) return;
    dirtyCheck=null; if(modal.open) modal.close(); detailId=null;lastFocused?.focus?.();
  }
  function field(title,name,value,tag='input') {
    const wrap=el('label','kn-field');wrap.append(el('span',null,title));
    const control=el(tag,'kn-field-control');control.name=name;
    if(tag==='textarea')control.rows=5;
    control.value=text(value);wrap.append(control);return [wrap,control];
  }
  function modalLayout(title) {
    dirtyCheck=null;modal.replaceChildren();const header=el('div','kn-modal-head');
    const heading=el('h2',null,title); heading.id='kn-modal-heading';
    modal.setAttribute('aria-labelledby','kn-modal-heading');
    const close=makeButton('×','kn-modal-close',modalClose); close.setAttribute('aria-label','Close task editor');
    header.append(heading,close);
    const form=el('form','kn-form');form.method='dialog';modal.append(header,form);return form;
  }
  function formActions(form,confirmLabel,onSave){
    const actions=el('div','kn-form-actions');
    const cancel=makeButton('Cancel','kn-button kn-quiet',modalClose);
    const submit=el('button','kn-button kn-primary',confirmLabel);submit.type='submit';
    const msg=el('p','kn-form-feedback');msg.setAttribute('role','status');msg.setAttribute('aria-live','polite');
    actions.append(cancel,submit);form.append(msg,actions);
    form.addEventListener('submit',async ev=>{
      ev.preventDefault();if(submit.disabled)return;
      submit.disabled=true;saving=true;msg.classList.remove('kn-error');msg.textContent='Saving…';
      try {const saved=await onSave();if(saved===false){msg.textContent='Move cancelled';return;}
        dirtyCheck=null;saving=false;modalClose();await refreshBoard({quiet:false});
      }catch(e){msg.textContent=readError(e);msg.classList.add('kn-error');}
      finally{saving=false;submit.disabled=false;}
    });
  }
  function openNew(){
    if(!board)return;const projects=Array.isArray(board.projects)?board.projects:[];
    if(!projects.length){status('Create a project in Full Kanzo first.',true);return;}
    lastFocused=document.activeElement;const form=modalLayout('New task');
    const selectWrap=el('label','kn-field');selectWrap.append(el('span',null,'Project'));
    const select=el('select','kn-field-control');
    projects.forEach(p=>select.append(new Option(p.name||p.slug,p.slug)));
    select.value=project==='all'?projects[0].slug:project; selectWrap.append(select);
    const [titleWrap,title]=field('Title','title',''); title.required=true;title.maxLength=400;
    const [descWrap,desc]=field('Description','description','','textarea');
    form.append(selectWrap,titleWrap,descWrap);
    dirtyCheck=()=>Boolean(title.value.trim()||desc.value.trim());
    formActions(form,'Create task',async()=>{
      const taskTitle=title.value.trim();if(!taskTitle)throw Error('A title is required');
      const result=await api(`${BASE}/tasks`,{method:'POST',body:{project:select.value,title:taskTitle,description:desc.value}});
      // New tasks begin in To do. Make the created item discoverable even if an old filter hid it.
      project=select.value;stage='todo';search='';searchField.value='';userSelectedStage=true;visibleLimit.clear();
      return result;
    });
    modal.showModal();title.focus();
  }
  async function openTask(id){
    if(!goodId(id))return;lastFocused=document.activeElement;detailId=id;
    const form=modalLayout('Task details');form.append(el('p','kn-loading','Loading task…'));
    modal.showModal();
    try{
      const data=await api(`${BASE}/tasks/${id}`);
      if(!active || detailId!==id || !modal.open)return;
      if(!data?.task||data.task.id!==id||!Array.isArray(data.comments))throw Error('Unexpected task response');
      const t=data.task;form.replaceChildren();
      const deepLink=el('a','kn-full-task','Open in full Kanzo for attachments and advanced controls');
      deepLink.href=`/embed/kanzo/#${encodeURIComponent(t.project)}/${id}`;deepLink.target='_blank';deepLink.rel='noopener noreferrer';
      form.append(deepLink);
      const [titleWrap,title]=field('Task','title',t.title);title.required=true;title.maxLength=400;
      const [descWrap,description]=field('Description','description',t.description,'textarea');
      const [tagsWrap,tags]=field('Tags, comma separated','tags',(t.tags||[]).join(', '));
      const statusWrap=el('label','kn-field'); statusWrap.append(el('span',null,'Workflow stage'));
      const stagePick=el('select','kn-field-control');
      [...new Set([...safeStages(),t.status])].forEach(s=>stagePick.append(new Option(label(s),s)));
      stagePick.value=t.status; statusWrap.append(stagePick);
      const ownerWrap=el('label','kn-human-field');const human=el('input');human.type='checkbox';human.checked=Boolean(t.human);
      ownerWrap.append(human,document.createTextNode(' Human owned task'));
      const identity=el('div','kn-identity-row');
      const taskKey=`${t.project}#${t.id}`;
      const copyNotice=el('span','kn-copy-notice');copyNotice.setAttribute('role','status');
      const copy=makeButton('Copy task ID','kn-button kn-quiet kn-copy-key',async()=>{
        try {if(!navigator.clipboard?.writeText) throw Error('Clipboard is not available');
          await navigator.clipboard.writeText(taskKey); copyNotice.textContent='Copied';
        }catch {copyNotice.textContent='Copy is unavailable in this browser';}
      });
      identity.append(el('p','kn-task-identity',taskKey),copy,copyNotice);
      form.append(identity,titleWrap,descWrap,tagsWrap,statusWrap,ownerWrap);
      const comments=el('section','kn-comments');comments.append(el('h3',null,`Comments (${data.comments.length})`));
      const history=el('div','kn-comment-list');
      data.comments.slice(-30).forEach(c=>{
        const entry=el('div','kn-comment');
        entry.append(el('strong',null,c.author||'Comment'),el('p',null,c.body));history.append(entry);
      });
      if(!data.comments.length)history.append(el('p','kn-empty-inline','No comments yet'));
      comments.append(history);
      const [commentWrap,comment]=field('Add comment','comment','','textarea');comment.rows=2;
      comments.append(commentWrap);form.append(comments);
      const changed=()=>title.value.trim()!==t.title||description.value!==t.description||tags.value!==(t.tags||[]).join(', ')||human.checked!==Boolean(t.human)||stagePick.value!==t.status;
      dirtyCheck=()=>changed()||Boolean(comment.value.trim());
      formActions(form,'Save changes',async()=>{
        const name=title.value.trim();if(!name)throw Error('A task title is required');
        const patch={title:name,description:description.value,tags:tags.value,human:human.checked};
        const changedStage=stagePick.value!==t.status;
        if(!dirtyCheck()) return true;
        // Kanzo is shared with live agents. Re-read before overwriting task fields or stage.
        if(changed()) {
          const latest=await api(`${BASE}/tasks/${id}`);
          const r=latest?.task;
          if(!r || r.title!==t.title || r.description!==t.description || r.status!==t.status ||
              Boolean(r.human)!==Boolean(t.human) || JSON.stringify(r.tags||[])!==JSON.stringify(t.tags||[]))
            throw Error('This task changed in Kanzo. Close and reopen it before saving to avoid overwriting another agent.');
        }
        if(changedStage && ['review','done'].includes(stagePick.value)) {
          if(!window.confirm(`Move ${t.project}#${id} to ${label(stagePick.value)}? This changes the real Kanzo board.`))return false;
        }
        if(name!==t.title||description.value!==t.description||tags.value!==(t.tags||[]).join(', ')||human.checked!==t.human) await api(`${BASE}/tasks/${id}`,{method:'PATCH',body:patch});
        if(changedStage) {
          await api(`${BASE}/tasks/${id}/move`,{method:'POST',body:{status:stagePick.value}});
          const persisted=await api(`${BASE}/tasks/${id}`);
          if (persisted?.task?.status!==stagePick.value) throw Error('Kanzo did not confirm the requested task stage; reopen the task before continuing.');
        }
        if(comment.value.trim())await api(`${BASE}/tasks/${id}/comments`,{method:'POST',body:{body:comment.value.trim()}});
        // A saved task should remain findable in the stage it moved to.
        if(changedStage) {stage=stagePick.value;userSelectedStage=true;visibleLimit.clear();}
      });
      title.focus();
    }catch(e){
      if(detailId===id&&modal.open){form.replaceChildren(el('p','kn-error',readError(e)),makeButton('Close','kn-button',modalClose));}
    }
  }
  projectSelect.addEventListener('change',()=>{project=projectSelect.value;visibleLimit.clear();render();});
  stageSelect.addEventListener('change',()=>{stage=stageSelect.value;userSelectedStage=true;visibleLimit.clear();render();});
  searchField.addEventListener('input',()=>{
    search=searchField.value.trim().toLocaleLowerCase();
    if(search && stage!=='all') {stage='all';userSelectedStage=true;}
    visibleLimit.clear();render();
  });
  doneCheckbox.addEventListener('change',()=>{showAllDone=doneCheckbox.checked;refreshBoard({quiet:false});});
  modal.addEventListener('cancel',event=>{event.preventDefault();modalClose();});
  modal.addEventListener('close',()=>{detailId=null;dirtyCheck=null;lastFocused?.focus?.();});
  const onKey=e=>{
    if(modal.open||e.altKey||e.ctrlKey||e.metaKey||['INPUT','TEXTAREA','SELECT'].includes(e.target?.tagName)) return;
    if(e.key==='/'||e.key==='s') {e.preventDefault();searchField.focus();}
    else if(e.key==='n') {e.preventDefault();openNew();}
  };
  root.addEventListener('keydown',onKey);
  refreshBoard({quiet:false});
  const onVisibility=()=>{if(!document.hidden&&!modal.open) refreshBoard();};
  document.addEventListener('visibilitychange',onVisibility);
  // A background refresh re-renders the cards and snaps the scroll position back. Doing that
  // while a finger is still scrolling (momentum included) makes the sticky header and stage
  // tiles shudder on iOS, so refreshes wait until scrolling has been quiet for a moment.
  let lastScroll=0;
  const onScroll=()=>{lastScroll=Date.now();};
  window.addEventListener('scroll',onScroll,{passive:true});
  const scrolling=()=>Date.now()-lastScroll<1500;
  const poll=()=>{if(!active||!root.isConnected)return;if(!document.hidden&&!modal.open&&!scrolling())refreshBoard();timer=setTimeout(poll,scrolling()?2000:20000);};
  timer=setTimeout(poll,20000);
  return ()=>{active=false;requestSerial++;clearTimeout(timer);if(modal.open)modal.close();root.removeEventListener('keydown',onKey);document.removeEventListener('visibilitychange',onVisibility);window.removeEventListener('scroll',onScroll);};
}
