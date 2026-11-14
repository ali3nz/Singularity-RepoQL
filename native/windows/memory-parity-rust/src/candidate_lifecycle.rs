//! Candidate lifecycle and TTL eligibility from memory-candidate-v2.mjs.
//! The caller supplies timestamps; this module never promotes records or
//! writes memory authority state. Errors are policy decisions, not transport failures.
use crate::candidate_policy;
use chrono::{DateTime, NaiveDate, Utc};
use serde_json::{json, Map, Value};

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        _ => true,
    }
}

fn js_string(value: Option<&Value>, fallback: &str) -> String {
    match value {
        None | Some(Value::Null) => fallback.to_owned(),
        Some(Value::String(s)) => s.clone(),
        Some(v) => v.to_string(),
    }
}

fn result_with(candidate: &Value, status: &str, state: &str) -> Map<String, Value> {
    let mut out = candidate.as_object().cloned().unwrap_or_default();
    out.insert("maturityState".to_owned(), json!(state));
    out.insert("status".to_owned(), json!(status));
    out
}

pub fn transition(input: &Value) -> Value {
    let cand = input.get("candidate").unwrap_or(&Value::Null);
    let from = js_string(cand.get("maturityState"), "OBSERVATION");
    let to = if input.get("toState") == Some(&Value::Null) {
        "null".to_owned()
    } else {
        js_string(input.get("toState"), "undefined")
    };
    let reject = |reason: String| json!({"ok":true,"accepted":false,"reason":reason});
    match to.as_str() {
        "CANDIDATE" => {
            if from != "OBSERVATION" {
                return reject(format!("lifecycle: {from}->CANDIDATE not allowed"));
            }
            if !candidate_policy::anchored_provenance(cand) {
                return reject(
                    "lifecycle: OBSERVATION->CANDIDATE requires anchored provenance".to_owned(),
                );
            }
            json!({"ok":true,"accepted":true,"candidate":result_with(cand,"candidate","CANDIDATE")})
        }
        "VERIFIED" => {
            if from != "CANDIDATE" {
                return reject(format!(
                    "lifecycle: {from}->VERIFIED not allowed (must pass through CANDIDATE)"
                ));
            }
            if !candidate_policy::anchored_provenance(cand) {
                return reject(
                    "lifecycle: CANDIDATE->VERIFIED requires anchored provenance".to_owned(),
                );
            }
            let requested = input.get("verification").filter(|v| !v.is_null());
            let saved = cand.get("verification");
            if !truthy(requested) && !truthy(saved) {
                return reject(
                    "lifecycle: CANDIDATE->VERIFIED requires a verification anchor".to_owned(),
                );
            }
            let mut out = result_with(cand, "verified", "VERIFIED");
            out.insert(
                "verification".to_owned(),
                requested.or(saved).cloned().unwrap_or(Value::Null),
            );
            json!({"ok":true,"accepted":true,"candidate":out})
        }
        "EXPIRED" | "SUPERSEDED" | "INVALIDATED" => {
            if from != "VERIFIED" && from != "CANDIDATE" {
                return reject(format!("lifecycle: {from}->{to} not allowed"));
            }
            // JS generates new Date().toISOString() for terminal transitions;
            // supply it from the trusted caller to retain timing semantics.
            let Some(closed_at) = input.get("closedAt").and_then(Value::as_str) else {
                return json!({"ok":false,"code":"MISSING_CLOSED_AT"});
            };
            if DateTime::parse_from_rfc3339(closed_at).is_err() {
                return json!({"ok":false,"code":"INVALID_CLOSED_AT"});
            }
            let mut out = result_with(cand, &to.to_ascii_lowercase(), &to);
            out.insert("lifecycleClosedAt".to_owned(), json!(closed_at));
            json!({"ok":true,"accepted":true,"candidate":out})
        }
        _ => reject(format!("lifecycle: unknown target state {to}")),
    }
}

fn parsed_date(value: &str) -> Option<DateTime<Utc>> {
    if let Ok(t) = DateTime::parse_from_rfc3339(value) {
        return Some(t.with_timezone(&Utc));
    }
    // Date.parse supports date-only ISO input used by existing legacy records.
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map(|d| d.and_utc())
}

pub fn ttl(input: &Value) -> Value {
    let cand = input.get("candidate").unwrap_or(&Value::Null);
    let ttl = cand.get("ttlDays").filter(|v| !v.is_null());
    if ttl.is_none() {
        return json!({"ok":true,"due":false,"reason":"no ttl"});
    }
    let state = js_string(cand.get("maturityState"), "undefined");
    if state != "VERIFIED" {
        return json!({"ok":true,"due":false,"reason":format!("state {state} is not TTL-managed")});
    }
    let base = ["verifiedAt", "promotedAt", "observedAt"]
        .iter()
        .find_map(|k| cand.get(*k).filter(|v| truthy(Some(v))));
    let Some(base) = base else {
        return json!({"ok":true,"due":true,"reason":"VERIFIED with ttlDays but no verifiable timestamp"});
    };
    let Some(stamp) = parsed_date(&js_string(Some(base), "")) else {
        return json!({"ok":true,"due":true,"reason":"unparseable timestamp"});
    };
    let Some(now) = input
        .get("now")
        .and_then(Value::as_str)
        .and_then(parsed_date)
    else {
        return json!({"ok":false,"code":"INVALID_NOW"});
    };
    let age_days = (now.timestamp_millis() - stamp.timestamp_millis()) as f64 / 86_400_000.0;
    let ttl_number = match ttl {
        Some(Value::Number(v)) => v.as_f64(),
        Some(Value::String(v)) => v.parse::<f64>().ok(),
        Some(Value::Bool(v)) => Some(if *v { 1.0 } else { 0.0 }),
        _ => None,
    };
    let days = age_days.floor() as i64;
    let shown = js_string(ttl, "null");
    let due = ttl_number.is_some_and(|t| age_days > t);
    json!({"ok":true,"due":due,"reason":format!("age {days}d {} ttl {shown}d",if due {">"}else{"<="})})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn promotion_requires_independent_governance_path() {
        let input = json!({"candidate":{"maturityState":"CANDIDATE","provenance":[{"kind":"live-evidence","uri":"file:///one"}]},"toState":"VERIFIED","verification":"test receipt"});
        let result = transition(&input);
        assert_eq!(result["accepted"], true);
        assert_eq!(result["candidate"]["maturityState"], "VERIFIED");
        let no_anchor = json!({"candidate":{"maturityState":"CANDIDATE","provenance":[]},"toState":"VERIFIED","verification":"receipt"});
        assert_eq!(transition(&no_anchor)["accepted"], false);
    }
    #[test]
    fn ttl_is_readonly_with_explicit_time() {
        let input = json!({"candidate":{"maturityState":"VERIFIED","ttlDays":3,"verifiedAt":"2026-11-01T00:00:00Z"},"now":"2026-11-05T00:00:00Z"});
        assert_eq!(ttl(&input)["due"], true);
        assert_eq!(ttl(&input)["reason"], "age 4d > ttl 3d");
    }
}
