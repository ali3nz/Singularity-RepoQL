//! Own the single pinned OpenMausBot vendor child using the existing Job Object.
//! Task registration, archive integrity and HTTP/lease evidence remain with the manager.
use super::{assert_existing_path_safe, run, Component, Stack, SCHEMA};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
struct Receipt {
    schema: String,
    root: PathBuf,
    node: PathBuf,
    payload: PathBuf,
    cli: PathBuf,
    port: u16,
    supervisor: PathBuf,
}

fn component(base: &Path, root: &Path, exe: &Path, receipt: Receipt) -> Result<Component, String> {
    let runtime = base.join("Runtime");
    let expected_root = base.join("WindowsNative").join("openmausbot");
    let expected_exe = base
        .join("WindowsNative")
        .join("current")
        .join("bin")
        .join("singularity-windows-supervisorw.exe");
    let node = runtime.join("node").join("node.exe");
    let payload = runtime.join("openmausbot");
    let cli = payload.join("cli.js");
    if receipt.schema != "singularity-openmausbot-rust/v1"
        || root != expected_root
        || receipt.root != expected_root
        || exe != expected_exe
        || receipt.supervisor != expected_exe
        || receipt.node != node
        || receipt.payload != payload
        || receipt.cli != cli
        || receipt.port != 18211
    {
        return Err("OpenMausBot receipt identity mismatch".into());
    }
    let data = expected_root.join("data");
    let arg = |path: &Path| {
        path.to_str()
            .map(str::to_owned)
            .ok_or_else(|| "OpenMausBot path is not Unicode".to_string())
    };
    Ok(Component {
        id: "openmausbot".into(),
        executable: node,
        working_dir: payload,
        args: vec![
            arg(&cli)?,
            "serve".into(),
            "--no-pair".into(),
            "--local".into(),
            "--data-dir".into(),
            arg(&data)?,
            "--port".into(),
            "18211".into(),
            "--label".into(),
            "Singularity".into(),
        ],
        env: BTreeMap::from([
            ("OMB_PORT".into(), "18211".into()),
            ("OMB_WEBHOOK_PORT".into(), "18212".into()),
            ("NO_COLOR".into(), "1".into()),
        ]),
        // The manager proves HTTP, CIM, lease and listener agreement. The
        // vendor response does not implement the generic component header.
        health: None,
    })
}

/// Check only the vendor lease for the PID already observed by the manager.
pub fn verify_lease(root: &Path, expected_pid: u32) -> Result<(), String> {
    if expected_pid == 0 {
        return Err("OpenMausBot invalid expected process".into());
    }
    let lease = root.join("data").join("openmausbot-server.lease");
    assert_existing_path_safe(&lease, true)?;
    let mut raw = Vec::new();
    fs::File::open(lease)
        .map_err(|_| "cannot open OpenMausBot lease")?
        .take(16_385)
        .read_to_end(&mut raw)
        .map_err(|_| "cannot read OpenMausBot lease")?;
    if raw.len() > 16_384 {
        return Err("OpenMausBot lease too large".into());
    }
    let json = raw.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&raw);
    #[derive(Deserialize)]
    struct Lease {
        pid: u32,
    }
    let record: Lease = serde_json::from_slice(json).map_err(|_| "invalid OpenMausBot lease")?;
    if record.pid != expected_pid {
        return Err("OpenMausBot lease identity mismatch".into());
    }
    Ok(())
}

