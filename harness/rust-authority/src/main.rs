mod authority;
mod bridge;
mod case_store;
mod compat;
mod coordinator;
mod deviation;
mod doc_impact;
mod effort;
mod engine_router;
mod engine_state;
mod gate;
mod nanny_observe;
mod no_change;
mod payload;
mod phase_driver;
mod resource_lease;
mod run_state;
mod run_summary;
mod scope;
mod state_cli;
mod store;
mod worker;

use chrono::{Duration as ChronoDuration, Utc};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::env;
use std::io::{BufRead, Read};
use std::path::PathBuf;
use std::time::Duration;
use store::Store;
use tiny_http::{Header, Method, Response, Server, StatusCode};

const HTML: &str = include_str!("../assets/index.html");

fn percentile(values: &mut [u64], rank: f64) -> Option<u64> {
    if values.is_empty() {
        return None;
    }
    values.sort_unstable();
    let index = ((values.len() as f64 * rank).ceil() as usize).saturating_sub(1);
    values.get(index).copied()
}

fn summary(store: &Store, hours: i64) -> Value {
    // Only attempt events contribute to model latency or model success statistics.
    // Run lifecycle is separate and may be absent in an uninstrumented session.
    let hours = hours.clamp(1, 24 * 14);
    let rows = store.read_since(Utc::now() - ChronoDuration::hours(hours), 200_000);
    let mut runs = HashSet::new();
    let mut terminal: HashMap<String, String> = HashMap::new();
    let mut by_engine: BTreeMap<String, u64> = BTreeMap::new();
    let (
        mut successes,
        mut failures,
        mut unknown_outcomes,
        mut durations,
        mut input_tokens,
        mut output_tokens,
    ) = (0u64, 0u64, 0u64, Vec::new(), 0u64, 0u64);
    let (mut cost_reported, mut cost_estimated) = (0f64, 0f64);
    let (mut has_reported, mut has_estimated) = (false, false);
    for row in &rows {
        if let Some(run) = row.get("runId").and_then(Value::as_str) {
            runs.insert(run.to_owned());
            match row.get("kind").and_then(Value::as_str).unwrap_or("") {
                "run_completed" => {
                    terminal.insert(run.into(), "completed".into());
                }
                "run_failed" => {
                    terminal.insert(run.into(), "failed".into());
                }
                "run_cancelled" => {
                    terminal.insert(run.into(), "cancelled".into());
                }
                "run_started" => {
                    terminal.remove(run);
                }
                _ => {}
            }
        }
        if row.get("kind").and_then(Value::as_str) != Some("model_invocation") {
            continue;
        }
        let engine = row
            .get("engine")
            .and_then(Value::as_str)
            .unwrap_or("not provided");
        *by_engine.entry(engine.into()).or_default() += 1;
        if row.get("success") == Some(&Value::Bool(true)) {
            successes += 1;
        }
        if row.get("success") == Some(&Value::Bool(false)) {
            failures += 1;
        }
        if !matches!(row.get("success"), Some(Value::Bool(_))) {
            unknown_outcomes += 1;
        }
        if let Some(ms) = row.get("durationMs").and_then(Value::as_u64) {
            durations.push(ms);
        }
        input_tokens = input_tokens
            .saturating_add(row.get("inputTokens").and_then(Value::as_u64).unwrap_or(0));
        output_tokens = output_tokens
            .saturating_add(row.get("outputTokens").and_then(Value::as_u64).unwrap_or(0));
        if let Some(cost) = row.get("costUsd").and_then(Value::as_f64) {
            if cost.is_finite() && cost >= 0.0 {
                match row.get("costSource").and_then(Value::as_str) {
                    Some("provider_reported") => {
                        cost_reported += cost;
                        has_reported = true;
                    }
                    Some("estimated") => {
                        cost_estimated += cost;
                        has_estimated = true;
                    }
                    _ => {}
                }
            }
        }
    }
    let mut p50 = durations.clone();
    let mut p95 = durations.clone();
    let mut p99 = durations;
    let terminal_count = terminal.len();
    json!({
        "windowHours": hours,
        "events": rows.len(),
        "eventsMayBeTruncated": rows.len() == 200_000,
        "distinctRunsObserved": runs.len(),
        "terminalRunsObserved": terminal_count,
        "runCompletionDataAvailable": !terminal.is_empty(),
        "modelAttemptsSuccess": successes,
        "modelAttemptsFailure": failures,
        "modelAttemptsOutcomeUnknown": unknown_outcomes,
        "modelLatencyP50Ms": percentile(&mut p50, 0.50),
        "modelLatencyP95Ms": percentile(&mut p95, 0.95),
        "modelLatencyP99Ms": percentile(&mut p99, 0.99),
        "latencySamples": p50.len(),
        "tokensInputRecorded": input_tokens,
        "tokensOutputRecorded": output_tokens,
        "providerReportedCostUsd": if has_reported {Some(cost_reported)} else {None},
        "estimatedCostUsd": if has_estimated {Some(cost_estimated)} else {None},
        "byEngine": by_engine,
        "storage": store.status(),
        "dataSource": "locally collected allowlisted events",
        "disclaimer": "Observer only; attempts are not completed tasks; source event coverage may be incomplete"
    })
}

