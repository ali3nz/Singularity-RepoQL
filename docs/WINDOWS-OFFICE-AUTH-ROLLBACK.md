# Claude Office Windows authentication migration and reversible rollback

**Scope:** installation options 2 and 4 only. Options 1 and 3 must neither
install nor activate Claude Office. This is a source-level, **unverified**
Windows integration change, not evidence of a functioning Office GUI.

## Why this exists

The prior working Linux/production dashboard obtained the Office API key
from the `token` query parameter in the configured
`CLAUDE_OFFICE_EMBED_URL` (or preferred `SINGULARITY_OFFICE_EMBED_URL`).
The browser itself loaded `/embed/office/?embed=1`, **not** that secret URL.
`dashboard/native_panel_proxy.py` extracted the token server-side and sent
`X-API-Key` to the fixed Office backend. `dashboard/office_bridge.py`
validated the public HTTPS URL and offered that same-origin iframe only when
the URL was configured. This arrangement was hard to establish and must not be
silently removed or replaced on an existing installation.

Milestone 8 introduced native Windows `SINGULARITY_OFFICE_PANEL_KEY_FILE` as
the required source for the server-side `X-API-Key`, deliberately refusing
tokens embedded in a URL when `SINGULARITY_WINDOWS_NATIVE=1`. But the frontend
still required the old `CLAUDE_OFFICE_EMBED_URL` even in key-file mode. This
regression could produce an Office page with `no launch URL` after a successful
key-file migration. **Milestone 9 corrects that mismatch and preserves a
controlled rollback.** Linux behaviour is unchanged.

## Safe Windows modes

| Environment | Credential mode | Behaviour |
| --- | --- | --- |
| `SINGULARITY_WINDOWS_NATIVE=1` and `SINGULARITY_OFFICE_NATIVE_AUTH_MODE=key_file` (optional) | Private file | `SINGULARITY_OFFICE_PANEL_KEY_FILE` provides the Office API key; no public URL required to make the same-origin iframe link. The installer must still enforce and verify NTFS ACLs. |
| `SINGULARITY_WINDOWS_NATIVE=1` and `SINGULARITY_OFFICE_NATIVE_AUTH_MODE=legacy_url` (default) | **Production-compatible** | Server extracts an existing key from `CLAUDE_OFFICE_EMBED_URL` or `SINGULARITY_OFFICE_EMBED_URL`; requires matching `CLAUDE_OFFICE_PUBLIC_URL`, an HTTPS origin, exactly one `token`, and `embed=1`. Token is only sent to the fixed configured local Office service as `X-API-Key`. |
| Linux / other | Original implementation | Existing token-URL flow is untouched. |

Any other native mode is rejected. The default token-URL mode does **not** allow
unauthenticated access or remote, request-provided upstreams. The normal
session, loopback, Origin, cookie and dashboard identity checks still apply.

## Keep or restore the proven token URL without source edits

1. **Back up** the current private service configuration and record the working
   Office application version, loopback port, public origin, and panel status.
   Never upload the saved configuration, token URL or key file to GitHub/Drive.
2. On **only the Windows dashboard service** (not in browser JavaScript), set
   `SINGULARITY_WINDOWS_NATIVE=1` and
   `SINGULARITY_OFFICE_NATIVE_AUTH_MODE=legacy_url`.
3. Restore the **previously working** `CLAUDE_OFFICE_PUBLIC_URL` HTTPS origin and
   `CLAUDE_OFFICE_EMBED_URL` (or `SINGULARITY_OFFICE_EMBED_URL`) with its existing
   `?token=...&embed=1` query. Use a secured service environment or protected
   secrets store. **Do not paste real values into issue reports or shell history.**
4. Preserve `SINGULARITY_OFFICE_HOST=127.0.0.1` and its known-good loopback
   port. Do not weaken Cloudflare Access, dashboard authentication, loopback
   restriction or the service's API-key authentication.
5. Restart only the dashboard via the approved Windows service manager after
   a backup; test `/api/harness/office`, authenticated panel handshake, iframe
   assets and WebSocket, plus a real Code-tab/OpenChamber Office event. Verify
   the browser URL and response contain **no** secret token.
6. To try the optional private-file mechanism, select
   `SINGULARITY_OFFICE_NATIVE_AUTH_MODE=key_file`, configure and ACL-check
   `SINGULARITY_OFFICE_PANEL_KEY_FILE`, restart, then repeat the same checks.

**Do not remove the old, working token URL from private backup until real
Windows tests confirm key-file mode supports the particular Claude Office
backend.** Never log or paste the capability URL, even in diagnostics.

## If the new code needs to be rolled back completely

The original source was archived at commit
`4f3d0f971f09ec677e7d4e5e49147476c054b311`. The relevant *pre-port*
logic is in `dashboard/native_panel_proxy.py` (`backend_key('office')`)
and `dashboard/office_bridge.py` (`embed_url()`). Milestone 8 introduced the
Windows-only key-file source; Milestone 9 introduces the explicit opt-in
compatibility mode. The cumulative patch and source archives are retained
separately in the `Windows-Native-Rust-Development` Drive folder.

Use a **staged, reviewed two-file source restore** only if the environment
switch fails, not a blanket `git checkout` that discards unrelated security
fixes. Preserve all existing dashboard session / Access and panel audience
isolation controls. Verify on a disposable instance before touching production.

## Synthetic regression coverage

`PYTHONPATH=dashboard python -m unittest dashboard/test_office_windows_rollback.py -v`

These tests establish configuration routing and fail-closed parsing; they do
**not** establish live Office authentication, session rendering, WebSocket or
Windows service ACLs. Those remain release blockers.

## Milestone 10 policy: preserve the production token URL by default

The operator selected the established Office token URL for the native Windows
release. `SINGULARITY_OFFICE_NATIVE_AUTH_MODE` therefore defaults to
`legacy_url` when omitted. The legacy mode is **not deprecated**; it remains
the supported default for options 2 and 4 pending actual native GUI acceptance.
An explicit `key_file` value opts into the alternative. The prior Milestone 9
source used the opposite default; restore that behaviour, if ever required, by
setting `SINGULARITY_OFFICE_NATIVE_AUTH_MODE=key_file` and configuring
`SINGULARITY_OFFICE_PANEL_KEY_FILE` with appropriate NTFS ACLs.

No credentials were copied into this source package. Keep the existing URL in
**private service configuration**, not the tracked `.env.example`, commit,
logs, or browser address. The dashboard continues to use `X-API-Key` to the
fixed upstream and `/embed/office/?embed=1` as its browser-facing path. The
native parser accepts the existing `room=modern` or `room=dm` variant but no
unrecognized parameters. Use options 1/3 to exclude Office entirely.

If Office fails after enabling native mode: preserve the existing URL unchanged,
verify the same local Office backend and HTTPS public origin, check the
readiness endpoint's non-secret status, and compare with the last known-good
Linux/production embedding. Reverting *only* `SINGULARITY_OFFICE_NATIVE_AUTH_MODE`
changes credential sourcing and does not modify the running Office service.
Do not disable downstream authentication as a workaround.
