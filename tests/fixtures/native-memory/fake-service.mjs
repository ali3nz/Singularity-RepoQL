// A tiny native service used by the supervisor tests. It is deliberately a
// real child process listening on a real loopback socket so the supervisor is
// exercised end to end: PID discovery, health polling, restart and stop.
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const mode = process.env.FAKE_SERVICE_MODE ?? "ok";
const port = Number(process.env.PORT ?? process.env.TDAI_GATEWAY_PORT ?? 0);
const stateFile = process.env.FAKE_STATE_FILE;

if (mode === "exit") {
  process.stderr.write("fake service exiting before listening\n");
  process.exit(7);
}

if (mode === "leak") {
  process.stdout.write(`token=${process.env.TDAI_GATEWAY_API_KEY ?? process.env.PANEL_SECRET ?? ""}\n`);
  process.stderr.write("fake service refusing to become healthy\n");
  setTimeout(() => process.exit(9), 500);
} else {
  if (stateFile) appendFileSync(stateFile, `start ${new Date().toISOString()}\n`);
  const server = createServer((req, res) => {
    if (mode === "never-healthy" && req.url === "/health") {
      res.writeHead(503);
      res.end("nope");
      return;
    }
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`fake service listening on ${port}\n`);
  });
  process.on("SIGTERM", () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
