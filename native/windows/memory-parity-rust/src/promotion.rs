//! Bounded, read-only policy for the MemoryCore promotion scanner.
//!
//! Credentials, text excerpts, network requests, cursor files and writes stay
//! in the Python owner. All inputs are sanitized metadata; these commands are
//! only used with an independent Python verdict comparison.
use serde_json::{json, Value};
use std::collections::HashSet;

const MAX_ROWS: usize = 2048;
const MAX_CANDIDATES: usize = 12;
const MAX_EXCERPT_CHARS: u64 = 4000;
const DAY: i64 = 24 * 3600;
const CAP_24H: usize = 3;

fn bad() -> Value {
    json!({"ok":false,"code":"INVALID_PROMOTION_INPUT"})
}

fn integer(input: &Value, key: &str) -> Option<i64> {
    input.get(key)?.as_i64()
}
fn names(input: &Value, key: &str) -> Option<HashSet<String>> {
    let rows = input.get(key)?.as_array()?;
    if rows.len() > MAX_ROWS {
        return None;
    }
    let mut set = HashSet::new();
    for row in rows {
        let name = row.as_str()?;
        if name.len() > 256 {
            return None;
        }
        set.insert(name.to_owned());
    }
    Some(set)
}

/// Returns selection indices, never record content. Preserves source order and
/// the legacy behavior that one too-large row ends the current page.
pub fn shortlist(input: &Value) -> Value {
    let Some(rows) = input.get("records").and_then(Value::as_array) else {
        return bad();
    };
    if rows.len() > MAX_ROWS {
        return bad();
    }
    let Some(done) = names(input, "doneIds") else {
        return bad();
    };
    let Some(after) = integer(input, "afterTs") else {
        return bad();
    };
    let mut selected = Vec::new();
    let mut budget = MAX_EXCERPT_CHARS;
    let mut newest = 0_i64;
    for (index, row) in rows.iter().enumerate() {
        let (Some(id), Some(ts), Some(len), Some(has_text)) = (
            row.get("id").and_then(Value::as_str),
            integer(row, "ts"),
            row.get("excerptLen").and_then(Value::as_u64),
            row.get("hasText").and_then(Value::as_bool),
        ) else {
            return bad();
        };
        if id.len() > 256 || len > 300 {
            return bad();
        }
        if id.is_empty() || ts <= 0 || !has_text {
            continue;
        }
        if done.contains(id) {
            continue;
        }
        if ts <= after {
            continue;
        }
        let need = len.saturating_add(8);
        if need > budget || selected.len() >= MAX_CANDIDATES {
            break;
        }
        budget -= need;
        selected.push(index);
        newest = newest.max(ts);
    }
    json!({"ok":true,"indices":selected,"newestTs":newest})
}

fn ordered_rows(input: &Value, key: &str, timestamp_key: &str) -> Option<Vec<(String, i64)>> {
    let rows = input.get(key)?.as_array()?;
    if rows.len() > MAX_ROWS {
        return None;
    }
    let mut result = Vec::with_capacity(rows.len());
    for row in rows {
        let id = row.get("id")?.as_str()?;
        if id.len() > 256 {
            return None;
        }
        let ts = integer(row, timestamp_key)?;
        result.push((id.to_owned(), ts));
    }
    Some(result)
}

/// Preserve unreviewed record IDs even if subsequent query pages change.
/// A no-op cursor request is acceptable; forward movement needs evidence.
pub fn advance(input: &Value) -> Value {
    let (Some(after), Some(target), Some(presented), Some(pending), Some(done), Some(deferred)) = (
        integer(input, "afterTs"),
        integer(input, "advanceTs"),
        integer(input, "maxPresentedTs"),
        ordered_rows(input, "pendingReview", "ts"),
        names(input, "doneIds"),
        ordered_rows(input, "deferred", "recTs"),
    ) else {
        return bad();
    };
    if target <= after {
        return json!({"ok":true,"allowed":true,"code":"NOOP","blocked":[],"afterTs":after});
    }
    if pending.is_empty() {
        return json!({"ok":true,"allowed":false,"code":"NO_SHORTLIST","blocked":[],"afterTs":after});
    }
    if target > presented {
        return json!({"ok":true,"allowed":false,"code":"BEYOND_SHORTLIST","blocked":[],"afterTs":after});
    }
    let mut blocked = HashSet::new();
    for (id, ts) in pending {
        if ts <= target && !done.contains(&id) {
            blocked.insert(id);
        }
    }
    for (id, ts) in deferred {
        if ts != 0 && ts <= target {
            blocked.insert(id);
        }
    }
    if !blocked.is_empty() {
        let mut blocked: Vec<String> = blocked.into_iter().collect();
        blocked.sort();
        return json!({"ok":true,"allowed":false,"code":"UNRESOLVED","blocked":blocked,"afterTs":after});
    }
    json!({"ok":true,"allowed":true,"code":"ADVANCE","blocked":[],"afterTs":target})
}

/// Pure eligibility decision. No writes and no visibility into concept text.
pub fn eligibility(input: &Value) -> Value {
    let (Some(now), Some(times)) = (
        integer(input, "nowTs"),
        input.get("recentTs").and_then(Value::as_array),
    ) else {
        return bad();
    };
    if times.len() > MAX_ROWS {
        return bad();
    }
    let mut recent_count = 0_usize;
    for ts in times {
        let Some(ts) = ts.as_i64() else {
            return bad();
        };
        if ts >= now.saturating_sub(DAY) {
            recent_count += 1;
        }
    }
    let prior = match input.get("priorTs") {
        Some(Value::Null) => None,
        Some(v) => match v.as_i64() {
            Some(ts) => Some(ts),
            None => return bad(),
        },
        None => return bad(),
    };
    let duplicate = prior.is_some_and(|ts| now.saturating_sub(ts) < 7 * DAY);
    let code = if recent_count >= CAP_24H {
        "CAP_REACHED"
    } else if duplicate {
        "REPEAT_CONCEPT"
    } else {
        "ELIGIBLE"
    };
    json!({"ok":true,"allowed":code == "ELIGIBLE","code":code,"recentCount":recent_count})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_unresolved_review() {
        let mut body = json!({"afterTs":0,"advanceTs":20,"maxPresentedTs":20,"pendingReview":[{"id":"a","ts":10},{"id":"b","ts":20}],"doneIds":["b"],"deferred":[]});
        assert_eq!(advance(&body)["code"], "UNRESOLVED");
        body["doneIds"] = json!(["a", "b"]);
        assert_eq!(advance(&body)["afterTs"], 20);
        body["advanceTs"] = json!(21);
        assert_eq!(advance(&body)["code"], "BEYOND_SHORTLIST");
    }
    #[test]
    fn respects_window_and_repeat() {
        let input = json!({"nowTs":86400,"recentTs":[0,100,86400],"priorTs":null});
        assert_eq!(eligibility(&input)["code"], "CAP_REACHED");
        let input = json!({"nowTs":86400,"recentTs":[0],"priorTs":85000});
        assert_eq!(eligibility(&input)["code"], "REPEAT_CONCEPT");
    }
    #[test]
    fn shortlist_stops_on_budget() {
        let rows = json!({"records":[{"id":"1","ts":8,"excerptLen":300,"hasText":true},{"id":"2","ts":9,"excerptLen":300,"hasText":true}],"doneIds":["1"],"afterTs":0});
        assert_eq!(shortlist(&rows)["indices"], json!([1]));
    }
}
