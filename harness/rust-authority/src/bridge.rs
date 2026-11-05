//! Typed bridge result classification; source contract kit/lib/bridge-result.mjs.
use regex::Regex;
use serde_json::{json, Value};

pub fn failure_class(rc: i64) -> &'static str {
    match rc {
        0 => "NONE",
        42 => "QUOTA",
        43 => "AUTH",
        44 | 53 => "PROVIDER_DOWN",
        45 => "RATE_LIMIT",
        47 => "MODEL_FAILURE",
        48 => "TOOL_FAILURE",
        49 => "CONFIG_ERROR",
        54 => "SUBMITTED_UNKNOWN",
        _ => "UNKNOWN",
    }
}

pub fn premium_eligible(v: &Value) -> bool {
    let class = match v {
        Value::String(s) => s.as_str(),
        Value::Number(n) => failure_class(n.as_i64().unwrap_or(1)),
        _ => "UNKNOWN",
    };
    matches!(
        class,
        "QUOTA" | "RATE_LIMIT" | "AUTH" | "PROVIDER_DOWN" | "CONTEXT_LIMIT" | "MODEL_FAILURE"
    )
}

fn re_match(pattern: &str, s: &str) -> bool {
    Regex::new(pattern).map(|r| r.is_match(s)).unwrap_or(false)
}

fn truncated(s: &str, length: usize) -> String {
    s.chars().take(length).collect()
}

pub fn classify(input: &Value, engine: &str) -> Value {
    let status = input.get("status").and_then(Value::as_i64);
    let stdout = input.get("stdout").and_then(Value::as_str).unwrap_or("");
    let stderr = input.get("stderr").and_then(Value::as_str).unwrap_or("");
    let text = format!("{stdout}\n{stderr}");
    let error = truncated(&text, 400);
    let timed_out = input
        .get("timedOut")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let signal = input.get("signal").and_then(Value::as_str).unwrap_or("");
    if engine == "openai-sol" {
        if status.is_none() && (timed_out || !signal.is_empty()) {
            return json!({"code":54,"failureClass":"SUBMITTED_UNKNOWN",
                "error":format!("sol bridge killed ({}) — accepted-state unknown; not re-sent",if timed_out {"timeout"} else {signal}),"text":error});
        }
        if let Some((code, class)) = match status {
            Some(44) => Some((44, "PROVIDER_DOWN")),
            Some(45) => Some((45, "ACCOUNT_THROTTLE")),
            Some(53) => Some((53, "GATEWAY_BUSY")),
            Some(54) => Some((54, "SUBMITTED_UNKNOWN")),
            _ => None,
        } {
            return json!({"code":code,"failureClass":class,"error":error});
        }
    }
    let rc = status.unwrap_or(1);
    if rc != 0
        && re_match(
            r"(?i)you'?ve hit your usage limit|usage limit|session limit|rate.?limit.*exhaust|resets? (daily|weekly)|try again at",
            &text,
        )
    {
        let reset = Regex::new(r#"(?i)try again at ([^.\n]+[AP]M|[^\n"]+)"#)
            .ok()
            .and_then(|r| r.captures(&text))
            .and_then(|c| c.get(1).map(|m| m.as_str().trim().to_string()));
        return json!({"code":42,"error":error,"resetAt":reset});
    }
    if re_match(
        r"(?i)invalid api key|unauthorized|authentication|401|api key (missing|not set)",
        &text,
    ) {
        return json!({"code":43,"error":error});
    }
    if rc != 0 && re_match(r"(?i)insufficient credits|402|credit", &text) {
        return json!({"code":42,"error":error});
    }
    if re_match(
        r"(?i)model not found|no such model|provider.*(unavailable|down)|overloaded|at capacity|capacity.*exhausted|5\d\d (from|error)",
        &text,
    ) {
        return json!({"code":44,"error":error});
    }
    if re_match(
        r"(?i)timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|temporary failure|temporarily|HTTP 429|429 too many|too many requests",
        &text,
    ) {
        return json!({"code":45,"error":error});
    }
    if re_match(
        r"(?i)privacy|confidential|not allowed for (personal|confidential)",
        &text,
    ) {
        return json!({"code":46,"error":error});
    }
    if re_match(
        r"(?i)readonly violation|attempted (write|edit)|modified files",
        &text,
    ) {
        return json!({"code":48,"error":error});
    }
    if rc == 49
        && re_match(
            r"(?i)flag|option|config|not supported|unknown command",
            &text,
        )
    {
        return json!({"code":49,"error":error});
    }
    if rc == 47 {
        return json!({"code":47,"error":error});
    }
    if rc == 53 {
        return json!({"code":53,"error":error});
    }
    if rc == 0 {
        return json!({"code":0});
    }
    json!({"code":if rc==124 {45} else {1},"error":error})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn never_retry_unknown_submission() {
        assert!(!premium_eligible(&json!(54)));
        assert!(!premium_eligible(&json!("SUBMITTED_UNKNOWN")));
        assert!(!premium_eligible(&json!("ACCOUNT_THROTTLE")));
        assert_eq!(
            classify(&json!({"status":45}), "openai-sol")["failureClass"],
            "ACCOUNT_THROTTLE"
        );
        assert_eq!(
            classify(&json!({"status":null,"timedOut":true}), "openai-sol")["code"],
            54
        );
    }
}
