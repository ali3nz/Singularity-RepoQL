//! Live agent seat state machine over identity-free event positions.
//! Does not read the SQLite database or receive agent/model names, logs or run IDs.
use serde_json::{json, Value};
use std::io::{self, Read};
const SCHEMA: &str = "singularity-harness-agent-seats/v1";
const MAX_BYTES: u64 = 32 * 1024;
const MAX_EVENTS: usize = 200;
const MAX_AGENTS: u64 = 200;
#[derive(Clone)]
struct Seat {
    agent_index: u64,
    model_pos: Option<usize>,
    provider_pos: Option<usize>,
    stage_pos: Option<usize>,
    status_pos: Option<usize>,
    status_error: bool,
    started_pos: Option<usize>,
    last_pos: Option<usize>,
    model_frozen: bool,
    provider_frozen: bool,
    started_frozen: bool,
}
fn boolean(obj: &serde_json::Map<String, Value>, key: &str) -> Result<bool, &'static str> {
    obj.get(key).and_then(Value::as_bool).ok_or("INVALID_EVENT")
}
fn project(request: &Value) -> Result<Value, &'static str> {
    let obj = request.as_object().ok_or("INVALID_REQUEST")?;
    if obj.len() != 3 || obj.get("schema").and_then(Value::as_str) != Some(SCHEMA) {
        return Err("INVALID_REQUEST");
    }
    let count = obj
        .get("agent_count")
        .and_then(Value::as_u64)
        .ok_or("INVALID_COUNT")?;
    if count > MAX_AGENTS {
        return Err("INVALID_COUNT");
    }
    let events = obj
        .get("events")
        .and_then(Value::as_array)
        .ok_or("INVALID_EVENTS")?;
    if events.len() > MAX_EVENTS {
        return Err("TOO_MANY_EVENTS");
    }
    let mut seats: Vec<Seat> = Vec::new();
    for (i, event) in events.iter().enumerate() {
        let e = event.as_object().ok_or("INVALID_EVENT")?;
        if e.len() != 7 {
            return Err("INVALID_EVENT");
        }
        let agent = e
            .get("agent")
            .and_then(Value::as_u64)
            .ok_or("INVALID_AGENT")?;
        if agent >= count {
            return Err("INVALID_AGENT");
        }
        let kind = e
            .get("kind")
            .and_then(Value::as_u64)
            .ok_or("INVALID_KIND")?;
        if kind > 4 {
            return Err("INVALID_KIND");
        }
        let model = boolean(e, "model")?;
        let provider = boolean(e, "provider")?;
        let stage = boolean(e, "stage")?;
        let status = boolean(e, "status")?;
        let ts = boolean(e, "ts")?;
        if kind == 0 {
            continue;
        }
        let index = match seats.iter().position(|seat| seat.agent_index == agent) {
            Some(index) => index,
            None => {
                seats.push(Seat {
                    agent_index: agent,
                    model_pos: None,
                    provider_pos: None,
                    stage_pos: None,
                    status_pos: None,
                    status_error: false,
                    started_pos: None,
                    last_pos: None,
                    model_frozen: false,
                    provider_frozen: false,
                    started_frozen: false,
                });
                seats.len() - 1
            }
        };
        let seat = &mut seats[index];
        if !seat.model_frozen {
            seat.model_pos = Some(i);
            seat.model_frozen = model;
        }
        if !seat.provider_frozen {
            seat.provider_pos = Some(i);
            seat.provider_frozen = provider;
        }
        if stage {
            seat.stage_pos = Some(i);
        }
        if kind == 4 {
            seat.status_error = true;
            seat.status_pos = None;
        } else if status {
            seat.status_error = false;
            seat.status_pos = Some(i);
        }
        if !seat.started_frozen {
            seat.started_pos = Some(i);
            seat.started_frozen = ts;
        }
        seat.last_pos = Some(i);
    }
    Ok(Value::Array(
        seats
            .iter()
            .map(|seat| {
                json!({
                    "agent_index":seat.agent_index,"model_pos":seat.model_pos,
                    "provider_pos":seat.provider_pos,"stage_pos":seat.stage_pos,
                    "status_pos":seat.status_pos,"status_error":seat.status_error,
                    "started_pos":seat.started_pos,"last_pos":seat.last_pos
                })
            })
            .collect(),
    ))
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
            eprintln!("Agent seat projection rejected: {error}");
            std::process::exit(2);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn first_model_latest_status_and_error() {
        let request = json!({"schema":SCHEMA,"agent_count":1,"events":[
            {"agent":0,"kind":1,"model":true,"provider":false,"stage":true,"status":false,"ts":true},
            {"agent":0,"kind":4,"model":true,"provider":true,"stage":false,"status":false,"ts":true},
            {"agent":0,"kind":2,"model":false,"provider":false,"stage":false,"status":true,"ts":true}
        ]});
        let result = project(&request).unwrap();
        assert_eq!(result[0]["model_pos"], 0);
        assert_eq!(result[0]["provider_pos"], 1);
        assert_eq!(result[0]["status_pos"], 2);
        assert_eq!(result[0]["status_error"], false);
        assert_eq!(result[0]["started_pos"], 0);
        assert_eq!(result[0]["last_pos"], 2);
    }
    #[test]
    fn reject_private_data() {
        let mut request = json!({"schema":SCHEMA,"agent_count":1,"events":[]});
        assert!(project(&request).unwrap().as_array().unwrap().is_empty());
        request["run_id"] = json!("private");
        assert!(project(&request).is_err());
        request = json!({"schema":SCHEMA,"agent_count":1,"events":[
            {"agent":0,"kind":1,"model":false,"provider":false,"stage":false,"status":false,"ts":true,"agent_name":"private"}
        ]});
        assert!(project(&request).is_err());
    }
}
