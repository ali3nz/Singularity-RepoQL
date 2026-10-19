# INSTRUCTIONS.md — agent install walkthrough (Windows + RepoQL variant)

You are an agent installing **Singularity-RepoQL** on a Windows machine for a
user who already has **RepoQL (`rql`) installed**. This document is the full
install. Execute one variant end-to-end, then report as described at the end.

## 0. Prerequisites (verify before starting)

- Windows 11 (22H2 or later), WSL2, and Ubuntu 24.04+ (or Debian 13+).
  If WSL is not installed, run `wsl --install -d Ubuntu-24.04` in an elevated
  PowerShell window, launch the distro once to create its Linux user, then
  verify `wsl -l -v` reports version 2.
- One Docker Engine reachable **inside the distro**, with Compose v2
  (`docker info` and `docker compose version` must succeed). This may be
  Docker Desktop with its WSL2 engine and distro integration enabled, or a
  Linux Docker Engine installed inside WSL2. The 2026-10-19 live acceptance
  used the WSL-native Engine; the Docker Desktop path was not exercised.
- `git`, `curl`, and Python 3 in WSL2; ~12 GB free disk and a stable internet
  connection. Keep the checkout under the WSL2 Linux filesystem (for example
  `~/projects`), not `/mnt/c`.
- **RepoQL already installed**. For Variant B it must be the Linux WSL2
  `rql` binary, not Windows-only `rql.exe`. If `rql --version` is missing in
  the current shell, try `bash -lc 'rql --version'` or
  `~/.local/bin/rql --version`; use `REPOQL_RQL_PATH="$HOME/.local/bin/rql"`
  if the login shell has the binary but `scripts/start.sh` does not detect it.
  See `docs/REPOQL-SETUP.md`.
- An OpenAI-compatible or Anthropic-compatible provider endpoint for both
  memory extraction and proxy traffic (the same configuration can serve
  both). A local model server is also valid; its endpoint must be reachable
  from WSL and from containers, and the model name must match its `/v1/models`
  response. A successful connection check proves transport, not model quality.
- Do all install and acceptance commands in a WSL2 terminal (Windows
  Terminal); paths below are WSL2 paths.

## 1. Choose exactly ONE variant

- **Variant A — memory stack + Claude Code.** No Claude Office. No
  OpenChamber. The memory stack captures what Claude Code does through its
  proxy; nothing else is installed.
- **Variant B — memory stack + OpenChamber + Claude Office.** The full
  stack: memory stack, the OpenChamber workspace (with the seven specialised
  agents plus the Board of Advisors), and the Claude Office activity
  visualizer. RepoQL is mounted into OpenChamber automatically when
  `start.sh` detects `rql`.

Clone the repository once, from the WSL2 home (or wherever the user keeps
projects):

```bash
git clone https://github.com/ali3nz/Singularity-RepoQL.git
cd Singularity-RepoQL
```

## 2. Variant A — memory stack + Claude Code (no Office, no OpenChamber)

1. Bring up the memory stack:

   ```bash
   cd memory/upstream
   ./verify.sh --skip-llm     # environment/preflight only
   cd ../..
   scripts/start-memory-stack.sh
   (cd memory/upstream && ./verify.sh)
   ```

   The safe wrapper runs the byte-exact Tencent quickstart, redacts its
   startup output, and independently requires `auth/verify` to return
   `data.valid=true`. The admin key stays in `memory/upstream/.admin-key`
   (mode 0600); it is never printed as a value. Do not invoke the vendored
   `memory/upstream/start-all.sh` directly: upstream v2.0.2 prints the key and
   its own verifier checks only HTTP 200. The memory stack publishes Core
   8420, Panel 8125, Knowledge 8424 and Proxy 8096 on host interfaces; restrict
   them with the host firewall to trusted clients. Only UI ports 3127/3128 bind
   loopback.

2. Verify and prepare the validator credentials:

   ```bash
   docker ps | grep tdai-
   python3 scripts/provision-secrets.py
   bash tests/validate-memory-loop.sh
   ```

   The provisioning command creates local plugin credentials needed by the
   validator; it does not start OpenChamber or Claude Office. The validate
   script exercises capture (add → search) end-to-end
   against the memory core and must print a passing result.

3. If Claude Code is not installed in WSL2, use Anthropic's native WSL
   installer and verify it before wiring the proxy:

   ```bash
   curl -fsSL https://claude.ai/install.sh | bash
   claude --version
   ```

   Install and run the Linux `claude` command inside WSL2; a Windows-side
   `claude.exe` that is not on WSL's PATH is not a substitute. Official guide:
   <https://docs.anthropic.com/en/docs/claude-code/setup>.

   Wire Claude Code through the proxy (add to, or merge into,
   `~/.claude/settings.json`):

   ```json
   {
     "env": {
       "ANTHROPIC_BASE_URL": "http://127.0.0.1:8096/claude-code/default"
     }
   }
   ```

   From then on Claude Code sessions are captured by the memory stack
   through the proxy automatically.

4. Variant A does NOT install OpenChamber or Claude Office. Do not copy
   `openchamber/` anywhere. Claude Code keeps using its own agents — the
   specialised agents in this repository belong to Variant B's
   OpenChamber runtime.

