#!/usr/bin/env node
// memory-hook.mjs — Claude Code subagent lifecycle hooks ↔ Singularity MemoryCore.
//
//   node memory-hook.mjs subagent-start   # inside SubagentStart
//   node memory-hook.mjs subagent-stop    # inside SubagentStop
//
// subagent-start: the hook payload's `agent_type` names the subagent. Only
// Singularity agents (namespaced `singularity-*`, mapped in agent-map.mjs) are
// acted on; every other subagent exits silently. A mapped agent gets a BOUNDED
// recall from its own existing MemoryCore identity (≤4 L0 + ≤4 L1 items,
// clipped) returned as hookSpecificOutput.additionalContext — advisory context,
// never instructions. MemoryCore being unreachable must never break the agent:
// failures are logged to stderr and the hook still exits 0 (nothing is claimed
// as recalled).
//
// subagent-stop: a terminated Singularity agent's last assistant message is
// distilled into ONE bounded lesson and persisted under that agent's identity
// through the product's reconciled write path (query-before-write → add →
// verify), so retries never duplicate records. Trivial output, unmapped agents
// and the parent conversation are never captured.
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
import { callMemoryCore, loadGhostMemoryConfig } from "../../ghost/ghost-memory.mjs";
import { reconcileMemoryUnit } from "../../openchamber/plugins/product-office/memory-reconcile.js";
import { resolveSingularityAgent } from "./agent-map.mjs";

const DEFAULT_TEAM = "openchamber-agents";
const MAX_RECALL_ITEM_CHARS = 400;
const MAX_LESSON_CHARS = 4000;
const MIN_LESSON_CHARS = 200;

const clip = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n) : s; };
const sha8 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 8);

// Redact obvious secret shapes before anything is written to memory.
export function redactSecrets(text) {
  return String(text ?? "")
    .replace(/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{10,}\b/g, "[REDACTED]")
    .replace(/\bAKIA[A-Z0-9]{12,}\b/g, "[REDACTED]")
    .replace(/\b(?:api[_-]?key|token|secret|password)\b(\s*[:=]\s*)"?[\w./+=-]{8,}"?/gi, (_m, sep) => `key${sep}[REDACTED]`);
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

export function identityFor(agentType, env = {}) {
  void agentType; // attribution is per-role; team/user come from env/config
  return {
    team_id: env.AGENT_PROFILE_TEAM || DEFAULT_TEAM,
    user_id: env.AGENT_PROFILE_USER || "pilot-operator",
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

  // Memory attribution comes from Claude Code's own hook payload, so a
  // non-Singularity subagent (including parent sessions) never touches memory.
  const agent = resolveSingularityAgent(input.agent_type ?? input.agentType);
  if (!agent) return { exitCode: 0, stdout: null, stderr };

  const configPath = memoryConfigPath(env);
  if (!configPath) {
    return { exitCode: 0, stdout: null, stderr: ["singularity memory hook: no SINGULARITY_REPO_ROOT configured (run scripts/install-claude-code.mjs); continuing without memory"] };
  }

  let cfg;
  try {
    cfg = loadGhostMemoryConfig({ ...env, SINGULARITY_MEMORY_CONFIG: configPath });
  } catch {
    return { exitCode: 0, stdout: null, stderr: ["singularity memory hook: cannot read memory config; continuing without memory"] };
  }
  const identity = { ...identityFor(input.agent_type ?? input.agentType, env), agent_id: agent.memoryAgentId };

  try {
    if (kind === "subagent-start") {
      // Bounded recall: two searches, ≤4 items each, strictly clipped.
      const query = clip(String(input.prompt ?? input.userPrompt ?? "").trim()
        || `${agent.memoryAgentId} prior experience and lessons`, 400);
      const [l0, l1] = await Promise.all([
        callMemoryCore("/v3/conversation/search", { ...identity, query, limit: 4 }, { ...cfg, identity }, fetchImpl).catch((e) => ({ _error: e, data: null })),
        callMemoryCore("/v3/atomic/search", { ...identity, query, limit: 4 }, { ...cfg, identity }, fetchImpl).catch((e) => ({ _error: e, data: null })),
      ]);
      const failed = [l0, l1].filter((r) => r._error);
      if (failed.length) {
        // Degraded, not fatal: report the failure, claim nothing, never block the harness.
        stderr.push(`singularity memory hook: recall degraded, continuing without memory (memory core unreachable: ${failed.map((f) => f._error?.name || "error").join(", ")})`);
      }
      const items = [];
      for (const [r, layer] of [[l0, "L0"], [l1, "L1"]]) {
        for (const m of r?.data?.messages || r?.data?.atoms || r?.data?.items || []) {
          const text = clip(m.content ?? m.body, MAX_RECALL_ITEM_CHARS);
          if (!text.trim()) continue;
          items.push(`- [${layer}${m.timestamp || m.recorded_at ? ` ${clip(m.timestamp || m.recorded_at, 25)}` : ""}] ${text}`);
          if (items.length >= 8) break;
        }
        if (items.length >= 8) break;
      }
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

      const content = `Singularity lesson from ${agent.memoryAgentId} (Claude Code session ${clip(input.session_id ?? "unknown", 48)}, ${now()}):\n${redactSecrets(raw)}`;
      // Stable invocation identity: same (session, agent, content) reconciles to
      // zero new records on retry instead of duplicating one.
      const task_id = `cc-${sha8(JSON.stringify([input.session_id, agent.claudeAgent, content]))}`;
      const session_id = `claude-code-${agent.memoryAgentId}-${sha8(String(input.session_id ?? "unknown"))}`;
      const unit = { session_id, task_id, messages: [{ role: "assistant", content, recorded_at: now() }] };
      // Mirror the product plugin's memoryRequest contract (openchamber/plugins/
      // product-office/index.js): return the response's inner data payload and
      // throw unless the API reports code 0 — the reconciler relies on both.
      const request = async (path, body) => {
        const r = await callMemoryCore(`/v3${path}`, body, { ...cfg, identity }, fetchImpl);
        if (r.error || (r.code !== undefined && r.code !== 0)) throw new Error(r.message || r.error || `memory API code ${r.code}`);
        return r.data;
      };
      const res = await reconcileMemoryUnit(request, identity, unit);
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
