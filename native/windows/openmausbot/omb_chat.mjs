#!/usr/bin/env node
/** Minimal stdio MCP client for the installed OpenMausBot vendor CLI.
 *
 * Verified contract (not invented): `native/windows/openmausbot/headless.py`
 * drives the same server through the same three tools —
 *   list_bots                      -> { bots: [{id, name, chiefOfStaff, ...}] }
 *   send_bot_message {bot_id, text, send_id} -> { taskId | task_id, ... }  (send_id is the vendor's de-duplication key)
 *   wait_for_conversation {target_type:'bot', target_id, task_id, timeout_seconds}
 * and `native/windows/configure_project_mcp.mjs` launches the vendor MCP server as
 * `node <cli.js> mcp` with OMB_PORT in the environment. The vendor bundle
 * (`dist-server/openmausbot.js`) additionally exposes the `trigger` tool
 * (action create|update|pause|resume|run_now, when=schedule|app_event|webhook|limit_reset,
 * name, instructions, schedule) and `trigger_info` (action list|events) for readback,
 * which is how a routine is created and independently confirmed.
 *
 * No HTTP API, database write, second scheduler or credential handling is added here:
 * one MCP session per call, JSON-RPC over stdin/stdout, line-delimited.
 */
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

const PROTOCOL = '2024-11-05';

