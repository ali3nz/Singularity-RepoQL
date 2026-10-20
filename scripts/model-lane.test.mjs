// Unit tests for the canonical model lane (scripts/model-lane.mjs).
//
// The lane is derived, never hardcoded, and its probe must separate the four
// actionable cases (route invalid / auth failed / no models / not functional)
// from a real, working completion.
//
// Run: node --test scripts/model-lane.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeModelLane, resolveModelLane, proxyPort, modelLaneAdvice, MODEL_LANE } from "./model-lane.mjs";

const jsonRes = (status, payload) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) });

test("the lane is derived from the canonical config, never hardcoded to a broken route", () => {
  const lane = resolveModelLane({ flavour: "container" });
  assert.equal(lane.lane, MODEL_LANE);
  assert.equal(lane.spaceId, "default");
  assert.equal(lane.route, "http://proxy:8096/claude-code/default/v1",
    "the container flavour uses the product-network alias and the registered lane");
  assert.ok(!lane.route.includes("/openai/"), "the structurally invalid lane must never be the default");

  const host = resolveModelLane({ flavour: "host" });
  assert.equal(host.route, "http://127.0.0.1:8096/claude-code/default/v1");
});

test("the proxy port comes from the memory stack's upstream .env", () => {
  assert.equal(proxyPort({ upstreamEnvContent: "PROXY_PORT=9100\nOTHER=1" }), 9100);
  assert.equal(proxyPort({ env: { SINGULARITY_PROXY_PORT: "9200" } }), 9200);
  assert.equal(proxyPort({}), 8096);
  const lane = resolveModelLane({ flavour: "host", upstreamEnvContent: "PROXY_PORT=9100" });
  assert.equal(lane.route, "http://127.0.0.1:9100/claude-code/default/v1");
});

test("an explicit space id overrides the default (a registered business space)", () => {
  const lane = resolveModelLane({ flavour: "host", env: { SINGULARITY_MODEL_SPACE_ID: "team-alpha" } });
  assert.equal(lane.route, "http://127.0.0.1:8096/claude-code/team-alpha/v1");
});

test("a route the proxy does not register is PATH_INVALID (routing, not credentials)", async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return jsonRes(400, { error: "spaceId is required in the request path" }); };
  const r = await probeModelLane({ gatewayUrl: "http://proxy:8096/openai/default/v1", key: "sk-x", fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.state, "PATH_INVALID");
  assert.match(r.detail, /spaceId is required/);
  assert.equal(calls.length, 1, "a routing failure must not spend a model call");
  assert.match(modelLaneAdvice(r.state), /SINGULARITY_MODEL_SPACE_ID/);
});

test("a rejected key is AUTH_FAILED", async () => {
  const fetchImpl = async () => jsonRes(401, { error: "Authentication failed" });
  const r = await probeModelLane({ gatewayUrl: "http://proxy:8096/claude-code/default/v1", key: "sk-bad", fetchImpl });
  assert.equal(r.state, "AUTH_FAILED");
  assert.equal(r.ok, false);
});

test("a registered space with an empty model list and a working completion is OK", async () => {
  const fetchImpl = async (url) => (url.endsWith("/models")
    ? jsonRes(200, { data: [] })
    : jsonRes(200, { choices: [{ message: { content: "pong" } }] }));
  const r = await probeModelLane({ gatewayUrl: "http://proxy:8096/claude-code/default/v1", key: "sk-ok", fetchImpl });
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.state, "OK");
  assert.match(r.detail, /real completion/);
});

test("an empty model list with no working model is NO_MODELS", async () => {
  const fetchImpl = async (url) => (url.endsWith("/models")
    ? jsonRes(200, { data: [] })
    : jsonRes(404, { error: "Invalid model identifier" }));
  const r = await probeModelLane({ gatewayUrl: "http://proxy:8096/claude-code/default/v1", key: "sk-ok", fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.state, "NO_MODELS");
  assert.match(modelLaneAdvice(r.state), /model/i);
});

test("a lane that authenticates but fails the completion is NOT_FUNCTIONAL", async () => {
  const fetchImpl = async (url) => (url.endsWith("/models")
    ? jsonRes(200, { data: [{ id: "m1" }] })
    : jsonRes(500, { error: "upstream exploded" }));
  const r = await probeModelLane({ gatewayUrl: "http://proxy:8096/claude-code/default/v1", key: "sk-ok", fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.state, "NOT_FUNCTIONAL");
});

test("no key is NO_CREDENTIALS and no request is made", async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return jsonRes(200, { data: [] }); };
  const r = await probeModelLane({ gatewayUrl: "http://proxy:8096/claude-code/default/v1", key: "", fetchImpl });
  assert.equal(r.state, "NO_CREDENTIALS");
  assert.equal(called, false);
});

test("an unreachable proxy is UNREACHABLE", async () => {
  const fetchImpl = async () => { throw new Error("ECONNREFUSED"); };
  const r = await probeModelLane({ gatewayUrl: "http://127.0.0.1:1/claude-code/default/v1", key: "sk-ok", fetchImpl });
  assert.equal(r.state, "UNREACHABLE");
  assert.equal(r.ok, false);
});

test("the lane never returns the key material", async () => {
  const fetchImpl = async (url) => (url.endsWith("/models")
    ? jsonRes(200, { data: [] })
    : jsonRes(200, { choices: [{ message: { content: "pong" } }] }));
  const r = await probeModelLane({ gatewayUrl: "http://proxy:8096/claude-code/default/v1", key: "sk-super-secret", fetchImpl });
  assert.ok(!JSON.stringify(r).includes("sk-super-secret"), "the key must never appear in the verdict");
});
