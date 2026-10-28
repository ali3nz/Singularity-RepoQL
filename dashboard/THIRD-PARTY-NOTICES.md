# Third-party notices for the dashboard projection

The dashboard projection ships **no third-party programs or binaries**. It is
Python standard-library code plus static HTML/CSS/JS, derived from the product's
private `repoql-dashboard` source and distributed under the repository's MIT
licence (see `../LICENSE` and `PROVENANCE.md`).

The components below are integrated **over HTTP or a Unix socket as separate
processes** and are not copied, bundled, vendored or redistributed here.

| Component | Role | Licence status |
| --- | --- | --- |
| RepoQL runtime (`rql`) | Reads the graph through the supported CLI | Not bundled. Installed and licensed by the user; the connector runtime tested is 1.7.15. |
| Kanzo (`emanuele-em/kanzo`) | Unmodified Kanban board embedded at `/embed/kanzo/`, version 0.1.3 | **AGPL-3.0-only**, separate process. Not redistributed. |
| Tencent MemoryPanel | Optional panel proxied at `/embed/tencent/` | Not bundled. Operator/user supplies the service. |
| Claude Office (`ali3nz/claude-office`) | Optional visualizer proxied at `/embed/office/` | Not bundled. See the product's Office documentation. |
| Ghost | Optional status/control adapter (snapshot file + Unix socket) | Not bundled; the user's own deployment. |
| Cloudflare Access | Optional JWT verification at a public origin | External service; verification uses PyJWT if installed. |
| PyJWT | Optional Access JWT verification | MIT, imported lazily and not vendored. |

## Unresolved licence questions

These are recorded rather than assumed:

1. **Kanzo AGPL-3.0 and network embedding.** The dashboard merely proxies an
   unmodified, separately installed Kanzo process; no Kanzo code is distributed
   here. Whether an operator's combined deployment triggers AGPL network-use
   obligations is a question for that deployment, not answered by this notice.
2. **RepoQL runtime distribution terms.** The runtime is not included. A user
   redistributing the runtime must follow its own licence, which is outside this
   repository's MIT grant.
3. **Office / Tencent / Ghost assets.** The static UI in this directory contains
   no assets copied from those applications. A deployment that proxies their
   HTML/JS is serving the vendor's own content and must preserve its notices.