/** One live MCP child: handshake first, then one request at a time. */
export async function mcpSession({cli, port, calls, env = {}, spawnChild = spawn, timeout = 120000}) {
  if (!Array.isArray(calls)) throw new Error('OMB_MCP_CALLS_REQUIRED');
  let child;
  try {
    child = spawnChild(process.execPath, [cli, 'mcp'], {
      env: {...process.env, OMB_PORT: String(port), ...env},
      windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    throw new Error('OMB_MCP_SESSION_FAILED');
  }
  if (!child?.stdin || !child?.stdout || typeof child.on !== 'function' || typeof child.kill !== 'function') {
    child?.kill?.();
    throw new Error('OMB_MCP_SESSION_FAILED');
  }

  const reader = createInterface({input: child.stdout, crlfDelay: Infinity});
  const pending = new Map();
  let nextId = 0;
  let terminalError = null;

  const failPending = (error) => {
    if (!terminalError) terminalError = error;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error.message === 'OMB_MCP_EOF'
        ? new Error(request.eofError) : terminalError);
    }
    pending.clear();
  };

  reader.on('line', (line) => {
    const text = line.trim();
    if (!text.startsWith('{')) return;
    let frame;
    try { frame = JSON.parse(text); } catch { return; }
    if (typeof frame.id !== 'number') return;
    const request = pending.get(frame.id);
    if (!request) return;
    pending.delete(frame.id);
    clearTimeout(request.timer);
    request.resolve(frame);
  });
  reader.on('close', () => failPending(new Error('OMB_MCP_EOF')));
  child.on('error', () => failPending(new Error('OMB_MCP_SESSION_FAILED')));
  child.on('close', () => failPending(new Error('OMB_MCP_EOF')));
  child.stdin.on('error', () => failPending(new Error('OMB_MCP_SESSION_FAILED')));
  child.stdout.on('error', () => failPending(new Error('OMB_MCP_SESSION_FAILED')));

  const writeFrame = (frame) => new Promise((resolve, reject) => {
    if (terminalError) { reject(terminalError); return; }
    if (child.stdin.destroyed) {
      const error = new Error('OMB_MCP_SESSION_FAILED');
      failPending(error);
      reject(error);
      return;
    }
    try {
      child.stdin.write(JSON.stringify(frame) + '\n', (error) => {
        if (error) {
          const failure = new Error('OMB_MCP_SESSION_FAILED');
          failPending(failure);
          reject(failure);
        } else resolve();
      });
    } catch {
      const error = new Error('OMB_MCP_SESSION_FAILED');
      failPending(error);
      reject(error);
    }
  });

  const request = (method, params, eofError) => {
    if (terminalError) return Promise.reject(terminalError);
    const id = ++nextId;
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => failPending(new Error('OMB_MCP_TIMEOUT')), timeout);
      pending.set(id, {resolve, reject, timer, eofError});
    });
    writeFrame({jsonrpc: '2.0', id, method, params}).catch((error) => failPending(error));
    return reply;
  };

  try {
    const initialized = await request('initialize', {
      protocolVersion: PROTOCOL, capabilities: {},
      clientInfo: {name: 'singularity-maintainer', version: '1'},
    }, 'OMB_MCP_INIT_FAILED');
    if (initialized.error || !initialized.result) throw new Error('OMB_MCP_INIT_FAILED');
    await writeFrame({jsonrpc: '2.0', method: 'notifications/initialized', params: {}});

    const results = [];
    for (const call of calls) {
      const reply = await request('tools/call',
        {name: call.name, arguments: call.arguments ?? {}}, 'OMB_MCP_NO_REPLY:' + call.name);
      if (reply.error) throw new Error('OMB_MCP_ERROR:' + call.name);
      const payload = reply.result ?? {};
      if (payload.isError) throw new Error('OMB_MCP_TOOL_ERROR:' + call.name);
      if (payload.structuredContent && typeof payload.structuredContent === 'object') {
        results.push(payload.structuredContent);
        continue;
      }
      let parsed = payload;
      for (const item of payload.content ?? []) {
        if (item?.type !== 'text') continue;
        try { parsed = JSON.parse(item.text); } catch { parsed = {text: item.text}; }
        break;
      }
      results.push(parsed);
    }
    return results;
  } finally {
    reader.close();
    try { child.stdin.end(); } catch { /* child may already be closed */ }
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

/** A chat sender for the repair executor: acknowledges only on a vendor receipt. */
export function ombChatSender({cli, port, botName = 'Singularity Maintainer', env = {}, spawnChild = spawn}) {
  if (typeof cli !== 'string' || !cli) throw new Error('OMB_CHAT_CLI_REQUIRED');
  const session = (calls) => mcpSession({cli, port, calls, env, spawnChild});
  return async (message, opts = {}) => {
    const sendId = typeof opts.sendId === 'string' && opts.sendId ? opts.sendId : null;
    if (!sendId) return {acknowledged: false, reason: 'OMB_CHAT_SEND_ID_REQUIRED'};
    try {
      const [bots] = await session([{name: 'list_bots'}]);
      const list = Array.isArray(bots?.bots) ? bots.bots : [];
      const bot = list.find((b) => b && b.name === botName);
      if (!bot) return {acknowledged: false, reason: 'OMB_MAINTAINER_BOT_NOT_FOUND'};
      const [sent] = await session([{name: 'send_bot_message', arguments: {bot_id: bot.id, text: message, send_id: sendId}}]);
      const id = sent?.messageId ?? sent?.message_id ?? sent?.taskId ?? sent?.task_id ?? null;
      return id ? {acknowledged: true, messageId: String(id), botId: bot.id}
        : {acknowledged: false, reason: 'OMB_CHAT_NO_RECEIPT'};
    } catch (error) {
      return {acknowledged: false, reason: String(error?.message || error).slice(0, 120)};
    }
  };
}

/** Create the Maintainer's routine through the vendor `trigger` tool and read it
 *  back with `trigger_info`. Returns verified:true only when the listed routine
 *  has the same name and a future run. */
export async function ensureMaintainerRoutine({cli, port, botName = 'Singularity Maintainer', routine, env = {}, spawnChild = spawn, now = Date.now()}) {
  if (!routine || typeof routine.name !== 'string' || typeof routine.instructions !== 'string' || !routine.schedule)
    throw new Error('OMB_ROUTINE_DEFINITION_REQUIRED');
  const [listed] = await mcpSession({cli, port, calls: [{name: 'list_bots'}], env, spawnChild});
  const bot = (Array.isArray(listed?.bots) ? listed.bots : []).find((b) => b && b.name === botName);
  if (!bot) return {created: false, verified: false, reason: 'OMB_MAINTAINER_BOT_NOT_FOUND'};
  const [before] = await mcpSession({cli, port, calls: [{name: 'trigger_info', arguments: {action: 'list'}}], env, spawnChild});
  const existing = findRoutine(before, routine.name);
  let created = false;
  if (!existing) {
    await mcpSession({cli, port, calls: [{name: 'trigger', arguments: {
      action: 'create', when: 'schedule', for_bot_id: bot.id,
      name: routine.name, instructions: routine.instructions, schedule: routine.schedule,
    }}], env, spawnChild});
    created = true;
  }
  const [after] = await mcpSession({cli, port, calls: [{name: 'trigger_info', arguments: {action: 'list'}}], env, spawnChild});
  const observed = findRoutine(after, routine.name);
  const nextRun = observed?.nextRunAt ?? observed?.next_run_at ?? null;
  const enabled = observed?.enabled !== false;
  const verified = Boolean(observed && enabled && nextRun && Date.parse(nextRun) > now - 60_000);
  return {created, verified, triggerId: observed?.id ?? observed?.trigger_id ?? null,
    nextRunAt: nextRun, enabled, reason: verified ? null : 'OMB_ROUTINE_NOT_OBSERVED'};
}

/** Read-only: confirm the routine exists, is enabled and has a future run. */
export async function readMaintainerRoutine({cli, port, name, env = {}, spawnChild = spawn, now = Date.now()}) {
  const [report] = await mcpSession({cli, port, calls: [{name: 'trigger_info', arguments: {action: 'list'}}], env, spawnChild});
  const observed = findRoutine(report, name);
  const nextRunAt = observed?.nextRunAt ?? observed?.next_run_at ?? null;
  const enabled = observed?.enabled !== false;
  const verified = Boolean(observed && enabled && nextRunAt && Date.parse(nextRunAt) > now - 60_000);
  return {present: Boolean(observed), verified, triggerId: observed?.id ?? observed?.trigger_id ?? null,
    nextRunAt, enabled, reason: verified ? null : 'OMB_ROUTINE_NOT_OBSERVED'};
}

function findRoutine(report, name) {
  const buckets = [report?.routines, report?.triggers, report?.items, report?.list].filter(Array.isArray);
  for (const list of buckets) {
    const hit = list.find((r) => r && (r.name === name || r.title === name));
    if (hit) return hit;
  }
  return null;
}
