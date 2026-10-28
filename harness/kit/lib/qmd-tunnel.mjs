// lib/qmd-tunnel.mjs — V3.4.0 (ticket 088, plan §10.4/§D26). QMD's HTTP MCP
// transport is bound to LOOPBACK on controller (private service — D26). The
// coordinator runs in the Freebuff workspace container, so it reaches QMD
// through an idempotent SSH local-forward (127.0.0.1:18181 ->
// controller 127.0.0.1:8181). Failure NEVER breaks a run (plan §10.7): if the
// tunnel cannot be established the caller gets ok:false and the context
// builder degrades to mandatory-only context.
import { spawn } from "node:child_process";

const TUNNEL_PORT = process.env.QMD_TUNNEL_PORT ?? "18181";
const HEALTH_TIMEOUT_MS = 2500;

async function healthy(port) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), HEALTH_TIMEOUT_MS);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctl.signal });
    return r.ok;
  } catch { return false; }
  finally { clearTimeout(t); }
}

// Idempotent: if the tunnel endpoint already answers, do nothing. Otherwise
// spawn one detached forwarder (survives this process, cleaned up by nothing —
// it exits on its own if the SSH connection drops; the next ensure call revives it).
export async function ensureQmdTunnel({ port = TUNNEL_PORT, sshHost = "controller" } = {}) {
  try {
    if (await healthy(port)) return { ok: true, reused: true, port };
    const child = spawn("ssh", [
      "-f", "-N",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ConnectTimeout=10",
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=3",
      "-L", `${port}:127.0.0.1:8181`,
      sshHost,
    ], { stdio: "ignore", detached: true });
    child.unref();
    // -f forks to background once the forward is established; give it a moment.
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await healthy(port)) return { ok: true, reused: false, port };
    }
    return { ok: false, code: "TUNNEL_TIMEOUT" };
  } catch (e) {
    return { ok: false, code: "TUNNEL_ERROR", detail: String(e?.message ?? e).slice(0, 120) };
  }
}
