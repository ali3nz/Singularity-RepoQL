// Lossless *meaning* translation of existing Orchestra metadata event types.
// It never reads any file or emits events itself. Existing source ledgers stay authoritative.
// Only safe, bounded identifiers and fixed enum values cross the telemetry boundary.
import {cleanEvent} from './telemetry-transport.mjs';

const OBSERVER = Object.freeze({
  run_allocated:'run_allocated', case_started:'run_started', run_completed:'run_completed',
  run_failed:'run_failed', run_paused:'run_paused', run_resumed:'run_resumed',
  phase_started:'stage_started', phase_completed:'stage_completed',
  agent_allocated:'agent_started', agent_released:'agent_completed',
  sol_consult_started:'review_started',sol_consult_finished:'review_completed',
  operator_wait_started:'operator_wait_started', operator_wait_finished:'operator_wait_finished',
  retry_started:'retry_started',agent_thinking:'agent_thinking',
});
const ROLES = new Set(['CEO','WORKER','PLANNER','QUALITY','VISION','CONSULTANT','SENIOR_TECH']);
const USAGE_KEYS = Object.freeze(['runId','sessionId','component','role','engine','model','provider','billingClass','attempt','success','failureClass','rc','paid','visionUsed','freebucksUsed','durationMs','fallbackFrom','inputTokens','cachedInputTokens','outputTokens','reasoningTokens','totalTokens']);
function safeId(value){return typeof value==='string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)?value:null;}
function safeLabel(value){return typeof value==='string' && /^[a-zA-Z0-9_.:/#-]{1,128}$/.test(value)?value:null;}
function finished(event){return event && typeof event==='object' && !Array.isArray(event);}
function finalize(record){const data=cleanEvent(record);return data ? JSON.parse(data) : null;}

/** Map one native invocation-telemetry ledger row; no unverified cost extrapolation. */
export function fromInvocation(row){
  if(!finished(row) || !safeLabel(row.engine))return null;
  const output={kind:'model_invocation'};
  for(const key of USAGE_KEYS){
    const value=row[key];
    if(value===undefined || value===null)continue;
    if(key==='runId'||key==='sessionId'){
      const id=safeId(value);if(id)output[key]=id;
    }else if(['component','role','engine','model','provider','billingClass','failureClass','fallbackFrom'].includes(key)){
      const label=safeLabel(value);if(label)output[key]=label;
    }else if(['attempt','rc','durationMs','freebucksUsed','inputTokens','cachedInputTokens','outputTokens','reasoningTokens','totalTokens'].includes(key)){
      if(Number.isSafeInteger(value) && (key==='rc'||value>=0))output[key]=value;
    }else if(typeof value==='boolean'){output[key]=value;}
  }
  // Existing ledger never supplies actual billable cost: leave it unknown.
  return finalize(output);
}

/** Map one native observer-sink event. Never transmit displayName, phase title or arbitrary status. */
export function fromObserver(row){
  if(!finished(row) || typeof row.transition!=='string')return null;
  const kind=OBSERVER[row.transition];
  const runId=safeId(row.caseId);
  if(!kind || !runId)return null;
  const output={kind,runId};
  const engine=safeLabel(row.engine);
  if(engine)output.engine=engine;
  if(ROLES.has(row.visualRole))output.role=row.visualRole;
  const sessionId=safeId(row.agentSessionId);
  if(sessionId)output.sessionId=sessionId;
  // Do not infer successful completion from an observer phase event.
  return finalize(output);
}

export const SUPPORTED_OBSERVER_TRANSITIONS=Object.freeze(Object.keys(OBSERVER));
