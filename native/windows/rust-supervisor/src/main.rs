use singularity_windows_supervisor::{load, run};
use std::path::Path;
fn main() {
    let mut args = std::env::args().skip(1);
    let mode = args.next();
    let path = args.next();
    if mode.as_deref() == Some("openmausbot-verify-lease") {
        let pid = args.next().and_then(|n| n.parse::<u32>().ok());
        let ok = match (path.as_deref(), pid, args.next()) {
            (Some(root), Some(pid), None) => {
                singularity_windows_supervisor::openmausbot::verify_lease(Path::new(root), pid)
                    .is_ok()
            }
            _ => false,
        };
        if !ok {
            eprintln!("OPENMAUSBOT_LEASE_UNVERIFIED");
            std::process::exit(1);
        }
        println!("OPENMAUSBOT_LEASE_VERIFIED");
        return;
    }
    if args.next().is_some() || !matches!(mode.as_deref(), Some("check" | "run")) || path.is_none()
    {
        eprintln!("usage: singularity-windows-supervisor <check|run> <absolute-config-json>");
        std::process::exit(2);
    }
    let stack = match load(Path::new(path.as_deref().unwrap())) {
        Ok(stack) => stack,
        Err(err) => {
            eprintln!("configuration rejected: {err}");
            std::process::exit(1);
        }
    };
    if mode.as_deref() == Some("check") {
        println!(
            "{{\"valid\":true,\"variant\":{},\"components\":{},\"runtimeTested\":false}}",
            stack.variant,
            stack.components.len()
        );
        return;
    }
    if let Err(err) = run(stack) {
        eprintln!("supervisor halted: {err}");
        std::process::exit(1);
    }
}
