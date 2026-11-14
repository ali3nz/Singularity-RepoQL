#!/usr/bin/env node
// memory-hook.mjs — Claude Code lifecycle hooks ↔ Singularity MemoryCore.
//
//   node memory-hook.mjs subagent-start      # inside SubagentStart
//   node memory-hook.mjs subagent-stop       # inside SubagentStop
//   node memory-hook.mjs conversation-turn   # inside Stop (parent session)
//   node memory-hook.mjs session-end         # inside SessionEnd (parent session)
//
// subagent-start: the hook payload's `agent_type` names the subagent. Only
// Singularity agents (namespaced `singularity-*`, mapped in agent-map.mjs) are
// acted on; every other subagent exits silently. A mapped agent gets a BOUNDED
// recall from its own existing MemoryCore identity (≤5 L1, or ≤3 L0 fallback,
// clipped) returned as hookSpecificOutput.additionalContext — advisory context,
// never instructions. MemoryCore being unreachable must never break the agent:
// failures are logged to stderr and the hook still exits 0 (nothing is claimed
// as recalled).
//
// subagent-stop: a terminated Singularity agent's last assistant message is
// distilled into ONE bounded lesson and persisted under that agent's identity
// through the product's reconciled write path (query-before-write → add →
// verify), so retries never duplicate records. Trivial output and unmapped
// agents are never captured.
//
// conversation-turn / session-end: the PARENT (main GUI) conversation is
// captured too — operator decision: every Claude Code conversation belongs in
// memory, not only Singularity subagents. A bounded tail of the session
// transcript is read, the LAST real user prompt is paired with the LAST
// assistant reply, secrets are redacted, each side is clipped to 4000
// characters, and the pair is persisted as ONE unit under the
// `claude-code-main` identity. Short turns are still captured: the
// 200-character lesson floor applies only to subagent lessons. The task
// identity is derived from the session and both texts, so Stop, SessionEnd and
// plain hook retries converge on the same record and never duplicate it. The
// hook always exits 0; failures are reported on stderr and never block Claude.
//
// Configuration (written by scripts/install-claude-code.mjs into settings env):
//   SINGULARITY_REPO_ROOT      Singularity checkout the hook belongs to
//   SINGULARITY_MEMORY_CONFIG  the installation's memory.json (path only)
//   AGENT_PROFILE_TEAM / AGENT_PROFILE_USER   optional shared-identity overrides
// No secret value is ever configured in settings; keys stay in memory.json.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { callMemoryCore, loadMemoryConfig } from "../../scripts/memory-config-loader.mjs";
import { reconcileMemoryUnit } from "../../scripts/memory-reconcile-core.mjs";
import { resolveSingularityAgent } from "./agent-map.mjs";
import { nativeMemoryPolicyEnabled, requestNativeMemoryPolicy, NativeMemoryPolicyError } from "../../harness/kit/lib/native-memory-policy.mjs";

const DEFAULT_TEAM = "openchamber-agents";
const MAX_RECALL_ITEM_CHARS = 400;
const MAX_LESSON_CHARS = 4000;
const MIN_LESSON_CHARS = 200;
const MAX_PARENT_MESSAGE_CHARS = 4000;
const MAX_TRANSCRIPT_BYTES = 1024 * 1024;
const DEFAULT_MAIN_AGENT = "claude-code-main";

const clip = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n) : s; };
const sha8 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 8);
const sha16 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

// Redact obvious secret shapes before anything is written to memory.
export function redactSecrets(text) {
  return String(text ?? "")
    .replace(/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{10,}\b/g, "[REDACTED]")
    .replace(/\bAKIA[A-Z0-9]{12,}\b/g, "[REDACTED]")
    .replace(/\b(?:api[_-]?key|token|secret|password)\b(\s*[:=]\s*)"?[\w./+=-]{8,}"?/gi, (_m, sep) => `key${sep}[REDACTED]`);
}

