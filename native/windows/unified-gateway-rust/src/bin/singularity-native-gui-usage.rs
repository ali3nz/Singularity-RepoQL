//! Source-isolated, read-only Claude Code GUI receipt projection.
//!
//! Receives only public receipt fields, does not read a host log or contact a
//! provider, and never claims subscription quota or full token history.
use serde_json::{json, Value};
use std::io::{self, Read};

const LIMIT_BYTES: u64 = 2 * 1024 * 1024;
const CLAUDE: &str = "claude-desktop-code";
const NOTE: &str = "Only receipts explicitly attributed to this installation GUI may appear. Recent events are a partial sample, not a full usage history. Subscription plan quotas, allowance balances, and unreported tokens are unknown.";

fn allowed_string(value: Option<&Value>, max: usize) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|s| s.chars().count() <= max)
        .map(str::to_owned)
}

fn count(value: Option<&Value>, max: u64) -> Option<u64> {
    value.and_then(Value::as_u64).filter(|num| *num <= max)
}

fn project(payload: &Value, gui: &str) -> Value {
    if gui != CLAUDE {
        return json!({"available":false,"error":"native_gui_variant_required","native_gui_only":true});
    }
    let mut result = json!({
        "native_gui_only": true, "gui": CLAUDE, "expected_source": CLAUDE,
        "measurement_status": "NO_VERIFIED_GUI_RECEIPTS",
        "input_tokens_recorded": null, "output_tokens_recorded": null,
        "input_token_events": null, "output_token_events": null,
        "allowance": null, "daily": [], "freebuff": null, "recent": [],
        "sources": [], "collected_at": null, "note": NOTE
    });
    if !payload.is_object() || payload.get("available") == Some(&Value::Bool(false)) {
        result["available"] = json!(false);
        result["error"] = json!("unified_usage_upstream_unavailable");
        return result;
    }
    let sources: Vec<Value> = payload
        .get("sources")
        .and_then(Value::as_array)
        .into_iter()
        .flat_map(|rows| rows.iter())
        .filter(|row| row.is_object() && row.get("id").and_then(Value::as_str) == Some(CLAUDE))
        .map(|row| {
            let status = match row.get("status").and_then(Value::as_str) {
                Some("ok") => "ok",
                Some("partial") => "partial",
                Some("unavailable") => "unavailable",
                _ => "unverified",
            };
            json!({"id":CLAUDE,"label":CLAUDE,"status":status,
                   "events":count(row.get("events"),u64::MAX),
                   "latest_at":allowed_string(row.get("latest_at"),40)})
        })
        .collect();
    let recent: Vec<Value> = payload
        .get("recent")
        .and_then(Value::as_array)
        .into_iter()
        .flat_map(|rows| rows.iter())
        .filter(|row| row.is_object() && row.get("source").and_then(Value::as_str) == Some(CLAUDE))
        .take(50)
        .map(|row| {
            json!({
                "source": CLAUDE, "timestamp": allowed_string(row.get("timestamp"),40),
                "model": allowed_string(row.get("model"),128),
                "input_tokens": count(row.get("input_tokens"),1_000_000_000_000_000),
                "output_tokens": count(row.get("output_tokens"),1_000_000_000_000_000)
            })
        })
        .collect();
    let measurement_status = if recent.is_empty() {
        "NO_VERIFIED_GUI_RECEIPTS"
    } else {
        "SAMPLE_ONLY"
    };
    result["available"] = json!(true);
    result["sources"] = json!(sources);
    result["recent"] = json!(recent);
    result["measurement_status"] = json!(measurement_status);
    result["collected_at"] = json!(allowed_string(payload.get("collected_at"), 40));
    result
}

fn process(value: &Value) -> Result<Value, &'static str> {
    let obj = value.as_object().ok_or("INVALID_REQUEST")?;
    if obj.len() != 2 || !obj.contains_key("payload") || !obj.contains_key("gui") {
        return Err("INVALID_REQUEST");
    }
    let gui = obj
        .get("gui")
        .and_then(Value::as_str)
        .ok_or("INVALID_GUI")?;
    Ok(project(&obj["payload"], gui))
}

fn main() {
    let mut input = Vec::new();
    let reply = match io::stdin().take(LIMIT_BYTES + 1).read_to_end(&mut input) {
        Ok(_) if input.len() as u64 <= LIMIT_BYTES => serde_json::from_slice::<Value>(&input)
            .map_err(|_| "INVALID_JSON")
            .and_then(|value| process(&value)),
        _ => Err("REQUEST_TOO_LARGE"),
    };
    match reply {
        Ok(result) => println!("{result}"),
        Err(error) => {
            eprintln!("GUI receipt projection rejected: {error}");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cannot_create_plan_allowance_or_cross_gui_receipts() {
        let got = project(
            &json!({"available":true,"allowance":99,"freebuff":{"token":"secret"},"recent":[
            {"source":"freebuff","input_tokens":500}, {"source":CLAUDE,"input_tokens":3,"output_tokens":5}]}),
            CLAUDE,
        );
        assert_eq!(got["recent"].as_array().unwrap().len(), 1);
        assert!(got["allowance"].is_null());
        assert!(got["freebuff"].is_null());
        assert_eq!(got["measurement_status"], "SAMPLE_ONLY");
        assert!(!got.to_string().contains("secret"));
    }
    #[test]
    fn no_receipts_does_not_mean_zero_usage() {
        let got = project(&json!({"available":true}), CLAUDE);
        assert_eq!(got["measurement_status"], "NO_VERIFIED_GUI_RECEIPTS");
        assert!(got["input_tokens_recorded"].is_null());
    }
    #[test]
    fn malformed_counts_not_accepted() {
        let got = project(
            &json!({"available":true,"recent":[{"source":CLAUDE,
            "input_tokens":true,"output_tokens":-5}]}),
            CLAUDE,
        );
        assert!(got["recent"][0]["input_tokens"].is_null());
        assert!(got["recent"][0]["output_tokens"].is_null());
    }
    #[test]
    fn unavailable_and_unsupported_variants_fail_closed() {
        assert_eq!(
            project(&json!({"available":false}), CLAUDE)["available"],
            false
        );
        assert_eq!(
            project(&json!({"available":true}), "openchamber-desktop")["available"],
            false
        );
    }
}
