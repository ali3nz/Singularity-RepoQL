#!/usr/bin/env node
// ghost-turn.mjs — run ONE Ghost turn on the OpenChamber (opencode) runtime,
// with a bounded MemoryCore recall block prepended to the instruction.
//
// Usage:
//   node ghost/ghost-turn.mjs --slot=audit --instruction="<text>" [--session=ghost-slot-audit] [--dry]
//   node ghost/ghost-turn.mjs --slot=docs  --instruction-file=/path/brief.md [--recall=off]
//
// Exit codes: 0 = turn completed; 2 = usage; 3 = turn failed; 4 = capture failed.
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const LOG_DIR = process.env.GHOST_TURN_LOG_DIR || join(ROOT, "data", "ghost", "runs");
const RUNTIME = process.env.GHOST_RUNTIME || "opencode";
const CONTAINER = process.env.GHOST_CONTAINER || "singularity-openchamber";
const AGENT = process.env.GHOST_AGENT || "ghost";
const MODEL = process.env.GHOST_MODEL || "";
const MEMORY_SCRIPT = process.env.GHOST_MEMORY_SCRIPT || join(HERE, "ghost-memory.mjs");
const MAX_OUT = Number(process.env.GHOST_MAX_OUTPUT_CHARS || 60000);

export function formatRecallBlock(query, items, maxChars = 1800) {
  const lines = [];
  for (const it of items || []) {
    if (!it || typeof it.text !== "string") continue;
    lines.push(`- ${it.text.replace(/\s+/g, " ").slice(0, 400)}`);
    if (lines.join("\n").length >= maxChars) break;
  }
  const block = lines.length
    ? `[memory] MemoryCore recall for "${query}" (agent ghost, layer L1). Treat as your own past memories; they can be stale, so verify facts that matter.\n${lines.join("\n")}\n[/memory]\n\n`
    : "";
  return { count: lines.length, block, ids: (items || []).map((i) => i && i.id).filter(Boolean) };
}

export function parseOpencodeJsonStream(stdout, maxChars = MAX_OUT) {
  const texts = [];
  let usage = null, sesid = null, runError = "";
  for (const line of String(stdout || "").split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let j = null;
    try { j = JSON.parse(t); } catch { continue; }
    if (j.sessionID) sesid = j.sessionID;
    if (j.type === "error" && j.error) runError = String(j.error.message || j.error.type || "");
    if (j.type === "text" && typeof j.part?.text === "string") texts.push(j.part.text);
    if (j.type === "step_finish" && j.part?.tokens) {
      const tk = j.part.tokens;
      usage = usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      usage.prompt_tokens += tk.input || 0;
      usage.completion_tokens += (tk.output || 0) + (tk.reasoning || 0);
      usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    }
  }
  return { answer: texts.join("\n").trim().slice(0, maxChars), usage, sessionId: sesid, runError };
}

function sh(cmd, args, input) {
  return spawnSync(cmd, args, { encoding: "utf8", input, timeout: 3_600_000, maxBuffer: 64 * 1024 * 1024 });
}

