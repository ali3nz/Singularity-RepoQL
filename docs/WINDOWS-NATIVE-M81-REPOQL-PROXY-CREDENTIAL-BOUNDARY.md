# Milestone 81 — RepoQL dashboard proxy credential isolation

**Source-only security correction — RELEASE BLOCKED.** This does not assert live Windows, official RepoQL Panel or Claude Code integration acceptance.

The dashboard's `/embed/repoql/` HTTP and WebSocket proxy previously forwarded the browser's `Authorization` and Cloudflare Access headers to the independently running RepoQL panel at 127.0.0.1:41005. The dashboard's own bearer token and Access identity must not cross this service boundary. The dashboard's `repoql_native_launch` HMAC cookie must also stay scoped to the dashboard proxy; the official RepoQL panel can use different session credentials.

Both proxy paths now use the same filter. It removes the dashboard's exact bearer, any `Cf-Access-*` identity assertions, scoped dashboard launch cookies, and browser `Referer`. It preserves unrelated official RepoQL Authorization bearers, RepoQL session cookies and WebSocket handshake headers. It rejects CR/LF header injection. Invalid request Content-Length now gets a controlled 400, and cross-origin mutations are rejected before reading a request body.

Focused tests run without network, credentials or services: `python -m unittest discover -s dashboard -p test_repoql_proxy_credential_boundary.py` (5 passing), including directly invoked simulated HTTP and WebSocket proxy paths. CI runs this test. **The official RepoQL v1.7.18 Control Panel must be retested natively**, both login and established-session requests, to confirm that its expected headers continue to function and that no dashboard credentials arrive upstream.
