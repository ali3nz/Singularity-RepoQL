// agent-map.mjs — explicit mapping between Claude Code subagent names and the
// Singularity MemoryCore identities they must reuse.
//
// Rule: one logical Singularity agent owns exactly one MemoryCore identity
// (team_id / user_id / agent_id). The Claude Code display names are namespaced
// ("singularity-<role>") only to avoid collisions with Claude Code's built-in
// subagents; the MEMORY identity stays the role name, so an OpenChamber agent
// and its Claude Code twin share the same persistent profile and neither gets
// a duplicate scope. Ghost and standalone are deliberately absent: Ghost owns
// its own ghost-companion profile (ghost/setup-ghost.sh) and standalone's
// guidance belongs to the main-agent configuration, not a subagent.
//
// Consumers: scripts/install-claude-code.mjs (profile provisioning + install
// plan), adapters/claude-code/memory-hook.mjs (hook attribution).

export const AGENT_MAP = Object.freeze({
  "singularity-code-reviewer": { memoryAgentId: "code-reviewer", sourceDef: "openchamber/agents/code-reviewer.md" },
  "singularity-quality-fixer": { memoryAgentId: "quality-fixer", sourceDef: "openchamber/agents/quality-fixer.md" },
  "singularity-researcher-web": { memoryAgentId: "researcher-web", sourceDef: "openchamber/agents/researcher-web.md" },
  "singularity-thinker": { memoryAgentId: "thinker", sourceDef: "openchamber/agents/thinker.md" },
  "singularity-explore": { memoryAgentId: "explore", sourceDef: "openchamber/agents/explore.md" },
  "singularity-general": { memoryAgentId: "general", sourceDef: "openchamber/agents/general.md" },
  "singularity-board": { memoryAgentId: "board", sourceDef: "openchamber/agents/board.md" },
});

/** Resolve a Claude Code hook `agent_type` to its Singularity memory identity role. */
export function resolveSingularityAgent(agentType) {
  if (typeof agentType !== "string") return null;
  const entry = AGENT_MAP[agentType];
  return entry ? { claudeAgent: agentType, memoryAgentId: entry.memoryAgentId } : null;
}
