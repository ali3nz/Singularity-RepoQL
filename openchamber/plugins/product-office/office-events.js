import { withinMemoryRoots } from "./memory-reconcile.js";

/** Whitelisted metadata only. Never forward prompts, tool input/output or errors. */
export function mapOfficeEvent(event, session, toolName = "tool") {
  const id = event?.data?.sessionID;
  if (typeof id !== "string" || !/^ses_[a-zA-Z0-9_-]+$/.test(id)) return [];
  const directory = session?.location?.directory;
  if (typeof directory !== "string" || !withinMemoryRoots(directory)) return [];
  const sessionID = `oc-${id}`;
  const base = { agent_id: sessionID, native_agent_id: id, display_name: `OpenCode ${id.slice(-8)}`, project_name: "Product workspace" };
  const data = event.data;
  const parentID = data.parentID ?? session.parentID;
  const make = (type, extra = {}) => ({ event_type: type, session_id: sessionID, timestamp: new Date(event.created).toISOString(), data: { ...base, ...extra } });
  switch (event.type) {
    case "session.created": {
      const events = [make("session_start")];
      if (typeof parentID === "string" && /^ses_[a-zA-Z0-9_-]+$/.test(parentID)) {
        events.push({ ...make("subagent_start", { parent_session_id: `oc-${parentID}` }), session_id: `oc-${parentID}` });
      }
      return events;
    }
    case "session.execution.started": return [make("user_prompt_submit")];
    case "session.execution.succeeded":
    case "session.execution.interrupted": return [make("stop")];
    case "session.execution.failed": return [make("error", { message: "Agent execution failed" }), make("stop")];
    case "session.deleted": return [make("session_end")];
    case "session.tool.called": return [make("pre_tool_use", { tool_name: toolName, tool_use_id: data.id })];
    case "session.tool.success": return [make("post_tool_use", { tool_name: toolName, tool_use_id: data.id, success: true })];
    case "session.tool.failed": return [make("post_tool_use", { tool_name: toolName, tool_use_id: data.id, success: false })];
    default: return [];
  }
}
