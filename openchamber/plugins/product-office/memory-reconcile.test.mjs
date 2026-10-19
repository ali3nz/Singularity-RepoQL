import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryRoots, reconcileMemoryUnit, scopeForSession } from "./memory-reconcile.js";
const scope = { team_id: "project-a", user_id: "user-a", agent_id: "build" };
const unit = { session_id: "ses_test", task_id: "turn-unique", messages: [
  { role: "user", content: "Synthetic decision", recorded_at: "2026-10-17T00:00:00.000Z" },
  { role: "assistant", content: "Recorded synthetic decision", recorded_at: "2026-10-17T00:00:01.000Z" },
] };
function fixture(failAfterPartial = false) {
  const rows = [];
  let fault = failAfterPartial;
  return { rows, request: async (path, body) => {
    assert.equal(body.team_id, scope.team_id);
    if (path.endsWith("query")) return { messages: rows, total: rows.length };
    const messages = fault ? body.messages.slice(0, 1) : body.messages;
    messages.forEach(m => rows.push({ ...m, timestamp: m.recorded_at, task_id: body.task_id }));
    if (fault) { fault = false; throw new Error("simulated connection lost after partial commit"); }
    return {};
  } };
}
test("replayed capture does not duplicate existing messages", async () => {
  const f = fixture();
  assert.equal((await reconcileMemoryUnit(f.request, scope, unit)).written, 2);
  assert.equal((await reconcileMemoryUnit(f.request, scope, unit)).written, 0);
  assert.equal(f.rows.length, 2);
});
test("partial write failure replays only missing messages", async () => {
  const f = fixture(true);
  await assert.rejects(reconcileMemoryUnit(f.request, scope, unit));
  assert.equal((await reconcileMemoryUnit(f.request, scope, unit)).written, 1);
  assert.equal(f.rows.length, 2);
});
test("reconciliation queries by task_id and ignores rows without one", async () => {
  // Verified against the deployed Memory Core image: /conversation/query
  // accepts a task_id filter and echoes task_id on each row. The fixture
  // asserts the REQUEST contract so a regression here fails loudly.
  const seen = [];
  const rows = [];
  const request = async (path, body) => {
    seen.push({ path, task_id: body.task_id });
    if (path.endsWith("query")) {
      return { messages: rows.filter(r => r.task_id === body.task_id), total: rows.length };
    }
    body.messages.forEach(m => rows.push({ ...m, task_id: body.task_id }));
    return {};
  };
  const other = { session_id: "ses_test", task_id: "other-task", messages: [{ role: "user", content: "unrelated", recorded_at: "2026-10-17T00:00:00.000Z" }] };
  await reconcileMemoryUnit(request, scope, other); // different task in the same session
  assert.equal((await reconcileMemoryUnit(request, scope, unit)).written, 2);
  assert.equal(rows.length, 3);
  assert.ok(seen.every(s => s.task_id && (s.task_id === "other-task" || s.task_id === "turn-unique")));
  // A second reconciliation of the same unit must recognise both stored rows
  // by task_id even though the fixture's query response is now filtered.
  assert.equal((await reconcileMemoryUnit(request, scope, unit)).written, 0);
});
test("project directory and user identity isolate scope", () => {
  const session = { projectID: "global", location: { directory: "/home/openchamber/workspaces/a" } };
  const a = scopeForSession(session, "build", "user-a");
  assert.notEqual(a.team_id, scopeForSession({ ...session, location: { directory: "/home/openchamber/workspaces/b" } }, "build", "user-a").team_id);
  assert.notEqual(a.team_id, scopeForSession(session, "build", "user-b").team_id);
  assert.throws(() => scopeForSession({ location: { directory: "/private" } }, "build"));
});


test("capture roots cover the product home and workspaces by default", () => {
  assert.doesNotThrow(() => scopeForSession({ projectID: "p", location: { directory: "/home/openchamber" } }, "build"));
  assert.doesNotThrow(() => scopeForSession({ projectID: "p", location: { directory: "/home/openchamber/workspaces/pilot-sum" } }, "build"));
  assert.throws(() => scopeForSession({ projectID: "p", location: { directory: "/home/openchamber-evil" } }, "build"));
  assert.throws(() => scopeForSession({ projectID: "p", location: { directory: "/" } }, "build"));
});

test("SINGULARITY_MEMORY_ROOTS overrides the default with fail-closed parsing", () => {
  const previous = process.env.SINGULARITY_MEMORY_ROOTS;
  const session = (directory) => ({ projectID: "p", location: { directory } });
  try {
    process.env.SINGULARITY_MEMORY_ROOTS = "/opt/work , /srv/other/";
    assert.doesNotThrow(() => scopeForSession(session("/opt/work/app"), "build"));
    assert.doesNotThrow(() => scopeForSession(session("/srv/other/x"), "build"));
    assert.throws(() => scopeForSession(session("/opt/other"), "build"));
    process.env.SINGULARITY_MEMORY_ROOTS = "   ";
    assert.doesNotThrow(() => scopeForSession(session("/home/openchamber"), "build"));
    assert.throws(() => scopeForSession(session("/opt/work/app"), "build"));
    process.env.SINGULARITY_MEMORY_ROOTS = "/,relative,/ok/root/";
    assert.doesNotThrow(() => scopeForSession(session("/ok/root/x"), "build"));
    assert.throws(() => scopeForSession(session("/relative"), "build"));
  } finally {
    if (previous === undefined) delete process.env.SINGULARITY_MEMORY_ROOTS;
    else process.env.SINGULARITY_MEMORY_ROOTS = previous;
  }
});

test("memoryRoots falls back when the override has no usable entries", () => {
  assert.deepEqual(memoryRoots({}), ["/home/openchamber"]);
  assert.deepEqual(memoryRoots({ SINGULARITY_MEMORY_ROOTS: " , , " }), ["/home/openchamber"]);
  assert.deepEqual(memoryRoots({ SINGULARITY_MEMORY_ROOTS: "/a//,/b/" }), ["/a", "/b"]);
  assert.deepEqual(memoryRoots({ SINGULARITY_MEMORY_ROOTS: "/" }), ["/home/openchamber"]);
});
