# INSTRUCTIONS.md — agent install walkthrough (Windows)

You are an agent installing **Singularity-RepoQL** on a Windows machine for a
user who already has **RepoQL (`rql`) installed**. This document is the full
install. Execute exactly ONE of the four installation options end-to-end, then
report as described at the end. There are no other installation options and no
optional component selectors; Ghost and Claude Office are automatically
included in options 2 and 4 and absent from options 1 and 3.

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
- **RepoQL already installed**. For options 3 and 4 it must be the Linux WSL2
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

## 1. Choose exactly ONE installation option (there are exactly four)

| Option | Harness | Ghost | Claude Office | This walkthrough |
|---|---|---|---|---|
| 1 — Claude Code + MemoryCore | existing Claude Code | — | — | §2 |
| 2 — Claude Code Complete | existing Claude Code | required (`GHOST_BACKEND=claude-code`) | required | §2 + ghost/README.md, office/README.md |
| 3 — Existing OpenChamber + MemoryCore | existing OpenChamber (never reinstalled) | — | — | §3 (attach-only) |
| 4 — OpenChamber Complete | existing OpenChamber (never reinstalled) | required (`GHOST_BACKEND=openchamber`) | required | §3 + ghost/README.md, office/README.md |

Mandatory capabilities of EVERY installation option: the memory stack, the
seven specialist agents with persistent MemoryCore identities, ordinary-session
memory routing, the documentation closeout gate with verified ingestion, and
a working RepoQL connection. Pass `--variant 1|2|3|4` to
`scripts/install-claude-code.mjs` (interactive installs offer the same four
options as a numbered menu) so the option gate can verify these — an install
cannot report success when a mandatory component was skipped.

- **Option 1 — Claude Code + MemoryCore.** Memory stack + Claude Code only:
  the memory stack captures what Claude Code does through its proxy; no
  Office, no OpenChamber, no Ghost.
- **Option 3 — OpenChamber + MemoryCore.** Attaches to your EXISTING
  OpenChamber (never reinstalled): memory stack, plugin capture/recall, the
  specialised agents (including the Board of Advisors) and automatic RepoQL
  mounting via `start.sh`. No Office, no Ghost.
- **Options 2 and 4 automatically include Ghost + Claude Office as mandatory
  parts** — they cannot be deselected — and use the gates above to prove them
  functional (Ghost dream checkpoint recovery and Office's event flow), not
  merely present.

Clone the repository once, from the WSL2 home (or wherever the user keeps
projects):

```bash
git clone https://github.com/ali3nz/Singularity-RepoQL.git
cd Singularity-RepoQL
```

## 2. Option 1 — memory stack + Claude Code (no Office, no OpenChamber, no Ghost)

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

3. Install the specialised Claude Code agents + memory hooks, and enable
   persistent memory for the NORMAL Claude Code session (gives Claude Code the
   same self-learning specialists that come with OpenChamber, as native Claude
   Code subagents, plus ordinary-session memory through the proxy):

   ```bash
   node scripts/install-claude-code.mjs install --variant 1 --enable-main-memory
   ```

   This installs the seven `singularity-*` subagent definitions to
   `~/.claude/agents/`, merges the memory hooks (SubagentStart recall +
   SubagentStop lesson capture) AND the documentation hooks (SessionStart
   guidance + Stop closeout check) and env into `~/.claude/settings.json`
   (merging, never replacing; a timestamped backup is written), provisions/
   verifies the agents' persistent MemoryCore profiles (the same identities the
   OpenChamber agents use), routes the normal parent session through the
   memory proxy (`ANTHROPIC_BASE_URL` → the installation's proxy; NEVER
   silently replacing an existing provider — conflicts require explicit
   `--replace-provider` consent, and exact rules live in
   [`docs/CLAUDE-CODE-SETUP.md`](docs/CLAUDE-CODE-SETUP.md)), and registers the
   `singularity-repoql` MCP server when a Linux `rql` is detected. The
   documentation hooks enforce the shared documentation policy and
   automatically ingest updated runbooks into MemoryCore with verified
   retrieval — see [`docs/DOC-INGESTION.md`](docs/DOC-INGESTION.md).
   Re-running it is idempotent. Everything else is advanced configuration
   (`--scope project`, `--team/--user`,
   `--dry-run`, `--no-main-memory`, `--replace-provider`, `status --probe`)
   and verification: [`docs/CLAUDE-CODE-SETUP.md`](docs/CLAUDE-CODE-SETUP.md).
   If a scoped user key was not yet provisioned, the installer still completes
   and the hooks continue without memory until
   `provision-secrets.py --memory-user-key` has been run; re-run the installer
   afterwards (then re-run with `--enable-main-memory` for proxy routing).

