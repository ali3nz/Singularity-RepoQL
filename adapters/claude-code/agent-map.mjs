// agent-map.mjs — the Claude Code agent roster: every non-pentest Singularity
// role, its source definition, the surface it runs on, and (for delegation
// targets only) the MemoryCore identity it must reuse.
//
// Two surfaces share one namespaced namespace and one install directory:
//
//   surface: "subagent" — a delegation target. Claude Code spawns it through the
//     Agent tool; it reuses the role's MemoryCore identity (team_id / user_id /
//     agent_id). The SubagentStart/SubagentStop hooks recall and capture under
//     that identity, so an OpenChamber agent and its Claude Code twin share one
//     persistent profile and neither gets a duplicate scope.
//
//   surface: "main" — a main-session agent, launched with
//     `claude --agent singularity-<role>`. It carries the role's authority
//     (orchestrator, the seat-plan coordinators, super, standalone, free-mode,
//     ghost). It deliberately has NO per-agent MemoryCore identity: the
//     main-session lane is already captured by the installer's proxy path, and a
//     second profile would duplicate it. resolveSingularityAgent() therefore
//     returns null for these, and the subagent hooks never attribute a
//     main-session turn to a subagent identity.
//
// Roster rule: the surface always mirrors the source definition's `mode` in
// openchamber/agents/. A `mode: subagent` role is a delegation target; a
// `mode: primary` role is a main-session surface. Nothing is invented here, and
// a role that has no source definition cannot be added.
//
// Scope: all portable non-pentest roles. Ghost appears on the main surface only; its memory
// identity stays its own ghost-companion profile (ghost/setup-ghost.sh) and is
// never mapped to a second MemoryCore identity.
//
// Consumers: scripts/install-claude-code.mjs (install/uninstall plan iterates
// Object.keys), adapters/claude-code/memory-hook.mjs (hook attribution).

export const AGENT_MAP = Object.freeze({
  // --- delegation targets (mode: subagent) ----------------------------------
  "singularity-code-reviewer": { surface: "subagent", memoryAgentId: "code-reviewer", sourceDef: "openchamber/agents/code-reviewer.md" },
  "singularity-researcher-web": { surface: "subagent", memoryAgentId: "researcher-web", sourceDef: "openchamber/agents/researcher-web.md" },
  "singularity-thinker": { surface: "subagent", memoryAgentId: "thinker", sourceDef: "openchamber/agents/thinker.md" },
  "singularity-explore": { surface: "subagent", memoryAgentId: "explore", sourceDef: "openchamber/agents/explore.md" },
  "singularity-general": { surface: "subagent", memoryAgentId: "general", sourceDef: "openchamber/agents/general.md" },
  "singularity-board": { surface: "subagent", memoryAgentId: "board", sourceDef: "openchamber/agents/board.md" },

  // --- main-session surfaces (mode: primary) --------------------------------
  "singularity-orchestrator": { surface: "main", memoryAgentId: null, sourceDef: "openchamber/agents/orchestrator.md" },
  "singularity-solo-coordinator": { surface: "main", memoryAgentId: null, sourceDef: "openchamber/agents/solo-coordinator.md" },
  "singularity-duel-coordinator": { surface: "main", memoryAgentId: null, sourceDef: "openchamber/agents/duel-coordinator.md" },
  "singularity-quad-coordinator": { surface: "main", memoryAgentId: null, sourceDef: "openchamber/agents/quad-coordinator.md" },
  "singularity-duo": { surface: "main", memoryAgentId: null, sourceDef: "openchamber/agents/duo.md" },
  "singularity-super": { surface: "main", memoryAgentId: null, sourceDef: "openchamber/agents/super.md" },
  "singularity-standalone": { surface: "main", memoryAgentId: null, sourceDef: "openchamber/agents/standalone.md" },
  "singularity-free-mode": { surface: "main", memoryAgentId: null, sourceDef: "openchamber/agents/free-mode.md" },
  "singularity-ghost": { surface: "main", memoryAgentId: null, sourceDef: "openchamber/agents/ghost.md" },
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
