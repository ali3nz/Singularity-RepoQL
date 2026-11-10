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


def verify():
    errors = []
    policy = json.loads((ROOT / "native/windows/variants.json").read_text(encoding="utf-8"))
    if policy.get("schema") != 1 or policy.get("platform") != "windows-native":
        errors.append("unsupported native variant schema")
    if set(policy.get("variants", {})) != {"1", "2", "3", "4"}:
        errors.append("require exactly four install variants")
    all_features = {"memory", "repoql_mcp", "repoql_dashboard", "kanban", "agent_chat", "tencent_connector", "ghost", "office"}
    for n in (1, 2, 3, 4):
        row = policy["variants"].get(str(n), {})
        f = row.get("features", {})
        if set(f) != all_features:
            errors.append(f"option {n}: feature schema drift")
        if not all(f.get(k) is True for k in all_features - {"ghost", "office"}):
            errors.append(f"option {n}: missing core feature")
        want_office = n in (2, 4)
        if (f.get("office") is not want_office or f.get("ghost") is not False
                or row.get("rustOfficeFeature") is not want_office
                or row.get("rustGhostFeature") is not False):
            errors.append(f"option {n}: optional payload mismatch")
        expected_gui = "claude-desktop-code" if n < 3 else "openchamber-desktop"
        if row.get("gui") != expected_gui:
            errors.append(f"option {n}: wrong GUI target")

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
        "native/desktop-bridge/Cargo.toml", "native/desktop-bridge/src/main.rs",
        "native/windows/rust-supervisor/Cargo.toml", "native/windows/rust-supervisor/src/lib.rs", "native/windows/rust-supervisor/src/main.rs", "native/windows/register-supervisor-task.ps1", "native/windows/test_rust_supervisor_source.py",
        "native/desktop-bridge/src/variant.rs", "native/desktop-bridge/src/repoql_compat.rs",
        "native/desktop-bridge/src/windows_cpu.rs", "native/desktop-bridge/src/ghost.rs",
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
        "native/gui-plugins/openchamber/singularity-office.mjs",
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
    # Ghost may exist as a feature but must be compiled out on Windows
    # (every gate is all(feature = "ghost", not(windows))); a bare ghost gate
    # or ungated ghost-control entry point would ship it on Windows.
    ghost_ungated = any('feature = "ghost"' in ln and 'not(windows)' not in ln
                        for ln in bridge.splitlines())
    if ('default = []' not in cargo or 'office = []' not in cargo
            or ghost_ungated or '#[cfg(feature = "office")]' not in bridge):
        errors.append("Rust Office exclusion is not enforced by feature gating")
    dashboard = (ROOT / "dashboard/server.py").read_text(encoding="utf-8")
    if 'variant_route_allowed(path, profile)' not in dashboard or '"/api/features"' not in dashboard:
        errors.append("dashboard variant policy is not server enforced")
    # IMPORTANT: source gates are NOT a live compatibility probe. The native
    # RepoQL CLI must parse/test/pack both manifests before release acceptance.
    return {"ok": not errors, "static_files_checked": len(files),
            "options_checked": [1, 2, 3, 4], "errors": errors,
            "acceptance": "NOT_RUN_NATIVE_WINDOWS", "installed_connector_contract": "NOT_VERIFIED",
            "required_connector_contract": REQUIRED_CONNECTOR_CONTRACT, "repoql_version_required": REQUIRED_VERSION,
            "rust_compile": "NOT_RUN_IN_THIS_ENVIRONMENT"}


if __name__ == "__main__":
    result = verify()
    print(json.dumps(result, indent=2))
    sys.exit(0 if result["ok"] else 1)
