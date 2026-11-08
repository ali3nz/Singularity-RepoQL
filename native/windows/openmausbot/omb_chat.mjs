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
import {spawnSync} from 'node:child_process';

const PROTOCOL = '2024-11-05';

/** One MCP session: initialize + the supplied tool calls, answered in order. */
export function mcpSession({cli, port, calls, env = {}, run = spawnSync, timeout = 120000}) {
  const frames = [
    {jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {protocolVersion: PROTOCOL, capabilities: {}, clientInfo: {name: 'singularity-maintainer', version: '1'}}},
    {jsonrpc: '2.0', method: 'notifications/initialized', params: {}},
    ...calls.map((c, i) => ({jsonrpc: '2.0', id: i + 2, method: 'tools/call',
      params: {name: c.name, arguments: c.arguments ?? {}}})),
  ];
  const result = run(process.execPath, [cli, 'mcp'], {
    input: frames.map((f) => JSON.stringify(f)).join('\n') + '\n',
    env: {...process.env, OMB_PORT: String(port), ...env},
    encoding: 'utf8', timeout, windowsHide: true, shell: false, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || typeof result.stdout !== 'string') throw new Error('OMB_MCP_SESSION_FAILED');
  const replies = new Map();
  for (const line of result.stdout.split(/\r?\n/)) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    try {
      const frame = JSON.parse(text);
      if (typeof frame.id === 'number') replies.set(frame.id, frame);
    } catch { /* non-JSON banner line from the vendor process */ }
  }
  return calls.map((c, i) => {
    const reply = replies.get(i + 2);
    if (!reply) throw new Error('OMB_MCP_NO_REPLY:' + c.name);
    if (reply.error) throw new Error('OMB_MCP_ERROR:' + c.name);
    const payload = reply.result ?? {};
    if (payload.isError) throw new Error('OMB_MCP_TOOL_ERROR:' + c.name);
    if (payload.structuredContent && typeof payload.structuredContent === 'object') return payload.structuredContent;
    for (const item of payload.content ?? []) {
      if (item?.type === 'text') {
        try { return JSON.parse(item.text); } catch { return {text: item.text}; }
      }
    }
    return payload;
  });
}

/** A chat sender for the repair executor: acknowledges only on a vendor receipt. */
export function ombChatSender({cli, port, botName = 'Singularity Maintainer', env = {}, run = spawnSync}) {
  if (typeof cli !== 'string' || !cli) throw new Error('OMB_CHAT_CLI_REQUIRED');
  const session = (calls) => mcpSession({cli, port, calls, env, run});
  return (message, opts = {}) => {
    const sendId = typeof opts.sendId === 'string' && opts.sendId ? opts.sendId : null;
    if (!sendId) return {acknowledged: false, reason: 'OMB_CHAT_SEND_ID_REQUIRED'};
    try {
      const [bots] = session([{name: 'list_bots'}]);
      const list = Array.isArray(bots?.bots) ? bots.bots : [];
      const bot = list.find((b) => b && b.name === botName);
      if (!bot) return {acknowledged: false, reason: 'OMB_MAINTAINER_BOT_NOT_FOUND'};
      const [sent] = session([{name: 'send_bot_message', arguments: {bot_id: bot.id, text: message, send_id: sendId}}]);
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
export function ensureMaintainerRoutine({cli, port, botName = 'Singularity Maintainer', routine, env = {}, run = spawnSync, now = Date.now()}) {
  if (!routine || typeof routine.name !== 'string' || typeof routine.instructions !== 'string' || !routine.schedule)
    throw new Error('OMB_ROUTINE_DEFINITION_REQUIRED');
  const [listed] = mcpSession({cli, port, calls: [{name: 'list_bots'}], env, run});
  const bot = (Array.isArray(listed?.bots) ? listed.bots : []).find((b) => b && b.name === botName);
  if (!bot) return {created: false, verified: false, reason: 'OMB_MAINTAINER_BOT_NOT_FOUND'};
  const before = mcpSession({cli, port, calls: [{name: 'trigger_info', arguments: {action: 'list'}}], env, run})[0];
  const existing = findRoutine(before, routine.name);
  let created = false;
  if (!existing) {
    mcpSession({cli, port, calls: [{name: 'trigger', arguments: {
      action: 'create', when: 'schedule', for_bot_id: bot.id,
      name: routine.name, instructions: routine.instructions, schedule: routine.schedule,
    }}], env, run});
    created = true;
  }
  const after = mcpSession({cli, port, calls: [{name: 'trigger_info', arguments: {action: 'list'}}], env, run})[0];
  const observed = findRoutine(after, routine.name);
  const nextRun = observed?.nextRunAt ?? observed?.next_run_at ?? null;
  const enabled = observed?.enabled !== false;
  const verified = Boolean(observed && enabled && nextRun && Date.parse(nextRun) > now - 60_000);
  return {created, verified, triggerId: observed?.id ?? observed?.trigger_id ?? null,
    nextRunAt: nextRun, enabled, reason: verified ? null : 'OMB_ROUTINE_NOT_OBSERVED'};
}

/** Read-only: confirm the routine exists, is enabled and has a future run. */
export function readMaintainerRoutine({cli, port, name, env = {}, run = spawnSync, now = Date.now()}) {
  const [report] = mcpSession({cli, port, calls: [{name: 'trigger_info', arguments: {action: 'list'}}], env, run});
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
