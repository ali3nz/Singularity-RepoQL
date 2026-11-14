//! Bounded, read-only numeric summary of harness usage receipts.
//!
//! Python retains authenticated SQLite reads and actual provider cost accounting.
//! The Rust child sees only numeric counts and cannot access model names, run
//! identities, subscription receipts, costs, prompts or on-disk ledgers.
use serde_json::{json, Value};
use std::io::{self, Read};

const MAX_BYTES: u64 = 64 * 1024;
const MAX_ROWS: usize = 500;
const MAX_COUNT: u64 = 1_000_000_000_000;
const SCHEMA: &str = "singularity-harness-usage-counts/v1";

fn bounded_count(value: &Value) -> Result<u64, &'static str> {
    match value.as_u64() {
        Some(n) if n <= MAX_COUNT => Ok(n),
        _ => Err("INVALID_COUNT"),
    }
}

fn project(request: &Value) -> Result<Value, &'static str> {
    let object = request.as_object().ok_or("INVALID_REQUEST")?;
    if object.len() != 3
        || object.get("schema").and_then(Value::as_str) != Some(SCHEMA)
        || !object.contains_key("rows")
        || !object.contains_key("completed")
    {
        return Err("INVALID_REQUEST");
    }
    let completed = bounded_count(&request["completed"])?;
    let rows = request["rows"].as_array().ok_or("INVALID_ROWS")?;
    if rows.len() > MAX_ROWS {
        return Err("TOO_MANY_ROWS");
    }
    let mut missing_input = 0u64;
    let mut missing_output = 0u64;
    let mut paid_calls = 0u64;
    for raw in rows {
        let row = raw.as_array().ok_or("INVALID_ROW")?;
        if row.len() != 4 {
            return Err("INVALID_ROW");
        }
        let calls = bounded_count(&row[0])?;
        let in_samples = bounded_count(&row[1])?;
        let out_samples = bounded_count(&row[2])?;
        let paid = bounded_count(&row[3])?;
        if in_samples > calls || out_samples > calls || paid > calls {
            return Err("INCONSISTENT_RECEIPT_COUNTS");
        }
        missing_input += calls - in_samples;
        missing_output += calls - out_samples;
        paid_calls += paid;
    }
    Ok(json!({
        "calls_without_input_tokens": missing_input,
        "calls_without_output_tokens": missing_output,
        "paid_calls": paid_calls,
        "completed_tasks": completed
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
            eprintln!("Harness usage projection rejected: {error}");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn req(rows: Value) -> Value {
        json!({"schema":SCHEMA,"rows":rows,"completed":4})
    }
    #[test]
    fn empty_and_sampled_counts() {
        let empty = project(&req(json!([]))).unwrap();
        assert_eq!(empty["paid_calls"], 0);
        assert_eq!(empty["completed_tasks"], 4);
        let got = project(&req(json!([[6, 4, 1, 2], [1, 0, 1, 0]]))).unwrap();
        assert_eq!(got["calls_without_input_tokens"], 3);
        assert_eq!(got["calls_without_output_tokens"], 5);
        assert_eq!(got["paid_calls"], 2);
    }
    #[test]
    fn rejects_private_and_forged_rows() {
        let mut request = req(json!([[1, 1, 1, 1]]));
        assert!(project(&request).is_ok());
        request["apiKey"] = json!("PRIVATE");
        assert!(project(&request).is_err());
        assert!(project(&req(json!([[1, 2, 1, 1]]))).is_err());
        assert!(project(&req(json!([[1, true, 1, 1]]))).is_err());
        assert!(project(&req(json!([[1, 1, 1, "PRIVATE"]]))).is_err());
        assert!(project(&req(json!([[1, 1, 1, 1, 0]]))).is_err());
    }
}
