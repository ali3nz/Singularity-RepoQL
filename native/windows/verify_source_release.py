#!/usr/bin/env python3
"""Static, read-only packaging contract check. NOT end-to-end acceptance.

Run on both Windows and Linux. Never claims external Tencent, RepoQL or GUI
software works just because its source adapter is present.
"""
from pathlib import Path
import json
import sys
from repoql_compat import REQUIRED_VERSION, REQUIRED_CONNECTOR_CONTRACT, MANIFESTS, manifest_contract

ROOT = Path(__file__).resolve().parents[2]


def windows_claude_only_bridge(cargo: str, bridge: str) -> bool:
    """Full profile requires Office support and no retired control entry point."""
    return ('default = []' in cargo and 'office = []' in cargo
            and 'ghost' not in cargo.lower()
            and 'mod ghost;' not in bridge and 'ghost-control' not in bridge
            and '#[cfg(feature = "office")]' in bridge)


def verify():
    errors = []
    # Root product metadata must describe the same single Claude Code product as
    # the Windows release contract, not the retired multi-frontend manifests.
    product_manifest_path = ROOT / "MANIFEST.json"
    runtime_pins_path = ROOT / "native/windows/runtime-pins.json"
    try:
        product_manifest = json.loads(product_manifest_path.read_text(encoding="utf-8"))
        product = product_manifest.get("product", {})
        if (product.get("install_profiles") != ["claude-code-full"]
                or product.get("frontend") != "Claude Code"
                or product_manifest.get("native_windows_wip", {}).get("options") != [2]):
            errors.append("root product metadata must describe one full Claude Code install")
        if any(x in product_manifest_path.read_text(encoding="utf-8").casefold()
               for x in ("ghost", "openchamber")):
            errors.append("retired product present in the root manifest")
        pins = json.loads(runtime_pins_path.read_text(encoding="utf-8"))
        if "ghostRunner" in pins:
            errors.append("retired runner pin present in the native runtime")
    except (OSError, ValueError, TypeError, AttributeError):
        errors.append("root product manifest or runtime pins unreadable")
    policy = json.loads((ROOT / "native/windows/variants.json").read_text(encoding="utf-8"))
    if policy.get("schema") != 1 or policy.get("platform") != "windows-native":
        errors.append("unsupported native variant schema")
    if set(policy.get("variants", {})) != {"2"} or policy.get('defaultVariant') != 2:
        errors.append("exactly one full Claude Code install profile required")
    row = policy.get('variants',{}).get('2',{})
    features = row.get('features',{})
    required = {"memory", "repoql_mcp", "repoql_dashboard", "kanban", "agent_chat",
                "tencent_connector", "kanzo", "openmausbot", "office"}
    if any(features.get(name) is not True for name in required):
        errors.append("full Claude Code feature contract incomplete")
    if features.get('ghost') is not False or row.get('rustGhostFeature') is not False:
        errors.append("retired feature must be explicitly disabled")
    if row.get('rustOfficeFeature') is not True or row.get('gui') != 'claude-desktop-code':
        errors.append("Claude Code and Office full profile required")

    repoql = policy.get("repoql", {})
    if (repoql.get("requiredVersion") != REQUIRED_VERSION or
            repoql.get("connectorContract") != REQUIRED_CONNECTOR_CONTRACT or
            "connectorAbi" in repoql or repoql.get("versionPolicy") != "exact-match-fail-closed"):
        errors.append("RepoQL release pin must remain exact 1.7.18 with the fetch-render contract, fail closed")
    for name, scheme in MANIFESTS.items():
        contract, manifest_errors = manifest_contract(ROOT / name, scheme)
        if manifest_errors or contract is None:
            errors.extend(f"RepoQL manifest {name}: {problem}" for problem in manifest_errors or ["contract not verified"])
    files = [
        "dashboard/native_listener.py",
        "native/windows/unified-gateway-rust/tests/differential_doc_native_write.py",
        "native/windows/rust-supervisor/src/setup.rs",
        "native/windows/test_rust_setup_request.ps1",
        "native/windows/rust-supervisor/src/bin/singularity-windows-setup.rs",
        "native/windows/unified-gateway-rust/src/bin/singularity-dashboard-listener.rs",
        "native/windows/unified-gateway-rust/src/bin/singularity-unified-proxy.rs",
        "native/windows/unified-gateway-rust/tests/differential_dashboard_listener.py",
        "native/windows/unified-gateway-rust/src/bin/dashboard_listener/password.rs",
        "native/windows/unified-gateway-rust/src/bin/dashboard_listener/static_asset.rs",
        "native/desktop-bridge/Cargo.toml", "native/desktop-bridge/src/main.rs",
        "native/windows/rust-supervisor/Cargo.toml", "native/windows/rust-supervisor/src/lib.rs", "native/windows/rust-supervisor/src/main.rs", "native/windows/register-supervisor-task.ps1", "native/windows/test_rust_supervisor_source.py",
        "native/desktop-bridge/src/variant.rs", "native/desktop-bridge/src/repoql_compat.rs",
        "native/desktop-bridge/src/windows_cpu.rs",
        "native/windows/repoql_compat.py", "native/windows/test_repoql_compat.py", "native/windows/test_office_native_contract.py", "native/windows/build_source_variants.py", "native/windows/preflight.ps1", "native/windows/test_preflight_contract.py", "native/windows/scan_source_archive.py", "native/windows/test_scan_source_archive.py",
        "native/windows/stage-native.ps1", "native/windows/smoke-stage.ps1", "native/windows/test_stage_native_contract.py",
        "native/windows/native_runtime_acceptance.py", "native/windows/test_native_runtime_acceptance.py",
        "native/windows/test_rust_case_lock_contract.py", "native/windows/test_supervisor_readiness_contract.py",
        "dashboard/harness_rust.py", "dashboard/test_harness_rust_native_security.py", "dashboard/test_supervisor_health_endpoint.py",
        "dashboard/unified_bridge.py", "dashboard/test_unified_windows_proxy.py",
        "dashboard/test_windows_gateway_locality.py", "dashboard/static/kanban_native.js",
        "native/windows/unified-gateway-rust/Cargo.toml", "native/windows/unified-gateway-rust/Cargo.lock",
        "native/windows/unified-gateway-rust/src/main.rs",
        "native/windows/unified-gateway-rust/src/bin/kanzo_board_audit.rs",
        "native/windows/refresh_installed_claude_rules.mjs", "native/windows/refresh_installed_claude_rules.test.mjs",
        "adapters/claude-code/singularity-workflow.md", "docs/WINDOWS-AGENT-MEMORY-POLICY.md",
        "native/windows/openmausbot/claude_mcp_launcher.mjs",
        "dashboard/server.py", "dashboard/variant_features.py", "dashboard/static/index.html",
        "dashboard/static/app.js", "dashboard/static/navigation_ui.js",
        "dashboard/repoql_native_auth.py", "dashboard/agentchat_feed.py", "dashboard/test_agentchat_windows_file_identity.py",
        "dashboard/native_repoql_gate.py", "dashboard/test_native_repoql_gate.py",
        "dashboard/native_gui_usage.py", "dashboard/test_native_gui_usage.py",
        "dashboard/native_cpu_history.py", "dashboard/test_native_cpu_collector_lifecycle.py",
        "native/windows/build_cpu_collector_component.py", "native/windows/test_cpu_collector_component.py",
        "native/windows/plan_claude_code_windows.mjs", "native/windows/plan_claude_code_windows.test.mjs",
        "native/windows/configure_claude_code_windows.mjs", "native/windows/configure_claude_code_windows.test.mjs",
        "native/windows/test_claude_package_config_integration.py",
        "native/windows/claude_complete_release_audit.py", "native/windows/test_claude_complete_release_audit.py",
        "dashboard/native_cpu.py", "dashboard/test_native_cpu.py",
        "dashboard/test_native_auth_broker.py",
        "dashboard/native_readiness.py", "dashboard/test_native_readiness.py",
        "dashboard/test_native_readiness_rust_bridge.py",
        "native/windows/unified-gateway-rust/src/bin/singularity-native-readiness.rs",
        "native/windows/unified-gateway-rust/tests/differential_native_readiness.py",
        "dashboard/test_native_cpu_history_rust_bridge.py",
        "native/windows/unified-gateway-rust/src/bin/singularity-native-cpu-history.rs",
        "native/windows/unified-gateway-rust/tests/differential_native_cpu_history.py",
        "dashboard/test_openmaus_inventory_rust_bridge.py",
        "native/windows/unified-gateway-rust/src/bin/singularity-openmaus-inventory.rs",
        "native/windows/unified-gateway-rust/tests/differential_openmaus_inventory.py",
        "dashboard/test_repo_query_usage_rust_bridge.py",
        "native/windows/unified-gateway-rust/src/bin/singularity-repoql-query-usage.rs",
        "native/windows/unified-gateway-rust/tests/differential_repoql_query_usage.py",
        "dashboard/test_native_panel_safety.py", "dashboard/test_office_windows_rollback.py", "dashboard/test_office_proxy_roundtrip.py", "dashboard/test_windows_connector_roundtrip.py", "docs/WINDOWS-OFFICE-AUTH-ROLLBACK.md",
        "dashboard/repoql_connectors.py", "dashboard/native_panel_proxy.py",
        "connectors/kanzo/connector.ts", "connectors/kanzo/manifest.yaml",
        "connectors/memorycore/connector.ts", "connectors/memorycore/manifest.yaml",
        "scripts/bundle-classification.mjs", "scripts/doc-ingest-node.mjs",
        "scripts/memory-doc-ingest.py", "scripts/test_doc_ledger_lock.py", "THIRD_PARTY_NOTICES.md",
    ]
    for name in files:
        if not (ROOT / name).is_file():
            errors.append(f"missing required source: {name}")
    # No binary vendoring of the commercial third-party RepoQL engine is allowed.
    if (ROOT / "native/windows/rql.exe").exists():
        errors.append("bundled RepoQL executable requires separate licence/provenance review")
    cargo = (ROOT / "native/desktop-bridge/Cargo.toml").read_text(encoding="utf-8")
    bridge = (ROOT / "native/desktop-bridge/src/main.rs").read_text(encoding="utf-8")
    if not windows_claude_only_bridge(cargo, bridge):
        errors.append("Rust Windows Claude Code Office bridge scope is invalid")
    dashboard = (ROOT / "dashboard/server.py").read_text(encoding="utf-8")
    route_path = ROOT / "dashboard/dashboard_route_policy.py"
    route_policy = route_path.read_text(encoding="utf-8") if route_path.is_file() else ""
    if ('variant_route_allowed(path, profile)' not in dashboard
            or 'classify_dashboard_route(method, path)' not in dashboard
            or '"/api/features": "read_features"' not in route_policy):
        errors.append("dashboard variant policy is not server enforced")
    # IMPORTANT: source gates are NOT a live compatibility probe. The native
    # RepoQL CLI must parse/test/pack both manifests before release acceptance.
    return {"ok": not errors, "static_files_checked": len(files),
            "options_checked": [2], "errors": errors,
            "acceptance": "NOT_RUN_NATIVE_WINDOWS", "installed_connector_contract": "NOT_VERIFIED",
            "required_connector_contract": REQUIRED_CONNECTOR_CONTRACT, "repoql_version_required": REQUIRED_VERSION,
            "rust_compile": "NOT_RUN_IN_THIS_ENVIRONMENT"}


if __name__ == "__main__":
    result = verify()
    print(json.dumps(result, indent=2))
    sys.exit(0 if result["ok"] else 1)
