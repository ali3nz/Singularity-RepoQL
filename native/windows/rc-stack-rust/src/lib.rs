//! Native Windows replacement candidate for memory/rc_stack.py.
//! No production credentials/config are imported; caller explicitly supplies RC paths.
use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use wait_timeout::ChildExt;

pub const SCHEMA: &str = "native-memory-supervisor/v1";
pub const CORE_PORT: u16 = 18221;
pub const PANEL_PORT: u16 = 18226;

fn path_text(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

pub fn build_config(
    root: &Path,
    node: &Path,
    core: &Path,
    panel: &Path,
    core_port: u16,
    panel_port: u16,
    command: Option<Vec<String>>,
) -> Result<Value, String> {
    if !root.is_absolute() {
        return Err("root must be an absolute RC-owned path".into());
    }
    if core_port == panel_port {
        return Err("core and panel need distinct ports".into());
    }
    if core_port == 0 || panel_port == 0 {
        return Err("port out of range".into());
    }
    for p in [core, panel] {
        if !p.is_absolute() || !p.is_dir() {
            return Err(format!("vendor build input is missing: {}", p.display()));
        }
    }
    if !node.is_file() {
        return Err(format!("node runtime is missing: {}", node.display()));
    }
    Ok(json!({
        "schema":SCHEMA,"root":path_text(root),
        "stateDir":path_text(&root.join("state")),"logsDir":path_text(&root.join("logs")),
        "node":path_text(node),
        "components":{
            "core":{"kind":"core","host":"127.0.0.1","port":core_port,"cwd":path_text(core),
                "command":command.unwrap_or_else(||vec!["--import".into(),"tsx".into(),"src/gateway/server.ts".into()]),
                "healthPath":"/health","readyTimeoutMs":180000,"env":{}},
            "panel":{"kind":"panel","host":"127.0.0.1","port":panel_port,"cwd":path_text(panel),
                "command":["dist/index.js"],"healthPath":"/","readyTimeoutMs":120000,"env":{}}
        },"order":["core","panel"]
    }))
}
pub fn write_config(path: &Path, config: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut data = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    data.push('\n');
    fs::write(path, data).map_err(|e| e.to_string())
}
pub fn healthy(state: &Value) -> bool {
    state["code"] == "RUNNING"
        && state["processes"].as_array().is_some_and(|rows| {
            !rows.is_empty()
                && rows
                    .iter()
                    .all(|row| row["health"] == "ok" && row["ownership"] == "verified")
        })
}
pub fn read_token(config: &Value) -> Result<String, String> {
    let base = config["stateDir"].as_str().ok_or("stateDir missing")?;
    let path = Path::new(base).join("secrets").join("core-bearer");
    let content =
        fs::read_to_string(path).map_err(|e| format!("bearer token is unavailable: {e}"))?;
    let token = content.trim();
    if token.is_empty() {
        return Err("bearer token file is empty".into());
    }
    Ok(token.to_string())
}

/// Supervises the *existing* Node script without changing its ownership or lifecycle rules.
/// No token, shell or environment values are passed in command arguments.
pub fn lifecycle(
    node: &Path,
    supervisor: &Path,
    verb: &str,
    config_path: &Path,
) -> Result<Value, String> {
    if !["start", "status", "stop"].contains(&verb) {
        return Err("invalid lifecycle verb".into());
    }
    let mut child = Command::new(node)
        .arg(supervisor)
        .arg(verb)
        .arg("--config")
        .arg(config_path)
        .arg("--json")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("supervisor launch failed: {e}"))?;
    // Drain both pipes concurrently so a noisy child cannot deadlock while
    // the parent waits for exit. Retain a bounded prefix of each stream.
    fn drain<R: Read + Send + 'static>(
        mut r: R,
        cap: usize,
    ) -> std::thread::JoinHandle<std::io::Result<String>> {
        std::thread::spawn(move || {
            let mut retained = Vec::new();
            let mut buf = [0u8; 8192];
            loop {
                let n = r.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                let take = cap.saturating_sub(retained.len()).min(n);
                retained.extend_from_slice(&buf[..take]);
            }
            Ok(String::from_utf8_lossy(&retained).into_owned())
        })
    }
    let out_reader = drain(
        child.stdout.take().ok_or("supervisor stdout unavailable")?,
        4 * 1024 * 1024,
    );
    let err_reader = drain(
        child.stderr.take().ok_or("supervisor stderr unavailable")?,
        1024 * 1024,
    );
    let timeout = Duration::from_secs(600);
    let result = child.wait_timeout(timeout).map_err(|e| e.to_string())?;
    if result.is_none() {
        let _ = child.kill();
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let stdout = out_reader
        .join()
        .map_err(|_| "stdout reader failed")?
        .map_err(|e| e.to_string())?;
    let stderr = err_reader
        .join()
        .map_err(|_| "stderr reader failed")?
        .map_err(|e| e.to_string())?;
    if result.is_none() {
        return Err("supervisor timed out".into());
    }
    let payload: Value = serde_json::from_str(stdout.trim()).unwrap_or(Value::Null);
    if !status.success() {
        return Err(format!(
            "stack {verb} failed: {}",
            if stderr.trim().is_empty() {
                payload.to_string()
            } else {
                stderr.trim().to_string()
            }
            .chars()
            .take(300)
            .collect::<String>()
        ));
    }
    Ok(if payload.is_null() {
        json!({})
    } else {
        payload
    })
}

