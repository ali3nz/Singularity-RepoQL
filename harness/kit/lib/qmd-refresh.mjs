// lib/qmd-refresh.mjs — V3.4.0 Phase 15 (plan §10.6/D30). Refresh the QMD
// collections after accepted publication of MEX/docs/plans/run summaries.
// Fire-and-forget maintenance: a refresh failure NEVER invalidates accepted
// knowledge — it logs a typed warning and is retried on the next acceptance.
// Runs over SSH on controller (where the QMD container lives) from the kit.
import { execFile } from "node:child_process";

const SSH_ARGS = ["controller"];
const CONTAINER = "agenthome-qmd";

export function refreshQmdAfterAcceptance({ sshHost = "controller" } = {}) {
  return new Promise((resolve) => {
    const cmd = [
      "docker", "exec", CONTAINER, "sh", "-c",
      "export PATH=$PATH:/usr/local/bin; qmd update 2>&1 | tail -2; qmd embed 2>&1 | tail -1 || echo 'embed skipped (background embed may hold the lock)'",
    ];
    const args = sshHost === "controller" ? SSH_ARGS.concat(cmd.join(" ")) : cmd;
    const bin = sshHost === "controller" ? "ssh" : cmd[0];
    execFile(bin, args, { timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, warning: `qmd refresh failed: ${String(err.message ?? err).slice(0, 100)}` });
        return;
      }
      resolve({ ok: true, output: String(stdout ?? "").slice(-200) });
    });
  });
}
