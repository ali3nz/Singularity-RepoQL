// worker-digest.mjs — ticket 189 item 12: compact operator-facing progress +
// to-do digest per worker. Pure read of state.json, status-<id>.md and the last
// TO-OPERATOR lines of run.log. No dispatch, no network.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Parse one status file text -> { status, phase, progress[], todos[] }.
// Absent ## Todo section = no todos (never fails).
export function parseStatusText(text) {
  const t = String(text ?? "");
  const hdr = t.match(/^#\s*Status:\s*(\S+)/m);
  const phase = t.match(/^Phase:\s*(.+)$/m);
  const section = (name) => {
    const m = t.match(new RegExp(`^##\\s*${name}\\s*\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "im"));
    return m ? m[1] : "";
  };
  const progress = section("Progress").split("\n").map((l) => l.trim()).filter((l) => /^[-*]\s+/.test(l)).map((l) => l.replace(/^[-*]\s+/, ""));
  const todos = [];
  for (const l of section("Todo").split("\n")) {
    const m = l.trim().match(/^[-*]\s*\[( |x|X)\]\s*(.+)$/);
    if (m) todos.push({ done: m[1].toLowerCase() === "x", text: m[2].trim() });
  }
  return { status: hdr ? hdr[1].toLowerCase() : "unknown", phase: phase ? phase[1].trim() : null, progress, todos };
}

function lastOperatorLines(runLogText, n = 3) {
  return String(runLogText ?? "").split("\n").filter((l) => l.includes("TO-OPERATOR:")).slice(-n).map((l) => l.replace(/^\[[^\]]*\]\s*TO-OPERATOR:\s*/, "").slice(0, 200));
}

const engineOf = (seat) => seat?.engine ?? "freebuff";

// Build the digest for one run directory.
export function buildDigest(runDir, { maxProgress = 3 } = {}) {
  let state = {};
  try { state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")); } catch { /* tolerate */ }
  const ids = Array.isArray(state.workers) ? state.workers : [];
  const seats = Array.isArray(state.seats) ? state.seats : [];
  const workers = ids.map((id) => {
    const f = join(runDir, `status-${id}.md`);
    const seat = seats.find((s) => s.id === id) ?? { id };
    let parsed = { status: "missing", phase: null, progress: [], todos: [] };
    if (existsSync(f)) { try { parsed = parseStatusText(readFileSync(f, "utf8")); } catch { /* keep default */ } }
    return { id, engine: engineOf(seat), model: seat.model ?? null, status: parsed.status, phase: parsed.phase, progress: parsed.progress.slice(-maxProgress), todos: parsed.todos };
  });
  let log = "";
  try { log = readFileSync(join(runDir, "run.log"), "utf8"); } catch { /* none */ }
  return {
    runId: state.runId ?? null, runState: state.runState ?? null, mode: state.mode ?? null,
    currentPhase: state.currentPhase ?? null, completedThrough: state.completedThrough ?? 0,
    totalPhases: state.plan?.phases?.length ?? state.phases?.length ?? null,
    verdicts: state.phaseVerdicts ?? {}, workers, operatorLines: lastOperatorLines(log),
  };
}

// Render one digest as a compact block for the coordinator chat.
export function renderDigest(d) {
  const head = `Run ${d.runId ?? "?"} — ${d.runState ?? "?"}${d.mode ? ` (${d.mode})` : ""}, phase ${d.currentPhase ?? "none"}/${d.totalPhases ?? "?"} (done ${d.completedThrough}), verdicts ${JSON.stringify(d.verdicts)}`;
  const lines = [head];
  for (const w of d.workers) {
    lines.push(`• ${w.id} [${w.engine}${w.model ? ` ${w.model}` : ""}] ${w.status}${w.phase ? ` (phase ${w.phase})` : ""}`);
    for (const p of w.progress) lines.push(`    - ${p.slice(0, 160)}`);
    if (w.todos.length) {
      const done = w.todos.filter((t) => t.done).length;
      lines.push(`    todo ${done}/${w.todos.length}:`);
      for (const t of w.todos) lines.push(`      [${t.done ? "x" : " "}] ${t.text.slice(0, 120)}`);
    }
  }
  if (d.operatorLines.length) { lines.push("latest operator updates:"); for (const l of d.operatorLines) lines.push(`  · ${l}`); }
  return lines.join("\n");
}

export function renderDigests(list) {
  return list.length ? list.map(renderDigest).join("\n\n") : "(no run to digest)";
}