fn post(url: &str, body: &Value, token: &str) -> Result<Value, String> {
    let resp = ureq::post(url)
        .set("Content-Type", "application/json")
        .set("Authorization", &format!("Bearer {token}"))
        .set("x-tdai-service-id", "default")
        .timeout(Duration::from_secs(30))
        .send_json(body.clone());
    match resp {
        Ok(r) => r
            .into_json()
            .map_err(|e| format!("response JSON invalid: {e}")),
        Err(ureq::Error::Status(code, r)) => {
            let message = r.into_string().unwrap_or_default();
            Err(format!(
                "HTTP {code} from {url}: {}",
                message.chars().take(300).collect::<String>()
            ))
        }
        Err(e) => Err(format!("probe request failed: {e}")),
    }
}

/// Use a random, unique session id per probe. This operation writes and deletes
/// live data: caller must explicitly choose the target RC instance and identity.
pub fn probe(
    base: &str,
    token: &str,
    session_id: &str,
    text: &str,
    user: &str,
    agent: &str,
) -> Result<Value, String> {
    if session_id.trim().is_empty()
        || text.trim().is_empty()
        || user.trim().is_empty()
        || agent.trim().is_empty()
    {
        return Err("probe requires nonempty scoped session, user, agent and text".into());
    }
    let base = base.trim_end_matches('/');
    if !base.starts_with("http://127.0.0.1:") && !base.starts_with("http://localhost:") {
        return Err("probe endpoint must be explicit local loopback".into());
    }
    let common = json!({"user_id":user,"agent_id":agent});
    let add = json!({"user_id":user,"agent_id":agent,"session_id":session_id,
        "messages":[{"role":"user","content":text},{"role":"assistant","content":format!("ack {text}")}]});
    let added = post(&format!("{base}/v2/conversation/add"), &add, token)?;
    let count = added["data"]["accepted_ids"]
        .as_array()
        .map(|a| a.len())
        .unwrap_or(0);
    if added["code"] != 0 || count != 2 {
        return Err(format!("scoped write rejected: {}", added["code"]));
    }
    let search = json!({"user_id":user,"agent_id":agent,"query":text,"limit":5});
    let recalled = post(&format!("{base}/v2/conversation/search"), &search, token)?;
    let rows = recalled["data"]["messages"]
        .as_array()
        .ok_or("scoped recall returned nothing")?;
    if recalled["code"] != 0 || rows.is_empty() {
        return Err("scoped recall returned nothing".into());
    }
    if !rows
        .iter()
        .any(|r| r["content"].as_str().unwrap_or("").contains(text))
    {
        return Err("scoped recall did not contain the written text".into());
    }
    let ids: Vec<String> = rows
        .iter()
        .filter_map(|r| {
            r["id"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        })
        .collect();
    let delete = json!({"user_id":common["user_id"],"agent_id":common["agent_id"],
        "session_ids":[session_id],"message_ids":ids});
    let deleted = post(&format!("{base}/v2/conversation/delete"), &delete, token)?;
    if deleted["code"] != 0 {
        return Err("scoped delete rejected".into());
    }
    let after = post(&format!("{base}/v2/conversation/search"), &search, token)?;
    let remaining = after["data"]["messages"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|r| r["content"].as_str().unwrap_or("").contains(text))
                .count()
        })
        .unwrap_or(0);
    if after["code"] != 0 || remaining != 0 {
        return Err(format!("test record survived deletion: {remaining} hit(s)"));
    }
    Ok(
        json!({"accepted":count,"recalled":rows.len(),"deleted":deleted["data"]["deleted_count"],"remaining":remaining}),
    )
}

