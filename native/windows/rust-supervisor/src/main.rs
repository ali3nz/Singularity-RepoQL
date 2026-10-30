use std::path::Path;
use singularity_windows_supervisor::{load, run};
fn main() {
    let mut args = std::env::args().skip(1);
    let mode = args.next();
    let path = args.next();
    if args.next().is_some() || !matches!(mode.as_deref(), Some("check" | "run")) || path.is_none() {
        eprintln!("usage: singularity-windows-supervisor <check|run> <absolute-config-json>");
        std::process::exit(2);
    }
    let stack = match load(Path::new(path.as_deref().unwrap())) {
        Ok(stack) => stack,
        Err(err) => { eprintln!("configuration rejected: {err}"); std::process::exit(1); }
    };
    if mode.as_deref() == Some("check") {
        println!("{{\"valid\":true,\"variant\":{},\"components\":{},\"runtimeTested\":false}}", stack.variant, stack.components.len());
        return;
    }
    if let Err(err) = run(stack) { eprintln!("supervisor halted: {err}"); std::process::exit(1); }
}
