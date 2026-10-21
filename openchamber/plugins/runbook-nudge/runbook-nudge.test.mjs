import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "rb-nudge-module-"));
copyFileSync(process.env.RUNBOOK_PLUGIN || fileURLToPath(new URL("./index.js", import.meta.url)), join(root, "plugin.mjs"));
const mod = await import(pathToFileURL(join(root, "plugin.mjs")));
test("loadSharedPolicy: no installed runtime copy is audited as unavailable (fail-open)", async () => {
  const trail = [];
  const policy = await mod.loadSharedPolicy((e) => trail.push(e));
  assert.equal(policy, null);
  const un = trail.filter(r => r.decision === "NUDGE-RB-DISCOVERY-UNAVAILABLE");
  assert.equal(un.length, 1);
  assert.match(un[0].reason, /singularity-runtime/);
});

test("loadSharedPolicy: loads the SHARED policy from its installed runtime sibling and rejects a spoiler module", async () => {
  // Simulate the attach layout: plugins/<plugin>/index.mjs with a sibling
  // singularity-runtime/scripts/doc-policy.mjs (the real shared policy).
  const dir = mkdtempSync(join(tmpdir(), "rb-nudge-runtime-"));
  try {
    const pluginDir = join(dir, "plugins", "runbook-nudge");
    const runtimeScripts = join(dir, "plugins", "singularity-runtime", "scripts");
    mkdirSync(pluginDir, { recursive: true });
    mkdirSync(runtimeScripts, { recursive: true });
    copyFileSync(fileURLToPath(new URL("./index.js", import.meta.url)), join(pluginDir, "index.mjs"));
    copyFileSync(fileURLToPath(new URL("../../../scripts/doc-policy.mjs", import.meta.url)), join(runtimeScripts, "doc-policy.mjs"));
    // doc-policy imports ./selflearn-candidates.mjs relative to itself, so the
    // runtime layout needs BOTH scripts — exactly what scripts/attach-openchamber.mjs ships.
    copyFileSync(fileURLToPath(new URL("../../../scripts/selflearn-candidates.mjs", import.meta.url)), join(runtimeScripts, "selflearn-candidates.mjs"));
    const instance = await import(pathToFileURL(join(pluginDir, "index.mjs")).href);
    const trail = [];
    const policy = await instance.loadSharedPolicy((e) => trail.push(e));
    assert.equal(typeof policy.autoIngestChangedDocs, "function");
    assert.equal(typeof policy.saveSessionBaseline, "function");
    assert.equal([...trail].some(r => r.decision === "NUDGE-RB-DISCOVERY-MODULE"), true, "module provenance audited");

  } finally { rmSync(dir, { recursive: true, force: true }); }

  // A spoiler file masquerading as the shared policy is rejected by the API
  // check — arbitrary untrusted content is never treated as policy. A separate
  // directory keeps the import cache from masking the rejection.
  const dir2 = mkdtempSync(join(tmpdir(), "rb-nudge-spoiler-"));
  try {
    const pluginDir = join(dir2, "plugins", "runbook-nudge");
    const runtimeScripts = join(dir2, "plugins", "singularity-runtime", "scripts");
    mkdirSync(pluginDir, { recursive: true });
    mkdirSync(runtimeScripts, { recursive: true });
    copyFileSync(fileURLToPath(new URL("./index.js", import.meta.url)), join(pluginDir, "index.mjs"));
    writeFileSync(join(runtimeScripts, "doc-policy.mjs"), "export const autoIngestChangedDocs = \"spoiler\";\n");
    const instance2 = await import(pathToFileURL(join(pluginDir, "index.mjs")).href);
    const trail2 = [];
    const rejected = await instance2.loadSharedPolicy((e) => trail2.push(e));
    assert.equal(rejected, null);
    assert.equal(trail2.filter(r => r.decision === "NUDGE-RB-DISCOVERY-UNAVAILABLE").length, 1);
    assert.match(trail2[trail2.length - 1].reason, /not the policy API/);
  } finally { rmSync(dir2, { recursive: true, force: true }); }
});

// ── existing tests appended below ──