fn json_response(value: Value, status: u16) -> Response<std::io::Cursor<Vec<u8>>> {
    let mut response = Response::from_data(serde_json::to_vec(&value).unwrap_or_default())
        .with_status_code(StatusCode(status));
    response
        .add_header(Header::from_bytes("Content-Type", "application/json; charset=utf-8").unwrap());
    response.add_header(Header::from_bytes("Cache-Control", "no-store").unwrap());
    response
}

fn serve(store: Store, address: &str) -> Result<(), String> {
    // Intentionally loopback only. Integration through existing authenticated RepoQL proxy is future work.
    if !address.starts_with("127.0.0.1:") && !address.starts_with("[::1]:") {
        return Err(
            "refusing non-loopback listener; integrate behind existing authenticated UI".into(),
        );
    }
    let server = Server::http(address).map_err(|e| e.to_string())?;
    eprintln!("Observer prototype listening at http://{address}; not installed in RepoQL");
    let token = env::var("ORCHESTRA_OBSERVER_INGEST_TOKEN")
        .ok()
        .filter(|s| !s.is_empty());
    loop {
        let mut req = match server.recv_timeout(Duration::from_secs(1)) {
            Ok(Some(req)) => req,
            Ok(None) => continue,
            Err(e) => return Err(e.to_string()),
        };
        let url = req.url().split('?').next().unwrap_or("");
        match (req.method(), url) {
            (&Method::Get, "/") => {
                let mut response = Response::from_string(HTML);
                response.add_header(
                    Header::from_bytes("Content-Type", "text/html; charset=utf-8").unwrap(),
                );
                response.add_header(Header::from_bytes("Cache-Control", "no-store").unwrap());
                let _ = req.respond(response);
            }
            (&Method::Get, "/api/summary") => {
                let _ = req.respond(json_response(summary(&store, 24), 200));
            }
            (&Method::Get, "/api/recent") => {
                let rows = store.read_since(Utc::now() - ChronoDuration::hours(24), 100);
                let _ = req.respond(json_response(json!({"events": rows}), 200));
            }
            (&Method::Post, "/api/events") => {
                let authorized = token.as_ref().is_some_and(|secret| {
                    req.headers().iter().any(|h| {
                        h.field.equiv("Authorization")
                            && h.value.as_str() == format!("Bearer {secret}")
                    })
                });
                if !authorized {
                    let _ =
                        req.respond(json_response(json!({"error":"ingest token required"}), 403));
                    continue;
                }
                let mut bytes = Vec::new();
                let read_result = req
                    .as_reader()
                    .take((store::MAX_EVENT_BYTES + 1024) as u64)
                    .read_to_end(&mut bytes);
                if read_result.is_err() || bytes.len() > store::MAX_EVENT_BYTES {
                    let _ = req.respond(json_response(json!({"error":"payload too large"}), 413));
                    continue;
                }
                let result = serde_json::from_slice::<Value>(&bytes)
                    .map_err(|e| e.to_string())
                    .and_then(|v| store.record(&v));
                let (status, payload) = match result {
                    Ok(true) => (202, json!({"accepted":true})),
                    Ok(false) => (
                        507,
                        json!({"accepted":false,"reason":"storage budget exceeded"}),
                    ),
                    Err(e) => (400, json!({"accepted":false,"error":e})),
                };
                let _ = req.respond(json_response(payload, status));
            }
            _ => {
                let _ = req.respond(json_response(json!({"error":"not found"}), 404));
            }
        }
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let root = env::var("ORCHESTRA_OBSERVER_DIR").unwrap_or_else(|_| "./observer-data".to_owned());
    let store = Store::new(PathBuf::from(root));
    let command = args.get(1).map(String::as_str).unwrap_or("help");
    let result: Result<(), String> = match command {
        "state" => {
            // Explicit local CLI only. No remotely reachable case-state mutation endpoint.
            match env::var("ORCH_STATE_DIR") {
                Ok(dir) if !dir.is_empty() => {
                    let mut buf = String::new();
                    std::io::stdin()
                        .take(64 * 1024)
                        .read_to_string(&mut buf)
                        .map_err(|e| e.to_string())
                        .and_then(|_| {
                            serde_json::from_str::<Value>(&buf).map_err(|e| e.to_string())
                        })
                        .and_then(|req| state_cli::execute(std::path::Path::new(&dir), &req))
                        .map(|out| println!("{out}"))
                }
                _ => Err("ORCH_STATE_DIR must be set explicitly".into()),
            }
        }
        "compat" => {
            let mut buf = String::new();
            std::io::stdin()
                .take(256 * 1024)
                .read_to_string(&mut buf)
                .map_err(|e| e.to_string())
                .and_then(|_| serde_json::from_str::<Value>(&buf).map_err(|e| e.to_string()))
                .map(|input| {
                    println!("{}", compat::execute(&input));
                })
        }
        "compat-lines" => (|| -> Result<(), String> {
            let stdin = std::io::stdin();
            for line in stdin.lock().lines() {
                let line = line.map_err(|e| e.to_string())?;
                if line.len() > 256 * 1024 {
                    return Err("oversize compat line".into());
                }
                let reply = serde_json::from_str::<Value>(&line)
                    .map(|input| compat::execute(&input))
                    .unwrap_or_else(|_| json!({"error":"invalid input json"}));
                println!("{reply}");
            }
            Ok(())
        })(),
        "resource-script" => match env::var("ORCH_STATE_DIR") {
            Ok(dir) if !dir.is_empty() => {
                let mut buf = String::new();
                std::io::stdin()
                    .take(128 * 1024)
                    .read_to_string(&mut buf)
                    .map_err(|e| e.to_string())
                    .and_then(|_| serde_json::from_str::<Value>(&buf).map_err(|e| e.to_string()))
                    .and_then(|v| resource_lease::script(std::path::Path::new(&dir), &v))
                    .map(|out| println!("{out}"))
            }
            _ => Err("ORCH_STATE_DIR must be set explicitly".into()),
        },
        "record" => {
            let mut buf = String::new();
            match std::io::stdin()
                .take((store::MAX_EVENT_BYTES + 1024) as u64)
                .read_to_string(&mut buf)
            {
                Ok(_) => match serde_json::from_str::<Value>(&buf)
                    .map_err(|e| e.to_string())
                    .and_then(|v| store.record(&v))
                {
                    Ok(accepted) => {
                        println!("{}", json!({"accepted":accepted}));
                        Ok(())
                    }
                    Err(e) => Err(e),
                },
                Err(e) => Err(e.to_string()),
            }
        }
        "summary" => {
            println!("{}", summary(&store, 24));
            Ok(())
        }
        "status" => {
            println!("{}", store.status());
            Ok(())
        }
        "serve" => serve(
            store,
            args.get(2).map(String::as_str).unwrap_or("127.0.0.1:7878"),
        ),
        // Journal-authoritative run state: explicit operations only.
        "run-state" => match env::var("ORCHESTRA_RUNSTATE_DIR") {
            Ok(dir) if !dir.is_empty() => {
                let mut buf = String::new();
                std::io::stdin()
                    .take(512 * 1024)
                    .read_to_string(&mut buf)
                    .map_err(|e| e.to_string())
                    .and_then(|_| serde_json::from_str::<Value>(&buf).map_err(|e| e.to_string()))
                    .and_then(|req| {
                        let store = run_state::RunStore::new(&dir);
                        // A batch runs in one process so a single fencing
                        // ownership epoch can cover several operations.
                        match req {
                            Value::Array(items) => {
                                let mut out = Vec::new();
                                for item in items {
                                    out.push(store.execute(&item)?);
                                }
                                Ok(Value::Array(out))
                            }
                            other => store.execute(&other),
                        }
                    })
                    .map(|out| println!("{out}"))
            }
            _ => Err("ORCHESTRA_RUNSTATE_DIR must be set explicitly".into()),
        },
        // Exclusive run-state authority for the coordinator (Unix socket,
        // peer-uid + token authenticated). This is the only writer.
        "authority-serve" => authority::config_from_env().and_then(authority::serve),
        // One process, two surfaces: the write authority socket plus the
        // read-only HTTP projection the dashboard consumes.
        "serve-all" => (|| -> Result<(), String> {
            let runs_dir = coordinator::state_dir_from_env()?;
            let coord_token = coordinator::token_from_env()?;
            let http_dir = runs_dir.clone();
            std::thread::spawn(move || {
                if let Err(e) = coordinator::serve("127.0.0.1:7879", http_dir, coord_token) {
                    eprintln!("coordinator-read stopped: {e}");
                }
            });
            authority::serve(authority::config_from_env()?)
        })(),
        // Read-only coordinator projection for the Harness Control Center.
        // Requires an explicit runs directory and a >=32-char bearer token.
        "coord-serve" => coordinator::state_dir_from_env()
            .and_then(|runs_dir| coordinator::token_from_env().map(|token| (runs_dir, token)))
            .and_then(|(runs_dir, token)| {
                coordinator::serve(
                    args.get(2).map(String::as_str).unwrap_or("127.0.0.1:7879"),
                    runs_dir,
                    token,
                )
            }),
        _ => {
            eprintln!("Usage: orchestra-observer state|run-state|resource-script|compat|compat-lines|record|summary|status|coord-serve|authority-serve|serve-all|serve [127.0.0.1:7878]");
            Ok(())
        }
    };
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn run_outcomes_do_not_count_as_model_attempts() {
        let dir = std::env::temp_dir().join(format!(
            "orchestra-summary-{}-{}",
            std::process::id(),
            Utc::now().timestamp_micros()
        ));
        let store = Store::new(&dir);
        store
            .record(&json!({"kind":"run_started","runId":"r1"}))
            .unwrap();
        store.record(&json!({"kind":"model_invocation","runId":"r1","engine":"test","success":true,"durationMs":12})).unwrap();
        store
            .record(&json!({"kind":"run_completed","runId":"r1"}))
            .unwrap();
        let out = summary(&store, 24);
        assert_eq!(out["modelAttemptsSuccess"], 1);
        assert_eq!(out["modelAttemptsOutcomeUnknown"], 0);
        assert_eq!(out["terminalRunsObserved"], 1);
        assert_eq!(out["latencySamples"], 1);
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn unknown_model_outcomes_do_not_count_as_failures() {
        let dir = std::env::temp_dir().join(format!(
            "orchestra-unknown-{}-{}",
            std::process::id(),
            Utc::now().timestamp_micros()
        ));
        let store = Store::new(&dir);
        store
            .record(&json!({"kind":"model_invocation","engine":"unknown","durationMs":35}))
            .unwrap();
        let out = summary(&store, 24);
        assert_eq!(out["modelAttemptsSuccess"], 0);
        assert_eq!(out["modelAttemptsFailure"], 0);
        assert_eq!(out["modelAttemptsOutcomeUnknown"], 1);
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn percentile_nearest_rank() {
        let mut v = vec![10, 20, 30, 40];
        assert_eq!(percentile(&mut v, 0.95), Some(40));
        assert_eq!(percentile(&mut [], 0.50), None);
    }
}