function recallBlock(text, limit = 5, maxChars = 1800) {
  const query = String(text).replace(/\s+/g, " ").trim().slice(0, 240);
  const r = sh(process.execPath, [MEMORY_SCRIPT, "recall", query, "--limit", String(limit)]);
  if (r.status !== 0) return { ok: false, query, count: 0, block: "", error: String(r.stderr || r.stdout || "").slice(-300) };
  let items = [];
  try { items = JSON.parse(r.stdout || "{}").items || []; } catch { return { ok: false, query, count: 0, block: "", error: "unparsable recall output" }; }
  const formatted = formatRecallBlock(query, items, maxChars);
  return { ok: true, query, ...formatted, ids: formatted.ids.slice(0, limit) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = (n, d) => {
    const eq = argv.find((a) => a.startsWith(`--${n}=`));
    if (eq) return eq.slice(n.length + 3);
    const i = argv.indexOf(`--${n}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
  };
  const slot = flag("slot");
  if (!slot) { console.error("usage: ghost-turn.mjs --slot=<name> --instruction=... | --instruction-file=..."); process.exit(2); }
  const instruction = flag("instruction") || (flag("instruction-file") ? readFileSync(flag("instruction-file"), "utf8") : "");
  if (!instruction.trim()) { console.error("empty instruction"); process.exit(2); }
  const session = flag("session", `ghost-slot-${slot}`);
  const dry = argv.includes("--dry");
  const RECALL = String(flag("recall", process.env.GHOST_TURN_RECALL || "on")) === "on";
  const RECALL_LIMIT = Number(flag("recall-limit", process.env.GHOST_RECALL_LIMIT || 5));
  const RECALL_CHARS = Number(flag("recall-chars", process.env.GHOST_RECALL_CHARS || 1800));

  const started = new Date();
  const record = { slot, session, agent: AGENT, model: MODEL || "(default)", started: started.toISOString(), dry };

  if (dry) { record.result = "dry"; console.log(JSON.stringify(record, null, 2)); process.exit(0); }

  const mem = RECALL ? recallBlock(instruction, RECALL_LIMIT, RECALL_CHARS) : { ok: true, skipped: true, block: "", count: 0 };
  record.recall = { on: RECALL, ok: mem.ok, count: mem.count, query: mem.query, ids: mem.ids || [], error: mem.error, chars: mem.block.length };
  const prompt = mem.block + instruction;

  const sessionArg = /^ses[\w-]+$/.test(session) ? `--session ${session}` : `--title ${JSON.stringify(session)}`;
  const modelArg = MODEL ? `--model ${JSON.stringify(MODEL)}` : "";
  const remote = `${RUNTIME} run --agent ${AGENT} ${modelArg} --format json ${sessionArg} "$(cat)"`;
  const run = spawnSync("docker", ["exec", "-i", CONTAINER, "sh", "-lc", remote], {
    encoding: "utf8", input: prompt, timeout: 3_600_000, maxBuffer: 64 * 1024 * 1024,
  });
  record.rc = run.status;
  record.stderr = (run.stderr || "").slice(-2000);

  const parsed = parseOpencodeJsonStream(run.stdout, MAX_OUT);
  record.session_id = parsed.sessionId;
  record.usage = parsed.usage;
  if (parsed.runError) record.turn_error = parsed.runError;
  record.answer_chars = parsed.answer.length;
  record.answer_head = parsed.answer.slice(0, 400);
  record.finished = new Date().toISOString();

  const CAPTURE = String(flag("capture", process.env.GHOST_TURN_CAPTURE || "off")) === "on";
  record.capture_mode = CAPTURE ? "explicit" : "plugin";
  if (CAPTURE && run.status === 0 && parsed.answer) {
    const u = sh(process.execPath, [MEMORY_SCRIPT, "remember", "--role", "user", "--text", `[slot ${slot}] ${instruction.slice(0, 4000)}`, "--session", session]);
    const a = sh(process.execPath, [MEMORY_SCRIPT, "remember", "--role", "assistant", "--text", parsed.answer.slice(0, 4000), "--session", session]);
    record.capture = { user_rc: u.status, assistant_rc: a.status };
    if (u.status !== 0 || a.status !== 0) record.result = "capture-failed";
  } else if (run.status !== 0 || (parsed.runError && !parsed.answer)) {
    record.result = "turn-failed";
  }
  record.result = record.result || "ok";

  mkdirSync(LOG_DIR, { recursive: true });
  appendFileSync(join(LOG_DIR, `ghost-turn-${slot}.jsonl`), JSON.stringify(record) + "\n");
  console.log(JSON.stringify(record, null, 2));
  process.exit(record.result === "ok" ? 0 : record.result === "turn-failed" ? 3 : 4);
}
