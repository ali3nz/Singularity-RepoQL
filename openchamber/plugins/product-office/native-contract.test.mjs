import { test } from "node:test";
import assert from "node:assert/strict";
import { unwrapData, storageEntries } from "./native-contract.js";
test("unwraps native session and context API envelopes", () => {
  assert.equal(unwrapData({ data: { id: "ses_test" } }).id, "ses_test");
  assert.deepEqual(unwrapData({ data: [{ type: "user" }] }), [{ type: "user" }]);
});
test("reads native plugin storage key/value objects", () => {
  assert.deepEqual(storageEntries({ entries: [{ key: "pending/1", value: { kind: "synthetic" } }] }), [["pending/1", { kind: "synthetic" }]]);
});
test("rejects invalid storage shapes instead of losing queued events", () => {
  assert.throws(() => storageEntries({ entries: [["key", "value"]] }));
  assert.throws(() => storageEntries({}));
});
