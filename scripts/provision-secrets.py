#!/usr/bin/env python3
"""Provision local credentials for a Singularity installation.

Creates, with restrictive permissions and without printing any values:

  secrets/claude-office.env                          CLAUDE_OFFICE_API_KEY, CLAUDE_OFFICE_INGEST_KEY
  data/opencode/config/product-secrets/office.json   endpoint + ingestKey for the OpenChamber plugin
  data/opencode/config/product-secrets/memory.json   baseUrl + gateway/user identity for the plugin
  secrets/ghost.env                                  optional Ghost add-on settings (when --with-ghost is passed)

Existing values are preserved: re-running fills in what is missing and never
overwrites a key that already has a value. Nothing is printed except file
paths and presence booleans.

Least-privileged Memory Core identity (default): the OpenChamber plugin's
runtime traffic uses a DEDICATED agent/business user key passed with
--memory-user-key (or MEMORY_USER_KEY). The memory stack's ADMINISTRATIVE key is
never read into, copied to or propagated by this provisioner: there is no
fallback flag. A supplied key equal to the admin key is refused (rc 2).
"""

import argparse
import json
import os
import secrets
import sys
from pathlib import Path


def write_private(path: Path, content: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(content)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    os.chmod(path, 0o600)


def read_env_file(path: Path) -> dict:
    values = {}
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()
    return values


def write_env_file(path: Path, values: dict) -> None:
    write_private(path, "".join(f"{k}={v}\n" for k, v in values.items()))


# The proxy route the product's model traffic uses is DERIVED from the
# canonical memory-stack configuration — never hardcoded. A hardcoded lane the
# proxy does not register fails with a ROUTING error ("spaceId is required in
# the request path") that looks like a credential problem but is not.
BROKEN_MODEL_LANES = {
    "http://proxy:8096/openai/default/v1",
    "http://127.0.0.1:8096/openai/default/v1",
}


def proxy_port(base: Path) -> int:
    """The proxy port from the memory stack's upstream .env (the same source
    the Claude Code main-agent memory uses)."""
    values = read_env_file(base / "memory" / "upstream" / ".env")
    try:
        return int(values.get("PROXY_PORT", "8096"))
    except ValueError:
        return 8096


def resolve_model_lane(base: Path) -> str:
    """The canonical model lane: <proxy>/<lane>/<space id>/v1 — the same
    proxy, lane and space id as the main-agent memory.

    The space id must be the service the scoped user key is provisioned under:
    MemoryCore auth/verify scopes a key's validity to ONE service id, so a lane
    derived from a different id answers 401 even with the correct key. Read the
    configured serviceId from the attached plugin's memory.json (the same file
    the product's live memory traffic already uses) before falling back to the
    env overrides and the clean-slate default."""
    port = proxy_port(base)
    space = (
        os.environ.get("SINGULARITY_MODEL_SPACE_ID")
        or os.environ.get("MEMORY_SERVICE_ID")
    )
    if not space:
        space = read_json_field(base / "openchamber" / "plugins" / "product-office" / "memory.json", "serviceId")
    if not space:
        space = read_json_field(base / "data" / "opencode" / "config" / "product-office" / "memory.json", "serviceId")
    if not space:
        space = read_json_field(base / "data" / "opencode" / "config" / "product-secrets" / "memory.json", "serviceId")
    space = space or "default"
    lane = os.environ.get("SINGULARITY_MODEL_LANE") or "claude-code"
    return f"http://proxy:{port}/{lane}/{space}/v1"


def read_json_field(path: Path, field: str):
    """A single scalar from a JSON config file, or None — never a secret: the
    serviceId/category names are configuration, not credentials."""
    try:
        return (json.loads(path.read_text()) or {}).get(field) or None
    except (OSError, ValueError, AttributeError):
        return None


def user_key_is_admin(base: Path, candidate: str) -> bool:
    """True when CANDIDATE equals the memory stack's administrative key.

    Read in-process and compared in constant time. The key value is never
    printed, returned or logged: only the boolean leaves this function."""
    import hmac
    admin_file = base / "memory" / "upstream" / ".admin-key"
    try:
        admin = admin_file.read_text(encoding="utf-8").strip()
    except OSError:
        return False
    if not admin or not candidate:
        return False
    return hmac.compare_digest(admin.encode("utf-8"), str(candidate).encode("utf-8"))


def merge_json(path: Path, defaults: dict) -> dict:
    current = {}
    if path.exists():
        try:
            current = json.loads(path.read_text())
        except (OSError, ValueError):
            current = {}
    merged = {}
    for key, default in defaults.items():
        existing = current.get(key)
        merged[key] = existing if existing not in (None, "") else default
    write_private(path, json.dumps(merged, indent=2) + "\n")
    return merged


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--base-dir", default=".", help="installation root (default: current directory)")
    ap.add_argument("--memory-base-url", default="http://memory-core:8420",
                    help="in-network Memory Core endpoint the plugin resolves (default: %(default)s)")
    ap.add_argument("--memory-service-id", default=os.environ.get("MEMORY_SERVICE_ID", "default"))
    ap.add_argument("--memory-user-key", default=os.environ.get("MEMORY_USER_KEY", ""),
                    help="Memory Core user key (sk-mem-...) for the OpenChamber plugin's runtime traffic; "
                         "create a dedicated (business-user scoped) key and pass it here"
                    )
    # Hidden on purpose: the former administrative-key fallback is REFUSED with
    # an explicit message (see main), it is no longer a documented option.
    ap.add_argument("--allow-admin-plugin-key", action="store_true", help=argparse.SUPPRESS)
    ap.add_argument("--variant", choices=["1", "2", "3", "4"], default=None,
                    help="installation option scope: Claude Office is part of options 2 and 4 ONLY — "
                         "options 1 and 3 never receive Office/Ghost provisioning or credentials. "
                         "Omit for the legacy unscoped behaviour.")
    ap.add_argument("--plugin-dir", default=None,
                    help="override the OpenChamber plugin config directory (default <base>/data/opencode/config/product-secrets); "
                         "used by the attach flow to provision into an EXISTING OpenChamber's config")
    ap.add_argument("--office-base-url", default="http://product-office:8000")
    ap.add_argument("--with-ghost", action="store_true", help="also provision secrets/ghost.env for the optional Ghost companion agent add-on")
    ap.add_argument("--ghost-upstream-base", default=os.environ.get("GHOST_UPSTREAM_BASE", ""),
                    help="explicit model lane for the Ghost dream daemon (default: the canonical lane derived from the memory stack config)")
    ap.add_argument("--ghost-backend", choices=["claude-code", "openchamber"], default=None,
                    help="which backend executes the Ghost turns (default: claude-code for option 2, openchamber for option 4)")
    args = ap.parse_args()

    base = Path(args.base_dir).resolve()
    # B7: the administrative key is never propagated. Refused BEFORE any write
    # (no directory, no office key, no plugin file is created by a refused run).
    if args.allow_admin_plugin_key:
        print("REFUSED: the administrative Memory Core key is never written into plugin "
              "configuration (--allow-admin-plugin-key is no longer supported). Create a "
              "scoped business-user key and pass it with --memory-user-key.", file=sys.stderr)
        return 2
    if args.memory_user_key and user_key_is_admin(base, args.memory_user_key.strip()):
        print("REFUSED: the supplied memory user key is the memory stack ADMINISTRATIVE key — "
              "it is never propagated to the plugin. Create a dedicated scoped business-user key "
              "and pass that instead (nothing was written; no key value is printed).", file=sys.stderr)
        return 2
    secrets_dir = base / "secrets"
    plugin_dir = Path(args.plugin_dir).resolve() if args.plugin_dir else base / "data" / "opencode" / "config" / "product-secrets"
    include_office = args.variant is None or args.variant in ("2", "4")
    if args.with_ghost and args.variant in ("1", "3"):
        print("REFUSED: Ghost is part of installation options 2 and 4 only — it cannot be provisioned for option " + args.variant, file=sys.stderr)
        return 2
    secrets_dir.mkdir(parents=True, exist_ok=True)
    plugin_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(secrets_dir, 0o700)
    os.chmod(plugin_dir, 0o700)

    # 1. Claude Office keys — ONLY for installation options 2/4 (or legacy
    # unscoped runs): options 1/3 must never receive Office provisioning.
    generated = []
    office_env = secrets_dir / "claude-office.env"
    office_values = read_env_file(office_env)
    if include_office:
        for key in ("CLAUDE_OFFICE_API_KEY", "CLAUDE_OFFICE_INGEST_KEY"):
            if not office_values.get(key):
                office_values[key] = secrets.token_hex(32)
                generated.append(key)
        if generated or not office_env.exists():
            write_env_file(office_env, office_values)
    else:
        office_values = {}

    # 2. Memory Core identity for the plugin. The plugin's runtime traffic uses
    # ONLY a dedicated scoped key supplied by the operator. The administrative
    # key of the memory stack is NEVER read, copied or propagated here: there is
    # no fallback path. An absent scoped key leaves userKey empty, which the
    # installation gate reports as INCOMPLETE (never as a working identity).
    # (The administrative-key refusal itself runs BEFORE any write, near the top
    # of main(): a refused run must leave no file behind.)
    user_key = args.memory_user_key.strip()
    if not user_key:
        print(
            "warning: no scoped runtime key passed with --memory-user-key. "
            "memory.json is written with an empty userKey; create a dedicated "
            "(least-privileged) Memory Core user key, then re-run this script "
            "with --memory-user-key. The installation gate stays INCOMPLETE until then.",
            file=sys.stderr,
        )

    # The gateway key is the memory proxy's bearer, NOT the plugin's identity:
    # it is taken from the memory stack's own gateway setting only. It is never
    # filled from the user key (that would hand the plugin the user credential
    # as a bearer and mask a missing gateway setting).
    gateway_key = read_env_file(base / "memory" / "upstream" / ".env").get(
        "MEMORY_CORE_GATEWAY_API_KEY", ""
    )
    memory_json = merge_json(plugin_dir / "memory.json", {
        "baseUrl": args.memory_base_url,
        "authPrefix": "Bearer ",
        "gatewayKey": gateway_key,
        "serviceId": args.memory_service_id,
        "userKey": user_key,
    })
    # A pre-existing userKey that is the ADMIN key (written by an earlier run
    # with the removed fallback) is actively repaired, never preserved.
    if memory_json.get("userKey") and user_key_is_admin(base, memory_json.get("userKey")):
        memory_json["userKey"] = user_key
        write_private(plugin_dir / "memory.json", json.dumps(memory_json, indent=2) + "\n")
        print("repaired: a stale administrative userKey was removed from the plugin memory config", file=sys.stderr)
    if include_office:
        merge_json(plugin_dir / "office.json", {
            "endpoint": args.office_base_url.rstrip("/") + "/api/v1/events",
            "ingestKey": office_values["CLAUDE_OFFICE_INGEST_KEY"],
        })

    # Processing provider for the automatic lesson pipeline. The attached
    # runtime lives inside the target's config directory, where the product's
    # memory/upstream/.env is NOT mounted — so the resolved provider (URL,
    # model, optional key) is carried beside the other product secrets. Mode
    # 0600, never printed. Absent MEMORY_LLM_BASE_URL writes nothing and the
    # pipeline reports "no processing provider configured" honestly.
    upstream_values = read_env_file(base / "memory" / "upstream" / ".env")
    if plugin_dir and upstream_values.get("MEMORY_LLM_BASE_URL"):
        merge_json(plugin_dir / "selflearn.json", {
            "url": upstream_values["MEMORY_LLM_BASE_URL"].rstrip("/"),
            "model": upstream_values.get("MEMORY_LLM_MODEL", ""),
            "key": upstream_values.get("MEMORY_LLM_API_KEY", ""),
        })

    ghost_env = secrets_dir / "ghost.env"
    if args.with_ghost:
        ghost_values = read_env_file(ghost_env)
        # The model lane is DERIVED (never a hardcoded route) and the backend
        # matches the selected installation option: option 2 drives Ghost
        # through Claude Code, option 4 through OpenChamber.
        lane = args.ghost_upstream_base or resolve_model_lane(base)
        backend = args.ghost_backend or ("claude-code" if args.variant == "2" else "openchamber")
        ghost_defaults = {
            "GHOST_TIMEZONE": "UTC",
            "GHOST_UPSTREAM_BASE": lane,
            "GHOST_DREAM_GATEWAY_URL": lane,
            "GHOST_BACKEND": backend,
            "GHOST_DREAM_CHECK_INTERVAL_SEC": "3600",
        }
        for k, v in ghost_defaults.items():
            existing = ghost_values.get(k)
            # A structurally invalid lane (one the proxy does not register) is
            # repaired; every other existing value — a custom endpoint the
            # operator set deliberately — is preserved.
            if not existing or (k in ("GHOST_UPSTREAM_BASE", "GHOST_DREAM_GATEWAY_URL") and existing in BROKEN_MODEL_LANES):
                ghost_values[k] = v
        write_env_file(ghost_env, ghost_values)

    print(json.dumps({
        "variant": args.variant,
        "office_provisioned": include_office,
        "office_env": str(office_env) if include_office else None,
        "memory_json": str(plugin_dir / "memory.json"),
        "office_json": str(plugin_dir / "office.json") if include_office else None,
        "selflearn_json": str(plugin_dir / "selflearn.json") if (plugin_dir / "selflearn.json").exists() else None,
        "ghost_env": str(ghost_env) if ghost_env.exists() else None,
        "office_keys_generated": generated,
        "memory_user_key_present": bool(memory_json.get("userKey")),
        "note": "values intentionally not printed",
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
