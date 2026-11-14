//! Pure read-only Windows CPU history projection.
//!
//! Python owns the authenticated RepoQL process identity, Win32 sampling,
//! per-installation SQLite store and read-only file access. This optional CLI
//! receives only timestamps, CPU percentages and verified sample states.
//! It cannot open, write or select a database or infer an unverified sample.
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{self, Read};

const LIMIT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_ROWS: usize = 20_000;

fn required_i64(object: &serde_json::Map<String, Value>, key: &str) -> Result<i64, &'static str> {
    object
        .get(key)
        .and_then(Value::as_i64)
        .ok_or("INVALID_PARAMETERS")
}

fn precise_sum(values: &[f64]) -> f64 {
    // Error-free partial sums, with the final half-even fix used by fsum.
    let mut partials: Vec<f64> = Vec::new();
    for &value in values {
        let mut x = value;
        let mut kept = 0;
        for i in 0..partials.len() {
            let mut y = partials[i];
            if x.abs() < y.abs() {
                std::mem::swap(&mut x, &mut y);
            }
            let hi = x + y;
            let lo = y - (hi - x);
            if lo != 0.0 {
                partials[kept] = lo;
                kept += 1;
            }
            x = hi;
        }
        partials.truncate(kept);
        partials.push(x);
    }
    let mut hi = partials.pop().unwrap_or(0.0);
    while let Some(x) = partials.pop() {
        let sum = hi + x;
        let lo = x - (sum - hi);
        hi = sum;
        if lo != 0.0 {
            if partials
                .last()
                .is_some_and(|x| x.is_sign_positive() == lo.is_sign_positive())
            {
                let twice = lo * 2.0;
                let corrected = hi + twice;
                if corrected - hi == twice {
                    hi = corrected;
                }
            }
            break;
        }
    }
    hi
}

fn rounded(value: f64) -> f64 {
    // Fixed-decimal formatting rounds the original binary float, like Python round(v, 2).
    // Multiplying by 100 first would produce different ties for values like 2.675.
    format!("{value:.2}").parse::<f64>().unwrap_or(value)
}

fn project(request: &Value) -> Result<Value, &'static str> {
    let obj = request.as_object().ok_or("INVALID_REQUEST")?;
    if obj.len() != 7
        || [
            "period",
            "now",
            "window",
            "bucket",
            "retention_days",
            "sample_interval_seconds",
            "rows",
        ]
        .iter()
        .any(|key| !obj.contains_key(*key))
    {
        return Err("INVALID_REQUEST");
    }
    let period = obj
        .get("period")
        .and_then(Value::as_str)
        .ok_or("INVALID_PERIOD")?;
    if period.is_empty()
        || period.len() > 20
        || !period.is_ascii()
        || period.bytes().any(|b| b < 32)
    {
        return Err("INVALID_PERIOD");
    }
    let now = required_i64(obj, "now")?;
    let window = required_i64(obj, "window")?;
    let bucket = required_i64(obj, "bucket")?;
    let retention = required_i64(obj, "retention_days")?;
    let interval = required_i64(obj, "sample_interval_seconds")?;
    if !(0..=10_000_000_000).contains(&now)
        || !(1..=31_536_000).contains(&window)
        || !(1..=2_592_000).contains(&bucket)
        || !(1..=365).contains(&retention)
        || !(1..=3600).contains(&interval)
    {
        return Err("INVALID_PARAMETERS");
    }
    let rows = obj
        .get("rows")
        .and_then(Value::as_array)
        .ok_or("INVALID_ROWS")?;
    if rows.is_empty() || rows.len() > MAX_ROWS {
        return Err("INVALID_ROWS");
    }
    let mut by_bucket: BTreeMap<i64, Vec<f64>> = BTreeMap::new();
    let mut values: Vec<f64> = Vec::new();
    let mut gaps = 0u64;
    let mut previous: Option<i64> = None;
    let mut last: Option<i64> = None;
    for row in rows {
        let fields = row.as_array().ok_or("INVALID_ROW")?;
        if fields.len() != 3 {
            return Err("INVALID_ROW");
        }
        let ts = fields[0].as_i64().ok_or("INVALID_ROW")?;
        if ts < now - window || ts > now || previous.is_some_and(|old| ts < old) {
            return Err("INVALID_ROW");
        }
        let cpu = if fields[1].is_null() {
            None
        } else {
            Some(
                fields[1]
                    .as_f64()
                    .filter(|v| v.is_finite())
                    .ok_or("INVALID_ROW")?,
            )
        };
        let state = fields[2].as_str().ok_or("INVALID_ROW")?;
        if !matches!(state, "ok" | "unavailable" | "identity_mismatch") {
            return Err("INVALID_ROW");
        }
        if let Some(old) = previous {
            if ts - old > interval.max(1) * 2 {
                gaps += 1;
            }
        }
        previous = Some(ts);
        last = Some(ts);
        let slot = ts.div_euclid(bucket) * bucket;
        let bucket_values = by_bucket.entry(slot).or_default();
        if let ("ok", Some(n)) = (state, cpu) {
            if (0.0..=409600.0).contains(&n) {
                bucket_values.push(n);
                values.push(n);
                continue;
            }
        }
        gaps += 1;
    }
    let series: Vec<Value> = by_bucket
        .into_iter()
        .map(|(ts, values)| {
            if values.is_empty() {
                json!({"ts":ts, "avg":null, "peak":null})
            } else {
                json!({"ts":ts, "avg": rounded(precise_sum(&values) / values.len() as f64),
                   "peak":rounded(values.iter().copied().fold(0.0, f64::max))})
            }
        })
        .collect();
    let last_ts = last.ok_or("INVALID_ROWS")?;
    let last_sample = DateTime::<Utc>::from_timestamp(last_ts, 0)
        .ok_or("INVALID_TIMESTAMP")?
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string();
    let available = !values.is_empty();
    let stats = json!({
        "avg": if available { Some(rounded(precise_sum(&values) / values.len() as f64)) } else { None },
        "peak": if available { Some(rounded(values.iter().copied().fold(0.0, f64::max))) } else { None },
        "samples": values.len(), "gaps":gaps,
        "last_sample":last_sample, "window_seconds":window,
    });
    Ok(json!({
        "available": available, "reason": if available { None } else { Some("native_windows_cpu_history_no_verified_samples") },
        "measurement_source":"rust-win32-process-times", "process_scale":"percent-of-one-core",
        "series":series, "stats":stats, "bucket_seconds":bucket,
        "period":period, "retention_days":retention,
    }))
}

