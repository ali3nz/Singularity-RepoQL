use serde_json::{json, Value};
use singularity_rc_stack as rc;
use std::path::Path;

fn execute(args: &[String]) -> Result<Value, String> {
    match args.first().map(String::as_str) {
        Some("config") => {
            let (cfg, path) = rc::config_from_cli(args)?;
            rc::write_config(&path, &cfg)?;
            Ok(json!({"ok":true,"path":path,"config":cfg}))
        }
        Some("status") | Some("start") | Some("stop") => {
            if args.len() != 4 {
                return Err("usage: rc-stack {start|status|stop} NODE SUPERVISOR CONFIG".into());
            }
            let result = rc::lifecycle(
                Path::new(&args[1]),
                Path::new(&args[2]),
                &args[0],
                Path::new(&args[3]),
            )?;
            Ok(result)
        }
        Some("healthy") => {
            if args.len() != 2 {
                return Err("usage: rc-stack healthy STATUS_JSON_FILE".into());
            }
            let state: Value =
                serde_json::from_slice(&std::fs::read(&args[1]).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            Ok(json!({"ok":true,"healthy":rc::healthy(&state)}))
        }
        Some("probe") => {
            if args.len() != 7 {
                return Err(
                    "usage: rc-stack probe BASE_URL CONFIG_JSON SESSION_ID TEXT USER AGENT".into(),
                );
            }
            let cfg: Value =
                serde_json::from_slice(&std::fs::read(&args[2]).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            let token = rc::read_token(&cfg)?;
            rc::probe(&args[1], &token, &args[3], &args[4], &args[5], &args[6])
        }
        Some("cleanup") => {
            if args.len() != 2 {
                return Err("usage: rc-stack cleanup RC_STATE_DIR".into());
            }
            Ok(json!({"ok":true,"removed":rc::cleanup(Path::new(&args[1]))?}))
        }
        Some("defaults") => {
            if args.len() != 2 {
                return Err("usage: rc-stack defaults LOCALAPPDATA".into());
            }
            rc::node_defaults(Path::new(&args[1]))
        }
        _ => Err(
            "usage: rc-stack {config|start|status|stop|healthy|probe|cleanup|defaults} ...".into(),
        ),
    }
}
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match execute(&args) {
        Ok(v) => println!("{v}"),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2)
        }
    }
}
