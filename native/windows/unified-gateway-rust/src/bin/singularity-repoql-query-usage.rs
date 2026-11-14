//! Read-only RepoQL query receipt window attribution.
//!
//! Python validates the authoritative private receipt file, rejects unsafe
//! paths and rows, deduplicates invocation ids, and filters dashboard polls.
//! Rust sees only a numeric repository count and validated (timestamp, index[])
//! entries. No repository names/paths, invocation IDs, agents or credentials.
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::io::{self, Read};

const MAX_BYTES: u64 = 16 * 1024 * 1024;
const MAX_EVENTS: usize = 200_000;
const MAX_REPOS: usize = 4096;
const WINDOW_SECS: [f64; 3] = [86_400.0, 604_800.0, 2_592_000.0];

fn project(request: &Value) -> Result<Value, &'static str> {
    let object = request.as_object().ok_or("INVALID_REQUEST")?;
    if object.len() != 3
        || ["now", "root_count", "events"]
            .iter()
            .any(|key| !object.contains_key(*key))
    {
        return Err("INVALID_REQUEST");
    }
    let now = request["now"]
        .as_f64()
        .filter(|v| v.is_finite() && *v >= 0.0 && *v <= 253_402_300_799.0)
        .ok_or("INVALID_CLOCK")?;
    let roots = request["root_count"].as_u64().ok_or("INVALID_REPO_COUNT")? as usize;
    if roots > MAX_REPOS {
        return Err("INVALID_REPO_COUNT");
    }
    let events = request["events"].as_array().ok_or("INVALID_EVENTS")?;
    if events.len() > MAX_EVENTS {
        return Err("INVALID_EVENTS");
    }
    let mut calls = [0u64; 3];
    let mut unattributed = [0u64; 3];
    let mut by_repo = vec![[0u64; 3]; roots];
    let mut earliest: Option<f64> = None;
    let mut latest: Option<f64> = None;
    for event in events {
        let row = event.as_array().ok_or("INVALID_EVENT")?;
        if row.len() != 2 {
            return Err("INVALID_EVENT");
        }
        let ts = row[0]
            .as_f64()
            .filter(|v| v.is_finite() && *v >= 0.0 && *v <= now + 300.0)
            .ok_or("INVALID_TIMESTAMP")?;
        let indexes = row[1].as_array().ok_or("INVALID_INDICES")?;
        if indexes.len() > 100 {
            return Err("INVALID_INDICES");
        }
        let mut touched = BTreeSet::new();
        for raw in indexes {
            let idx = raw.as_u64().ok_or("INVALID_INDEX")?;
            if idx >= roots as u64 || !touched.insert(idx as usize) {
                return Err("INVALID_INDEX");
            }
        }
        earliest = Some(earliest.map_or(ts, |value| value.min(ts)));
        latest = Some(latest.map_or(ts, |value| value.max(ts)));
        for (i, window) in WINDOW_SECS.iter().enumerate() {
            if now - window <= ts && ts <= now {
                calls[i] += 1;
                if touched.is_empty() {
                    unattributed[i] += 1;
                }
                for idx in &touched {
                    by_repo[*idx][i] += 1;
                }
            }
        }
    }
    let repositories: Vec<Value> = by_repo
        .iter()
        .map(|counts| json!({"1d":counts[0], "7d":counts[1], "30d":counts[2]}))
        .collect();
    Ok(json!({
        "calls":{"1d":calls[0],"7d":calls[1],"30d":calls[2]},
        "unattributed":{"1d":unattributed[0],"7d":unattributed[1],"30d":unattributed[2]},
        "repositories":repositories,"accepted_events":events.len(),
        "earliest":earliest,"latest":latest
    }))
}

fn main() {
    let mut input = Vec::new();
    let result = match io::stdin().take(MAX_BYTES + 1).read_to_end(&mut input) {
        Ok(_) if input.len() as u64 <= MAX_BYTES => serde_json::from_slice::<Value>(&input)
            .map_err(|_| "INVALID_JSON")
            .and_then(|v| project(&v)),
        _ => Err("REQUEST_TOO_LARGE"),
    };
    match result {
        Ok(value) => println!("{value}"),
        Err(error) => {
            eprintln!("RepoQL query usage rejected: {error}");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn multi_repository_call_counted_once_and_touched_each() {
        let got = project(&json!({"now":1_000_000.0,"root_count":2,"events":[
            [1_000_000.0,[0,1]], [999_999.0,[1]], [999_900.0,[]]
        ]}))
        .unwrap();
        assert_eq!(got["calls"]["1d"], 3);
        assert_eq!(got["repositories"][0]["1d"], 1);
        assert_eq!(got["repositories"][1]["1d"], 2);
        assert_eq!(got["unattributed"]["1d"], 1);
        assert_eq!(got["accepted_events"], 3);
    }
    #[test]
    fn future_and_old_events_not_in_windows_but_still_observed() {
        let got = project(&json!({"now":6_000_000.0,"root_count":1,"events":[
            [6_000_010.0,[0]], [100.0,[0]]
        ]}))
        .unwrap();
        assert_eq!(got["accepted_events"], 2);
        assert_eq!(got["calls"]["30d"], 0);
        assert_eq!(got["earliest"], 100.0);
    }
    #[test]
    fn rejects_private_metadata_and_forged_index() {
        let mut request = json!({"now":1_000_000.0,"root_count":1,"events":[[999_999.0,[0]]]});
        assert!(project(&request).is_ok());
        request["repo_roots"] = json!(["C:/private"]);
        assert!(project(&request).is_err());
        assert!(
            project(&json!({"now":1_000_000.0,"root_count":1,"events":[[999_999.0,[2]]]})).is_err()
        );
        assert!(
            project(&json!({"now":1_000_000.0,"root_count":1,"events":[[999_999.0,[0,0]]]}))
                .is_err()
        );
    }
}