Variant A is done after step 3. Skip to "Report".

## 3. Variant B — memory stack + OpenChamber + Claude Office

1. **Memory stack first** — execute Variant A steps 1–2 exactly as written
   (the same stack powers both variants; skip only the Claude Code wiring in
   step A3 unless the user also wants Claude Code captured).

2. **Install the OpenChamber configuration bundle**. With Docker Compose
   deployments the repo's `data/opencode/config/` directory is bind-mounted
   only into this OpenChamber container. Keep it isolated from the Windows
   Electron app and any existing `~/.config/opencode` tree; do not overwrite
   either. The copy is repo-internal:

   | From (repo)                       | To (runtime)             |
   | --------------------------------- | ------------------------ |
   | `openchamber/AGENTS.md`           | `AGENTS.md`              |
   | `openchamber/agents/`             | `agents/`                |
   | `openchamber/opencode.jsonc`      | `opencode.jsonc`         |
   | `openchamber/dcp.jsonc`           | `dcp.jsonc`              |
   | `openchamber/plugins/product-office/` | `plugins/product-office/` |
   | `openchamber/package.json`        | `package.json`           |

   This ships the eight agent definitions — `standalone` (primary),
   `thinker`, `general`, `explore`, `researcher-web`, `code-reviewer`,
   `quality-fixer` and **`board` (Board of Advisors)** — the runtime agent
   policy (`AGENTS.md`), and the Office/memory plugin. For a non-Docker
   OpenChamber install, copy the same files into `~/.config/opencode/`
   instead (same layout). Full details: `docs/OPENCHAMBER-SETUP.md`.

3. **Confirm the plugin secrets exist.** Variant A step 2 already runs
   `scripts/provision-secrets.py` before its loop validator. If continuing from
   a stack where that step was skipped or the files were removed, run it now;
   it writes `data/opencode/config/product-secrets/memory.json` and
   `office.json` from the running stack (gateway/service/user keys and Office
   token). Do not print the generated credential values.

4. **Build both local images before starting the optional UI services.** Follow
   `docs/OPENCHAMBER-SETUP.md` for `openchamber:local` and
   `docs/OFFICE-SETUP.md` for `claude-office:local` (the latter uses the
   validated `1fce512` revision). `scripts/start.sh` starts existing images; it
   does not build them.

5. **Preflight the ports, then start the stack.** Check for listeners on
   `8420`, `8125`, `8424`, `8096`, `3127`, and `3128` in both WSL2 and Windows;
   identify any owner before proceeding and do not terminate an unknown
   process. In WSL2, inspect with `ss -ltnp`. Create a private UI-password
   file once if needed:

   ```bash
   umask 077
   mkdir -p secrets
   python3 -c 'import secrets; print("OPENCHAMBER_UI_PASSWORD=" + secrets.token_urlsafe(32))' > secrets/openchamber.env
   chmod 600 secrets/openchamber.env
   scripts/start.sh
   ```

   `start.sh` pre-creates bind-mount directories as the WSL user, creates the
   shared product network, attaches memory-core, starts OpenChamber and Office,
   and automatically mounts the WSL Linux `rql` binary when detected. It
   persists RepoQL state in `data/repoql/`. If `rql` is missing or broken, the
   script says so and skips RepoQL while the rest of the stack can start.

6. **Check both local services**: OpenChamber at `http://127.0.0.1:3127` and
   Claude Office at `http://127.0.0.1:3128`; both should return HTTP 200.
   Sign in with the UI password, then check agent selection and a RepoQL tool
   call in a real OpenChamber session.

7. **Verify everything**:

   ```bash
   bash tests/validate-memory-loop.sh    # capture/proxy loop
   bash tests/validate-repoql.sh         # rql in container + host status + MCP handshake
   ```

   `validate-repoql.sh` must print `REPOQL VALIDATION OK`.

## 4. Troubleshooting

- RepoQL claim errors after a container recreation ("served by a host on
  another machine"): run `rql serve --path .` inside the workspace to
  reclaim it. **Never** run `rql host reset` — it deletes the index.
- `rql host status` exits 1 also for a healthy workspace with no host yet;
  judge by the verdict text, not just the exit code.
- Updating RepoQL: update the WSL2 copy as usual, then RECREATE the
  OpenChamber container (the bind mount pins the symlink target/inode).
- One RepoQL host serves one workspace at a time; hosts idle-exit on their
  own (5 min via MCP, 15 min from CLI) and clear the lock gracefully.
- glibc: both sides need ≥ 2.38 (WSL2 Ubuntu 24.04+/Debian 13+; the
  containers are Debian 13-based).
- The detailed acceptance checklist for Windows platform
  specifics lives in `docs/platforms/windows.md`.

## 5. Report (both variants)

Tell the user, in one place:

- variant chosen and every step executed,
- every verification command and its output (or the reason it was skipped),
- the Panel/UI URLs and where the admin key and product secrets live
  (file paths only — never print secret values),
- anything that did not match the documented behavior (that is a bug in
  this document or code — say so plainly).
