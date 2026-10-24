// modes.mjs — execution modes as SEAT PLANS with authority, not agent aliases.
//
// A mode decides: how many workers share the case, who may approve a stage, and
// whether the run is constrained to zero-cost routes. Two invariants hold in
// every mode:
//   1. The reviewer is never the worker whose work is under review.
//   2. A coordinator may not approve on its own — acceptance needs reviewer or
//      operator authority.
import { newId } from "./state.mjs";

export const MODE_NAMES = Object.freeze(["solo", "duo", "quad", "super", "custom", "free_only"]);

const BASE_SEATS = {
  solo: [{ role: "coordinator", count: 1 }, { role: "worker", count: 1 }, { role: "reviewer", count: 1 }],
  duo: [{ role: "coordinator", count: 1 }, { role: "worker", count: 2 }, { role: "reviewer", count: 1 }],
  quad: [{ role: "coordinator", count: 1 }, { role: "worker", count: 4 }, { role: "reviewer", count: 1 }],
  super: [{ role: "coordinator", count: 1, canImplement: true }, { role: "worker", count: 2 }, { role: "reviewer", count: 1 }],
  custom: [],
  free_only: [{ role: "coordinator", count: 1 }, { role: "worker", count: 1 }, { role: "reviewer", count: 1 }],
};

export const MODES = Object.freeze(
  Object.fromEntries(
    Object.entries(BASE_SEATS).map(([name, seats]) => [
      name,
      {
        name,
        seats,
        providerPolicy: name === "free_only" ? "free" : "any",
        allowsCoordinatorImplementation: name === "super",
        requiresExplicitSeats: name === "custom",
      },
    ]),
  ),
);

export class ModeError extends Error {
  constructor(message) {
    super(message);
    this.name = "ModeError";
  }
}

function expand(plan, mode, idFactory) {
  const seats = [];
  for (const spec of plan) {
    for (let i = 0; i < spec.count; i += 1) {
      seats.push({
        id: `${mode}-${spec.role}-${i + 1}-${idFactory().slice(-6)}`,
        role: spec.role,
        canImplement: Boolean(spec.canImplement) || spec.role === "worker",
        authority: spec.role === "reviewer" ? "approve" : spec.role === "operator" ? "approve" : "work",
      });
    }
  }
  return seats;
}

/**
 * Build the seat plan for a run.
 *
 * `customSeats` is required for mode "custom" and is refused for other modes, so
 * a typo cannot silently produce an empty team.
 */
export function seatPlan(modeName, { customSeats = null, freeOnly = false, idFactory = () => newId("seat") } = {}) {
  const mode = MODES[modeName];
  if (!mode) throw new ModeError(`unknown mode '${modeName}' (one of: ${MODE_NAMES.join(", ")})`);

  if (mode.requiresExplicitSeats) {
    if (!Array.isArray(customSeats) || customSeats.length === 0) {
      throw new ModeError("mode 'custom' requires an explicit seat list");
    }
    for (const seat of customSeats) {
      if (!["coordinator", "worker", "reviewer", "operator"].includes(seat.role)) {
        throw new ModeError(`custom seat has unknown role '${seat.role}'`);
      }
    }
  } else if (customSeats) {
    throw new ModeError(`mode '${modeName}' does not accept a custom seat list`);
  }

  const seats = mode.requiresExplicitSeats
    ? customSeats.map((s, i) => ({
        id: s.id ?? `${modeName}-${s.role}-${i + 1}-${idFactory().slice(-6)}`,
        role: s.role,
        canImplement: s.role === "worker" || Boolean(s.canImplement),
        authority: s.role === "reviewer" || s.role === "operator" ? "approve" : "work",
      }))
    : expand(mode.seats, modeName, idFactory);

  const plan = {
    mode: modeName,
    seats,
    providerPolicy: freeOnly ? "free" : mode.providerPolicy,
    allowsCoordinatorImplementation: mode.allowsCoordinatorImplementation,
  };
  validatePlan(plan);
  return plan;
}

/**
 * Enforce the mode invariants. Throws ModeError rather than returning a plan
 * that would let a run approve itself.
 */
export function validatePlan(plan) {
  const roles = plan.seats.map((s) => s.role);
  if (!roles.includes("coordinator")) throw new ModeError("a run needs exactly one coordinator seat");
  if (roles.filter((r) => r === "coordinator").length > 1) throw new ModeError("a run has exactly one coordinator");
  if (!roles.includes("worker") && !plan.allowsCoordinatorImplementation) {
    throw new ModeError("a run needs at least one seat that can implement");
  }
  if (!roles.includes("reviewer")) throw new ModeError("a run needs an independent reviewer seat");

  const reviewers = plan.seats.filter((s) => s.role === "reviewer");
  const implementers = plan.seats.filter((s) => s.canImplement);
  for (const reviewer of reviewers) {
    if (implementers.some((w) => w.id === reviewer.id)) {
      throw new ModeError("reviewer independence violated: a seat cannot review its own work");
    }
  }
  const coordinator = plan.seats.find((s) => s.role === "coordinator");
  if (reviewers.some((r) => r.id === coordinator.id)) {
    throw new ModeError("reviewer independence violated: the coordinator cannot hold the reviewer seat");
  }
  if (plan.providerPolicy !== "free" && plan.providerPolicy !== "any") {
    throw new ModeError(`unknown provider policy '${plan.providerPolicy}'`);
  }
  return plan;
}

/** Which seats may implement a stage, given the mode. */
export function implementers(plan) {
  const workers = plan.seats.filter((s) => s.role === "worker");
  if (workers.length) return workers;
  if (plan.allowsCoordinatorImplementation) return plan.seats.filter((s) => s.role === "coordinator");
  throw new ModeError("no seat may implement in this plan");
}

/** The single seat allowed to approve acceptance. */
export function approver(plan) {
  const reviewer = plan.seats.find((s) => s.role === "reviewer");
  if (!reviewer) throw new ModeError("no reviewer seat");
  return reviewer;
}

export function describeMode(modeName) {
  const mode = MODES[modeName];
  if (!mode) throw new ModeError(`unknown mode '${modeName}'`);
  return {
    mode: mode.name,
    workers: mode.seats.filter((s) => s.role === "worker").reduce((n, s) => n + s.count, 0),
    reviewer: mode.seats.some((s) => s.role === "reviewer"),
    providerPolicy: mode.providerPolicy,
    coordinatorMayImplement: mode.allowsCoordinatorImplementation,
  };
}
