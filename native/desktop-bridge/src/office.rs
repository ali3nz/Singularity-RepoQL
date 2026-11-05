//! Privacy-bounded Claude Office event transport for Windows native GUI sessions.
//!
//! Both GUI integration paths invoke this Rust executable directly. OpenCode's
//! mandatory JavaScript plugin surface performs only lightweight event capture;
//! mapping, validation, credentials, and network IO live here.
//!
//! The integration is best-effort: it must never fail a model session and it
//! never forwards prompts, assistant messages, tool arguments/results, or paths.
use chrono::Utc;
use reqwest::blocking::Client;
use reqwest::redirect::Policy;
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::PathBuf;
use std::time::Duration;

const MAX_INPUT_BYTES: usize = 32 * 1024;
const MAX_CONFIG_BYTES: u64 = 32 * 1024;
const MAX_LABEL_CHARS: usize = 64;

fn short_label(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ' '))
        .take(MAX_LABEL_CHARS)
        .collect()
}

fn session_id(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.len() < 3 || trimmed.len() > 128 || !trimmed.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-')) {
        return None;
    }
    Some(trimmed.to_owned())
}

fn project_tail(raw: &str) -> String {
    let tail = raw.trim_end_matches(|c| c == '\\' || c == '/').rsplit(|c| c == '\\' || c == '/').next().unwrap_or("");
    let label = short_label(tail);
    if label.trim().is_empty() { "Desktop project".into() } else { label }
}

fn event_type(kind: &str) -> Option<&'static str> {
    match kind {
        "session-start" => Some("session_start"),
        "session-end" => Some("session_end"),
        "prompt" => Some("user_prompt_submit"),
        "pre-tool" => Some("pre_tool_use"),
        "post-tool" => Some("post_tool_use"),
        "stop" => Some("stop"),
        "subagent-stop" => Some("subagent_stop"),
        "compact" => Some("context_compaction"),
        "error" => Some("error"),
        _ => None,
    }
}

/// Explicitly white-listed event. No serialized source object is ever copied.
fn format_event(source: &str, kind: &str, payload: &Value) -> Option<Value> {
    let name = event_type(kind)?;
    let original_id = session_id(payload.get("session_id")?.as_str()?)?;
    let prefix = match source { "claude" => "cc", "opencode" => "oc", _ => return None };
    let id = format!("{prefix}-{original_id}");
    let display = format!("{} {}", if source == "claude" { "Claude Code" } else { "OpenChamber" },
        &original_id[original_id.len().saturating_sub(8)..]);
    let project = if source == "claude" {
        project_tail(payload.get("cwd").and_then(Value::as_str).unwrap_or(""))
    } else {
        project_tail(payload.get("project_name").and_then(Value::as_str).unwrap_or(""))
    };
    let mut data = json!({
        "agent_id": id,
        "native_agent_id": original_id,
        "display_name": display,
        "project_name": project,
    });
    if kind == "pre-tool" || kind == "post-tool" {
        let tool = short_label(payload.get("tool_name").and_then(Value::as_str).unwrap_or("tool"));
        data["tool_name"] = Value::String(if tool.is_empty() { "tool".into() } else { tool });
        if let Some(tool_id) = payload.get("tool_use_id").and_then(Value::as_str) {
            // Do not pass arbitrary host identifiers or content beyond a safe label.
            data["tool_use_id"] = Value::String(short_label(tool_id));
        }
        if kind == "post-tool" {
            if let Some(success) = payload.get("success").and_then(Value::as_bool) {
                data["success"] = Value::Bool(success);
            }
        }
    }
    if kind == "error" {
        // Never forward exception strings. Static identifier only.
        data["message"] = Value::String("Agent execution failed".into());
    }
    Some(json!({
        "event_type": name,
        "session_id": id,
        "timestamp": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "data": data,
    }))
}

fn endpoint(raw: &str) -> Result<String, &'static str> {
    let value = reqwest::Url::parse(raw).map_err(|_| "invalid local Office URL")?;
    if value.scheme() != "http"
        || !matches!(value.host_str(), Some("127.0.0.1" | "localhost" | "::1" | "[::1]"))
        || value.username() != ""
        || value.password().is_some()
        || value.path() != "/api/v1/events"
        || value.query().is_some()
        || value.fragment().is_some()
    {
        return Err("Claude Office must be a loopback HTTP /api/v1/events URL");
    }
    Ok(value.to_string())
}

