// agent-map.mjs — the Claude Code agent roster: every non-pentest Singularity
// role, its source definition, the surface it runs on, and (for delegation
// targets only) the MemoryCore identity it must reuse.
//
// Two surfaces share one namespaced namespace and one install directory:
//
//   surface: "subagent" — a delegation target. Claude Code spawns it through the
//     Agent tool; it reuses the role's MemoryCore identity (team_id / user_id /
//     agent_id). The SubagentStart/SubagentStop hooks recall and capture under
//     that identity, so an Claude Code delegated role uses one
//     persistent profile and neither gets a duplicate scope.
//
//   surface: "main" — a main-session agent, launched with
//     `claude --agent singularity-<role>`. It carries the role's authority
//     (the seat-plan coordinators, duo, super). It deliberately has NO per-agent MemoryCore identity: the
//     main-session lane is already captured by the installer's proxy path, and a
//     second profile would duplicate it. resolveSingularityAgent() therefore
//     returns null for these, and the subagent hooks never attribute a
//     main-session turn to a subagent identity.
//
// Roster rule: the surface always mirrors the source definition's `mode` in
// adapters/claude-code/agents/. A `mode: subagent` role is a delegation target; a
// `mode: primary` role is a main-session surface. Nothing is invented here, and
// a role that has no source definition cannot be added.
//
// Scope: retained Windows roles only. The orchestrator, solo-coordinator, standalone,
// free-mode, ghost, researcher-web, fleet-reviewer and quality-fixer roles are retired.
//
// Consumers: scripts/install-claude-code.mjs (install/uninstall plan iterates
// Object.keys), adapters/claude-code/memory-hook.mjs (hook attribution).

export const AGENT_MAP = Object.freeze({
  // --- delegation targets (mode: subagent) ----------------------------------
  "singularity-code-reviewer": { surface: "subagent", memoryAgentId: "code-reviewer", sourceDef: "adapters/claude-code/agents/singularity-code-reviewer.md" },
  "singularity-thinker": { surface: "subagent", memoryAgentId: "thinker", sourceDef: "adapters/claude-code/agents/singularity-thinker.md" },
  "singularity-explore": { surface: "subagent", memoryAgentId: "explore", sourceDef: "adapters/claude-code/agents/singularity-explore.md" },
  "singularity-general": { surface: "subagent", memoryAgentId: "general", sourceDef: "adapters/claude-code/agents/singularity-general.md" },
  "singularity-board": { surface: "subagent", memoryAgentId: "board", sourceDef: "adapters/claude-code/agents/singularity-board.md" },

  // --- main-session surfaces (mode: primary) --------------------------------
  "singularity-duel-coordinator": { surface: "main", memoryAgentId: null, sourceDef: "adapters/claude-code/agents/singularity-duel-coordinator.md" },
  "singularity-quad-coordinator": { surface: "main", memoryAgentId: null, sourceDef: "adapters/claude-code/agents/singularity-quad-coordinator.md" },
  "singularity-duo": { surface: "main", memoryAgentId: null, sourceDef: "adapters/claude-code/agents/singularity-duo.md" },
  "singularity-super": { surface: "main", memoryAgentId: null, sourceDef: "adapters/claude-code/agents/singularity-super.md" },
});

/** Resolve a Claude Code hook `agent_type` to its Singularity memory identity role.
 *  Returns null for main-session surfaces and for anything that is not ours: a
 *  main-session turn has no subagent profile, and built-in subagents are never
 *  captured or recalled. */
export function resolveSingularityAgent(agentType) {
  if (typeof agentType !== "string") return null;
  const entry = AGENT_MAP[agentType];
  if (!entry || !entry.memoryAgentId) return null;
  return { claudeAgent: agentType, memoryAgentId: entry.memoryAgentId, surface: entry.surface };
}
