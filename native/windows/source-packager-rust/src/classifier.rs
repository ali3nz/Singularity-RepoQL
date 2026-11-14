//! Claude Code source inventory and Windows single full Claude Code profile.
//! Mirrors scripts/bundle-classification.mjs and windows_source_policy.py.
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;
use walkdir::WalkDir;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Component {
    Core,
    Office,
    Dashboard,
}

pub const ROOTS: &[&str] = &[
    ".github",
    "adapters",
    "bin",
    "compose",
    "connectors",
    "dashboard",
    "docs",
    "native",
    "harness",
    "memory",
    "office",
    "orchestration",
    "scripts",
    "systemd",
    "templates",
    "tests",
];
pub const ROOT_FILES: &[&str] = &[
    ".gitignore",
    "AGENTS.md",
    "CHANGELOG.md",
    "INSTRUCTIONS.md",
    "LICENSE",
    "MANIFEST.json",
    "README.md",
    "SHA256SUMS",
    "THIRD_PARTY_NOTICES.md",
    "WINDOWS_GUI_PORT_STATUS.md",
    "WINDOWS_NATIVE_RELEASE_PROGRESS_20261029.md",
    "WINDOWS_NATIVE_RELEASE_MILESTONE6_20261029.md",
    "WINDOWS_NATIVE_RELEASE_MILESTONE7_20261029.md",
    "WINDOWS_NATIVE_RELEASE_MILESTONE8_20261029.md",
    "WINDOWS_NATIVE_RELEASE_MILESTONE9_20261029.md",
    "WINDOWS_NATIVE_RELEASE_MILESTONE10_20261029.md",
];
const SKIP_DIRS: &[&str] = &["node_modules", ".git", "__pycache__", "runs", "target"];

pub fn walk_shipped_files(root: &Path) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for dir in ROOTS {
        if !root.join(dir).exists() {
            continue;
        }
        for entry in WalkDir::new(root.join(dir))
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| {
                !e.file_type().is_dir()
                    || !SKIP_DIRS.contains(&e.file_name().to_string_lossy().as_ref())
            })
        {
            let entry = entry.map_err(|e| format!("walk failed: {e}"))?;
            if entry.file_type().is_dir() {
                continue;
            }
            if !entry.file_type().is_file() {
                return Err(format!(
                    "non-file or symlink in source: {}",
                    entry.path().display()
                ));
            }
            let relative = entry.path().strip_prefix(root).map_err(|e| e.to_string())?;
            out.push(relative.to_string_lossy().replace('\\', "/"));
        }
    }
    for file in ROOT_FILES {
        let path = root.join(file);
        if path.exists() {
            if path.is_symlink() || !path.is_file() {
                return Err(format!("source is not a regular file: {file}"));
            }
            out.push((*file).to_string());
        }
    }
    out.sort();
    out.dedup();
    Ok(out)
}

pub fn classify(raw: &str) -> Option<Component> {
    let p = raw.strip_prefix("./").unwrap_or(raw).replace('\\', "/");
    if p.is_empty() {
        return None;
    }
    if p.starts_with("office/")
        || p.starts_with("systemd/office-")
        || p.starts_with("compose/office-")
        || p.starts_with("compose/office.")
        || matches!(
            p.as_str(),
            "native/desktop-bridge/src/office.rs" | "dashboard/office_bridge.py"
        )
    {
        return Some(Component::Office);
    }
    if p.starts_with("dashboard/") {
        return Some(Component::Dashboard);
    }
    const CORE_PREFIXES: &[&str] = &[
        "native/",
        ".github/",
        "bin/",
        "connectors/",
        "repoql-feedback/",
        "harness/",
        "adapters/",
        "compose/",
        "docs/",
        "memory/",
        "orchestration/",
        "scripts/",
        "systemd/",
        "templates/",
        "tests/",
    ];
    if CORE_PREFIXES.iter().any(|part| p.starts_with(part))
        || matches!(
            p.as_str(),
            "AGENTS.md"
                | "INSTRUCTIONS.md"
                | "CHANGELOG.md"
                | "LICENSE"
                | "README.md"
                | "MANIFEST.json"
                | "SHA256SUMS"
                | "THIRD_PARTY_NOTICES.md"
                | ".gitignore"
        )
        || p == "WINDOWS_GUI_PORT_STATUS.md"
        || p == "WINDOWS_NATIVE_RELEASE_PROGRESS_20261029.md"
        || [6, 7, 8, 9, 10]
            .iter()
            .any(|n| p == format!("WINDOWS_NATIVE_RELEASE_MILESTONE{n}_20261029.md"))
    {
        return Some(Component::Core);
    }
    None
}

