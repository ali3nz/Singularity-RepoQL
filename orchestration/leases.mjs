// leases.mjs — resource leases prevent two workers from mutating the same
// resource at once. A lease is granted to exactly one owner until it is
// released or expires; a conflicting request is refused, not queued silently.
import path from "node:path";
import { readJson, writeJsonAtomic } from "./state.mjs";

export class LeaseConflict extends Error {
  constructor(resource, holder) {
    super(`resource '${resource}' is leased by ${holder}`);
    this.name = "LeaseConflict";
    this.resource = resource;
    this.holder = holder;
  }
}

const LEASES_FILE = "leases.json";

export function openLeases(store, { now = () => Date.now() } = {}) {
  const file = path.join(store.dir, LEASES_FILE);

  function read() {
    let data = readJson(file) ?? {};
    if (typeof data !== "object" || Array.isArray(data)) data = {};
    return data;
  }

  function write(data) {
    writeJsonAtomic(file, data);
  }

  function live(data, at) {
    const out = {};
    for (const [resource, lease] of Object.entries(data)) {
      if (lease && typeof lease === "object" && lease.expiresAt > at) out[resource] = lease;
    }
    return out;
  }

  return {
    file,
    /** Grant a lease or throw LeaseConflict. Re-acquiring your own lease renews it. */
    acquire({ resource, owner, ttlMs = 60_000, purpose = "" }) {
      if (!resource) throw new Error("resource is required");
      if (!owner) throw new Error("owner is required");
      if (!(ttlMs > 0)) throw new Error("ttlMs must be positive");
      return store.lock("leases", () => {
        const at = now();
        const data = live(read(), at);
        const held = data[resource];
        if (held && held.owner !== owner) throw new LeaseConflict(resource, held.owner);
        const lease = {
          resource,
          owner,
          purpose,
          acquiredAt: held?.acquiredAt ?? new Date(at).toISOString(),
          renewedAt: new Date(at).toISOString(),
          expiresAt: at + ttlMs,
        };
        data[resource] = lease;
        write(data);
        return lease;
      });
    },

    renew({ resource, owner, ttlMs = 60_000 }) {
      return store.lock("leases", () => {
        const at = now();
        const data = live(read(), at);
        const held = data[resource];
        if (!held) throw new LeaseConflict(resource, "nobody (lease expired or was released)");
        if (held.owner !== owner) throw new LeaseConflict(resource, held.owner);
        const lease = { ...held, renewedAt: new Date(at).toISOString(), expiresAt: at + ttlMs };
        data[resource] = lease;
        write(data);
        return lease;
      });
    },

    release({ resource, owner }) {
      return store.lock("leases", () => {
        const at = now();
        const data = live(read(), at);
        const held = data[resource];
        if (!held) return { released: false, reason: "no live lease" };
        if (held.owner !== owner) throw new LeaseConflict(resource, held.owner);
        delete data[resource];
        write(data);
        return { released: true };
      });
    },

    list() {
      return Object.values(live(read(), now()));
    },

    /** Drop expired entries so the file does not grow without bound. */
    reclaimExpired() {
      return store.lock("leases", () => {
        const at = now();
        const data = read();
        const kept = live(data, at);
        const dropped = Object.keys(data).filter((r) => !(r in kept));
        write(kept);
        return { dropped };
      });
    },
  };
}
