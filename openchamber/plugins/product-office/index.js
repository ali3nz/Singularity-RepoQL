import { readFileSync } from "node:fs";
import { mapOfficeEvent } from "./office-events.js";
import { flushOfficeQueue } from "./office-transport.js";
import { reconcileMemoryUnit, scopeForSession } from "./memory-reconcile.js";
import { buildTurns } from "./memory-turns.js";

// Configuration file locations may be overridden by environment variables.
// The defaults match the standard Singularity/OpenChamber installation layout.
const MEMORY_CONFIG = process.env.SINGULARITY_MEMORY_CONFIG
  || "/home/openchamber/.config/opencode/product-secrets/memory.json";
const OFFICE_CONFIG = process.env.SINGULARITY_OFFICE_CONFIG
  || "/home/openchamber/.config/opencode/product-secrets/office.json";

function readJsonIfPresent(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

// Claude Office is optional. MemoryCore capture and recall must keep working
// when Office, or either configuration file, is absent.
const memory = readJsonIfPresent(MEMORY_CONFIG);
const office = readJsonIfPresent(OFFICE_CONFIG);

// Endpoint validation: memory and Office traffic must stay on the isolated
// service network even when the stored configuration is wrong or absent.
function validateEndpoint(config, hostname, port) {
  if (!config) return null;
  try {
    const endpoint = new URL(config.baseUrl ?? config.endpoint);
    if (endpoint.protocol !== "http:" || endpoint.hostname !== hostname || endpoint.port !== port) return null;
    return endpoint;
  } catch { return null; }
}

const MEMORY_BASE = validateEndpoint(memory, "memory-core", "8420");
const OFFICE_ENDPOINT = validateEndpoint(office, "product-office", "8000");
// null means the integration is enabled; otherwise the reason it is disabled.
const memoryDisabled = memory ? (MEMORY_BASE ? null : "invalid-endpoint") : "not-configured";
const officeDisabled = office ? (OFFICE_ENDPOINT ? null : "invalid-endpoint") : "not-configured";

async function memoryRequest(path, body) {
  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  headers.set("Authorization", memory.authPrefix + memory.gatewayKey);
  headers.set("x-tdai-service-id", memory.serviceId);
  headers.set("x-tdai-user-key", memory.userKey);
  const response = await fetch(new URL("/v3" + path, MEMORY_BASE), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  const payload = await response.json();
  if (!response.ok || payload.code !== 0) throw new Error("Memory API rejected the request");
  return payload.data;
}
const EVENTS = new Set([
  "session.created", "session.execution.started", "session.execution.succeeded",
  "session.execution.failed", "session.execution.interrupted", "session.deleted",
  "session.tool.called", "session.tool.success", "session.tool.failed",
]);
const TOOL_EVENTS = new Set(["session.tool.called", "session.tool.success", "session.tool.failed"]);

export default {
  id: "product.office-events",
  async setup(ctx) {
    const controller = new AbortController();
    let stopped = false;
    const sessions = new Map();
    const timers = new Map();

    async function flushOffice() {
      if (!OFFICE_ENDPOINT) return;
      await flushOfficeQueue(ctx.storage, OFFICE_ENDPOINT, office.ingestKey, () => stopped);
    }

    async function flushMemory() {
      if (!MEMORY_BASE) return;
      const lock = (globalThis[Symbol.for("openchamber.product.memory.flush")] ??= { busy: false });
      if (lock.busy) return;
      lock.busy = true;
      try {
      const page = await ctx.storage.scan({ prefix: "memory/pending/", limit: 100 });
      for (const { key, value } of page.entries) {
        if (stopped) return;
        const sentKey = key.replace("/pending/", "/sent/");
        if (await ctx.storage.get(sentKey)) { await ctx.storage.remove(key); continue; }
        try {
          await reconcileMemoryUnit(memoryRequest, value.scope, value.unit);
        } catch {
          await ctx.storage.set("memory/status", { state: "degraded", checkedAt: Date.now() }).catch(() => {});
          return;
        }
        await ctx.storage.set(sentKey, true);
        await ctx.storage.remove(key);
      }
      await ctx.storage.set("memory/status", { state: "ready", checkedAt: Date.now() }).catch(() => {});
      } finally { lock.busy = false; }
    }

    function schedule(key, run, delay = 5000) {
      const previous = timers.get(key);
      if (previous) clearTimeout(previous);
      const next = setTimeout(async () => { timers.delete(key); if (!stopped) await run(); }, delay);
      next.unref?.();
      timers.set(key, next);
    }

    async function captureSession(sessionID) {
      if (!MEMORY_BASE) return;
      const session = await ctx.session.get({ sessionID });
      let scope;
      try { scope = scopeForSession(session, "build"); }
      catch (error) { await ctx.storage.set("memory/debug/" + sessionID, { stage: "scope", error: String(error?.message || error) }); return; }
      // Bounded rescan: messages before `through` already belong to closed,
      // recorded turns, so each event only walks the new tail. An interrupted
      // (still-open) turn stays inside the window until it is answered.
      const progress = await ctx.storage.get("memory/progress/" + sessionID);
      const through = Math.max(0, Math.min(Number(progress?.through) || 0, Number.MAX_SAFE_INTEGER - 1));
      const messages = await ctx.session.context({ sessionID });
      const window = messages.slice(through);
      const users = window.filter(m => m?.type === "user").length;
      const assistants = window.filter(m => m?.type === "assistant").length;
      await ctx.storage.set("memory/debug/" + sessionID, { stage: "scanned", from: through, total: messages.length, users, assistants, types: [...new Set(window.map(m => m?.type))] });
      let nextThrough = through;
      for (const turn of buildTurns(window)) {
        const start = through + turn.startIndex;
        const end = through + turn.endIndex;
        const taskId = sessionID + "-turn-" + turn.userIds[0];
        if (await ctx.storage.get("memory/ready/" + taskId)) {
          nextThrough = Math.max(nextThrough, end + 1);
          continue;
        }
        const userTs = messages[start]?.time?.created;
        const replyTs = turn.replyEndIndex != null ? messages[through + turn.replyEndIndex]?.time?.created : undefined;
        const userIso = typeof userTs === "number" ? new Date(userTs).toISOString() : new Date().toISOString();
        const replyIso = typeof replyTs === "number"
          ? new Date(replyTs + 1).toISOString()
          : typeof userTs === "number" ? new Date(userTs + 1).toISOString() : new Date().toISOString();
        const unit = {
          session_id: sessionID,
          task_id: taskId,
          messages: [
            { role: "user", content: turn.text, recorded_at: userIso },
            { role: "assistant", content: turn.reply, recorded_at: replyIso }
          ]
        };
        await ctx.storage.set("memory/pending/" + taskId, { scope, unit });
        await flushMemory();
        await ctx.storage.set("memory/ready/" + taskId, true);
        nextThrough = Math.max(nextThrough, end + 1);
      }
      await ctx.storage.set("memory/progress/" + sessionID, { through: nextThrough });
    }

    void (async () => {
      try {
        await ctx.session.hook("context", async (event) => {
          if (!MEMORY_BASE) return;
          try {
            const session = await ctx.session.get({ sessionID: event.sessionID });
            const scope = scopeForSession(session, "build");
            const lastUser = [...event.messages].reverse().find(m => m?.type === "user" || m?.role === "user");
            const parts = lastUser?.content;
            const question = ((typeof lastUser?.text === "string" ? lastUser.text : "") ||
              (Array.isArray(parts) ? parts.filter(p => p?.type === "text").map(p => p.text).join(" ") : "") ||
              session?.title || "").trim().slice(0, 400);
            const data = await memoryRequest("/atomic/search", { ...scope, query: question || "recent project decisions", limit: 5 });
            let items = (data?.items || []).filter(i => i?.content);
            if (items.length === 0) {
              const recent = await memoryRequest("/atomic/query", { ...scope, limit: 5 });
              items = (recent?.items || []).filter(i => i?.content);
            }
            await ctx.storage.set("memory/hook/" + event.sessionID, { ran: true, question: question.slice(0, 80), items: items.length, checkedAt: Date.now() }).catch(() => {});
            if (items.length > 0) {
              event.system.push({
                type: "text",
                text: "[product-memory] Recalled project memory (scope " + scope.team_id + "):\n" +
                  items.map(i => "- " + String(i.content).slice(0, 300)).join("\n") +
                  "\nTreat these as prior project context; the operator's current instruction always wins.",
              });
              await ctx.storage.set("memory/status", { state: "ready", recalled: items.length, checkedAt: Date.now() }).catch(() => {});
            }
          } catch {
            await ctx.storage.set("memory/status", { state: "recall-degraded", checkedAt: Date.now() }).catch(() => {});
          }
        });
      } catch {}
    })();

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (!EVENTS.has(event.type)) continue;
          try {
            const id = event.data.sessionID;
            const session = event.type === "session.deleted" ? sessions.get(id) : await ctx.session.get({ sessionID: id });
            if (event.type !== "session.deleted") sessions.set(id, session);
            if (OFFICE_ENDPOINT) {
              const payloads = mapOfficeEvent(event, session, "tool");
              if (TOOL_EVENTS.has(event.type)) {
                const messages = await ctx.session.context({ sessionID: id });
                const tool = messages.flatMap(m => m.type === "assistant" ? m.content : [])
                  .find(t => t?.type === "tool" && t.id === event.data.id);
                for (const payload of payloads) payload.data.tool_name = tool?.name || payload.data.tool_name;
              }
              for (const [index, payload] of payloads.entries()) {
                const key = "office/pending/" + event.id + "-" + index;
                if (!(await ctx.storage.get("office/sent/" + event.id + "-" + index))) await ctx.storage.set(key, payload);
              }
            }
            if (event.type === "session.execution.started" || event.type === "session.execution.succeeded" || event.type === "session.execution.failed" || event.type === "session.execution.interrupted") schedule("capture-" + id, () => captureSession(id), 0);
            if (event.type === "session.deleted") sessions.delete(id);
            void flushOffice().catch(() => {});
          } catch {
            if (OFFICE_ENDPOINT) await ctx.storage.set("office/status", { state: "degraded", checkedAt: Date.now() }).catch(() => {});
          }
        }
      } catch {
        if (!stopped && OFFICE_ENDPOINT) await ctx.storage.set("office/status", { state: "disconnected", checkedAt: Date.now() }).catch(() => {});
      }
    })();

    const interval = setInterval(() => { void flushOffice().catch(() => {}); void flushMemory().catch(() => {}); }, 2000);
    interval.unref?.();
    await ctx.storage.set("office/status", { state: officeDisabled ?? "starting", checkedAt: Date.now() });
    await ctx.storage.set("memory/status", { state: memoryDisabled ?? "starting", checkedAt: Date.now() });
    void flushOffice().catch(() => {});
    void flushMemory().catch(() => {});
    return () => {
      stopped = true;
      controller.abort();
      clearInterval(interval);
      for (const timer of timers.values()) clearTimeout(timer);
    };
  },
};
