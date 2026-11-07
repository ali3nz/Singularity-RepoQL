//! Deterministic, read-only Kanzo board status audit for the native Windows release.
//! The Kanzo API remains authoritative: this tool consumes a board JSON snapshot
//! and reports stage counts, never claims, mutates, or prints task content.
use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::{self, Read};

const MAX_BYTES: u64 = 16 * 1024 * 1024;
const STATUS: [&str; 5] = ["backlog", "todo", "doing", "review", "done"];

fn summary(board: &Value) -> Result<Value, String> {
    let tasks = board.get("tasks").and_then(Value::as_array)
        .ok_or("board.tasks must be an array")?;
    let states = board.get("statuses").and_then(Value::as_array)
        .ok_or("board.statuses must be an array")?;
    let projects = board.get("projects").and_then(Value::as_array)
        .ok_or("board.projects must be an array")?;
    if !states.iter().all(|v| v.as_str().is_some_and(|v| STATUS.contains(&v))) {
        return Err("unexpected Kanzo stage in board.statuses".into());
    }
    let supported: HashSet<&str> = states.iter().filter_map(Value::as_str).collect();
    let mut counts = [0usize; 5];
    let mut ids = HashSet::new();
    for task in tasks {
        let id = task.get("id").and_then(Value::as_u64)
            .filter(|n| *n > 0).ok_or("task has invalid ID")?;
        if !ids.insert(id) { return Err("duplicate task ID in board response".into()); }
        let state = task.get("status").and_then(Value::as_str)
            .ok_or("task missing native Kanzo status")?;
        if !supported.contains(state) { return Err("task status not advertised by Kanzo".into()); }
        let index = STATUS.iter().position(|s| *s == state)
            .ok_or("unknown task status")?;
        counts[index] += 1;
    }
    let hidden = board.get("done_hidden").map(|v|v.as_u64().ok_or("done_hidden must be nonnegative"))
        .transpose()?.unwrap_or(0);
    let total = tasks.len() as u64;
    Ok(json!({
        "schema": "singularity-kanzo-board-audit/1", "readOnly": true,
        "authority": "Kanzo board JSON; does not verify MCP claims or execution",
        "statuses": {"backlog": counts[0], "todo": counts[1], "doing": counts[2],
                     "review": counts[3], "done": counts[4]},
        "workQueue": counts[1] + counts[2] + counts[3],
        "loadedTasks": total, "projectCount": projects.len(),
        "doneHidden": hidden, "closedAtLeast": counts[4] as u64 + hidden,
        "fullClosedHistoryLoaded": hidden == 0,
        "doingMeans": "Kanzo workflow stage, not a proof of a valid work claim",
        "doneMeans": "Administrative closure; not implementation acceptance"
    }))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 1 || args[0] != "--stdin" {
        eprintln!("usage: kanzo_board_audit --stdin < Kanzo board API JSON");
        std::process::exit(2);
    }
    let mut input = Vec::new();
    if io::stdin().take(MAX_BYTES + 1).read_to_end(&mut input).is_err() || input.len() as u64 > MAX_BYTES {
        eprintln!("Kanzo board input unreadable or too large");
        std::process::exit(2);
    }
    let value: Value = match serde_json::from_slice(&input) {
        Ok(v) => v, Err(_) => { eprintln!("Kanzo board JSON invalid"); std::process::exit(2); }
    };
    match summary(&value) {
        Ok(result) => println!("{result}"),
        Err(error) => { eprintln!("{error}"); std::process::exit(1); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn counts_native_stages_and_hidden_closed_without_claiming_success() {
        let v = json!({"statuses":["backlog","todo","doing","review","done"],
          "projects":[{"slug":"singularity"}],"done_hidden":42,
          "tasks":[{"id":1,"status":"todo","title":"Private"},
                   {"id":2,"status":"doing"},{"id":3,"status":"done"}]});
        let result=summary(&v).unwrap();
        assert_eq!(result["workQueue"],json!(2));
        assert_eq!(result["statuses"]["doing"],1);
        assert_eq!(result["closedAtLeast"],json!(43));
        assert_eq!(result["fullClosedHistoryLoaded"],false);
        assert!(!result.to_string().contains("Private"));
        assert_eq!(result["readOnly"],true);
    }
    #[test]
    fn refuse_non_native_states_or_duplicate_ids() {
        let v=json!({"statuses":["todo","doing","done"],"projects":[],"tasks":[{"id":1,"status":"active"}]});
        assert!(summary(&v).is_err());
        let v=json!({"statuses":["todo","done"],"projects":[],"tasks":[{"id":1,"status":"todo"},{"id":1,"status":"done"}]});
        assert!(summary(&v).is_err());
    }
    #[test]
    fn refuses_negative_or_missing_board_evidence() {
        assert!(summary(&json!({})).is_err());
        assert!(summary(&json!({"statuses":["todo"],"projects":[],"tasks":[],"done_hidden":-1})).is_err());
    }
}
