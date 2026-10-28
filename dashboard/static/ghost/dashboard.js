// Ghost's real telemetry and schedule controls, mounted directly within RepoQL.
// The same hub also powers Ghost's optional standalone HTML page.
import {ghostFetch} from './api.js';
import {mountGhostTasks} from './tasks.js';

export function mountGhost(root) {
  let disposed=false,pollTimer=null;
const $=id=>root.querySelector(`#${id}`);let latest=null,displayed=null,paused=false,filter='all',networkError=false,page=0;const pageSize=6;
function applyTheme(theme){const safe=theme==='classic'?'classic':'neon';if(root.host)root.host.dataset.theme=safe;else document.documentElement.dataset.theme=safe;$('theme-picker').value=safe;return safe}
try{applyTheme(localStorage.getItem('ghost-theme'))}catch{applyTheme('neon')}
$('theme-picker').onchange=()=>{const theme=applyTheme($('theme-picker').value);try{localStorage.setItem('ghost-theme',theme)}catch{}};
for(const [id,cls] of [['work-title','work-identity'],['work-detail','work-detail']]){const p=document.createElement('p');p.id=id;p.className=cls;root.querySelector('.hero .model').before(p)}
function renderWorkIdentity(data,stale){const run=(data.runs||[])[0],pending=(data.sessions||[]).find(s=>s.state==='pending'),recent=(data.sessions||[])[0],owner=run?.owner;
if(stale){text('work-title','Work identity unavailable');text('work-detail','Waiting for fresh telemetry.');return}
if(run&&owner?.title){text('work-title',(owner.kind==='schedule'?'Scheduled job · ':owner.kind==='conversation'?'Conversation · ':owner.kind==='transport'?'Backend · ':'Task · ')+owner.title);text('work-detail',owner.source||'Attributed task metadata');return}
if(run){const waiting=(data.sessions||[]).filter(s=>s.state==='pending');text('work-title',waiting.length?'Active native '+(waiting.length===1?'conversation · ':'conversations · ')+waiting.map(s=>s.title||'Untitled conversation').join(' / '):'Background work · origin not yet attributed');text('work-detail',waiting.length?'Native chats are active; the backend run has not been causally linked to a specific chat.':'No matching native conversation or scheduled-job identity has been verified.');return}
if(pending){text('work-title','Conversation · '+(pending.title||'Untitled conversation'));text('work-detail','Native conversation has an unanswered turn. Provider inference has not been verified in this snapshot.');return}
text('work-title',recent?'Last conversation · '+(recent.title||'Untitled conversation'):'No active work observed');text('work-detail','No active conversation or attributed background inference in this snapshot.');}
const ago=ms=>{if(ms==null||!Number.isFinite(ms))return 'Not observed';let s=Math.max(0,Math.floor(ms/1000));return s<60?s+'s ago':s<3600?Math.floor(s/60)+'m '+s%60+'s ago':Math.floor(s/3600)+'h '+Math.floor(s%3600/60)+'m ago'};
const duration=ms=>{let s=Math.max(0,Math.floor(ms/1000));return [Math.floor(s/3600),Math.floor(s%3600/60),s%60].map(x=>String(x).padStart(2,'0')).join(':')};
const text=(id,v)=>$(id).textContent=v;
const descriptions={working:['Working','ACTIVE','An attributed Ghost model run is alive. Progress below reflects real model-call advancement, not connection heartbeats.'],retrying:['Rate-limit retry','RETRYING','Ghost is still running. The provider recently rate-limited a request; Ghost is retrying the same model.'],waiting:['Awaiting inference','PENDING','A native conversation has an unanswered turn, but no attributed model process was observed in this snapshot. This does not prove a stall.'],idle:['Standing by','IDLE','The observed native conversations are settled and no attributed Ghost model run is active.'],unknown:['Telemetry unavailable','UNVERIFIED','Fresh, complete telemetry is unavailable. Previous events are historical, not proof of current activity.']};
function render(){if(!latest)return;const now=Date.now(),age=now-latest.generatedAt;const stale=latest.collector!=='ok'||!Number.isFinite(age)||age>45000||age< -5000||latest.stale||networkError;const state=stale?'unknown':latest.state;const desc=descriptions[state]||descriptions.unknown;
text('state',desc[0]);text('phase',desc[1]);text('statuscopy',desc[2]);$('hero').className='hero '+(state==='retrying'?'warning':state==='unknown'?'unknown':'');$('connection').className='connection '+(stale?'offline':'live');text('connectionText',stale?'Telemetry unavailable / stale':'Live observer · refreshes automatically');$('notice').hidden=!stale;text('notice',networkError?'Connection to the status page failed. Showing historical data; current Ghost activity is not verified.':latest.error||'The telemetry snapshot is stale. Current Ghost activity is not verified.');
const runs=latest.runs||[],r=runs[0],pending=(latest.sessions||[]).find(s=>s.state==='pending');const start=r?.started||pending?.started;text('elapsed',!stale&&start?duration(now-start):'—');text('elapsedScope',r?(r.transport==='freebuff'?'Freebuff Ghost turn':'Managed run'):pending?'Native conversation':'No observed active turn');text('model',stale?'Not verified':r?.model||(pending?.selectedModel?'Selected: '+pending.selectedModel+' · inference not verified':'No active provider run'));
const last=Math.max(0,...runs.map(x=>x.lastProgress||0));text('progress',!stale&&last?ago(now-last):'—');const managed=runs.filter(x=>x.transport!=='freebuff'),retries=managed.reduce((n,x)=>n+x.retries,0);text('retries',stale?'—':managed.length?String(retries):'Not observed');text('retryHint',managed.length?'Managed HTTP 429 · '+managed.reduce((n,x)=>n+x.retries15m,0)+' in the last 15 minutes':'Freebuff retry telemetry is not collected');text('timeouts',latest.timeout?.state==='observed'?String(latest.timeout.count)+' observed':'Not observed');$('timeouts').className='value '+(latest.timeout?.state==='observed'?'red':'');text('deadline',r?.deadline==='none'?'None':'Not reported');text('deadlineHint',r?.deadline==='none'?'No fixed Step-5 inference cutoff':'No active policy evidence');
text('collector',stale?'Stale data':'Healthy');text('snapshotAge',Number.isFinite(age)?ago(age):'Not reported');text('runCount',stale?'Not verified':runs.length+' active');text('coverage-note',latest.sources?.freebuff?.state==='ok'?'Managed + Freebuff sources observed. Heartbeats are not progress; native chat ownership is not inferred from timing.':'Freebuff attribution unavailable or unverified. Other observed runs remain visible; missing provider evidence is not idle.');const recovery=(latest.events||[]).find(e=>e.kind==='recovered');text('recovery',recovery?ago(now-recovery.at):'Not observed');text('updated','Snapshot '+(latest.generatedAt?new Date(latest.generatedAt).toLocaleTimeString():'unavailable')+' · auto-refresh 5s');
const sessions=$('sessions');sessions.replaceChildren();
for(const s of latest.sessions||[]){
 const row=document.createElement('div');row.className='session';
 const name=document.createElement('div');name.textContent=s.title||'Untitled conversation';
 const sub=document.createElement('small');sub.textContent='…'+s.id.slice(-10)+(s.lastEvent?' · '+new Date(s.lastEvent).toLocaleTimeString():'');name.append(sub);
 const status=document.createElement('span');status.textContent=stale?'Not verified':s.state==='pending'?'Pending':s.outcome||s.state;status.className=s.state==='pending'?'amber':'cyan';row.append(name,status);sessions.append(row);
}
if(!sessions.children.length){const e=document.createElement('div');e.className='empty';e.textContent='No native conversations observed.';sessions.append(e)}
renderWorkIdentity(latest,stale);renderMemory(latest.memory,stale);renderCalendar(latest,stale);renderActivity(latest.activity,stale);
if(!paused)displayed=latest.events||[];renderLog();}
const names={request:['INFERENCE','Model request started','Observed provider call; not a completed task.'],rate_limit:['HTTP 429','Provider rate limit · retry scheduled','Same model retained; no automatic fallback.'],recovered:['RECOVERED','Provider request recovered','A previously retried request succeeded.'],timeout:['TIMEOUT','Explicit provider timeout','Reported by provider retry telemetry, not inferred from duration.'],connection_failure:['NETWORK','Provider connection failure','Explicit retry classification.'],provider_error:['PROVIDER','Provider error','Explicit retry classification.'],exhausted:['FAILED','Provider retry policy exhausted','Request-level failure; whole-turn outcome may differ.']};
function renderMemory(memory,stale){const box=$('memory-stats');box.replaceChildren();if(!memory||stale){box.textContent='Memory metadata unavailable / stale.';return}for(const group of memory.groups||[]){const row=document.createElement('div');row.className='drow';const label=document.createElement('span');label.textContent=group.label;const value=document.createElement('strong');value.textContent=group.state==='unavailable'?'Unavailable':(group.state==='partial'?'At least ':'')+Number(group.files).toLocaleString()+' files · '+(group.bytes/1048576).toFixed(2)+' MiB';row.append(label,value);box.append(row)}text('memory-note','Stored file metadata · observed '+new Date(memory.observedAt).toLocaleString()+'. Counts include archives and are not context tokens, recall quality, or unique facts. No memory contents are exposed.');}
function renderCalendar(data,stale){const cal=data.calendar,chip=$('calendar-state'),banner=$('calendar-banner'),box=$('calendar-entries');
 const ST={completed:['RAN · OK','Completed — verified'],failed:['FAILED','Failed on this date'],missed:['NOT RUN','Missed — lock held'],running:['RUNNING','Running now'],upcoming:['UPCOMING','Not started yet'],unknown:['UNVERIFIED','Outcome not verified']};
 if(!cal){chip.textContent='NO CALENDAR DATA';chip.className='control-chip red';banner.hidden=true;banner.replaceChildren();box.replaceChildren();const e=document.createElement('div');e.className='empty';e.textContent='Calendar observer has not produced data yet.';box.append(e);text('calendar-summary','');text('calendar-note','Calendar data unavailable.');text('calendar-range','');return}
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Pacific/Auckland',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 const entries=(cal.entries||[]).filter(e=>e.nzDate===today).slice().sort((a,b)=>(a.startMs||0)-(b.startMs||0));
 const s={};for(const e of entries)s[e.outcome]=(s[e.outcome]||0)+1;
 text('calendar-summary',entries.length+' scheduled'+Object.entries(ST).filter(([key])=>s[key]).map(([key,value])=>' · '+s[key]+' '+value[0].toLowerCase().replace(' · ',' ')).join(''));
  chip.textContent=(stale?'HISTORICAL · OBSERVER STALE':cal.ok?(cal.source==='live'?'LIVE':'CACHED '+fmtWhen(cal.observedAt)):'STALE · READ FAILED')+(cal.truncated?' · TRUNCATED':'');
  chip.className='control-chip'+(stale?' amber':cal.source==='live'?'':cal.ok?' amber':' red');
 const fails=(s.failed||0)+(s.missed||0);
 if(fails>0){banner.hidden=false;banner.className='cal-banner'+(stale?' stale':'');const n=document.createElement('strong');n.textContent=String(fails);const m=document.createElement('span');m.textContent=(s.failed?s.failed+' failed':'')+((s.failed&&s.missed)?' · ':'')+(s.missed?s.missed+' did not run':'')+' today';banner.replaceChildren(n,m)}else{banner.hidden=true;banner.replaceChildren()}
 box.replaceChildren();
 if(!entries.length){const e=document.createElement('div');e.className='empty';e.textContent=stale?'Today’s schedule is unavailable in this historical snapshot.':!cal.ok?'Calendar read failed — today’s schedule is unavailable.':cal.truncated?'No entries for today in the incomplete calendar data.':'No Companion tasks scheduled today.';box.append(e)}
 let cur=null,day=null;
 for(const e of entries){
  if(e.nzDate!==cur){cur=e.nzDate;day=document.createElement('div');day.className='cal-day';const h=document.createElement('div');h.className='cal-dayhead';const b=document.createElement('b');b.textContent=fmtDay(cur);const w=document.createElement('span');w.className='micro';w.textContent='NZ '+cur;h.append(b,w);day.append(h);box.append(day)}
  const meta=ST[e.outcome]||ST.unknown;
  const row=document.createElement('div');row.className='cal-entry '+e.outcome;
  const c=document.createElement('span');c.className='cal-chip';c.textContent=meta[0];
  const t=document.createElement('div');t.className='cal-title';t.textContent=e.title||'(untitled)';
  const times=document.createElement('div');times.className='cal-times';
  const z=document.createElement('span');z.textContent=e.allDay?'All day':e.startMs?new Date(e.startMs).toLocaleTimeString('en-GB',{timeZone:'Pacific/Auckland',hour:'2-digit',minute:'2-digit',hour12:false}):'—';
  times.append(z);
  c.title=meta[1]+(e.note?(' · '+e.note):'');c.setAttribute('aria-label',c.title);c.tabIndex=0;
  row.append(times,t,c);day.append(row);
 }
 text('calendar-note',stale?'Snapshot stale — historical outcomes, not fresh-verified.':(cal.ok?'Verified task evidence only. Unverified does not mean the task did not run.':(cal.error||'Calendar read failed; showing retained entries.')));
 text('calendar-range',today+' · NZ'+(cal.observedAt?' · calendar read '+new Date(cal.observedAt).toLocaleTimeString('en-GB',{timeZone:'Pacific/Auckland',hour:'2-digit',minute:'2-digit'}):''));
}
let activitySignature='',activityRun=null;
function renderActivity(activity,stale){
 const box=$('activity-scroll'),items=(activity?.items||[]).slice(-80);
 const state=stale?'HISTORICAL':activity?.state==='ok'?'LIVE':activity?.state==='retained'?'RECENT':activity?.state==='idle'?'IDLE':'UNAVAILABLE';
 text('activity-state',state);
 text('activity-note',(stale?'Historical snapshot — not current activity. ':activity?.note||'Display only · private thought traces are not published. ')+(activity?.truncated?' · Some activity/details omitted (bounded feed).':'')+' · Scroll to read; expand a tool for redacted details.');
 const signature=JSON.stringify([activity?.run,items,state]);if(signature===activitySignature)return;activitySignature=signature;
 const sameRun=activityRun===activity?.run,top=box.scrollTop||0,follow=!sameRun||box.scrollHeight-box.clientHeight-top<35;
 const open=new Set(Array.from(box.children||[]).filter(e=>e.open).map(e=>e.dataset.key));
 activityRun=activity?.run;box.replaceChildren();
 for(const [index,item] of items.entries()){
  const tool=item.kind==='tool',row=document.createElement(tool?'details':'div');row.className='activity-entry '+(tool?item.state:'');row.dataset.key=item.id||String(index);if(tool)row.open=sameRun&&open.has(row.dataset.key);
  const label=document.createElement(tool?'summary':'div');label.textContent=tool?(item.name+' · '+item.state):item.kind==='thinking'?'Thinking…':item.text||'Agent update';row.append(label);
  if(tool){for(const field of ['input','output','error'])if(typeof item[field]==='string'&&item[field]){const heading=document.createElement('span');heading.className='activity-label';heading.textContent=field.toUpperCase();const pre=document.createElement('pre');pre.textContent=item[field];row.append(heading,pre)}}
  if(item.truncated){const note=document.createElement('small');note.textContent='Detail truncated';row.append(note)}box.append(row);
 }
 if(!items.length){const empty=document.createElement('div');empty.className='empty';empty.textContent=stale?'No activity in this historical snapshot.':activity?.state==='idle'?'No active Ghost turn observed.':'No verified display activity available yet. Older turns may not have stored detail.';box.append(empty)}
 if(follow)box.scrollTop=box.scrollHeight;else box.scrollTop=top;
}
$('activity-latest').onclick=()=>{const box=$('activity-scroll');box.scrollTop=box.scrollHeight};
function fmtWhen(ms){return ms?new Date(ms).toLocaleTimeString('en-GB',{timeZone:'Pacific/Auckland',hour:'2-digit',minute:'2-digit',hour12:false})+' NZ':'—'}
function fmtDay(iso){const d=iso?new Date(iso+'T00:00:00Z'):null;return d&&!isNaN(d)?d.toLocaleDateString('en-US',{weekday:'short',day:'2-digit',month:'short',timeZone:'Pacific/Auckland'}):String(iso)}
function renderLog(){const events=(displayed||[]).filter(e=>filter==='all'||filter==='retry'&&e.kind==='rate_limit'||filter==='error'&&['timeout','connection_failure','provider_error','exhausted'].includes(e.kind));page=Math.min(page,Math.max(0,Math.ceil(events.length/pageSize)-1));const visible=events.slice(page*pageSize,(page+1)*pageSize);const log=$('logs');log.replaceChildren();for(const e of visible){const n=names[e.kind];if(!n)continue;const row=document.createElement('div');row.className='event '+e.kind;const t=document.createElement('time');t.textContent=new Date(e.at).toLocaleTimeString([],{hour12:false});t.dateTime=new Date(e.at).toISOString();const kind=document.createElement('span');kind.className='kind';kind.textContent=n[0];const message=document.createElement('div');message.className='message';message.textContent=n[1];const sub=document.createElement('small');sub.textContent=n[2]+' · …'+e.run.slice(-8)+(e.seq?' / #'+e.seq:'');message.append(sub);row.append(t,kind,message);log.append(row)}if(!events.length){const e=document.createElement('div');e.className='empty';e.textContent=filter==='error'?'No explicit errors in the retained log. This is not proof that every layer is error-free.':filter==='retry'?'No rate-limit retries in the retained log.':'No captured provider events yet. The observer does not invent activity.';log.append(e)}text('eventCount',events.length?(page*pageSize+1)+'–'+Math.min((page+1)*pageSize,events.length)+' / '+events.length:'0 events');text('feedState',paused?'FEED PAUSED / STATUS STILL LIVE':networkError?'CONNECTION LOST / HISTORICAL EVENTS':'READ-ONLY / SANITIZED EVENTS');$('newer').disabled=page===0;$('older').disabled=(page+1)*pageSize>=events.length;}
const pager=document.createElement('span');pager.className='pager';for(const [id,label] of [['newer','← Newer'],['older','Older →']]){const b=document.createElement('button');b.className='button';b.id=id;b.textContent=label;pager.append(b)}root.querySelector('.logfoot').lastElementChild.replaceWith(pager);
function pauseButton(){ $('pause').setAttribute('aria-pressed',String(paused));text('pause',paused?'Resume feed':'Pause feed') }
$('older').onclick=()=>{paused=true;page++;pauseButton();renderLog()};$('newer').onclick=()=>{page=Math.max(0,page-1);renderLog()};
$('pause').onclick=()=>{paused=!paused;if(!paused)page=0;pauseButton();render()};for(const b of root.querySelectorAll('[data-filter]'))b.onclick=()=>{filter=b.dataset.filter;page=0;for(const x of root.querySelectorAll('[data-filter]'))x.setAttribute('aria-pressed',String(x===b));renderLog()};
async function poll(){if(disposed)return;try{const r=await ghostFetch('/api/ghost/status',{cache:'no-store',signal:AbortSignal.timeout(10000)});if(r.status===401){networkError=true;text('connectionText','Session expired · sign in again');$('notice').hidden=false;text('notice','Your login has expired. Reload this page to sign in again.');if(latest)render();return}if(!r.ok)throw Error('status');latest=await r.json();if(disposed)return;networkError=false;render()}catch{if(disposed)return;networkError=true;if(latest)render();else{$('connection').className='connection offline';text('connectionText','Telemetry unavailable');$('notice').hidden=false;text('notice','Cannot reach fresh telemetry. No Ghost state is assumed.')}}finally{if(!disposed)pollTimer=setTimeout(poll,5000)}}
const clockTimer=setInterval(()=>{if(disposed)return;text('clock',new Date().toLocaleTimeString([],{hour12:false})+' LOCAL');if(latest)render()},1000);poll();
const stopTasks=mountGhostTasks(root,ghostFetch);
return ()=>{disposed=true;clearInterval(clockTimer);clearTimeout(pollTimer);stopTasks();};
}