/// Reuse the existing Office launch token for native GUI lifecycle events.
/// This is the production-compatible option 2/4 default; never print the URL
/// or put its token in a query string to the local Office backend.
fn launch_token() -> Result<String, &'static str> {
    let public = env::var("CLAUDE_OFFICE_PUBLIC_URL").map_err(|_| "Office public origin missing")?;
    let embed = env::var("SINGULARITY_OFFICE_EMBED_URL")
        .ok().filter(|v| !v.trim().is_empty())
        .or_else(|| env::var("CLAUDE_OFFICE_EMBED_URL").ok())
        .ok_or("Office existing token URL missing")?;
    let public = reqwest::Url::parse(&public).map_err(|_| "invalid Office public origin")?;
    let embed = reqwest::Url::parse(&embed).map_err(|_| "invalid Office launch URL")?;
    if public.scheme() != "https" || embed.scheme() != "https"
        || public.origin() != embed.origin()
        || public.path() != "/" || embed.path() != "/"
        || public.query().is_some() || public.fragment().is_some()
        || embed.fragment().is_some() || !public.username().is_empty()
        || !embed.username().is_empty() || public.password().is_some()
        || embed.password().is_some() {
        return Err("Office launch token origin mismatch");
    }
    let mut token = None;
    let mut embed_flag = false;
    let mut room_seen = false;
    for (key, value) in embed.query_pairs() {
        match key.as_ref() {
            "token" if token.is_none() && !value.is_empty()
                && value.len() <= 4096 && !value.chars().any(|c| c == '\r' || c == '\n') => {
                token = Some(value.into_owned());
            }
            "embed" if !embed_flag && value == "1" => embed_flag = true,
            "room" if !room_seen && (value == "modern" || value == "dm") => room_seen = true,
            _ => return Err("unsupported Office launch parameter"),
        }
    }
    if !embed_flag { return Err("Office embedded launch flag missing"); }
    token.ok_or("Office launch token unavailable")
}

fn office_credentials() -> Result<(String, String), &'static str> {
    // An explicit JSON config is an opt-in alternative for an existing
    // installation. Missing/invalid config is never silently replaced.
    if env::var_os("SINGULARITY_OFFICE_CONFIG").filter(|v| !v.is_empty()).is_some()
        || env::var_os("OFFICE_CONFIG").filter(|v| !v.is_empty()).is_some() {
        return config_credentials();
    }
    let host = env::var("SINGULARITY_OFFICE_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    if !matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1") {
        return Err("Office native backend must be loopback");
    }
    let port = env::var("SINGULARITY_OFFICE_PORT").unwrap_or_else(|_| "8001".into());
    let port = port.parse::<u16>().map_err(|_| "invalid Office native port")?;
    if port == 0 { return Err("invalid Office native port"); }
    let host = if host == "::1" { "[::1]" } else { &host };
    let url = endpoint(&format!("http://{host}:{port}/api/v1/events"))?;
    Ok((url, launch_token()?))
}

fn config_credentials() -> Result<(String, String), &'static str> {
    let file = env::var_os("SINGULARITY_OFFICE_CONFIG")
        .filter(|v| !v.is_empty())
        .or_else(|| env::var_os("OFFICE_CONFIG").filter(|v| !v.is_empty()))
        .map(PathBuf::from)
        .ok_or("Claude Office config path not supplied")?;
    let metadata = fs::metadata(&file).map_err(|_| "cannot stat Office config")?;
    if metadata.len() > MAX_CONFIG_BYTES { return Err("Office config file exceeds size limit"); }
    let raw = fs::read_to_string(&file).map_err(|_| "cannot read Office config")?;
    let config: Value = serde_json::from_str(&raw).map_err(|_| "invalid Office config JSON")?;
    let url = endpoint(config.get("endpoint").and_then(Value::as_str).ok_or("Office URL missing")?)?;
    let key = config.get("ingestKey").and_then(Value::as_str).filter(|k| !k.is_empty() && k.len() <= 1024 && !k.chars().any(|c| c == '\r' || c == '\n'))
        .ok_or("Office ingest key missing or malformed")?;
    Ok((url, key.to_owned()))
}

fn send(event: &Value) -> Result<(), &'static str> {
    let (url, key) = office_credentials()?;
    let client = Client::builder()
        .timeout(Duration::from_millis(1500))
        .redirect(Policy::none())
        .no_proxy()
        .build().map_err(|_| "cannot initialize Office client")?;
    let response = client.post(url)
        .header("X-API-Key", &key)
        .json(event)
        .send().map_err(|_| "Office endpoint unavailable")?;
    if !response.status().is_success() { return Err("Office endpoint rejected event"); }
    Ok(())
}

