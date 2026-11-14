//! One explicitly approved phase of the existing receipt-owned installer.
use crate::assert_existing_path_safe;
use serde::Deserialize;
use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
pub enum Phase {
    Plan,
    Stage,
    Configure,
    Verify,
    VerifyInstalled,
    DashboardPlan,
    DashboardRegister,
    DashboardRebind,
    DashboardVerify,
    DashboardStart,
    DashboardRemove,
    RollbackConfig,
    RollbackStage,
    RetireStage,
    RestoreRetired,
    UninstallPlan,
    Uninstall,
}

impl Phase {
    pub fn changes(self) -> bool {
        !matches!(
            self,
            Self::Plan
                | Self::Verify
                | Self::VerifyInstalled
                | Self::DashboardPlan
                | Self::DashboardVerify
                | Self::UninstallPlan
        )
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Plan | Self::UninstallPlan => "Plan",
            Self::Stage => "Stage",
            Self::Configure => "Configure",
            Self::Verify => "Verify",
            Self::VerifyInstalled => "VerifyInstalled",
            Self::DashboardPlan => "DashboardPlan",
            Self::DashboardRegister => "DashboardRegister",
            Self::DashboardRebind => "DashboardRebind",
            Self::DashboardVerify => "DashboardVerify",
            Self::DashboardStart => "DashboardStart",
            Self::DashboardRemove => "DashboardRemove",
            Self::RollbackConfig => "RollbackConfig",
            Self::RollbackStage => "RollbackStage",
            Self::RetireStage => "RetireStage",
            Self::RestoreRetired => "RestoreRetired",
            Self::Uninstall => "Uninstall",
        }
    }

    fn uninstall_script(self) -> bool {
        matches!(self, Self::UninstallPlan | Self::Uninstall)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Request {
    schema: String,
    pub phase: Phase,
    pub driver_root: PathBuf,
    install_root: Option<PathBuf>,
    bundle: Option<PathBuf>,
    prepared: Option<PathBuf>,
    bootstrap: Option<PathBuf>,
    python_exe: Option<PathBuf>,
    node_exe: Option<PathBuf>,
    repoql_exe: Option<PathBuf>,
    claude_exe: Option<PathBuf>,
    kanzo_exe: Option<PathBuf>,
    memory_config: Option<PathBuf>,
    office_config: Option<PathBuf>,
    claude_home: Option<PathBuf>,
    workspace: Option<PathBuf>,
    supervisor_config: Option<PathBuf>,
    dashboard_port: Option<u16>,
    native_runtime_root: Option<PathBuf>,
    rebind_backup_receipt: Option<PathBuf>,
    #[serde(default)]
    rust_dashboard_routes: bool,
    #[serde(default)]
    rust_dashboard_listener: bool,
    #[serde(default)]
    rust_unified_proxy: bool,
    #[serde(default)]
    rust_doc_writer: bool,
}

pub fn load(path: &Path) -> Result<Request, &'static str> {
    assert_existing_path_safe(path, true).map_err(|_| "SETUP_REQUEST_PATH_INVALID")?;
    let mut bytes = Vec::new();
    fs::File::open(path)
        .and_then(|f| f.take(32_769).read_to_end(&mut bytes))
        .map_err(|_| "SETUP_REQUEST_UNREADABLE")?;
    if bytes.len() > 32_768 {
        return Err("SETUP_REQUEST_TOO_LARGE");
    }
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    serde_json::from_slice(bytes).map_err(|_| "SETUP_REQUEST_INVALID")
}

impl Request {
    pub fn command(&self) -> Result<Vec<OsString>, &'static str> {
        if self.schema != "singularity-windows-setup/v1" {
            return Err("SETUP_SCHEMA_INVALID");
        }
        if (self.rust_dashboard_routes
            || self.rust_dashboard_listener
            || self.rust_unified_proxy
            || self.dashboard_port.is_some())
            && !matches!(self.phase, Phase::DashboardRegister | Phase::DashboardRebind)
        {
            return Err("SETUP_DASHBOARD_OPTIONS_OUT_OF_SCOPE");
        }
        if self.native_runtime_root.is_some()
            && !matches!(self.phase, Phase::DashboardRegister | Phase::DashboardRebind)
        {
            return Err("SETUP_NATIVE_RUNTIME_ROOT_OUT_OF_SCOPE");
        }
        if self.rebind_backup_receipt.is_some() != (self.phase == Phase::DashboardRebind) {
            return Err("SETUP_REBIND_BACKUP_REQUIRED_OR_OUT_OF_SCOPE");
        }
        if self.rust_doc_writer && !matches!(self.phase, Phase::Plan | Phase::Configure) {
            return Err("SETUP_DOC_WRITER_OPTION_OUT_OF_SCOPE");
        }
        if self.dashboard_port.is_some_and(|port| port < 1024) {
            return Err("SETUP_DASHBOARD_PORT_INVALID");
        }
        let name = if self.phase.uninstall_script() {
            "uninstall_claude_complete.ps1"
        } else {
            "install_claude_complete.ps1"
        };
        if !crate::local_absolute(&self.driver_root) {
            return Err("SETUP_DRIVER_INVALID");
        }
        let driver = self.driver_root.join("native").join("windows").join(name);
        assert_existing_path_safe(&driver, true).map_err(|_| "SETUP_DRIVER_INVALID")?;
        let mut args: Vec<OsString> = ["-NoLogo", "-NoProfile", "-NonInteractive", "-File"]
            .into_iter()
            .map(Into::into)
            .collect();
        args.extend([
            driver.into_os_string(),
            "-Mode".into(),
            self.phase.name().into(),
        ]);

