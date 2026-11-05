# Windows native worker alternative — Claude Code free workers = 0

**Status:** Adapter source and local mock protocol tests exist. Not integrated with the production Harness scheduler. Rust capacity policy exists as uncompiled source; Windows runtime acceptance and backend reservation remain incomplete.

## Separation of responsibilities

1. **Claude Desktop Code tab:** Optional user interface and memory hook source. No background execution slots are assumed.
2. **OpenChamber Desktop:** Manages or connects to the OpenCode HTTP server. Use the server's authenticated loopback API to create a task session and submit `prompt_async`. No WSL, Docker, SSH or Linux workspace dependency is needed for the API transport.
3. **Rust worker authority:** Determines permitted model, budget, concurrency reservation, durable queue, status reconciliation and completion evidence. `native/windows/rust-supervisor/src/backend_capacity.rs` is the initial *pure admission-policy* source; it does not yet reserve jobs or implement a queue. Leave these tasks blocked until Rust is compiled and admission is connected to the state authority.
4. **GitHub Actions Windows runners:** Native compilation and test execution are independent of any Claude Code worker quota. CI workflows still need actual execution receipts, and no branch has been published by this work.

## Explicit requirements

- Discover the OpenCode server that OpenChamber manages and validate its actual API version and auth. Local URL is an explicitly supplied `http://127.0.0.1:<port>`; never discover an arbitrary remote HTTP endpoint for carrying prompts or credentials.
- Set the matching server password through protected environment or OS credentials; never put credentials in URL, source ZIP, or git config. The adapter **requires** authentication; it does not bypass the application login.
- Query provider connectivity and current usage/limits. Admission capacity must be configured and verified; do not interpret model names, free-tier suffixes or subscription names as an available seat. Paid providers require explicit opt-in.
- Submit tasks as distinct sessions. `prompt_async` acknowledgement means *accepted*, not completed. Observe a final assistant message and require actual test/approval evidence before marking work complete.
- If delivery was uncertain, preserve `sessionId` and reconcile; do not blindly resend. If no allowed capacity is available, report deferred; a durable queue requires a separate ACL-protected Rust journal and is **not yet implemented**.
- The current Linux `openchamber-managed-seat.mjs` still shells out over SSH and Docker. It is *not* the Windows backend. Route it only on legacy Linux, and migrate the Windows conductor to the new Rust authority before enabling live dispatch.

## Evidence from this milestone

- `harness/kit/lib/native-opencode-worker.mjs`: authenticated loopback OpenCode HTTP client, bounds, redirect refusal, no implicit provider spending.
- `harness/kit/lib/native-opencode-worker.test.mjs`: isolated HTTP protocol tests with zero Claude workers, rejection and session reconciliation.
- `native/windows/rust-supervisor/src/backend_capacity.rs`: Rust admission policy and unit tests (**not compiled here**).

## Release gates

The product's native Windows release is blocked until all Rust crates compile, the native queue and scheduler are integrated, Windows/OpenChamber session creation succeeds against the installed server version, GUI visibility is confirmed, failures do not duplicate tasks, capacity/quota are truthfully displayed, and end-to-end implementation proof is retained.

RepoQL stays pinned to **1.7.18** with connector ABI 1. For Office variants, retain the existing server-side token-URL authentication path.

## Explicit native configuration contract (illustrative, no real capacity claim)

An operator may supply an `harness/kit/config.json` `nativeOpenCodeWorker` object with the shape below **only after** identifying the installed local OpenChamber/OpenCode server, verifying the provider's billing status and reserving a real seat. The model name is illustrative; it is not a claim of free entitlement:

```json
{
  "nativeOpenCodeWorker": {
    "server": "http://127.0.0.1:4096",
    "providerID": "example-provider",
    "modelID": "approved-model",
    "billingClass": "free",
    "allowPaid": false,
    "capacity": 1,
    "active": 0,
    "passwordEnv": "SINGULARITY_OPENCODE_PASSWORD",
    "expectedDirectory": "C:\\path\\to\\verified-workspace",
    "writeApproved": true
  }
}
```

The corresponding managed seat must identify `model: "example-provider/approved-model"`, `transport: "openchamber-managed"` and `billingClass: "free"`. The password is an environment value, never included in JSON or the packaged source. The server's actual port is discovered from the desktop app; `4096` is an example, not a guaranteed address.

**Important:** The current admission code trusts explicitly configured `capacity` and `active` counters; it does **not** yet obtain a concurrency reservation from the Rust authority. Do not enable in a public installation until that race is closed and a durable task/session receipt is stored. HTTP `204` means accepted, observed text is not proof that required files/tests were completed. The release gate remains blocked.
