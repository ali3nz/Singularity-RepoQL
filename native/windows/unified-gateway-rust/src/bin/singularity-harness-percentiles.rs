//! Read-only harness performance percentiles.
//!
//! Python owns authenticated telemetry and SQL reads. This process accepts only
//! bounded numeric completion and model-latency samples, never raw events,
//! credentials, run IDs, file names, agent identities or private logs.
use serde_json::{json, Value};
use std::io::{self, Read};

const MAX_BYTES: u64 = 512 * 1024;
const MAX_SAMPLES: usize = 20_000;
const MAX_ABS: f64 = 1_000_000_000_000.0;
const SCHEMA: &str = "singularity-harness-percentiles/v1";

fn samples(request: &Value, field: &str) -> Result<Vec<f64>, &'static str> {
    let rows = request
        .get(field)
        .and_then(Value::as_array)
        .ok_or("INVALID_SAMPLES")?;
    if rows.len() > MAX_SAMPLES {
        return Err("TOO_MANY_SAMPLES");
    }
    rows.iter()
        .map(|value| {
            let number = value.as_f64().ok_or("INVALID_NUMBER")?;
            if !number.is_finite() || number.abs() > MAX_ABS {
                return Err("INVALID_NUMBER");
            }
            Ok(number)
        })
        .collect()
}

fn percentile(ordered: &[f64], pct: f64) -> Option<f64> {
    if ordered.is_empty() {
        return None;
    }
    if ordered.len() == 1 {
        return Some(ordered[0]);
    }
    let rank = (ordered.len() - 1) as f64 * pct;
    let lower = rank as usize;
    let upper = (lower + 1).min(ordered.len() - 1);
    let weight = rank - lower as f64;
    Some(ordered[lower] * (1.0 - weight) + ordered[upper] * weight)
}

fn project(request: &Value) -> Result<Value, &'static str> {
    let obj = request.as_object().ok_or("INVALID_REQUEST")?;
    if obj.len() != 3
        || obj.get("schema").and_then(Value::as_str) != Some(SCHEMA)
        || !obj.contains_key("completion_ms")
        || !obj.contains_key("model_latency_ms")
    {
        return Err("INVALID_REQUEST");
    }
    let mut complete = samples(request, "completion_ms")?;
    let mut model = samples(request, "model_latency_ms")?;
    if complete.len() + model.len() > MAX_SAMPLES {
        return Err("TOO_MANY_SAMPLES");
    }
    complete.sort_by(f64::total_cmp);
    model.sort_by(f64::total_cmp);
    Ok(json!({
        "completion_ms": {
            "p50": percentile(&complete, 0.5),
            "p95": percentile(&complete, 0.95),
            "p99": percentile(&complete, 0.99),
            "samples": complete.len()
        },
        "model_latency_ms": {
            "p50": percentile(&model, 0.5),
            "p95": percentile(&model, 0.95),
            "samples": model.len()
        }
    }))
}

fn main() {
    let mut input = Vec::new();
    let result = match io::stdin().take(MAX_BYTES + 1).read_to_end(&mut input) {
        Ok(_) if input.len() as u64 <= MAX_BYTES => serde_json::from_slice::<Value>(&input)
            .map_err(|_| "INVALID_JSON")
            .and_then(|value| project(&value)),
        _ => Err("REQUEST_TOO_LARGE"),
    };
    match result {
        Ok(value) => println!("{value}"),
        Err(error) => {
            eprintln!("Harness percentile projection rejected: {error}");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn req(a: Value, b: Value) -> Value {
        json!({"schema":SCHEMA,"completion_ms":a,"model_latency_ms":b})
    }
    #[test]
    fn zero_one_and_multiple_samples() {
        let empty = project(&req(json!([]), json!([]))).unwrap();
        assert_eq!(empty["completion_ms"]["p50"], Value::Null);
        assert_eq!(empty["model_latency_ms"]["samples"], 0);
        let single = project(&req(json!([15]), json!([2]))).unwrap();
        assert_eq!(single["completion_ms"]["p99"], 15.0);
        let many = project(&req(json!([10, 0, 20]), json!([2, 4]))).unwrap();
        assert_eq!(many["completion_ms"]["p50"], 10.0);
        assert_eq!(many["completion_ms"]["p95"], 19.0);
        assert_eq!(many["model_latency_ms"]["p50"], 3.0);
    }
    #[test]
    fn denies_private_and_untrusted_inputs() {
        let mut request = req(json!([0]), json!([1]));
        assert!(project(&request).is_ok());
        request["run_id"] = json!("private");
        assert!(project(&request).is_err());
        assert!(project(&req(json!(["PRIVATE"]), json!([]))).is_err());
        assert!(project(&req(json!([true]), json!([]))).is_err());
        assert!(project(&req(json!([1e13]), json!([]))).is_err());
        assert!(project(&req(json!([0]), json!({"event":"private"}))).is_err());
    }
}
