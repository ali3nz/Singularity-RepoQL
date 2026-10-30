// Native Windows OpenChamber/OpenCode worker transport. No Claude Code worker,
// Docker, WSL, shell, SSH, or direct access to OpenCode's credential store.
// The host-side plugin is intentionally thin: a future Rust scheduler owns
// durable queueing, concurrency leases, retries and completion evidence.
const DEFAULT_MAX_RESPONSE = 1024 * 1024;

export class NativeWorkerError extends Error {
  constructor(code, message) { super(message); this.name = 'NativeWorkerError'; this.code = code; }
}

export function validateLoopbackServer(server) {
  let url;
  try { url = new URL(String(server ?? '')); } catch { throw new NativeWorkerError('CONFIG','invalid OpenCode server URL'); }
  if (url.protocol !== 'http:' || !['127.0.0.1','[::1]'].includes(url.hostname) || !url.port ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new NativeWorkerError('CONFIG','OpenCode endpoint must be an explicit, uncredentialed loopback HTTP origin with port');
  return url.origin;
}

export function dispatchDecision({ claudeCodeFreeWorkers = 0, opencodeCapacity = 0,
    activeOpenCode = 0, approvedModel = null, allowPaid = false, billingClass = 'unknown' } = {}) {
  // Claude Code is NOT an execution dependency. Only verified, configured
  // OpenCode capacity is eligible; unknown quota is not treated as free.
  void claudeCodeFreeWorkers;
  if (!approvedModel || typeof approvedModel.providerID !== 'string' || !approvedModel.providerID.trim() ||
      typeof approvedModel.modelID !== 'string' || !approvedModel.modelID.trim())
    return { status: 'BLOCKED', code: 'MODEL_NOT_CONFIGURED' };
  if (billingClass !== 'free' && !(billingClass === 'subscription' && allowPaid === true))
    return { status:'BLOCKED', code:'BILLING_NOT_AUTHORIZED' };
  if (!Number.isSafeInteger(opencodeCapacity) || opencodeCapacity < 0 ||
      !Number.isSafeInteger(activeOpenCode) || activeOpenCode < 0)
    return { status:'BLOCKED', code:'CAPACITY_UNVERIFIED' };
  if (opencodeCapacity === 0 || activeOpenCode >= opencodeCapacity)
    return { status:'DEFERRED', code:'NO_OPEN_CODE_CAPACITY', persisted:false };
  return { status:'READY', backend:'opencode-local', model: {providerID:approvedModel.providerID,modelID:approvedModel.modelID} };
}

async function readBounded(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new NativeWorkerError('BAD_RESPONSE','OpenCode response exceeds limit');
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks=[]; let total=0;
  try {
    while (true) {
      const {value,done}=await reader.read(); if (done) break;
      total+=value.byteLength;
      if (total > maxBytes) throw new NativeWorkerError('BAD_RESPONSE','OpenCode response exceeds limit');
      chunks.push(value);
    }
  } finally { try { await reader.cancel(); } catch {} }
  return new TextDecoder().decode(Buffer.concat(chunks.map(x=>Buffer.from(x))));
}

export function nativeOpenCodeClient({ server, username='opencode', password, timeoutMs=15_000, maxResponseBytes=DEFAULT_MAX_RESPONSE, fetchImpl=fetch }={}) {
  const origin=validateLoopbackServer(server);
  if (typeof password !== 'string' || !password.length) throw new NativeWorkerError('AUTH','server password required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000 ||
      !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 128 || maxResponseBytes > 8*1024*1024)
    throw new NativeWorkerError('CONFIG','invalid HTTP bounds');
  const basic='Basic '+Buffer.from(`${username}:${password}`,'utf8').toString('base64');
  async function request(method,path,body=undefined) {
    let response;
    try {
      response = await fetchImpl(origin+path, {
        method, redirect:'manual', signal:AbortSignal.timeout(timeoutMs),
        headers:{authorization:basic,accept:'application/json', ...(body===undefined?{}:{'content-type':'application/json'})},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),
      });
    } catch (err) { throw new NativeWorkerError('UNREACHABLE', `OpenCode request unsuccessful: ${err?.name==='TimeoutError'?'timeout':'transport failure'}`); }
    if (response.status>=300 && response.status<400) throw new NativeWorkerError('REDIRECT','OpenCode redirect refused');
    if ([401,403].includes(response.status)) throw new NativeWorkerError('AUTH','OpenCode authentication rejected');
    if ([429,503].includes(response.status)) throw new NativeWorkerError('NO_CAPACITY','OpenCode provider or service unavailable');
    if (!response.ok) throw new NativeWorkerError('UPSTREAM',`OpenCode HTTP ${response.status}`);
    const text=await readBounded(response,maxResponseBytes);
    if (response.status===204) return {accepted:true};
    try { return JSON.parse(text); } catch { throw new NativeWorkerError('BAD_RESPONSE','OpenCode returned invalid JSON'); }
  }
  return {
    async health() { const h=await request('GET','/global/health'); return {healthy:h?.healthy===true,version:typeof h?.version==='string'?h.version:null}; },
    async projectDirectory() { const p=await request('GET','/path'); return typeof p?.directory==='string'?p.directory:null; },
    async submit({taskId,prompt,decision,agent='build'}={}) {
      if (decision?.status!=='READY' || decision.backend!=='opencode-local')
        throw new NativeWorkerError('CAPACITY','no verified OpenCode seat reserved');
      if (typeof taskId!=='string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(taskId) ||
          typeof prompt!=='string' || prompt.length===0 || prompt.length>100_000 ||
          typeof agent!=='string' || !/^[a-zA-Z0-9_-]{1,50}$/.test(agent))
        throw new NativeWorkerError('CONFIG','invalid task request');
      // First create a durable OpenCode session, then async-send exactly once.
      // A failed second request returns its session identity: a supervisor must
      // reconcile status before any retry, never blindly duplicate prompt.
      const session=await request('POST','/session',{title:`Singularity ${taskId}`});
      if (typeof session?.id!=='string' || !/^ses[\w-]{1,100}$/.test(session.id))
        throw new NativeWorkerError('BAD_RESPONSE','OpenCode did not return a valid session id');
      const sessionId=session.id;
      try {
        const ack=await request('POST',`/session/${encodeURIComponent(sessionId)}/prompt_async`,{
          agent,model:decision.model,parts:[{type:'text',text:prompt}],
        });
        if (ack.accepted!==true) throw new NativeWorkerError('BAD_RESPONSE','OpenCode did not acknowledge asynchronous prompt');
      } catch (err) {
        return {status:'DELIVERY_UNCERTAIN',taskId,sessionId,errorCode:err.code??'UNKNOWN',retryWithoutReconcile:false};
      }
      return {status:'ACCEPTED',taskId,sessionId,completed:false};
    },
    async status(sessionId) {
      if (!/^ses[\w-]{1,100}$/.test(String(sessionId??''))) throw new NativeWorkerError('CONFIG','bad session id');
      const status=await request('GET','/session/status');
      return {sessionId, state:status?.[sessionId]??null, verified:status!=null};
    },
    async observeCompletion(sessionId, {timeoutMs:observeTimeoutMs=120_000, pollMs=1500,
        sleep=(ms)=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
      if (!Number.isSafeInteger(observeTimeoutMs) || observeTimeoutMs<100 || observeTimeoutMs>24*3600_000 ||
          !Number.isSafeInteger(pollMs) || pollMs<1 || pollMs>60_000)
        throw new NativeWorkerError('CONFIG','bad completion observation bounds');
      const began=Date.now();
      while (Date.now()-began < observeTimeoutMs) {
        const {state}=await this.status(sessionId);
        if (state?.type === 'idle') {
          const messages=await request('GET',`/session/${encodeURIComponent(sessionId)}/message?limit=20`);
          if (!Array.isArray(messages)) throw new NativeWorkerError('BAD_RESPONSE','OpenCode messages missing');
          const assistant=[...messages].reverse().find(m=>m?.info?.role==='assistant' && Array.isArray(m?.parts));
          const output=(assistant?.parts??[]).filter(p=>p?.type==='text').map(p=>p.text??'').join('\n').trim();
          if (output) return {status:'RESPONSE_OBSERVED',sessionId,output,completionVerified:false};
          return {status:'UNVERIFIED_COMPLETION',sessionId,reason:'no assistant text observed'};
        }
        if (!state || !['busy','retry'].includes(state.type))
          return {status:'UNVERIFIED_COMPLETION',sessionId,reason:'unrecognised or absent status'};
        await sleep(pollMs);
      }
      return {status:'STILL_RUNNING_OR_UNKNOWN',sessionId,reason:'observation deadline'};
    },
  };
}