/// Source-only diagnostic for the Windows installer. Validates the same
/// credential path used by the live event transport, without printing keys,
/// paths or URLs. This is NOT an authenticated HTTP / GUI acceptance test.
pub fn auth_check() -> i32 {
    let source = if env::var_os("SINGULARITY_OFFICE_CONFIG").filter(|v| !v.is_empty()).is_some()
        || env::var_os("OFFICE_CONFIG").filter(|v| !v.is_empty()).is_some() {
        "config_file"
    } else {
        "existing_token_url"
    };
    let ok = office_credentials().is_ok();
    println!("{}", json!({"ok":ok,"credential_source":source,
        "token_exposed":false,"live_office_authenticated":false,
        "real_windows_gui_verified":false}));
    if ok {0} else {2}
}

/// Do not allocate unbounded stdin when model-facing hosts send malformed data.
fn read_input() -> io::Result<Value> {
    let input = io::stdin();
    let mut handle = input.lock().take((MAX_INPUT_BYTES + 1) as u64);
    let mut buffer = Vec::new();
    handle.read_to_end(&mut buffer)?;
    if buffer.len() > MAX_INPUT_BYTES { return Err(io::Error::new(io::ErrorKind::InvalidData, "Office hook input exceeds limit")); }
    serde_json::from_slice(&buffer).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid hook input"))
}

/// Always exit success. An optional visualization must never block the GUI.
pub fn run(source: &str, kind_arg: Option<&str>) {
    let _ = (|| -> Result<(), &'static str> {
        let payload = read_input().map_err(|_| "invalid hook event")?;
        let kind = if source == "claude" {
            kind_arg.ok_or("missing Claude hook kind")?
        } else {
            payload.get("kind").and_then(Value::as_str).ok_or("missing OpenCode event kind")?
        };
        let event = format_event(source, kind, &payload).ok_or("unsupported Office event")?;
        send(&event)
    })();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn office_payload_is_whitelisted_and_does_not_contain_prompts_or_paths() {
        let raw = json!({"session_id":"ses_123456789", "cwd":r"C:\Work\PrivateRepo", "prompt":"TOP_SECRET_PROMPT",
            "tool_input":{"password":"VERY_SECRET"},"tool_name":"Bash", "tool_use_id":"tool-1"});
        let out = format_event("claude", "pre-tool", &raw).unwrap();
        let text = out.to_string();
        assert_eq!(out["session_id"], "cc-ses_123456789");
        assert_eq!(out["data"]["project_name"], "PrivateRepo");
        assert!(!text.contains("TOP_SECRET_PROMPT"));
        assert!(!text.contains("VERY_SECRET"));
        assert!(!text.contains("C:\\Work"));
        assert_eq!(out["event_type"], "pre_tool_use");
    }
    #[test]
    fn office_event_rejects_malformed_identity_and_unknown_types() {
        assert!(format_event("claude", "stop", &json!({"session_id":"../../traversal"})).is_none());
        assert!(format_event("opencode", "unknown", &json!({"session_id":"ses_123"})).is_none());
        assert!(format_event("opencode", "session-start", &json!({"session_id":"ses_123", "prompt":"NO_FORWARD"})).is_some());
    }
    #[test]
    fn office_launch_url_reuses_proven_token_without_remote_query() {
        { std::env::set_var("CLAUDE_OFFICE_PUBLIC_URL", "https://office.example.test");
                 std::env::set_var("CLAUDE_OFFICE_EMBED_URL", "https://office.example.test/?token=test-native-token&embed=1&room=modern"); }
        assert_eq!(launch_token().unwrap(), "test-native-token");
        { std::env::set_var("CLAUDE_OFFICE_EMBED_URL", "https://other.example.test/?token=test-native-token&embed=1"); }
        assert!(launch_token().is_err());
        { std::env::remove_var("CLAUDE_OFFICE_PUBLIC_URL");
                 std::env::remove_var("CLAUDE_OFFICE_EMBED_URL"); }
    }
    #[test]
    fn office_endpoint_does_not_permit_remote_or_redirect_targets() {
        assert!(endpoint("http://127.0.0.1:8000/api/v1/events").is_ok());
        assert!(endpoint("http://localhost:8000/api/v1/events").is_ok());
        assert!(endpoint("http://[::1]:8000/api/v1/events").is_ok());
        for bad in ["http://example.com/api/v1/events", "http://127.0.0.1:8000/admin", "http://localhost:8000/api/v1/events?key=x", "http://u:p@localhost:8000/api/v1/events"] {
            assert!(endpoint(bad).is_err(), "accepted {bad}");
        }
    }
}
