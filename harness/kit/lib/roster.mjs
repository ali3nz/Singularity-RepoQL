// roster.mjs — ticket 189: free-language custom orchestra rosters.
// Pure module: parse/validate a roster spec, assign seat ids, build worker
// objects, consultant chain overrides, and the WAIT-assignment matcher.
// No fs, no network. Spec grammar (comma-separated items):
//   N*freebuff | N*managed:openai/gpt-6-luna#max | N*<provider>/<model>
// Hard caps: <= 8 seats, <= 2 freebuff. Paid/metered models are refused.

export const SEAT_IDS = Object.freeze(["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"]);
export const MAX_SEATS = 8;
export const MAX_FREEBUFF = 2;
export const MANAGED_LUNA = "openai/gpt-6-luna#max";
export const CONSULTANTS = Object.freeze(["sol", "free", "default"]);
export const CONSULTANT_ROLES = Object.freeze(["PLANNER", "REVIEW", "FINAL_ACCEPTANCE", "CONSULT", "PREMIUM_REASONING"]);

const KNOWN_FREE_OPENCODE = new Set(["big-pickle"]);

// Free-model rule: opencode/<id>-free or known free (big-pickle);
// openrouter/<slug>:free or openrouter/free. Everything else is refused.
export function isFreeModelId(model, { extraFree = [] } = {}) {
  const m = String(model ?? "").trim().toLowerCase();
  if (!m || m.includes("#") || /\s/.test(m)) return false;
  if (extraFree.map((x) => String(x).toLowerCase()).includes(m)) return true;
  let mm = m.match(/^opencode\/([a-z0-9._-]+)$/);
  if (mm) return mm[1].endsWith("-free") || KNOWN_FREE_OPENCODE.has(mm[1]);
  if (m === "openrouter/free") return true;
  mm = m.match(/^openrouter\/([a-z0-9._:\/-]+)$/);
  if (mm) return mm[1].endsWith(":free");
  return false;
}

// Operator order 2026-10-05: the operator subscription models usable as managed
// (OpenChamber-container) kit seats. Executed via callManagedSeat inside the
// container, which holds the Go-plan and OpenRouter credentials. Exact allowlist.
export const MANAGED_PAID_MODELS = Object.freeze({
  "opencode-go/muse-spark-1.3-contributor": "opencode-go/muse-spark-1.3-contributor#xhigh",
  "opencode-go/muse-spark-1.3-contributor#xhigh": "opencode-go/muse-spark-1.3-contributor#xhigh",
  "opencode-go/deepseek-v4.1-flash": "opencode-go/deepseek-v4.1-flash",
  "openrouter/deepseek/deepseek-v4-flash-0731": "openrouter/deepseek/deepseek-v4-flash-0731",
});
export function normalizeManagedModel(raw) {
  const m = String(raw ?? "").trim().toLowerCase();
  if (m === "luna" || m === "openai/gpt-6-luna" || m === "openai/gpt-6-luna#max") return MANAGED_LUNA;
  return MANAGED_PAID_MODELS[m] ?? null;
}

// Parse "2*freebuff,4*opencode/muse-spark-1.3-contributor-free" into seats.
// Returns { ok, seats:[{id,kind,model,billingClass}], errors:[...] }.
// Freebuff seats take the first ids; other seats follow in spec order.
export function parseRosterSpec(spec, { maxSeats = MAX_SEATS, maxFreebuff = MAX_FREEBUFF, extraFree = [] } = {}) {
  const errors = [];
  const raw = String(spec ?? "").trim();
  if (!raw) return { ok: false, seats: [], errors: ["empty roster spec"] };
  const items = [];
  for (const part of raw.split(",")) {
    const p = part.trim();
    if (!p) { errors.push("empty item in roster spec (stray comma)"); continue; }
    const m = p.match(/^(?:(\d+)\s*\*\s*)?(\S+)$/);
    if (!m) { errors.push(`bad roster item "${p}" (expected N*<seat>)`); continue; }
    const n = m[1] === undefined ? 1 : Number(m[1]);
    if (!Number.isInteger(n) || n < 1 || n > maxSeats) { errors.push(`bad seat count in "${p}" (1..${maxSeats})`); continue; }
    const tok = m[2];
    const low = tok.toLowerCase();
    if (low === "freebuff") { items.push({ n, kind: "freebuff" }); continue; }
    if (low.startsWith("managed:")) {
      const model = normalizeManagedModel(tok.slice(8));
      if (!model) { errors.push(`managed seat model "${tok.slice(8)}" refused — launchable managed seats are ${MANAGED_LUNA} and ${Object.keys(MANAGED_PAID_MODELS).join(", ")}`); continue; }
      items.push({ n, kind: "managed", model });
      continue;
    }
    if (!low.includes("/")) { errors.push(`unknown seat "${tok}" (use freebuff, managed:${MANAGED_LUNA}, or provider/model)`); continue; }
    if (!isFreeModelId(low, { extraFree })) { errors.push(`model "${tok}" refused — paid, metered or unknown (only free opencode/openrouter models may be roster seats)`); continue; }
    items.push({ n, kind: "free", model: low });
  }
  if (errors.length) return { ok: false, seats: [], errors };
  const total = items.reduce((a, i) => a + i.n, 0);
  const fb = items.filter((i) => i.kind === "freebuff").reduce((a, i) => a + i.n, 0);
  if (total > maxSeats) errors.push(`${total} seats exceeds the cap of ${maxSeats}`);
  if (fb > maxFreebuff) errors.push(`${fb} freebuff seats exceeds the cap of ${maxFreebuff}`);
  if (errors.length) return { ok: false, seats: [], errors };
  const ordered = [...items.filter((i) => i.kind === "freebuff"), ...items.filter((i) => i.kind !== "freebuff")];
  const seats = [];
  for (const it of ordered) {
    for (let k = 0; k < it.n; k++) {
      const id = SEAT_IDS[seats.length];
      if (it.kind === "freebuff") seats.push({ id, kind: "freebuff", model: null, billingClass: "freebucks" });
      else if (it.kind === "managed") seats.push({ id, kind: "managed", model: it.model, billingClass: "subscription" });
      else seats.push({ id, kind: "free", model: it.model, billingClass: "free" });
    }
  }
  return { ok: true, seats, errors: [] };
}