pub fn run_openmausbot(root: &Path) -> Result<(), String> {
    if !cfg!(windows) {
        return Err("native Windows required".into());
    }
    let local = std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA required")?;
    let base = PathBuf::from(local).join("Singularity");
    let exe = std::env::current_exe().map_err(|_| "cannot identify supervisor executable")?;
    let expected_root = base.join("WindowsNative").join("openmausbot");
    if root != expected_root {
        return Err("OpenMausBot state root mismatch".into());
    }
    assert_existing_path_safe(root, false)?;
    assert_existing_path_safe(&exe, true)?;
    let path = root.join("installation.json");
    assert_existing_path_safe(&path, true)?;
    let mut raw = Vec::new();
    fs::File::open(&path)
        .map_err(|_| "cannot open OpenMausBot receipt")?
        .take(16_385)
        .read_to_end(&mut raw)
        .map_err(|_| "cannot read OpenMausBot receipt")?;
    if raw.len() > 16_384 {
        return Err("OpenMausBot receipt too large".into());
    }
    let json = raw.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&raw);
    let receipt: Receipt =
        serde_json::from_slice(json).map_err(|_| "invalid OpenMausBot receipt")?;
    let component = component(&base, root, &exe, receipt)?;
    assert_existing_path_safe(&component.working_dir.join("cli.js"), true)?;
    let data = root.join("data");
    // An absent data directory is a valid first launch, not a missing receipt.
    match fs::symlink_metadata(&data) {
        Ok(_) => assert_existing_path_safe(&data, false)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(_) => return Err("cannot inspect OpenMausBot data directory".into()),
    }
    run(Stack {
        schema: SCHEMA.into(),
        variant: 2,
        repoql_version: "1.7.18".into(),
        components: vec![component],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(base: &Path) -> (PathBuf, PathBuf, Receipt) {
        let root = base.join("WindowsNative").join("openmausbot");
        let exe = base
            .join("WindowsNative")
            .join("current")
            .join("bin")
            .join("singularity-windows-supervisorw.exe");
        let payload = base.join("Runtime").join("openmausbot");
        let receipt = Receipt {
            schema: "singularity-openmausbot-rust/v1".into(),
            root: root.clone(),
            node: base.join("Runtime").join("node").join("node.exe"),
            cli: payload.join("cli.js"),
            payload,
            port: 18211,
            supervisor: exe.clone(),
        };
        (root, exe, receipt)
    }

    #[test]
    fn uses_fixed_child_paths_arguments_and_environment() {
        let base = Path::new("fixture");
        let (root, exe, receipt) = fixture(base);
        let child = component(base, &root, &exe, receipt).unwrap();
        assert_eq!(
            child.executable,
            base.join("Runtime").join("node").join("node.exe")
        );
        assert_eq!(
            child.args[0],
            base.join("Runtime")
                .join("openmausbot")
                .join("cli.js")
                .to_str()
                .unwrap()
        );
        assert_eq!(
            &child.args[1..5],
            ["serve", "--no-pair", "--local", "--data-dir"]
        );
        assert_eq!(child.args[5], root.join("data").to_str().unwrap());
        assert_eq!(
            &child.args[6..],
            ["--port", "18211", "--label", "Singularity"]
        );
        assert_eq!(child.env.len(), 3);
        assert_eq!(child.env["OMB_WEBHOOK_PORT"], "18212");
        assert!(child.health.is_none());
    }

    #[test]
    fn refuses_legacy_receipt_and_drifted_targets() {
        let base = Path::new("fixture");
        for change in 0..7 {
            let (root, exe, mut receipt) = fixture(base);
            match change {
                0 => receipt.schema = "singularity-openmausbot/v1".into(),
                1 => receipt.root.push("foreign"),
                2 => receipt.node.push("foreign.exe"),
                3 => receipt.payload.push("foreign"),
                4 => receipt.cli.push("foreign.js"),
                5 => receipt.port = 18212,
                _ => receipt.supervisor.push("foreign.exe"),
            }
            assert!(component(base, &root, &exe, receipt).is_err());
        }
        let (root, exe, receipt) = fixture(base);
        assert!(component(base, &root, &exe.with_file_name("other.exe"), receipt).is_err());
    }

    #[test]
    fn lease_checks_bounds_and_exact_numeric_process() {
        let dir = std::env::temp_dir().join(format!("omb-lease-{}", std::process::id()));
        fs::create_dir(&dir).unwrap();
        fs::create_dir(dir.join("data")).unwrap();
        let lease = dir.join("data/openmausbot-server.lease");
        assert!(verify_lease(&dir, 42).is_err());
        fs::write(&lease, br#"{"pid":42,"other":"vendor metadata"}"#).unwrap();
        assert!(verify_lease(&dir, 42).is_ok());
        assert!(verify_lease(&dir, 43).is_err());
        assert!(verify_lease(&dir, 0).is_err());
        fs::write(&lease, br#"{"pid":"42"}"#).unwrap();
        assert!(verify_lease(&dir, 42).is_err());
        fs::write(&lease, vec![b' '; 16_385]).unwrap();
        assert!(verify_lease(&dir, 42).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    #[cfg(not(windows))]
    fn never_launches_on_other_platforms() {
        assert_eq!(
            run_openmausbot(Path::new("fixture")),
            Err("native Windows required".into())
        );
    }
}
