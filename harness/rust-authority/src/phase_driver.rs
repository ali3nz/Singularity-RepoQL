//! Deterministic phase-driver timeout decision from kit/lib/phase-driver.mjs.
//! No driver execution, SSH, clock reads or mutation is possible in this module.
use regex::Regex;
use serde_json::{json, Value};

fn finite(v: &Value) -> Option<f64> {
    v.as_f64().filter(|f| f.is_finite())
}
fn kind(x: &Value) -> &str {
    x.get("kind")
        .and_then(Value::as_str)
        .unwrap_or("line-count")
}
fn checkpoint_value(x: &Value) -> Option<f64> {
    if let Some(v) = x.get("value") {
        finite(v)
    } else {
        finite(x)
    }
}
fn formatted_number(x: &Value) -> String {
    if let Some(v) = x.as_i64() {
        return v.to_string();
    }
    if let Some(v) = x.as_u64() {
        return v.to_string();
    }
    if let Some(v) = x.as_f64() {
        return format!("{v}");
    }
    x.to_string()
}
fn fmt_checkpoint(x: &Value) -> String {
    if x.is_null() {
        return "none".into();
    }
    let value = x.get("value").unwrap_or(x);
    format!("{} {}", kind(x), formatted_number(value))
}
pub fn parse_progress(raw: &Value) -> Value {
    // JavaScript String(raw).match(/\d+/). Null/undefined -> null.
    if raw.is_null() {
        return Value::Null;
    }
    let raw = match raw {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    let re = Regex::new(r"\d+").expect("constant regex");
    match re.find(&raw).and_then(|m| m.as_str().parse::<u64>().ok()) {
        Some(v) if v <= 9_007_199_254_740_991 => json!({"value":v}),
        _ => Value::Null,
    }
}
pub fn compare(a: &Value, b: &Value) -> i8 {
    if a.is_null() || b.is_null() || kind(a) != kind(b) {
        return -1;
    }
    match (checkpoint_value(a), checkpoint_value(b)) {
        (Some(x), Some(y)) if x > y => 1,
        (Some(x), Some(y)) if x == y => 0,
        _ => -1,
    }
}
pub fn evaluate(input: &Value) -> Value {
    let decl = input.get("decl").unwrap_or(&Value::Null);
    if decl
        .get("driver")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .is_none()
    {
        return json!({"granted":false,"reason":"no declared driver"});
    }
    if decl
        .get("progress")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .is_none()
    {
        return json!({"granted":false,"reason":"no progress checkpoint declared"});
    }
    let cap = input.get("maxExtensions").and_then(finite).unwrap_or(3.0);
    let count = input.get("extensionCount").and_then(finite).unwrap_or(0.0);
    if count >= cap {
        return json!({"granted":false,"reason":format!("extension cap {cap} reached")});
    }
    let base = input.get("baseMs").and_then(finite);
    let started = input.get("startedAt").and_then(finite);
    let now = input.get("now").and_then(finite).unwrap_or(0.0);
    let ceiling = input
        .get("wallCeilingFactor")
        .and_then(finite)
        .unwrap_or(4.0);
    if let (Some(base), Some(started)) = (base, started) {
        if now >= started + base * ceiling {
            return json!({"granted":false,"reason":format!("wall-clock ceiling {ceiling}x base timeout reached")});
        }
    }
    let probe = input.get("probe").unwrap_or(&Value::Null);
    if probe.get("alive") != Some(&Value::Bool(true)) {
        let why = probe
            .get("why")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("probe returned no aliveness");
        return json!({"granted":false,"reason":format!("driver not alive ({why})")});
    }
    let raw = input.get("raw").unwrap_or(&Value::Null);
    let parsed = parse_progress(raw);
    if parsed.is_null() {
        return json!({"granted":false,"reason":"progress checkpoint unreadable"});
    }
    let value = json!({"kind":decl.get("progressKind").and_then(Value::as_str).unwrap_or("line-count"),"value":parsed["value"]});
    let prev = input.get("prev").unwrap_or(&Value::Null);
    if !prev.is_null() {
        let c = compare(&value, prev);
        if c == 0 {
            return json!({"granted":false,"reason":format!("progress unchanged ({}) — stalled driver",fmt_checkpoint(&value))});
        }
        if c < 0 {
            return json!({"granted":false,"reason":format!("progress went backwards ({} -> {})",fmt_checkpoint(prev),fmt_checkpoint(&value))});
        }
        return json!({"granted":true,"reason":format!("progress {} -> {}",fmt_checkpoint(prev),fmt_checkpoint(&value)),"value":value});
    }
    json!({"granted":true,"reason":format!("first checkpoint {}",fmt_checkpoint(&value)),"value":value})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn never_extends_without_progress() {
        let decl =
            json!({"driver":"safe-driver","progress":"/tmp/progress","progressKind":"line-count"});
        let x = json!({"decl":decl,"probe":{"alive":true},"raw":"12","prev":{"kind":"line-count","value":12}});
        assert_eq!(evaluate(&x)["granted"], false);
        assert!(evaluate(&x)["reason"]
            .as_str()
            .unwrap_or("")
            .contains("unchanged"));
    }
    #[test]
    fn respects_absolute_ceiling_and_dead_driver() {
        let decl = json!({"driver":"safe-driver","progress":"/tmp/progress"});
        let x = json!({"decl":decl,"probe":{"alive":true},"raw":"12","now":4000,"startedAt":0,"baseMs":1000});
        assert_eq!(evaluate(&x)["granted"], false);
        let x = json!({"decl":decl,"probe":{"alive":false},"raw":"12"});
        assert_eq!(evaluate(&x)["granted"], false);
    }
}
