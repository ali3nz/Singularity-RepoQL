//! Native Windows Ghost control client (complete variants only).
//! Talks to an explicitly configured loopback HTTP Ghost host. The host itself
//! is NOT shipped or installed by this transport. Legacy Unix sockets stay
//! restricted to existing Linux deployment.
use reqwest::blocking::Client;
use reqwest::redirect::Policy;
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::PathBuf;
use std::time::Duration;

const MAX_CONFIG: u64 = 32 * 1024;
const MAX_REQUEST: usize = 131072;
const MAX_REPLY: u64 = 1024 * 1024;
const ALLOWED: &[&str] = &["stop", "set-model", "continue", "remove-queued", "hold", "release", "pause-task", "resume-task", "set-prompt", "revert-prompt", "register-schedule", "update-schedule", "cancel-schedule"];

fn endpoint(raw: &str) -> Result<String, &'static str> {
    let url = reqwest::Url::parse(raw).map_err(|_| "invalid Ghost address")?;
    if url.scheme() != "http" || !matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1" | "[::1]"))
        || url.username() != "" || url.password().is_some()
        || url.query().is_some() || url.fragment().is_some() || url.path() != "/" {
        return Err("Ghost control must use a local HTTP origin");
    }
    Ok(url.origin().ascii_serialization())
}

fn validate(method: &str, body: &Value) -> Result<(), &'static str> {
    if method == "GET" { return Ok(()); }
    if method != "POST" { return Err("invalid Ghost method"); }
    if body.get("confirm").and_then(Value::as_bool) != Some(true) { return Err("confirmation_required"); }
    if !body.get("action").and_then(Value::as_str).is_some_and(|v| ALLOWED.contains(&v)) {
        return Err("unknown_action");
    }
    if !body.get("requestId").and_then(Value::as_str).is_some_and(|v|
        !v.is_empty() && v.len() <= 128 && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')) {
        return Err("invalid_request_id");
    }
    Ok(())
}

fn send(method: &str, body: &Value) -> Result<(u16, Value), &'static str> {
    validate(method, body)?;
    let path = env::var_os("SINGULARITY_GHOST_CONTROL_CONFIG")
        .filter(|v| !v.is_empty()).map(PathBuf::from).ok_or("Ghost control config not set")?;
    if fs::metadata(&path).map_err(|_| "Ghost config unavailable")?.len() > MAX_CONFIG {
        return Err("Ghost config oversized");
    }
    let cfg: Value = serde_json::from_slice(&fs::read(path).map_err(|_| "Ghost config unreadable")?)
        .map_err(|_| "Ghost config malformed")?;
    let base = endpoint(cfg.get("endpoint").and_then(Value::as_str).ok_or("Ghost address absent")?)?;
    let key = cfg.get("controlKey").and_then(Value::as_str)
        .filter(|v| !v.is_empty() && v.len() <= 1024 && !v.chars().any(char::is_control))
        .ok_or("Ghost control key unavailable")?;
    let client = Client::builder().timeout(Duration::from_secs(180)).redirect(Policy::none())
        .no_proxy().build().map_err(|_| "Ghost HTTP client unavailable")?;
    let mut request = if method == "GET" {client.get(format!("{base}/state"))} else {client.post(format!("{base}/action")).json(body)};
    request = request.header("X-Ghost-Control-Key", key);
    let response = request.send().map_err(|_| "Ghost daemon unavailable")?;
    let status = response.status().as_u16();
    let mut bounded = response.take(MAX_REPLY + 1);
    let mut data = Vec::new();
    bounded.read_to_end(&mut data).map_err(|_| "Ghost reply unreadable")?;
    if data.len() as u64 > MAX_REPLY { return Err("Ghost reply oversized"); }
    let payload: Value = serde_json::from_slice(&data).map_err(|_| "Ghost reply malformed")?;
    if !payload.is_object() { return Err("Ghost reply not an object"); }
    Ok((status, payload))
}

pub fn run(method: &str) -> i32 {
    let mut bytes = Vec::new();
    if method == "POST" {
        if io::stdin().lock().take((MAX_REQUEST+1) as u64).read_to_end(&mut bytes).is_err() || bytes.len() > MAX_REQUEST {
            println!("{}", json!({"status":413,"body":{"ok":false,"error":"request_too_large"}}));
            return 2;
        }
    }
    let payload = if method == "POST" {serde_json::from_slice(&bytes).unwrap_or(Value::Null)} else {Value::Null};
    match send(method,&payload) {
        Ok((status,body)) => {println!("{}",json!({"status":status,"body":body}));0},
        Err(_) => {
            println!("{}",json!({"status":503,"body":{"ok":false,"state":"unknown","error":"native_ghost_control_unavailable"}}));
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn loopback_credentialled_ghost_only() {
        assert!(endpoint("http://127.0.0.1:8473").is_ok());
        assert!(endpoint("http://[::1]:8473").is_ok());
        for value in ["https://example.com", "http://127.0.0.1:8000/action", "http://localhost:8000?key=hello", "http://foo@localhost:80/"] {
            assert!(endpoint(value).is_err());
        }
    }
    #[test]
    fn mutating_actions_require_explicit_confirmation_and_id() {
        assert!(validate("POST", &json!({"confirm":true,"action":"set-prompt","requestId":"r_123"})).is_ok());
        assert!(validate("POST", &json!({"confirm":false,"action":"set-prompt","requestId":"r_123"})).is_err());
        assert!(validate("POST", &json!({"confirm":true,"action":"execute-command","requestId":"r_123"})).is_err());
        assert!(validate("POST", &json!({"confirm":true,"action":"hold","requestId":"../bad"})).is_err());
        assert!(validate("GET", &Value::Null).is_ok());
    }
}
