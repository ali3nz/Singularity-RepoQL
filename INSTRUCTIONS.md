# INSTRUCTIONS.md — agent install walkthrough (Windows + RepoQL variant)

You are an agent installing **Singularity-RepoQL** on a Windows machine for a
user who already has **RepoQL (`rql`) installed**. This document is the full
install. Execute one variant end-to-end, then report as described at the end.

## 0. Prerequisites (verify before starting)

- Windows 11 (22H2 or later) with **WSL2** enabled and an Ubuntu 24.04+ (or
  Debian 13+) distro — older glibc (< 2.38) refuses to run `rql`.
- **Docker Desktop** installed and running with the *WSL2-based engine*
  (Settings → General → "Use the WSL 2 based engine").
- Inside WSL2: `git` and `docker` both on PATH (`docker compose version`
  must work), ~12 GB free disk, a stable internet connection.
- **`rql` is already installed and runnable** (working copy; validated with 1.7.15).
  The install commands that touch RepoQL assume it. If `rql --version`
  fails, STOP and ask the user — the variant presumes RepoQL exists.
- For **Variant B**, the rql that matters is the **WSL2 Linux** binary (a
  Windows-only `rql.exe` will not be mounted into OpenChamber); wire it per
  `docs/REPOQL-SETUP.md` first, and clone the repo into the WSL2 filesystem
  (e.g. `~/projects`), not under `/mnt/c`.
- **One LLM provider key** with an OpenAI-compatible or Anthropic-compatible
  endpoint reachable from the machine (used by the memory stack for
  extraction and summarization).
- Do all work inside the WSL2 terminal (Windows Terminal). Every path below
  is a WSL2 path.

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

1. Bring up the memory stack from the vendored upstream quickstart:

   ```bash
   cd memory/upstream
   ./verify.sh --skip-llm
   ./start-all.sh
   ```

   The stack starts the Tencent memory core, hub and proxy on the
   `tdai-memory-stack` Docker network and prints the Panel URLs plus an
   admin key written to `upstream/.admin-key`. Ports (loopback only):
   core 8420, panel 8125, knowledge 8424, proxy 8096.

2. Verify:

   ```bash
   ./verify.sh
   docker ps | grep tdai-
   cd ../..
   bash tests/validate-memory-loop.sh
   ```

   The validate script exercises capture (add → search) end-to-end
   against the memory core and must print a passing result.

3. Wire Claude Code through the proxy (add to, or merge into,
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
   as the runtime config, so the copy is repo-internal:

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

3. **Provision the plugin secrets** (the memory plugin and the Office
   channel): `scripts/provision-secrets.py` writes
   `data/opencode/config/product-secrets/memory.json` and `office.json`
   from the running stack (gateway key/service/user keys and the Office
   token).

4. **Start the stack** (choose your own UI password):

   ```bash
   OPENCHAMBER_UI_PASSWORD='<choose-one>' scripts/start.sh
   ```

   `start.sh` creates the product network, attaches the memory core, starts
   OpenChamber (compose/compose.yml) and — when an Office env file exists —
   Claude Office. **RepoQL: the script detects `rql` (it looks in
   `~/.local/bin/rql`, which the installer symlinks) and automatically adds
   `compose/repoql.override.yml`, which bind-mounts the rql binary into the
   OpenChamber container at `/usr/local/bin/rql` and persists
   `/home/openchamber/.repoql` state to `data/repoql/`. If `rql` is
   missing or broken, the script says so and skips RepoQL — the stack still
   starts.**

5. **Claude Office image** (only if the Office env file was provisioned):
   follow `docs/OFFICE-SETUP.md` exactly — build the visualizer once:

   ```bash
   git clone https://github.com/ali3nz/claude-office.git
   cd claude-office && git checkout 1fce512
   docker build -t claude-office:local .
   ```

6. **Open the UI** and confirm health: `http://127.0.0.1:3127` (loopback).
   Sign in with the UI password, open a workspace under
   `workspaces/` and confirm the specialised agents and the Board of
   Advisors are selectable.

7. **Verify everything**:

   ```bash
   bash tests/validate-memory-loop.sh    # capture/proxy loop
   bash tests/validate-repoql.sh         # rql inside OpenChamber + MCP handshake
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