#[derive(Debug, Serialize)]
pub struct Partition {
    pub core: Vec<String>,
    pub office: Vec<String>,
    pub dashboard: Vec<String>,
    pub unclassified: Vec<String>,
}
impl Partition {
    pub fn for_files(files: &[String]) -> Self {
        let mut out = Self {
            core: vec![],
            office: vec![],
            dashboard: vec![],
            unclassified: vec![],
        };
        for f in files {
            match classify(f) {
                Some(Component::Core) => out.core.push(f.clone()),
                Some(Component::Office) => out.office.push(f.clone()),
                Some(Component::Dashboard) => out.dashboard.push(f.clone()),
                None => out.unclassified.push(f.clone()),
            }
        }
        for rows in [
            &mut out.core,
            &mut out.office,
            &mut out.dashboard,
            &mut out.unclassified,
        ] {
            rows.sort();
        }
        out
    }
    pub fn selected_for_windows(&self, variant: u8) -> Result<Vec<String>, String> {
        if variant != 2 {
            return Err("only Claude Code Full is supported".into());
        }
        if !self.unclassified.is_empty() {
            return Err(format!(
                "unclassified shipped files: {}",
                self.unclassified
                    .iter()
                    .take(8)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        let mut out = self.core.clone();
        out.extend(self.dashboard.iter().cloned());
        out.extend(self.office.iter().cloned());
        out.retain(|f| {
            !linux_deployment_asset(f)
                && !windows_variant_excludes(f, variant).unwrap_or(true)
                && f != "SHA256SUMS"
        });
        out.sort();
        if out.is_empty() {
            return Err("empty source set".into());
        }
        Ok(out)
    }
}

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
pub fn windows_variant_excludes(name: &str, variant: u8) -> Result<bool, String> {
    if variant != 2 {
        return Err("only Claude Code Full is supported".into());
    }
    Ok(windows_retired_source(name))
}
pub fn partition_json(files: &[String]) -> serde_json::Value {
    serde_json::to_value(Partition::for_files(files)).expect("Partition is serializable")
}
pub fn audit_component_counts(files: &[String]) -> BTreeMap<&'static str, usize> {
    let p = Partition::for_files(files);
    BTreeMap::from([
        ("core", p.core.len()),
        ("office", p.office.len()),
        ("dashboard", p.dashboard.len()),
        ("unclassified", p.unclassified.len()),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_claude_code_policy() {
        assert_eq!(classify("office/readme.md"), Some(Component::Office));
        assert_eq!(classify("dashboard/test.py"), Some(Component::Dashboard));
        assert_eq!(
            classify("native/windows/source-packager-rust/src/main.rs"),
            Some(Component::Core)
        );
        assert_eq!(classify("unknown-root/file"), None);
        assert!(windows_retired_source(
            "native/windows/manage_ghost_scheduler.ps1"
        ));
        assert!(windows_retired_source("openchamber/plugins/payload.js"));
        assert!(windows_office_source("dashboard/office_bridge.py"));
        assert!(linux_deployment_asset("systemd/runtime.service"));
    }
    #[test]
    fn single_full_profile_only() {
        let p = Partition::for_files(&[
            "harness/x.mjs".into(),
            "dashboard/server.py".into(),
            "office/tool.py".into(),
        ]);
        assert!(p.selected_for_windows(1).is_err());
        assert_eq!(
            p.selected_for_windows(2).unwrap(),
            vec!["dashboard/server.py", "harness/x.mjs", "office/tool.py"]
        );
        assert!(p.selected_for_windows(3).is_err());
    }
}
