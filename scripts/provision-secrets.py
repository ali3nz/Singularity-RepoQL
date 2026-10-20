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
--memory-user-key (or MEMORY_USER_KEY). The admin key from the memory stack
startup is administrative — the plugin no longer falls back to it silently.
Pass --allow-admin-plugin-key only while a scoped key is being provisioned
(e.g. tests or bring-up), never as the routine configuration.
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
    ap.add_argument("--allow-admin-plugin-key", action="store_true",
                    help="explicitly let the plugin fall back to the memory stack ADMIN key "
                         "(bring-up convenience only — prefer a scoped runtime key)"
                    )
    ap.add_argument("--variant", choices=["1", "2", "3", "4"], default=None,
                    help="installation option scope: Claude Office is part of options 2 and 4 ONLY — "
                         "options 1 and 3 never receive Office/Ghost provisioning or credentials. "
                         "Omit for the legacy unscoped behaviour.")
    ap.add_argument("--plugin-dir", default=None,
                    help="override the OpenChamber plugin config directory (default <base>/data/opencode/config/product-secrets); "
                         "used by the attach flow to provision into an EXISTING OpenChamber's config")
    ap.add_argument("--office-base-url", default="http://product-office:8000")
    ap.add_argument("--with-ghost", action="store_true", help="also provision secrets/ghost.env for the optional Ghost companion agent add-on")
    args = ap.parse_args()

    base = Path(args.base_dir).resolve()
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

    # 2. Memory Core identity for the plugin. Least-privileged by default: the
    # plugin's runtime traffic must use its own scoped key, NOT the admin key.
    user_key = args.memory_user_key
    if not user_key and args.allow_admin_plugin_key:
        admin_key_file = base / "memory" / "upstream" / ".admin-key"
        if admin_key_file.exists():
            user_key = admin_key_file.read_text().strip()
            print(
                "warning: plugins provisioned with the ADMIN key "
                "(--allow-admin-plugin-key). Replace it with a scoped "
                "runtime key as soon as you can create one.",
                file=sys.stderr,
            )
    if not user_key:
        print(
            "warning: no scoped runtime key passed with --memory-user-key. "
            "memory.json is written with an empty userKey; create a "
            "dedicated (least-privileged) Memory Core user key, then re-run "
            "this script with --memory-user-key. Pass "
            "--allow-admin-plugin-key only as an explicit temporary fallback.",
            file=sys.stderr,
        )

    gateway_key = read_env_file(base / "memory" / "upstream" / ".env").get(
        "MEMORY_CORE_GATEWAY_API_KEY", ""
    )
    # When the gateway gate is unset (the quickstart default — a non-empty
    # value breaks the memory proxy's auth), the core accepts the admin user
    # key as the effective bearer. Mirror that here so provisioned clients
    # authenticate successfully out of the box.
    if not gateway_key:
        gateway_key = user_key
    memory_json = merge_json(plugin_dir / "memory.json", {
        "baseUrl": args.memory_base_url,
        "authPrefix": "Bearer ",
        "gatewayKey": gateway_key,
        "serviceId": args.memory_service_id,
        "userKey": user_key,
    })
    if include_office:
        merge_json(plugin_dir / "office.json", {
            "endpoint": args.office_base_url.rstrip("/") + "/api/v1/events",
            "ingestKey": office_values["CLAUDE_OFFICE_INGEST_KEY"],
        })

    ghost_env = secrets_dir / "ghost.env"
    if args.with_ghost:
        ghost_values = read_env_file(ghost_env)
        ghost_defaults = {
            "GHOST_TIMEZONE": "UTC",
            "GHOST_UPSTREAM_BASE": "http://proxy:8096/openai/default/v1",
            "GHOST_DREAM_CHECK_INTERVAL_SEC": "3600",
        }
        for k, v in ghost_defaults.items():
            if not ghost_values.get(k):
                ghost_values[k] = v
        write_env_file(ghost_env, ghost_values)

    print(json.dumps({
        "variant": args.variant,
        "office_provisioned": include_office,
        "office_env": str(office_env) if include_office else None,
        "memory_json": str(plugin_dir / "memory.json"),
        "office_json": str(plugin_dir / "office.json") if include_office else None,
        "ghost_env": str(ghost_env) if ghost_env.exists() else None,
        "office_keys_generated": generated,
        "memory_user_key_present": bool(memory_json.get("userKey")),
        "note": "values intentionally not printed",
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