// Native capture helpers remain opt-in. Exact comparison prevents a forged,
// buggy or incompatible binary from changing the stored lesson or task ID.
// Do not log the source text or native payload on disagreement.
function captureRedacted(text) {
  const input = String(text ?? "");
  const expected = redactSecrets(input);
  if (!nativeMemoryPolicyEnabled()) return expected;
  const native = requestNativeMemoryPolicy("hook-redact", { text: input });
  if (typeof native.text !== "string" || native.text !== expected) {
    throw new NativeMemoryPolicyError("NATIVE_HOOK_REDACTION_MISMATCH");
  }
  return native.text;
}

function stableCaptureIds(parts, sessionKey) {
  const expectedTaskId = `cc-${sha16(JSON.stringify(parts))}`;
  const expectedSessionHash = sha8(sessionKey);
  if (!nativeMemoryPolicyEnabled()) {
    return { taskId: expectedTaskId, sessionHash8: expectedSessionHash };
  }
  // The native command intentionally handles only string parts. Rejecting a
  // malformed event is safer than silently altering its task identity.
  if (!parts.every(p => typeof p === "string")) {
    throw new NativeMemoryPolicyError("INVALID_HOOK_ID_PARTS");
  }
  const native = requestNativeMemoryPolicy("hook-capture-id", { parts, sessionKey });
  if (native.taskId !== expectedTaskId || native.sessionHash8 !== expectedSessionHash) {
    throw new NativeMemoryPolicyError("NATIVE_HOOK_ID_MISMATCH");
  }
  return { taskId: native.taskId, sessionHash8: native.sessionHash8 };
}

// If the event omitted last_assistant_message, recover the last assistant text
// from the subagent's own transcript (best-effort; bounded tail).
function transcriptLastAssistant(path, maxBytes = 512 * 1024) {
  try {
    const raw = readFileSync(path, "utf8").slice(-maxBytes);
    for (const line of raw.split(/\r?\n/).reverse()) {
      if (!line.trim()) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      const m = j?.message ?? j;
      if (m?.role !== "assistant") continue;
      const text = typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n")
          : "";
      if (text.trim()) return text;
    }
  } catch { /* unreadable transcript: fall through */ }
  return "";
}

// Text of one transcript entry. Only real message content counts: tool
// results, thinking blocks and Claude's api-request blobs are not conversation.
function messageText(entry) {
  const m = entry?.message ?? entry;
  if (typeof m?.content === "string") return m.content;
  if (Array.isArray(m?.content)) {
    return m.content
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
  }
  return "";
}

// The parent session's transcript is a JSONL event log. Read a BOUNDED tail and
// return the last real user prompt paired with the last assistant reply that
// followed it. Claude Code writes tool results as `user` entries (content
// block type `tool_result`, toolUseResult present) and system/local-command
// messages with `isMeta`; neither is an operator prompt.
function transcriptLastTurn(path, maxBytes = MAX_TRANSCRIPT_BYTES) {
  try {
    const raw = readFileSync(path, "utf8").slice(-maxBytes);
    const entries = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch { /* partial first line of a bounded tail */ }
    }
    let assistant = "";
    let assistantAt = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i]?.type !== "assistant") continue;
      const text = messageText(entries[i]).trim();
      if (text) { assistant = text; assistantAt = i; break; }
    }
    if (!assistant) return { user: "", assistant: "" };
    let user = "";
    for (let i = assistantAt - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry?.type !== "user" || entry?.isMeta === true) continue;
      if (Array.isArray(entry?.message?.content) &&
          entry.message.content.some((p) => p?.type === "tool_result")) continue;
      const text = messageText(entry).trim();
      if (text) { user = text; break; }
    }
    return { user, assistant };
  } catch { return { user: "", assistant: "" }; }
}

/** Identity for the main Claude Code conversation. The parent session is not a
 * Singularity subagent, so it gets its own stable agent id instead of a role
 * mapping; AGENT_PROFILE_MAIN_AGENT exists for installations that already use a
 * different main-agent namespace. */
export function mainConversationIdentity(env = {}, baseIdentity = {}) {
  const override = String(env.AGENT_PROFILE_MAIN_AGENT || "").trim();
  return {
    team_id: env.AGENT_PROFILE_TEAM || DEFAULT_TEAM,
    user_id: env.AGENT_PROFILE_USER || baseIdentity.user_id || "pilot-operator",
    agent_id: override && override.length <= 128 ? override : DEFAULT_MAIN_AGENT,
  };
}

