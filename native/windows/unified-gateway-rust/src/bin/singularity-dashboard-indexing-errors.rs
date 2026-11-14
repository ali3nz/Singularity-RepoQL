//! Bounded index-only projection of the authenticated dashboard error list.
//! Python owns RepoQL queries and redaction; no URI or log text crosses stdin.
use serde_json::{json, Value};
use std::io::{self, Read};

const SCHEMA: &str = "singularity-dashboard-indexing-errors/v1";
const MAX_BYTES: u64 = 180_000;
const MAX_EVENTS: usize = 10_000;

fn project(input: &Value) -> Result<Value, &'static str> {
    let obj = input.as_object().ok_or("INVALID_REQUEST")?;
    if obj.len() != 4 || obj.get("schema").and_then(Value::as_str) != Some(SCHEMA) {
        return Err("INVALID_SCHEMA");
    }
    let ranks = obj
        .get("ranks")
        .and_then(Value::as_array)
        .ok_or("INVALID_RANKS")?;
    if ranks.len() > MAX_EVENTS {
        return Err("TOO_MANY_RANKS");
    }
    let page = obj
        .get("page")
        .and_then(Value::as_u64)
        .ok_or("INVALID_PAGE")?;
    let size = obj
        .get("page_size")
        .and_then(Value::as_u64)
        .ok_or("INVALID_PAGE_SIZE")?;
    if page == 0 || size == 0 || size > 200 {
        return Err("INVALID_PAGING");
    }
    let mut rows = Vec::with_capacity(ranks.len());
    for (index, rank) in ranks.iter().enumerate() {
        let rank = rank.as_u64().ok_or("INVALID_RANK")?;
        if rank >= ranks.len() as u64 {
            return Err("INVALID_RANK_INDEX");
        }
        rows.push((index, rank));
    }
    // Preserve Python's stable descending sort: ties retain original index order.
    rows.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let offset = page.saturating_sub(1).saturating_mul(size);
    let selected: Vec<usize> = rows
        .iter()
        .enumerate()
        .filter_map(|(at, (index, _))| {
            let at = at as u64;
            if at >= offset && at - offset < size {
                Some(*index)
            } else {
                None
            }
        })
        .collect();
    Ok(json!({"total": ranks.len(), "indices": selected}))
}

fn main() {
    let mut input = Vec::new();
    let output = match io::stdin().take(MAX_BYTES + 1).read_to_end(&mut input) {
        Ok(_) if input.len() as u64 <= MAX_BYTES => serde_json::from_slice::<Value>(&input)
            .map_err(|_| "INVALID_JSON")
            .and_then(|v| project(&v)),
        _ => Err("REQUEST_TOO_LARGE"),
    };
    match output {
        Ok(value) => println!("{value}"),
        Err(err) => {
            eprintln!("Indexing error projection rejected: {err}");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_timestamp_order_and_paging() {
        let request = json!({"schema": SCHEMA, "ranks": [1,2,2,0], "page":1,"page_size":3});
        assert_eq!(
            project(&request).unwrap(),
            json!({"total":4,"indices":[1,2,0]})
        );
        let request = json!({"schema": SCHEMA, "ranks":[0,1,1],"page":2,"page_size":1});
        assert_eq!(project(&request).unwrap(), json!({"total":3,"indices":[2]}));
    }

    #[test]
    fn refuses_private_fields_and_invalid_ranks() {
        let extra = json!({"schema":SCHEMA,"ranks":[0],"page":1,"page_size":1,"uri":"private"});
        assert!(project(&extra).is_err());
        assert!(project(&json!({"schema":SCHEMA,"ranks":[1],"page":1,"page_size":1})).is_err());
        assert!(project(&json!({"schema":SCHEMA,"ranks":["0"],"page":1,"page_size":1})).is_err());
    }
}