async function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), "rb-nudge-test-"));
  const names = ["OPENCHAMBER_CAPABILITY_DIR", "OPENCHAMBER_AUDIT_LOG", "OPENCHAMBER_RUNBOOK_NUDGE"];
  const old = Object.fromEntries(names.map(n => [n, process.env[n]]));
  process.env.OPENCHAMBER_CAPABILITY_DIR = dir;
  process.env.OPENCHAMBER_AUDIT_LOG = join(dir, "audit.jsonl");
  delete process.env.OPENCHAMBER_RUNBOOK_NUDGE;
  const hooks = [];
  let disposed = false;
  const ctx = { session: { hook: async (kind, cb) => { hooks.push({ kind, cb }); return { dispose: () => { disposed = true; } }; } } };
  const cleanup = await mod.default.setup(ctx);
  const event = (sid = "ses_test") => ({ sessionID: sid, system: [{ type: "text", text: "original policy" }], messages: [], tools: {}, options: {} });
  const audit = () => readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  try { await run({ dir, ctx, hooks, cleanup, disposed: () => disposed, event, audit }); }
  finally {
    for (const n of names) if (old[n] === undefined) delete process.env[n]; else process.env[n] = old[n];
    rmSync(dir, { recursive: true, force: true });
  }
}

test("registers only the primary context hook, with a working dispose", () => fixture(async ({ hooks, cleanup, disposed }) => {
  assert.deepEqual(hooks.map(x => x.kind), ["context"]);
  await cleanup(); assert.equal(disposed(), true);
}));

test("first model request receives the START and closing reminders", () => fixture(({ hooks, event, audit }) => {
  const e = event(); hooks[0].cb(e);
  assert.equal(e.system.length, 2);
  assert.match(e.system[1].text, /runbook start nudge/);
  assert.match(e.system[1].text, /Before your final answer/);
  assert.match(e.system[1].text, /if none exists, CREATE one; if one exists, UPDATE it/);
  assert.ok(audit().some(r => r.decision === "NUDGE-RB-CONTEXT"));
}));

test("every fresh request receives the closing nudge, START once per session", () => fixture(({ hooks, event, audit }) => {
  for (let i = 0; i < 4; i++) {
    const e = event(); e.messages = [{ role: "tool", content: "result" }]; hooks[0].cb(e);
    assert.match(e.system[1].text, /runbook closeout nudge/);
    assert.equal(e.system[1].text.includes("runbook start nudge"), i === 0);
  }
  assert.equal(audit().filter(r => r.decision === "NUDGE-RB-START").length, 1);
  assert.equal(audit().filter(r => r.decision === "NUDGE-RB-CONTEXT").length, 4);
}));

test("same outgoing draft does not accumulate duplicate reminder blocks", () => fixture(({ hooks, event }) => {
  const e = event(); hooks[0].cb(e); hooks[0].cb(e);
  assert.equal(e.system.length, 2);
  assert.equal(e.system.filter(p => p.text.includes("[runbook closeout nudge]")).length, 1);
}));

test("request messages, tools and options remain untouched", () => fixture(({ hooks, event }) => {
  const e = event(); e.tools = { read: {} }; e.options = { temperature: 0.2 }; e.messages = [{ role: "user", content: "hello" }];
  const before = JSON.stringify({ messages: e.messages, tools: e.tools, options: e.options, policy: e.system[0] });
  hooks[0].cb(e);
  assert.equal(JSON.stringify({ messages: e.messages, tools: e.tools, options: e.options, policy: e.system[0] }), before);
}));

test("persisted START dedup survives plugin recreation without suppressing the closing nudge", () => fixture(async ({ ctx, hooks, event }) => {
  hooks[0].cb(event());
  await mod.default.setup(ctx);
  const e = event(); hooks[1].cb(e);
  assert.doesNotMatch(e.system[1].text, /runbook start nudge/);
  assert.match(e.system[1].text, /runbook closeout nudge/);
}));

test("legacy persisted state is respected; closing context still delivered", () => fixture(async ({ dir, ctx, hooks, event }) => {
  mkdirSync(join(dir, "runbook-nudge-state"));
  writeFileSync(join(dir, "runbook-nudge-state", "ses_legacy.json"), JSON.stringify({ startDelivered: true }));
  await mod.default.setup(ctx);
  const e = event("ses_legacy"); hooks[1].cb(e);
  assert.doesNotMatch(e.system[1].text, /runbook start nudge/);
  assert.match(e.system[1].text, /runbook closeout nudge/);
}));

