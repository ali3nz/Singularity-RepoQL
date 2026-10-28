#!/usr/bin/env node
// One request/one response over the Orchestra state-authority Unix socket.
//
// The coordinator's state writes are synchronous, so `rust-authority.mjs`
// invokes this tiny CLI with spawnSync and passes the request on stdin. Keeping
// the transport in its own process also means a hung authority can never block
// the coordinator's event loop indefinitely: the parent enforces a hard timeout
// and this process enforces its own.
//
// Exit codes: 0 = a protocol response was printed (it may still be ok:false),
// 3 = transport/protocol failure before a response (printed as JSON).
import net from "node:net";

const socketPath = process.argv[2];
const REQUEST_LIMIT = 8 * 1024 * 1024;
const CLIENT_TIMEOUT_MS = 7000;

function fail(code, detail) {
  process.stdout.write(
    JSON.stringify({ ok: false, error: code, detail: String(detail ?? "").slice(0, 300) }) + "\n",
  );
  process.exit(3);
}

if (!socketPath) fail("CLI_USAGE", "socket path required");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (input.length > REQUEST_LIMIT) fail("REQUEST_TOO_LARGE");
});
process.stdin.on("end", () => {
  if (!input.trim()) fail("CLI_USAGE", "empty request");
  const socket = net.createConnection({ path: socketPath });
  let buffer = "";
  let done = false;
  const timer = setTimeout(() => {
    if (done) return;
    done = true;
    socket.destroy();
    fail("CLIENT_TIMEOUT");
  }, CLIENT_TIMEOUT_MS);

  socket.on("connect", () => {
    socket.write(input.trimEnd() + "\n");
  });
  socket.on("data", (chunk) => {
    buffer += chunk;
    const newline = buffer.indexOf("\n");
    if (newline >= 0 && !done) {
      done = true;
      clearTimeout(timer);
      process.stdout.write(buffer.slice(0, newline + 1));
      socket.end();
    }
  });
  socket.on("error", (error) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    fail("TRANSPORT", error?.code || error?.message);
  });
  socket.on("close", () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    fail("TRANSPORT", "closed without response");
  });
});
