//! Pure Claude Code memory capture preparation.
//!
//! The caller owns identity resolution, transcript access, task authorization,
//! MemoryCore I/O and readback. These helpers never access the filesystem,
//! network, credentials, clock, or process environment.
use regex::{Captures, Regex};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

fn pattern_sk() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?-u:\b)sk-[A-Za-z0-9][A-Za-z0-9_-]{8,}(?-u:\b)").expect("sk shape")
    })
}
fn pattern_github() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?-u:\b)(?:ghp|gho|github_pat)_[A-Za-z0-9_]{10,}(?-u:\b)")
            .expect("github shape")
    })
}
fn pattern_aws() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?-u:\b)AKIA[A-Z0-9]{12,}(?-u:\b)").expect("aws shape"))
}
fn pattern_key() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r#"(?i)(?-u:\b)(?:api[_-]?key|token|secret|password)(?-u:\b)(\s*[:=]\s*)"?[A-Za-z0-9_./+=-]{8,}"?"#,
        )
        .expect("key assignment shape")
    })
}

/// Mirror the ordered, shape-based redactions in memory-hook.mjs.
/// This is deliberately not a general-purpose secret scanner.
pub fn redact(input: &str) -> String {
    let step1 = pattern_sk().replace_all(input, "[REDACTED]");
    let step2 = pattern_github().replace_all(&step1, "[REDACTED]");
    let step3 = pattern_aws().replace_all(&step2, "[REDACTED]");
    pattern_key()
        .replace_all(&step3, |capture: &Captures<'_>| {
            format!("key{}[REDACTED]", &capture[1])
        })
        .into_owned()
}

pub fn redact_request(request: &Value) -> Value {
    match request.get("text").and_then(Value::as_str) {
        Some(text) if text.len() <= 128 * 1024 => json!({"ok":true,"text":redact(text)}),
        _ => json!({"ok":false,"code":"INVALID_HOOK_TEXT"}),
    }
}

fn sha_prefix(text: &[u8], count: usize) -> String {
    let output = Sha256::digest(text);
    let mut hex = String::with_capacity(count);
    for byte in output.iter().take(count.div_ceil(2)) {
        use std::fmt::Write;
        write!(&mut hex, "{byte:02x}").expect("in-memory hex");
    }
    hex.truncate(count);
    hex
}

/// Input parts are an already-normalized array from the trusted caller.
/// No task or role authority comes from this hash.
pub fn capture_id_request(request: &Value) -> Value {
    let Some(parts) = request.get("parts").and_then(Value::as_array) else {
        return json!({"ok":false,"code":"INVALID_CAPTURE_PARTS"});
    };
    let Some(session_key) = request.get("sessionKey").and_then(Value::as_str) else {
        return json!({"ok":false,"code":"INVALID_SESSION_KEY"});
    };
    if parts.len() != 3 || parts.iter().any(|v| !v.is_string()) || session_key.len() > 16 * 1024 {
        return json!({"ok":false,"code":"INVALID_CAPTURE_PARTS"});
    }
    let Ok(body) = serde_json::to_string(parts) else {
        return json!({"ok":false,"code":"INVALID_CAPTURE_PARTS"});
    };
    if body.len() > 128 * 1024 {
        return json!({"ok":false,"code":"CAPTURE_PARTS_TOO_LARGE"});
    }
    json!({
        "ok":true,
        "taskId":format!("cc-{}", sha_prefix(body.as_bytes(), 16)),
        "sessionHash8":sha_prefix(session_key.as_bytes(), 8),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn known_secret_shapes_are_redacted_without_exposing_original() {
        let result = redact(
            "ghp_abcdefghijklmnopqrstuvwxyz sk-abcdefgh1234 password=some-long-password-1234",
        );
        assert!(!result.contains("ghp_"));
        assert!(!result.contains("sk-abcdefgh1234"));
        assert!(!result.contains("some-long-password"));
        assert!(result.contains("[REDACTED]"));
    }
    #[test]
    fn identity_is_deterministic_and_bounded() {
        let input = json!({"sessionKey":"alpha","parts":["alpha","user","assistant"]});
        let a = capture_id_request(&input);
        assert_eq!(a, capture_id_request(&input));
    }
    #[test]
    fn rejects_invalid_request_shapes() {
        assert_eq!(
            capture_id_request(&json!({"parts":[1,2,3],"sessionKey":"a"}))["ok"],
            false
        );
        assert_eq!(redact_request(&json!({"text":27}))["ok"], false);
    }
}
