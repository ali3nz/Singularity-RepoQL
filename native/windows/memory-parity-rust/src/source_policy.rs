//! Pure Windows source boundary policies from windows_source_policy.py and
//! scan_source_archive.py. Does NOT replace ZIP scanning or checksum validation.

pub fn windows_retired_source(name: &str) -> bool {
    let n = name.replace('\\', "/").to_lowercase();
    [
        "ghost/",
        "openchamber/",
        "native/gui-plugins/openchamber/",
        "harness/openchamber-patches/",
        "harness/kit/prompts/",
    ]
    .iter()
    .any(|prefix| n.starts_with(prefix))
        || n.contains("ghost")
        || n.contains("openchamber")
        || [
            "native/windows/manage_native_windows.ps1",
            "native/windows/bootstrap_runtime.ps1",
            "native/windows/a4_run_step.ps1",
            "native/windows/test_native_windows_manager_contract.py",
            "native/windows/test_native_install_lifecycle_contract.py",
            "native/windows/test_native_install_lifecycle_behaviour.ps1",
            "scripts/install-claude-code.mjs",
            "scripts/doctor.mjs",
            "scripts/provision-secrets.py",
            "scripts/install-claude-code.gate.test.mjs",
            "scripts/install-claude-code.components.test.mjs",
            "scripts/install-claude-code.profiles.test.mjs",
            "scripts/doctor.test.mjs",
        ]
        .contains(&n.as_str())
}
pub fn windows_office_source(name: &str) -> bool {
    let n = name.replace('\\', "/").to_lowercase();
    n.starts_with("office/")
        || matches!(
            n.as_str(),
            "native/desktop-bridge/src/office.rs" | "dashboard/office_bridge.py"
        )
}
pub fn linux_deployment_asset(name: &str) -> bool {
    let b = name.rsplit('/').next().unwrap_or("").to_lowercase();
    [
        "compose/",
        "systemd/",
        "memory/upstream/",
        "memory/portable/systemd/",
    ]
    .iter()
    .any(|s| name.starts_with(s))
        || [
            "dashboard/docker-compose.yml",
            "dashboard/.env.example",
            "dashboard/config.example.json",
            "dashboard/collector.py",
        ]
        .contains(&name)
        || [".sh", ".service", ".timer", ".compose.yml"]
            .iter()
            .any(|s| b.ends_with(s))
        || b == "dockerfile"
        || b.starts_with("dockerfile.")
}
pub fn windows_variant_excludes(name: &str, variant: u8) -> Result<bool, &'static str> {
    if variant != 2 {
        return Err("only Claude Code Full is supported");
    }
    Ok(windows_retired_source(name))
}
fn reserved_windows_base(part: &str) -> bool {
    let base = part.split('.').next().unwrap_or("").to_uppercase();
    if ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&base.as_str()) {
        return true;
    }
    let mut chars = base.chars();
    let prefix: String = chars.by_ref().take(3).collect();
    if prefix != "COM" && prefix != "LPT" {
        return false;
    }
    matches!(
        chars.collect::<String>().as_str(),
        "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"
    )
}

pub fn windows_safe_member(name: &str) -> bool {
    if name.is_empty() || name.chars().count() > 240 || name.starts_with('/') || name.contains('\\')
    {
        return false;
    }
    for part in name.split('/') {
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.chars().count() > 200
            || part.ends_with('.')
            || part.ends_with(' ')
            || part
                .chars()
                .any(|c| (c as u32) < 32 || "<>:\"|?*".contains(c))
            || reserved_windows_base(part)
        {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_ntfs_unsafe_members() {
        for name in [
            "CON.txt",
            "a/../b",
            "a//b",
            "a\\b",
            "a/C:drive",
            "a/trailing.",
            "COM1.log",
            "a/",
            "a/<secret>",
        ] {
            assert!(!windows_safe_member(name), "{name}");
        }
        for name in [
            "harness/kit/lib/context-pack.mjs",
            "native/windows/authority.py",
            "config.mjs.bak",
        ] {
            assert!(windows_safe_member(name), "{name}");
        }
    }
    #[test]
    fn excludes_linux_deployment_and_office_variant_leaks() {
        assert!(linux_deployment_asset("memory/portable/systemd/a.service"));
        assert!(windows_variant_excludes("office/lib.rs", 1).is_err());
        assert!(!windows_variant_excludes("office/lib.rs", 2).unwrap());
        assert!(windows_variant_excludes("ghost/a.rs", 2).unwrap());
        assert!(windows_retired_source(
            "office/patches/windows-ghost-only.patch"
        ));
    }
}