/** Resolve the SAME identity as setup-agent-profiles.mjs. A configured
 * identity map has absolute precedence; missing or malformed entries must
 * never silently fall back to an unrelated role's memory namespace. */
export function identityFor(agentType, env = {}, baseIdentity = {}) {
  const agent = resolveSingularityAgent(agentType);
  if (!agent) return null;
  const role = agent.memoryAgentId;
  if (env.AGENT_PROFILE_IDENTITY_MAP) {
    let mapped;
    try {
      const json = JSON.parse(readFileSync(env.AGENT_PROFILE_IDENTITY_MAP, 'utf8'));
      mapped = json?.agents?.[role];
    } catch { throw new Error('IDENTITY_MAP_UNAVAILABLE'); }
    if (!mapped || !['team_id','user_id','agent_id'].every(k =>
        typeof mapped[k] === 'string' && mapped[k].trim() && mapped[k].length <= 128)) {
      throw new Error('IDENTITY_MAP_ROLE_UNVERIFIED');
    }
    return {team_id:mapped.team_id,user_id:mapped.user_id,agent_id:mapped.agent_id};
  }
  return {
    team_id: env.AGENT_PROFILE_TEAM || DEFAULT_TEAM,
    user_id: env.AGENT_PROFILE_USER || baseIdentity.user_id || 'pilot-operator',
    agent_id: role,
  };
}

export function memoryConfigPath(env = {}) {
  const root = env.SINGULARITY_REPO_ROOT;
  return env.SINGULARITY_MEMORY_CONFIG
    || (root ? resolve(root, "data/opencode/config/product-secrets/memory.json") : "");
}

/**
 * One hook invocation. Returns { exitCode, stdout: string|null, stderr: string[] }.
 * Pure over its inputs (env, stdio provided by opts) so unit tests can drive it.
 */
