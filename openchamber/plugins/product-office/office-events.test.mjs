import { test } from "node:test";
import assert from "node:assert/strict";
import { mapOfficeEvent } from "./office-events.js";
const session = { location: { directory: "/home/openchamber/workspaces/synthetic" } };
const base = { id: "evt_test", created: 1000, data: { sessionID: "ses_test", id: "call-a", input: { secret: "SYNTHETIC_SECRET" }, error: "SYNTHETIC_SECRET" } };
test("maps actual execution lifecycle without prompt content", () => {
  const out = mapOfficeEvent({ ...base, type: "session.execution.started" }, session);
  assert.equal(out[0].event_type, "user_prompt_submit");
  assert.ok(!JSON.stringify(out).includes("SYNTHETIC_SECRET"));
});
test("maps genuine tool transition with no input/output", () => {
  const out = mapOfficeEvent({ ...base, type: "session.tool.success" }, session, "read");
  assert.equal(out[0].data.tool_name, "read"); assert.equal(out[0].data.success, true);
  assert.ok(!JSON.stringify(out).includes("SYNTHETIC_SECRET"));
});
test("does not turn tool calls into invented subagents", () => {
  const out = mapOfficeEvent({ ...base, type: "session.tool.called" }, session, "subagent");
  assert.equal(out[0].event_type, "pre_tool_use");
});
test("excludes sessions outside the capture roots", () => {
  assert.deepEqual(mapOfficeEvent({ ...base, type: "session.created" }, { location: { directory: "/private" } }), []);
});
test("excludes unknown events and invalid identities", () => {
  assert.deepEqual(mapOfficeEvent({ ...base, type: "session.text.delta" }, session), []);
  assert.deepEqual(mapOfficeEvent({ ...base, type: "session.created", data: { sessionID: "../../private" } }, session), []);
});


test("includes home-project sessions under the default capture roots", () => {
  const out = mapOfficeEvent({ ...base, type: "session.created" }, { location: { directory: "/home/openchamber" } });
  assert.equal(out[0].event_type, "session_start");
});
