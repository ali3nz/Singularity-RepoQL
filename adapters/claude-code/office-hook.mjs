#!/usr/bin/env node
// office-hook.mjs — harness hook → Claude Office ingest.
//
// Reads a Claude Code hook payload on stdin and forwards ONE canonical Office event.
// Whitelisted metadata only, mirroring the product plugin contract: never forwards
// prompts, assistant text, tool input/output or error text.
//
// Usage (from a Claude Code hook command):  node office-hook.mjs <event-kind>
//   event kinds: session-start | prompt | pre-tool | post-tool | stop | subagent-stop | session-end
//
// Config (either):
//   OFFICE_CONFIG=/path/to/office.json   → { "endpoint": "http://product-office:8000", "ingestKey": "..." }
//   or OFFICE_ENDPOINT=... OFFICE_INGEST_KEY=...
//
// Best-effort by design: any failure exits 0 and never blocks the harness.
import { readFileSync } from "node:fs";

const KIND = process.argv[2] || "";

function config() {
  if (process.env.OFFICE_CONFIG) {
    const j = JSON.parse(readFileSync(process.env.OFFICE_CONFIG, "utf8"));
    return { endpoint: j.endpoint, key: j.ingestKey };
  }
  return { endpoint: process.env.OFFICE_ENDPOINT, key: process.env.OFFICE_INGEST_KEY };
}

try {
  const raw = readFileSync(0, "utf8") || "{}";
  const input = JSON.parse(raw);
  const { endpoint, key } = config();
  if (!endpoint || !key) process.exit(0);

  const native = String(input.session_id || "unknown");
  const sessionId = `cc-${native}`;
  const base = {
    agent_id: sessionId,
    native_agent_id: native,
    display_name: `Claude Code ${native.slice(-8)}`,
    project_name: typeof input.cwd === "string" && input.cwd ? input.cwd.split(/[\\/]/).filter(Boolean).pop() : "Claude Code",
  };
  const now = new Date().toISOString();
  const ev = (type, extra = {}) => ({ event_type: type, session_id: sessionId, timestamp: now, data: { ...base, ...extra } });

  let events = [];
  switch (KIND) {
    case "session-start": events = [ev("session_start")]; break;
    case "prompt": events = [ev("user_prompt_submit")]; break;
    case "pre-tool": events = [ev("pre_tool_use", { tool_name: String(input.tool_name || "tool"), tool_use_id: input.tool_use_id })]; break;
    case "post-tool": events = [ev("post_tool_use", { tool_name: String(input.tool_name || "tool"), tool_use_id: input.tool_use_id, success: input.tool_response?.error ? false : true })]; break;
    case "stop": events = [ev("stop")]; break;
    case "subagent-stop": events = [ev("subagent_stop")]; break;
    case "session-end": events = [ev("session_end")]; break;
    default: process.exit(0);
  }

  for (const e of events) {
    try {
      await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": key },
        body: JSON.stringify(e),
        signal: AbortSignal.timeout(1500),
      });
    } catch { /* best-effort: never block the harness */ }
  }
} catch { /* malformed input: ignore */ }
process.exit(0);