export async function runMemoryHook(argv, opts = {}) {
  const kind = argv[0] || "";
  const env = opts.env || {};
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const now = opts.now || (() => new Date().toISOString());
  let input = {};
  try { input = JSON.parse(opts.stdin ?? readFileSync(0, "utf8")) || {}; } catch { /* malformed payload */ }
  const stderr = [];

  // Parent-session capture is driven by its own transcript, not by a
  // Singularity subagent type. Everything else keeps the subagent attribution
  // contract: a non-Singularity subagent never touches memory.
  const parentKind = kind === "conversation-turn" || kind === "session-end";
  const agent = parentKind ? null : resolveSingularityAgent(input.agent_type ?? input.agentType);
  if (!parentKind && !agent) return { exitCode: 0, stdout: null, stderr };

  const configPath = memoryConfigPath(env);
  if (!configPath) {
    return { exitCode: 0, stdout: null, stderr: ["singularity memory hook: no SINGULARITY_REPO_ROOT configured (run scripts/install-claude-code.mjs); continuing without memory"] };
  }

  let cfg;
  try {
    cfg = loadMemoryConfig({ ...env, SINGULARITY_MEMORY_CONFIG: configPath });
  } catch {
    return { exitCode: 0, stdout: null, stderr: ["singularity memory hook: cannot read memory config; continuing without memory"] };
  }
  let identity;
  if (parentKind) {
    identity = mainConversationIdentity(env, cfg.identity);
  } else {
    try { identity = identityFor(input.agent_type ?? input.agentType, env, cfg.identity); }
    catch { return { exitCode:0, stdout:null, stderr:['singularity memory hook: role identity map invalid, continuing without memory'] }; }
  }

  try {
    if (parentKind) {
      // The last parent turn: bounded transcript tail, last real user prompt +
      // last assistant reply. An empty assistant reply means there is nothing
      // to remember (interrupted/aborted turn): never write a hollow record.
      const turn = transcriptLastTurn(input.transcript_path ?? input.transcriptPath);
      const assistantRaw = turn.assistant || String(input.last_assistant_message ?? "").trim();
      const assistantText = clip(captureRedacted(assistantRaw), MAX_PARENT_MESSAGE_CHARS).trim();
      if (!assistantText) return { exitCode: 0, stdout: null, stderr };
      // Short turns are valid parent turns: no MIN_LESSON_CHARS floor here.
      const userText = clip(captureRedacted(turn.user), MAX_PARENT_MESSAGE_CHARS).trim()
        || "(no user prompt recovered from transcript)";
      const sessionKey = String(input.session_id ?? "unknown");
      // Deterministic identity: Stop, SessionEnd and hook retries all derive the
      // same task_id from the same turn, so capture is idempotent by design.
      const { taskId: task_id, sessionHash8 } = stableCaptureIds([sessionKey, userText, assistantText], sessionKey);
      const session_id = `${DEFAULT_MAIN_AGENT}-${sessionHash8}`;
      const capturedAt = now();
      const unit = {
        session_id, task_id,
        messages: [
          { role: "user", content: userText, recorded_at: capturedAt },
          { role: "assistant", content: assistantText, recorded_at: capturedAt },
        ],
      };
      const request = async (path, body) => {
        const r = await callMemoryCore(`/v3${path}`, body, { ...cfg, identity }, fetchImpl);
        if (r.error || (r.code !== undefined && r.code !== 0)) throw new Error(r.message || r.error || `memory API code ${r.code}`);
        return r.data;
      };
      // Query-before-write. recorded_at legitimately changes on a retry, so
      // stability is judged on role+content; a row with a conflicting payload
      // under this task_id is an error, never evidence of persistence.
      const previous = await request("/conversation/query", {
        ...identity, session_id, task_id, offset: 0, limit: 10,
      });
      if (!Array.isArray(previous?.messages)) throw new Error("memory query did not return messages");
      const existing = previous.messages.filter((row) => row?.task_id === task_id);
      for (const row of existing) {
        if (!unit.messages.some((m) => m.role === row.role && m.content === row.content)) {
          throw new Error("memory task identity collision or unverifiable stored conversation turn");
        }
      }
      const missing = unit.messages.filter((m) =>
        !existing.some((row) => row.role === m.role && row.content === m.content));
      let written = 0;
      if (missing.length) {
        await request("/conversation/add", { ...identity, session_id, task_id, messages: missing });
        const verified = await request("/conversation/query", {
          ...identity, session_id, task_id, offset: 0, limit: 10,
        });
        const rows = Array.isArray(verified?.messages)
          ? verified.messages.filter((row) => row?.task_id === task_id) : [];
        const persisted = unit.messages.every((m) =>
          rows.some((row) => row.role === m.role && row.content === m.content));
        if (!persisted) throw new Error("Capture persistence not verified");
        written = missing.length;
      }
      stderr.push(`singularity memory: reconciled ${written} message(s) for ${identity.agent_id}`);
      return { exitCode: 0, stdout: null, stderr };
    }

    if (kind === "subagent-start") {
      // One bounded L1 search first; L0 only for empty/unavailable L1.
      const query = clip(String(input.prompt ?? input.userPrompt ?? "").trim()
        || `${agent.memoryAgentId} prior experience and lessons`, 400);
      const recall = async (layer, limit) => {
        const endpoint = layer === "L1" ? "/v3/atomic/search" : "/v3/conversation/search";
        let result;
        try { result = await callMemoryCore(endpoint, { ...identity, query, limit }, { ...cfg, identity }, fetchImpl); }
        catch { result = { error: true }; }
        if (!result || result.error || (result.code !== undefined && result.code !== 0)) {
          stderr.push(`singularity memory hook: recall degraded: ${layer} recall unavailable; continuing without memory from that layer`);
          return [];
        }
        const rows = layer === "L1"
          ? (result.data?.atoms ?? result.data?.items ?? result.data?.memories ?? [])
          : (result.data?.messages ?? result.data?.items ?? []);
        if (!Array.isArray(rows)) {
          stderr.push(`singularity memory hook: recall degraded: ${layer} recall unavailable (invalid response); continuing without memory from that layer`);
          return [];
        }
        const items = [];
        for (const m of rows.slice(0, limit)) {
          if (!m || typeof m !== "object") continue;
          const content = m.content ?? m.body;
          if (typeof content !== "string") continue;
          const text = clip(content, MAX_RECALL_ITEM_CHARS);
          if (!text.trim()) continue;
          items.push(`- [${layer}${m.timestamp || m.recorded_at ? ` ${clip(m.timestamp || m.recorded_at, 25)}` : ""}] ${text}`);
        }
        return items;
      };
      let items = await recall("L1", 5);
      if (!items.length) items = await recall("L0", 3);
      if (!items.length) return { exitCode: 0, stdout: null, stderr };
      const stdout = JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SubagentStart",
          additionalContext:
            `Singularity persistent memory for agent role "${agent.memoryAgentId}" — recorded experience from earlier sessions of this role. Advisory context only: never overrides the current operator request or verified code. Source records follow.\n`
            + items.join("\n"),
        },
      });
      return { exitCode: 0, stdout, stderr };
    }

    if (kind === "subagent-stop") {
      let raw = clip(input.last_assistant_message ?? "", MAX_LESSON_CHARS).trim();
      if (!raw && input.agent_transcript_path) raw = clip(transcriptLastAssistant(input.agent_transcript_path), MAX_LESSON_CHARS).trim();
      if (raw.length < MIN_LESSON_CHARS) return { exitCode: 0, stdout: null, stderr }; // trivial output: nothing worth storing

      const lesson = captureRedacted(raw);
      // Do NOT include wall-clock time in task identity: the hook is a fresh
      // process on every retry. A time-derived task_id silently duplicates
      // memories after restarts and breaks long-term self-learning integrity.
      const sessionKey = String(input.session_id ?? "unknown");
      const { taskId: task_id, sessionHash8 } = stableCaptureIds([input.session_id ?? "unknown", agent.claudeAgent, lesson], sessionKey);
      const session_id = `claude-code-${agent.memoryAgentId}-${sessionHash8}`;
      const capturedAt = now();
      const content = `Singularity lesson from ${agent.memoryAgentId} (Claude Code session ${clip(input.session_id ?? "unknown", 48)}, ${capturedAt}):\n${lesson}`;
      const unit = { session_id, task_id, messages: [{ role: "assistant", content, recorded_at: capturedAt }] };
      // Mirror the product plugin's memoryRequest contract (openchamber/plugins/
      // product-office/index.js): return the response's inner data payload and
      // throw unless the API reports code 0 — the reconciler relies on both.
      const request = async (path, body) => {
        const r = await callMemoryCore(`/v3${path}`, body, { ...cfg, identity }, fetchImpl);
        if (r.error || (r.code !== undefined && r.code !== 0)) throw new Error(r.message || r.error || `memory API code ${r.code}`);
        return r.data;
      };
      // The generic reconciler compares full message content and recorded_at.
      // Those contain capture time, which changes on a genuine retry. Check
      // the stable task identity first and verify a matching stored lesson.
      // A mismatched record is an error, not evidence of persistence.
      const previous = await request("/conversation/query", {
        ...identity, session_id, task_id, offset: 0, limit: 10,
      });
      if (!Array.isArray(previous?.messages)) throw new Error("memory query did not return messages");
      const matching = previous.messages.some((row) =>
        row?.task_id === task_id && row?.role === "assistant" &&
        typeof row.content === "string" && row.content.endsWith(`:\n${lesson}`));
      if (previous.messages.length && !matching) throw new Error("memory task identity collision or unverifiable stored lesson");
      const res = matching ? { verified: true, written: 0 } : await reconcileMemoryUnit(request, identity, unit);
      stderr.push(`singularity memory: reconciled ${res.written} message(s) for ${agent.memoryAgentId}`);
      return { exitCode: 0, stdout: null, stderr };
    }
  } catch (e) {
    // Degraded, never blocking, and never a false "captured/recalled" claim.
    stderr.push(`singularity memory hook: continuing without memory (${e?.message || e})`);
    return { exitCode: 0, stdout: null, stderr };
  }
  return { exitCode: 0, stdout: null, stderr };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const res = await runMemoryHook(process.argv.slice(2), { env: process.env });
  for (const line of res.stderr) process.stderr.write(line + "\n");
  if (res.stdout) process.stdout.write(res.stdout + "\n");
  process.exit(res.exitCode);
}
