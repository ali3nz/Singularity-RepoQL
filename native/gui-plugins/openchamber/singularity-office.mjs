// Native OpenCode plugin for OpenChamber Desktop (Windows).
// This file is the mandatory host-language hook adapter ONLY. All mapping,
// authorization, credential loading and HTTP are handled by the Rust bridge.
// Opt-in: if SINGULARITY_DESKTOP_BRIDGE is absent, it does nothing.
// Does not read message content or tool input/output, and does not touch auth.
import { spawn as nodeSpawn } from "node:child_process";

const SESSION_PATTERN = /^[a-zA-Z0-9_-]{3,128}$/;
const MAX_EVENT_BYTES = 2048;
const MAP = Object.freeze({
  "session.created": "session-start",
  "session.deleted": "session-end",
  "session.idle": "stop",
  "session.compacted": "compact",
  "session.error": "error",
});

const scope = x => typeof x === "string" && SESSION_PATTERN.test(x) ? x : null;
const basenameAny = p => String(p ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
const short = x => String(x ?? "").replace(/[^a-zA-Z0-9_. -]/g, "").slice(0, 64);

// Supports the event envelope used by OpenCode's documented plugin API.
// No user prompts, message contents or tool inputs are ever accessed.
export function officeEventFromOpenCode(event, directory = "") {
  const kind = MAP[event?.type];
  if (!kind) return null;
  const id = scope(event?.properties?.info?.id ?? event?.properties?.sessionID ?? event?.data?.sessionID);
  if (!id) return null;
  return {kind, session_id: id, project_name: short(basenameAny(directory))};
}

export function officeToolFromOpenCode(input, kind, directory = "") {
  const id = scope(input?.sessionID ?? input?.sessionId);
  if (!id || !["pre-tool", "post-tool"].includes(kind)) return null;
  return {
    kind, session_id: id, project_name: short(basenameAny(directory)),
    tool_name: short(input?.tool ?? "tool"), tool_use_id: short(input?.callID ?? ""),
    // OpenCode hook completion does not necessarily imply tool success.
  };
}

/** Fire-and-forget. Never forward arbitrary plugin event data to the subprocess. */
export function forwardToRust(payload, exe, spawn = nodeSpawn) {
  if (!payload || typeof exe !== "string" || !/^[A-Za-z]:\\/.test(exe) || !exe.toLowerCase().endsWith(".exe") || /[\r\n]/.test(exe) || exe.split(/[\\/]/).includes("..")) return false;
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  if (bytes.byteLength > MAX_EVENT_BYTES) return false;
  let child;
  try {
    child = spawn(exe, ["office-opencode"], {stdio: ["pipe", "ignore", "ignore"], windowsHide: true});
    child.on("error", () => {}); // optional Office transport must not fail the GUI
    child.stdin?.on("error", () => {});
    child.stdin?.end(bytes);
    child.unref?.();
  } catch { return false; }
  return true;
}

// Loaded by OpenCode as a plugin. The API runs in the desktop app's own server;
// the user does not have to start opencode CLI.
export const SingularityOfficeNative = async ({ directory }) => {
  const exe = process.env.SINGULARITY_DESKTOP_BRIDGE;
  const forward = payload => { if (exe) forwardToRust(payload, exe); };
  return {
    event: async ({event}) => forward(officeEventFromOpenCode(event, directory)),
    "tool.execute.before": async input => forward(officeToolFromOpenCode(input, "pre-tool", directory)),
    "tool.execute.after": async input => forward(officeToolFromOpenCode(input, "post-tool", directory)),
  };
};
