# Milestone 84 — Native RepoQL Control Panel proxy boundary (SOURCE ONLY)

The dashboard previously forwarded absolute upstream HTTP redirects without rewriting their origin. That could send a browser directly to a local RepoQL address instead of the dashboard's authenticated embed route; a foreign upstream redirect could also navigate the browser away. The fixed proxy now accepts only HTTP loopback issuer redirects on the known RepoQL port (41005), rewrites them onto the dashboard's `/embed/repoql/` origin, and rejects third-party origins, alternate ports, credentials in URLs, control characters and multiply encoded traversal. Existing relative and absolute-path redirects continue to resolve under the embed route. An invalid redirect returns a generic 502 without sending the upstream body or Location.

The proxy also refuses path traversal after up to three percent-decoding passes. This applies to the actual incoming proxy path, not merely the redirect, so encoded dot-dot and encoded-backslash inputs cannot use the proxy to escape the intended upstream path.

A separate failure-handler defect exposed the string value of unexpected exceptions to dashboard HTTP clients and full tracebacks to routine logs. The generic exception boundary now responds with `{"error":"internal_error"}` and writes only the exception class to stderr. Explicit, expected validation errors still follow their existing status codes.

## Focused source validation

```powershell
python -m unittest discover -s dashboard -p test_repoql_proxy_redirect_boundary.py -q
python -m unittest discover -s dashboard -p test_repoql_proxy_credential_boundary.py -q
python -m unittest discover -s dashboard -p test_repoql_error_boundary.py -q
```

These tests mock the fixed upstream, do not contact any live RepoQL instance, and do **not** demonstrate that the official 1.7.18 panel's runtime redirects have the assumed shapes. On a Windows test account, verify real login redirects, asset loads, browser cookies, WebSocket upgrades, session expiry, authentication, and denial of unwanted redirects with redacted captures. Do not expose capability-bearing URLs in screenshots or logs.

**Release remains BLOCKED:** Rust dependency locks and reviewed native builds, publisher provenance, official RepoQL connectors, native Claude Desktop, Tencent, Office/Ghost, rollback/reboot, and GitHub publication all need independent acceptance.