test("sessions have independent START state", () => fixture(({ hooks, event }) => {
  for (const sid of ["ses_one", "ses_two"]) { const e = event(sid); hooks[0].cb(e); assert.match(e.system[1].text, /runbook start nudge/); }
}));

test("flag off suppresses both reminders and does not mark START delivered", () => fixture(({ hooks, event }) => {
  process.env.OPENCHAMBER_RUNBOOK_NUDGE = "off";
  const e = event(); hooks[0].cb(e); assert.equal(e.system.length, 1);
  delete process.env.OPENCHAMBER_RUNBOOK_NUDGE;
  hooks[0].cb(e); assert.match(e.system[1].text, /runbook start nudge/);
}));

test("malformed, absent session and frozen context fail open without blocking", () => fixture(({ hooks, event }) => {
  for (const e of [null, {}, { sessionID: "ses_bad", system: null }, event("unknown"), { ...event(), system: Object.freeze([]) }]) assert.doesNotThrow(() => hooks[0].cb(e));
  const e = event(); hooks[0].cb(e); assert.match(e.system[1].text, /runbook start nudge/);
}));

test("unwritable start-state cannot prevent closing-reminder delivery", () => fixture(({ dir, hooks, event, audit }) => {
  writeFileSync(join(dir, "runbook-nudge-state"), "not a directory");
  const e = event(); assert.doesNotThrow(() => hooks[0].cb(e));
  assert.match(e.system[1].text, /runbook closeout nudge/);
  assert.ok(audit().some(r => r.decision === "NUDGE-RB-STATE-ERR"));
}));

test("start nudge puts the active-work check first and keeps it out of the closing text", () => fixture(({ hooks, event }) => {
  const e = event(); hooks[0].cb(e);
  const t = e.system[1].text;
  assert.match(t, /active related work/);
  assert.match(t, /tracking records/);
  assert.match(t, /ownership and claim conflicts/);
  assert.match(t, /record and claim one before starting/);
  assert.ok(t.indexOf("active related work") < t.indexOf("narrowest relevant docs area"));
  const second = event(); hooks[0].cb(second);
  assert.doesNotMatch(second.system[1].text, /runbook start nudge/);
  assert.doesNotMatch(mod.CLOSE_REMINDER, /active related work/);
}));

test("start nudge asks for a RepoQL concept search before editing", () => fixture(({ hooks, event }) => {
  const e = event(); hooks[0].cb(e);
  assert.match(e.system[1].text, /search existing RepoQL concepts/);
}));

test("closing nudge covers runbook, concepts and validation-honesty", () => fixture(({ hooks, event }) => {
  const e = event(); hooks[0].cb(e);
  const text = e.system[1].text;
  assert.match(text, /REPOQL/);
  assert.match(text, /search existing concepts/);
  assert.match(text, /documented capture path/);
  assert.match(text, /supersedes the record's lineage only/);
  assert.match(text, /Never hand-edit captured/);
  assert.match(text, /documented retirement process/);
  assert.match(text, /new durable wisdom, rules, shapes or/);
  assert.match(text, /SeeAlso/);
  assert.match(text, /VALIDATION/);
  assert.ok(text.includes("a command exiting successfully is not proof of correctness"));
}));

test("closing guidance is present on every fresh request, not only the first", () => fixture(({ hooks, event }) => {
  for (let i = 0; i < 3; i++) {
    const e = event(); hooks[0].cb(e);
    assert.match(e.system[e.system.length - 1].text, /runbook closeout nudge/);
  }
}));

test("wording is conditional and permissions-aware, not a gate or auto-write", () => {
  assert.match(mod.CLOSE_REMINDER, /reasonably likely to recur/);
  assert.match(mod.CLOSE_REMINDER, /Skip one-off or trivial work and duplicates/);
  assert.match(mod.CLOSE_REMINDER, /never exceed your permissions/);
});

test("missing context hook is explicitly audited without any send-once fallback", () => fixture(async ({ audit }) => {
  await assert.doesNotReject(() => mod.default.setup({}));
  assert.ok(audit().some(r => r.decision === "CONTEXT_HOOK_UNAVAILABLE"));
}));