4. If Claude Code is not installed in WSL2, use Anthropic's native WSL
   installer and verify it before wiring the proxy:

   ```bash
   curl -fsSL https://claude.ai/install.sh | bash
   claude --version
   ```

   Install and run the Linux `claude` command inside WSL2; a Windows-side
   `claude.exe` that is not on WSL's PATH is not a substitute. Official guide:
   <https://docs.anthropic.com/en/docs/claude-code/setup>.

   Wire Claude Code through the proxy (add to, or merge into,
   `~/.claude/settings.json`) — or, simply, re-run the step-3 installer with
   `--enable-main-memory`, which writes the same values with consent checks
   and a recorded previous state for rollback:

   ```json
   {
     "env": {
       "ANTHROPIC_BASE_URL": "http://127.0.0.1:8096/claude-code/default",
       "ANTHROPIC_AUTH_TOKEN": "<your scoped business-user key (sk-mem-…)>",
       "ANTHROPIC_MODEL": "<your upstream model, if required>"
     }
   }
   ```

   From then on Claude Code sessions are captured by the memory stack
   through the proxy automatically (normal parent sessions included — no
   specialist agent selection required).

5. Option 1 does NOT install OpenChamber, Claude Office or Ghost. Do not copy
   `openchamber/` anywhere. With step 3 done, Claude Code users still get the
   specialised agents — as native Claude Code subagents under their own
   persistent MemoryCore identities — without any OpenChamber dependency. (The
   `openchamber/agents/` definitions themselves remain the OpenChamber runtime
   config; the Claude Code integration reuses them only as the source of the
   shared MemoryCore identities.)

Option 1 is done after step 5. Skip to "Report".

## 3. Option 3 — memory stack + OpenChamber (no Ghost, no Office)

1. **Memory stack first** — execute Option 1 steps 1–2 exactly as written
   (the same stack powers every option; skip the Claude Code wiring — the
   step-3 subagent installer and the step-4 proxy settings — unless the user
   also runs Claude Code on this machine). When Claude Code is also used, run
   the step-3 installer as well: it binds the native Claude Code subagents to
   the SAME MemoryCore identities these OpenChamber agents use, so one
   Singularity instance serves both clients consistently.

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
   | `openchamber/plugins/runbook-nudge/`  | `plugins/runbook-nudge/`  |
   | `openchamber/package.json`        | `package.json`           |

   This ships the nine agent definitions — `standalone` (primary),
   `ghost` (persistent companion agent that dreams; its runtime is enabled
   only in option 4), `thinker`, `general`,
   `explore`, `researcher-web`, `code-reviewer`, `quality-fixer` and
   **`board` (Board of Advisors)** — the runtime agent
   policy (`AGENTS.md`), and the Office/memory plugins (`product-office`,
   `runbook-nudge`). For a non-Docker
   OpenChamber install, copy the same files into `~/.config/opencode/`
   instead (same layout). Full details: `docs/OPENCHAMBER-SETUP.md`.

3. **Confirm the plugin secrets exist.** Option 1 step 2 already runs
   `scripts/provision-secrets.py` before its loop validator (pass
   `--variant 3` when running it directly here: Office/Ghost credentials are
   refused for option 3, only OpenChamber plugin + memory secrets are
   written; `--variant 4 --with-ghost` also provisions `secrets/ghost.env`).
   If continuing from a stack where that step was skipped or the files were
   removed, run it now with `--plugin-dir` pointing at the runtime config's
   `product-secrets` directory. It writes
   `product-secrets/memory.json` and (option 4) `office.json` from the
   running stack (gateway/service/user keys and Office token). Do not print
   the generated credential values.

