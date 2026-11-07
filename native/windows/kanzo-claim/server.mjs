#!/usr/bin/env node
// Minimal MCP stdio server exposing the claim layer. JSON-RPC 2.0, one message
// per line (MCP stdio transport). No network listener, no production Kanzo board.
import readline from 'node:readline';
import { ClaimLayer } from './lib/layer.mjs';

const stateDir = process.env.KANZO_CLAIM_STATE_DIR;
if (!stateDir) {
  process.stderr.write('kanzo-claim: KANZO_CLAIM_STATE_DIR is required\n');
  process.exit(2);
}

let layer;
try {
  layer = new ClaimLayer({ stateDir });
} catch (err) {
  process.stderr.write(`kanzo-claim: cannot initialise state: ${err.message}\n`);
  process.exit(2);
}

const TOOLS = [
  {
    name: 'check_work',
    description: 'Report whether a scope is free, with any conflicting active claim receipts.',
    inputSchema: {
      type: 'object',
      properties: { scope: { type: 'string', description: 'Path-like work scope, e.g. dashboard/auth' } },
      required: ['scope'],
    },
  },
  {
    name: 'claim_work',
    description: 'Claim a scope for this session with a TTL. Refuses overlapping active scopes.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string' }, session: { type: 'string' },
        owner: { type: 'string' }, ttl_seconds: { type: 'number' },
      },
      required: ['scope', 'session'],
    },
  },
  {
    name: 'create_work',
    description: 'Create a local task record bound to a scope.',
    inputSchema: {
      type: 'object',
      properties: { scope: { type: 'string' }, title: { type: 'string' }, session: { type: 'string' } },
      required: ['scope', 'title'],
    },
  },
  {
    name: 'heartbeat',
    description: 'Extend an active claim before its TTL expires.',
    inputSchema: {
      type: 'object',
      properties: { claim_id: { type: 'string' }, session: { type: 'string' }, ttl_seconds: { type: 'number' } },
      required: ['claim_id', 'session'],
    },
  },
  {
    name: 'close_work',
    description: 'Release an active claim. Only the owning session may release it.',
    inputSchema: {
      type: 'object',
      properties: { claim_id: { type: 'string' }, session: { type: 'string' } },
      required: ['claim_id', 'session'],
    },
  },
  { name: 'list_tasks', description: 'List local task records.', inputSchema: { type: 'object', properties: {} } },
];

// MCP arguments are snake_case; the layer API is camelCase.
const HANDLERS = {
  check_work: ({ scope }) => layer.checkWork({ scope }),
  claim_work: ({ scope, session, owner, ttl_seconds }) =>
    layer.claimWork({ scope, session, owner, ttlSeconds: ttl_seconds }),
  create_work: ({ scope, title, session }) => layer.createWork({ scope, title, session }),
  heartbeat: ({ claim_id, session, ttl_seconds }) =>
    layer.heartbeat({ claim_id, session, ttlSeconds: ttl_seconds }),
  close_work: ({ claim_id, session }) => layer.closeWork({ claim_id, session }),
  list_tasks: () => layer.listTasks(),
};

function reply(id, result) { return { jsonrpc: '2.0', id, result }; }
function fail(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

async function handle(msg) {
  const { id = null, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'singularity-kanzo-claim', version: '0.1.0' },
    });
  }
  if (method === 'notifications/initialized') return null;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const name = params?.name;
    const handler = HANDLERS[name];
    if (!handler) return fail(id, -32602, `unknown tool: ${name}`);
    try {
      const result = await handler(params?.arguments ?? {});
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false });
    } catch (err) {
      const detail = err.conflict ? { conflict: err.conflict } : undefined;
      return reply(id, {
        content: [{ type: 'text', text: JSON.stringify({ error: err.message, ...(detail ?? {}) }) }],
        isError: true,
      });
    }
  }
  if (id === null) return null; // unknown notification
  return fail(id, -32601, `method not found: ${method}`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    process.stdout.write(JSON.stringify(fail(null, -32700, 'parse error')) + '\n');
    return;
  }
  const out = await handle(msg);
  if (out) process.stdout.write(JSON.stringify(out) + '\n');
});