fn main() {
    let mut input = Vec::new();
    let result = match io::stdin().take(LIMIT_BYTES + 1).read_to_end(&mut input) {
        Ok(_) if input.len() as u64 <= LIMIT_BYTES => serde_json::from_slice::<Value>(&input)
            .map_err(|_| "INVALID_JSON")
            .and_then(|v| project(&v)),
        _ => Err("REQUEST_TOO_LARGE"),
    };
    match result {
        Ok(value) => println!("{value}"),
        Err(error) => {
            eprintln!("CPU history projection rejected: {error}");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(rows: Value) -> Value {
        json!({"period":"1h", "now":1793253600i64, "window":3600, "bucket":60,
               "retention_days":30, "sample_interval_seconds":15,"rows":rows})
    }
    #[test]
    fn verified_rows_only_and_gap_accounting() {
        let value = project(&request(json!([
            [1793253500, 30.0, "ok"],
            [1793253520, null, "identity_mismatch"],
            [1793253600, 50.0, "ok"]
        ])))
        .unwrap();
        assert_eq!(value["available"], true);
        assert_eq!(value["stats"]["samples"], 2);
        assert_eq!(value["stats"]["gaps"], 2);
        assert_eq!(value["stats"]["avg"], 40.0);
        assert_eq!(value["stats"]["peak"], 50.0);
        assert_eq!(value["stats"]["last_sample"], "2026-10-29T06:00:00Z");
    }
    #[test]
    fn unverified_never_becomes_zero() {
        let value = project(&request(json!([[1793253590, null, "unavailable"]]))).unwrap();
        assert_eq!(value["available"], false);
        assert!(value["stats"]["avg"].is_null());
        assert_eq!(value["stats"]["samples"], 0);
    }
    #[test]
    fn rejects_paths_and_invalid_rows() {
        let mut req = request(json!([[1793253500, 20, "ok"]]));
        assert!(project(&req).is_ok());
        req["db_path"] = json!("C:\\private\\cpu.db");
        assert!(project(&req).is_err());
        assert!(project(&request(json!([[1793253500, 20, "spoofed"]]))).is_err());
        assert!(project(&request(json!([
            [1793253500, 20, "ok"],
            [1793253499, 20, "ok"]
        ])))
        .is_err());
    }
}