/// Removes only the caller's explicit RC `state` subtree; never project root.
pub fn cleanup(state: &Path) -> Result<bool, String> {
    if !state.is_absolute() || state.file_name().and_then(|x| x.to_str()) != Some("state") {
        return Err("refusing to remove a directory that is not an RC state dir".into());
    }
    if !state.exists() {
        return Ok(false);
    }
    let md = fs::symlink_metadata(state).map_err(|e| e.to_string())?;
    if !md.is_dir() || md.file_type().is_symlink() {
        return Err("RC state directory is not a real directory".into());
    }
    fs::remove_dir_all(state).map_err(|e| format!("RC state cleanup failed: {e}"))?;
    Ok(true)
}

pub fn node_defaults(local: &Path) -> Result<Value, String> {
    if !local.is_absolute() {
        return Err("LOCALAPPDATA is required on Windows".into());
    }
    let base = local.join("Singularity");
    Ok(json!({"root":path_text(&base.join("Fleet893P2/memory")),
        "node":path_text(&base.join("Runtime/node/node.exe")),
        "core_dir":path_text(&base.join("runtime/build/MemoryCore")),
        "panel_dir":path_text(&base.join("runtime/build/MemoryPanel"))}))
}

pub fn config_from_cli(args: &[String]) -> Result<(Value, PathBuf), String> {
    if args.len() != 6 && args.len() != 8 {
        return Err(
            "usage: rc-stack config ROOT NODE CORE_DIR PANEL_DIR OUTPUT [CORE_PORT PANEL_PORT]"
                .into(),
        );
    }
    let ports = if args.len() == 8 {
        (
            args[6].parse::<u16>().map_err(|e| e.to_string())?,
            args[7].parse::<u16>().map_err(|e| e.to_string())?,
        )
    } else {
        (CORE_PORT, PANEL_PORT)
    };
    Ok((
        build_config(
            Path::new(&args[1]),
            Path::new(&args[2]),
            Path::new(&args[3]),
            Path::new(&args[4]),
            ports.0,
            ports.1,
            None,
        )?,
        PathBuf::from(&args[5]),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unhealthy_states_fail() {
        assert!(healthy(
            &json!({"code":"RUNNING","processes":[{"health":"ok","ownership":"verified"}]})
        ));
        assert!(!healthy(&json!({"code":"RUNNING","processes":[]})));
        assert!(!healthy(
            &json!({"code":"STOPPED","processes":[{"health":"ok","ownership":"verified"}]})
        ));
    }
    #[test]
    fn config_rejects_unsafe_paths() {
        assert!(build_config(
            Path::new("relative"),
            Path::new("node"),
            Path::new("core"),
            Path::new("panel"),
            CORE_PORT,
            PANEL_PORT,
            None
        )
        .is_err());
        assert!(build_config(
            Path::new("/tmp/rc"),
            Path::new("node"),
            Path::new("core"),
            Path::new("panel"),
            CORE_PORT,
            CORE_PORT,
            None
        )
        .is_err());
    }
    #[test]
    fn no_arbitrary_cleanup() {
        assert!(cleanup(Path::new("relative/state")).is_err());
        assert!(cleanup(Path::new("/tmp/other")).is_err());
    }
}