        for (key, value) in [
            ("-InstallRoot", &self.install_root),
            ("-NativeRuntimeRoot", &self.native_runtime_root),
            ("-RebindBackupReceipt", &self.rebind_backup_receipt),
            ("-ClaudeHome", &self.claude_home),
            ("-Workspace", &self.workspace),
            ("-NodeExe", &self.node_exe),
            ("-SupervisorConfig", &self.supervisor_config),
        ] {
            push_path(&mut args, key, value)?;
        }
        let install_only = [
            ("-Bundle", &self.bundle),
            ("-Prepared", &self.prepared),
            ("-Bootstrap", &self.bootstrap),
            ("-PythonExe", &self.python_exe),
            ("-RepoqlExe", &self.repoql_exe),
            ("-ClaudeExe", &self.claude_exe),
            ("-KanzoExe", &self.kanzo_exe),
            ("-MemoryConfig", &self.memory_config),
            ("-OfficeConfig", &self.office_config),
        ];
        if self.phase.uninstall_script() && install_only.iter().any(|(_, value)| value.is_some()) {
            return Err("SETUP_UNINSTALL_INPUT_OUT_OF_SCOPE");
        }
        for (key, value) in install_only {
            push_path(&mut args, key, value)?;
        }
        if let Some(port) = self.dashboard_port {
            args.extend(["-DashboardPort".into(), port.to_string().into()]);
        }
        if self.rust_dashboard_routes {
            args.push("-UseRustDashboardRoutes".into());
        }
        if self.rust_dashboard_listener {
            args.push("-UseRustDashboardListener".into());
        }
        if self.rust_unified_proxy {
            args.push("-UseRustUnifiedProxy".into());
        }
        if self.rust_doc_writer {
            args.push("-UseRustDocWriter".into());
        }
        // Added only after the native prompt in the caller has approved this
        // exact phase and validated request. Never accepts arbitrary switches.
        if self.phase.changes() {
            args.extend(["-Apply".into(), "-NativeSetupConfirmed".into()]);
        }
        Ok(args)
    }
}

fn push_path(
    args: &mut Vec<OsString>,
    key: &str,
    path: &Option<PathBuf>,
) -> Result<(), &'static str> {
    if let Some(path) = path {
        let s = path.to_str().ok_or("SETUP_PATH_INVALID")?;
        if !crate::local_absolute(path) || s.contains(['\r', '\n', '"', '\0']) {
            return Err("SETUP_PATH_INVALID");
        }
        args.extend([key.into(), path.as_os_str().to_owned()]);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phases_keep_plan_read_only_and_apply_explicit() {
        for (phase, change) in [
            (Phase::Plan, false),
            (Phase::Stage, true),
            (Phase::Configure, true),
            (Phase::Verify, false),
            (Phase::DashboardRegister, true),
            (Phase::DashboardRebind, true),
            (Phase::UninstallPlan, false),
            (Phase::Uninstall, true),
        ] {
            assert_eq!(phase.changes(), change);
        }
    }

    #[test]
    fn rejects_unknown_fields_and_phase() {
        for bad in [
            r#"{"schema":"singularity-windows-setup/v1","phase":"Run","driverRoot":"fixture"}"#,
            r#"{"schema":"singularity-windows-setup/v1","phase":"Plan","driverRoot":"fixture","script":"foreign"}"#,
            r#"{"schema":"singularity-windows-setup/v1","phase":"Plan","driverRoot":"fixture","apply":true}"#,
        ] {
            assert!(serde_json::from_str::<Request>(bad).is_err());
        }
    }

    #[test]
    fn command_does_not_apply_a_preview_or_cross_driver_boundaries() {
        let root =
            std::env::temp_dir().join(format!("singularity-setup-test-{}", std::process::id()));
        let root = if cfg!(windows) {
            root
        } else {
            root.canonicalize().unwrap_or(root)
        };
        let dir = root.join("native").join("windows");
        fs::create_dir_all(&dir).unwrap();
        for name in [
            "install_claude_complete.ps1",
            "uninstall_claude_complete.ps1",
        ] {
            fs::write(dir.join(name), b"fixture").unwrap();
        }
        for (phase, driver, mode, changes) in [
            ("Plan", "install_claude_complete.ps1", "Plan", false),
            ("Stage", "install_claude_complete.ps1", "Stage", true),
            (
                "UninstallPlan",
                "uninstall_claude_complete.ps1",
                "Plan",
                false,
            ),
            (
                "Uninstall",
                "uninstall_claude_complete.ps1",
                "Uninstall",
                true,
            ),
        ] {
            let value = serde_json::json!({
                "schema":"singularity-windows-setup/v1", "phase":phase, "driverRoot":root,
            });
            let request: Request = serde_json::from_value(value).unwrap();
            let args = request.command().unwrap();
            assert_eq!(args[4], dir.join(driver).into_os_string());
            assert_eq!(args[6], mode);
            assert_eq!(args.iter().any(|s| s == "-Apply"), changes);
            assert_eq!(args.iter().any(|s| s == "-NativeSetupConfirmed"), changes);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn path_values_are_single_arguments_and_cannot_be_flags() {
        let mut args = Vec::new();
        let path = PathBuf::from(if cfg!(windows) {
            r"C:\Test path\one"
        } else {
            "/test path/one"
        });
        assert!(push_path(&mut args, "-Bundle", &Some(path.clone())).is_ok());
        assert_eq!(args, [OsString::from("-Bundle"), path.into_os_string()]);
        assert!(push_path(&mut args, "-Bundle", &Some("-Apply".into())).is_err());
    }
}