4. **Build the local images before starting the UI services.** Option 3 needs
   only `openchamber:local` (`docs/OPENCHAMBER-SETUP.md`); option 4
   additionally builds `claude-office:local` (`docs/OFFICE-SETUP.md`, the
   validated `1fce512` revision). `scripts/start.sh` starts existing images;
   it does not build them.

5. **Preflight the ports, then start the stack.** Check for listeners on
   `8420`, `8125`, `8424`, `8096`, `3127` (option 3/4) — and `3128` for
   option 4 — in both WSL2 and Windows;
   identify any owner before proceeding and do not terminate an unknown
   process. In WSL2, inspect with `ss -ltnp`. Create a private UI-password
   file once if needed:

   ```bash
   umask 077
   mkdir -p secrets
   python3 -c 'import secrets; print("OPENCHAMBER_UI_PASSWORD=" + secrets.token_urlsafe(32))' > secrets/openchamber.env
   chmod 600 secrets/openchamber.env
   # Option 4 only: enable Ghost (bundled component; option 3 excludes it)
   # bash ghost/setup-ghost.sh
   scripts/start.sh
   ```

   `start.sh` pre-creates bind-mount directories as the WSL user, creates the
   shared product network, attaches memory-core to it, then attaches the UI
   services: it looks for the running OpenChamber first (compose-managed
   `singularity-openchamber`, your own managed one, or another foreign
   OpenChamber container / native `~/.config/opencode` install) and attaches
   to it via `node scripts/attach-openchamber.mjs` — it never creates a
   second OpenChamber, and only brings up its own `singularity-openchamber`
   container when you explicitly choose managed mode. Claude Office
   (option 4 only) starts when its image exists, and Ghost (option 4 only)
   joins when `secrets/ghost.env` is present (see `docs/GHOST-SETUP.md`). The
   WSL Linux `rql` binary is mounted into a managed container automatically;
   in attach mode use `node scripts/attach-openchamber.mjs --container` to
   verify `rql` inside the existing container. RepoQL state persists in
   `data/repoql/`. If `rql` is missing or broken, the script says so and
   skips RepoQL while the rest of the stack can start.

6. **Check the local services**: OpenChamber at `http://127.0.0.1:3127`
   (option 4: also Claude Office at `http://127.0.0.1:3128`); each checked
   endpoint should return HTTP 200. Sign in with the UI password, then check
   agent selection and a RepoQL tool call in a real OpenChamber session.

7. **Verify everything**:

   ```bash
   bash tests/validate-memory-loop.sh    # capture/proxy loop
   bash tests/validate-repoql.sh         # rql in container + host status + MCP handshake
   ```

   `validate-repoql.sh` must print `REPOQL VALIDATION OK`.

### Option 4 — Ghost and Claude Office are added automatically

Option 4 is option 3 plus the two bundled components. They cannot be
deselected, and nothing may be added to option 3: selecting option 4 is the
only way the walkthrough installs them.

1. **Office**: build `claude-office:local` (`docs/OFFICE-SETUP.md`, validated
   revision `1fce512`), include port `3128` in the preflight (step 5), and
   include `http://127.0.0.1:3128` in the endpoint check (step 6).
2. **Ghost**: run `bash ghost/setup-ghost.sh` (clean-slate seed templates;
   `docs/GHOST-SETUP.md`) before `scripts/start.sh`, and confirm the dream
   checkpoint recovery gate on Ghost's first dream.
3. **Gate**: when Claude Code is also installed on this machine, run
   `node scripts/install-claude-code.mjs install --variant 4` — the option
   gate verifies Ghost and Claude Office before reporting success (option 3
   passes `--variant 3`; options 1/2 are §2 with `--variant 1|2`).

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

## 5. Report (all options)

Tell the user, in one place:

- installation option chosen (1–4) and every step executed,
- every verification command and its output (or the reason it was skipped),
- the Panel/UI URLs and where the admin key and product secrets live
  (file paths only — never print secret values),
- anything that did not match the documented behavior (that is a bug in
  this document or code — say so plainly).
