# Milestone 88 — Ghost draft API browser-origin boundary (SOURCE ONLY)

The authenticated `/api/ghost/plans` endpoint contains private scheduling prompts. Mutating requests now require an explicit `Origin` that exactly matches the dashboard host **and scheme**, `Content-Type: application/json`, `X-Requested-With: repoql-dashboard`, and `X-Ghost-Control: 1`; explicit cross-site fetches fail closed. This aligns with the stricter Ghost control endpoint and avoids accepting missing-Origin browser mutations.

The read-only GET contract remains unchanged; no native Ghost host calls were introduced. The test exercises the HTTP handler with a fake request object and does not establish native Windows authentication or CSRF acceptance. Real dashboard browser and reverse-proxy acceptance is still required.

**RELEASE BLOCKED** (missing live native Ghost scheduler, Windows acceptance, and broader integration evidence).