// Seat -> worker object in the shape orchestrate.mjs already understands.
export function seatToWorker(seat, config = {}) {
  if (seat.kind === "freebuff") {
    const base = (config.workers ?? []).find((w) => w.id === seat.id) ?? { id: seat.id, role: `worker-${seat.id}` };
    return { ...base };
  }
  if (seat.kind === "managed") {
    const w = { id: seat.id, engine: "opencode", transport: "openchamber-managed", model: seat.model, billingClass: "subscription" };
    if (seat.model !== MANAGED_LUNA) w.writeMode = "ssh-workspace"; // operator paid-model seats implement like the default Muse worker
    return w;
  }
  const w = { id: seat.id, engine: "opencode", model: seat.model, billingClass: "free" };
  if (seat.model.startsWith("openrouter/")) w.superProvider = "openrouter";
  return w;
}

// Full computation used by computeRunWorkers: { ok, runWorkers, paidSeats, seats, errors }.
export function computeCustomWorkers(spec, config = {}) {
  const maxSeats = config.custom?.maxSeats ?? MAX_SEATS;
  const p = parseRosterSpec(spec, { maxSeats, extraFree: config.custom?.extraFreeModels ?? [] });
  if (!p.ok) return { ok: false, runWorkers: [], paidSeats: 0, seats: [], errors: p.errors };
  const runWorkers = p.seats.map((s) => seatToWorker(s, config));
  return { ok: true, runWorkers, paidSeats: p.seats.filter((s) => s.kind === "freebuff").length, seats: p.seats, errors: [] };
}

export function normalizeConsultant(c) {
  const v = String(c ?? "").trim().toLowerCase();
  if (!v) return { ok: true, value: "default" };
  return CONSULTANTS.includes(v) ? { ok: true, value: v } : { ok: false, value: null, error: `bad --consultant "${c}" (sol|free|default)` };
}

// Per-run in-memory chain override. NEVER written to config.json.
// Returns the override map applied ({} for default).
export function applyConsultantChains(consultant, cfg) {
  const chains = consultant === "sol" ? ["openai-sol"] : consultant === "free" ? ["opencode-muse-free", "opencode-longcat", "opencode-space-bunny", "opencode-ling31", "openrouter-laguna-free", "openrouter-sante-free"] : null; // ticket 343 zero-cost chain
  if (!chains) return {};
  cfg.routing = cfg.routing ?? {};
  cfg.routing.roleChains = cfg.routing.roleChains ?? {};
  const applied = {};
  for (const role of CONSULTANT_ROLES) { cfg.routing.roleChains[role] = [...chains]; applied[role] = [...chains]; }
  return applied;
}

// Human/prompt description of the actual roster.
export function describeRoster(seats) {
  const parts = (seats ?? []).map((s) => {
    const what = s.kind === "freebuff" ? "Freebuff GLM (freebucks)" : s.kind === "managed" ? `${s.model} (managed subscription, no failover)` : `${s.model} (free)`;
    return `${s.id}=${what}`;
  });
  return parts.join("; ");
}

// Assignment is a WAIT that must NOT be dispatched to a free/managed seat:
// "WAIT", "wait.", "WAIT - reason", "Wait — reason". Not "WAIT for X to ...".
export function isWaitAssignment(a) {
  return /^WAIT\s*(?:\.|[-\u2013\u2014]\s*\S.*)?$/i.test(String(a ?? "").trim());
}
