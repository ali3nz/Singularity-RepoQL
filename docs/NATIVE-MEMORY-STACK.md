# Native Windows memory stack

`scripts/native-memory-supervisor.mjs` is the single lifecycle authority for a
native (no Docker, no WSL) memory stack on Windows. It stages and builds the
pinned upstream `TencentDB-Agent-Memory` v2.0.2 source, then starts, checks,
restarts and stops the Node entrypoints.

## Commands

```powershell
node scripts/native-memory-supervisor.mjs prepare --config <stack.json> [--clean] [--dry-run]
node scripts/native-memory-supervisor.mjs start   --config <stack.json> [--json]
node scripts/native-memory-supervisor.mjs status  --config <stack.json> [--json]
node scripts/native-memory-supervisor.mjs stop    --config <stack.json> [--json]
node scripts/native-memory-supervisor.mjs restart --config <stack.json> [--json]
```

`start` refuses to run while a manifest already exists. `status` exits non-zero
unless every recorded process still passes the ownership and health checks.

## Safety rules (enforced, not advisory)

- **Loopback only.** A component whose `host` is not `127.0.0.1`, `::1` or
  `localhost` is rejected before any process starts.
- **Foreign ports are never killed.** Every port is probed first; `EADDRINUSE`
  is reported and the start aborts. Existing listeners are untouched.
- **PID ownership before stop.** The manifest records PID, executable path and
  Windows `CreationDate`. `stop` re-queries the process and refuses to signal a
  recycled or replaced PID. An absent process counts as already stopped.
- **Secrets stay out of output and command lines.** A bearer token is generated
  once under `<state>/secrets`, restricted with `icacls /inheritance:r` to the
  current user, `SYSTEM` and `Administrators`, and verified. If the ACL cannot
  be applied/verified the file is deleted and the start fails. Logs are passed
  through a redactor before an error is printed.
- **Isolated environment.** `HOME`, `USERPROFILE`, `XDG_*`, `TMP`/`TEMP`,
  data, logs and generated config all live under the stack root.
- **Detached children.** Services are launched detached so they outlive the
  launcher's console. An OpenSSH Windows session still belongs to a job object;
  if sshd closes the session, Windows may terminate the whole job. Cross-session
  persistence needs a service/scheduled-task wrapper, which is deliberately not
  installed by this tool.

## Provenance and transforms

`prepare` verifies the pinned tarball sha256 and the commit prefix in its name
before staging. It never edits the vendored `memory/upstream` tree. Three small,
documented transforms are applied to staged copies only:

1. **Core package transform** — drop the private/optional peer chain and alias
   the Jimp config-typescript peer so npm can install on this host. Runtime code
   is unchanged. The existing `core-v2.0.2-l1recordids` patch is applied first.
2. **L1 extraction prompt** — after the existing core patch and before npm
   builds, apply the fixed `core-v2.0.2-l1prompt` source override. Both chat and
   code prompts preserve engineering decisions, exact evidence and open work,
   and require a JSON array even for one scene. SHA256 checks normalize only
   CRLF to LF for both preimage and override; unknown source is refused. The
   dry-run exposes this step and prepare logs the applied digest.
3. **Knowledge loopback transform** — upstream calls
   `serve({ fetch: app.fetch, port: config.port })` with no hostname, which binds
   `0.0.0.0`. The staged `src/server.ts` gains
   `hostname: process.env.HOST ?? "127.0.0.1"`. `start` re-checks the built
   `dist/server.mjs` and refuses a knowledge build without that option.

## Prompt update and rollback

Last updated: 2026-11-13. Prepare changes staged source only, not memory data.
Do not run prepare against an active build or rebuild an existing prepared stack
merely to refresh this prompt. Stage the new candidate separately. For an owned
existing build, retain the old prompt and its digest in the installation backup
before an approved maintenance update; restore those exact bytes to roll back.
`PROMPT_PREIMAGE_SHA256_MISMATCH` means inspect the pinned revision and the
actual source; never weaken the hash check. Windows CRLF is supported explicitly.
The focused prompt fixture tests cover LF/CRLF, idempotency and tamper refusal;
no model call is needed to validate the source transform.

## Known limitation

MemoryCore and MemoryPanel run natively and were verified with a real loopback
stack (health, authenticated raw write/search, restart with data intact).
MemoryKnowledge builds (`dist/server.mjs`), but its upstream dependency graph
conflicts on Windows: `@opentelemetry/exporter-trace-otlp-http@0.300.0` wants
`@opentelemetry/api >=1.10 <1.11`, while `@langfuse/otel@5.6.0` /
`@opentelemetry/core@2.12.0` peers require `<1.10`. npm cannot satisfy both, and
forcing `api@1.10.0` removes peers that Langfuse imports. No dependency override
is shipped, so `knowledge` is not part of the validated stack. See the D3
evidence for the exact error.

MemoryProxy is not part of this supervisor.

## Example

See `docs/native-memory-stack.example.json`.
