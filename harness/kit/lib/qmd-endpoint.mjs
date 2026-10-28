// lib/qmd-endpoint.mjs — ticket 091: resolve the QMD MCP base URL for this
// runtime. Preference order (Sol v3-confirmed topology, 2026-09-25):
//   1. QMD_BASE_URL env — explicit override, wins when reachable
//   2. DIRECT agenthome-net service URL (default http://agenthome-qmd:8181)
//      — the Freebuff workspace container is attached to agenthome-net, and
//      on user-defined docker networks the container name resolves as DNS
//   3. SSH tunnel fallback (lib/qmd-tunnel.mjs, D26) — for host-side runs
//      or any runtime not attached to agenthome-net
// Fail-open contract unchanged (plan §10.7): resolution never throws; the
// caller degrades to mandatory-only context when ok:false.
import { ensureQmdTunnel } from "./qmd-tunnel.mjs";

const DIRECT_URL = process.env.QMD_DIRECT_URL ?? "http://agenthome-qmd:8181";
const PROBE_TIMEOUT_MS = 1500;

async function reachable(baseUrl) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  try {
    const r = await fetch(baseUrl.replace(/\/$/, "") + "/health", { signal: ctl.signal });
    return r.ok;
  } catch { return false; }
  finally { clearTimeout(t); }
}

export async function resolveQmdEndpoint() {
  const explicit = process.env.QMD_BASE_URL;
  if (explicit && (await reachable(explicit))) return { ok: true, mode: "env", baseUrl: explicit };
  if (await reachable(DIRECT_URL)) return { ok: true, mode: "direct", baseUrl: DIRECT_URL };
  const tun = await ensureQmdTunnel();
  if (tun.ok) return { ok: true, mode: "tunnel", baseUrl: `http://127.0.0.1:${tun.port ?? 18181}` };
  const detail = explicit ? `env ${explicit} unreachable, direct failed, tunnel failed` : "direct + tunnel both failed";
  return { ok: false, code: "QMD_UNREACHABLE", detail };
}
