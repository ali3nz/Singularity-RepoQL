//! Bounded graph projection. Accepts integer node identifiers only.
//! The authenticated caller owns actual URI, names and graph data.
use serde_json::{json, Value};
use std::io::{self, Read};
const SCHEMA: &str = "singularity-dashboard-graph/v1";
const MAX_BYTES: u64 = 512 * 1024;
const MAX_PAIRS: usize = 20000;
const MAX_NODES: u64 = 40000;
fn project(request: &Value) -> Result<Value, &'static str> {
    let obj = request.as_object().ok_or("INVALID_REQUEST")?;
    if obj.len() != 3 || obj.get("schema").and_then(Value::as_str) != Some(SCHEMA) {
        return Err("INVALID_REQUEST");
    }
    let count = obj
        .get("node_count")
        .and_then(Value::as_u64)
        .ok_or("INVALID_COUNT")?;
    if count > MAX_NODES {
        return Err("INVALID_COUNT");
    }
    let pairs = obj
        .get("pairs")
        .and_then(Value::as_array)
        .ok_or("INVALID_PAIRS")?;
    if pairs.len() > MAX_PAIRS {
        return Err("TOO_MANY_PAIRS");
    }
    let mut seen = vec![false; count as usize];
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    for pair in pairs {
        let tuple = pair.as_array().ok_or("INVALID_PAIR")?;
        if tuple.len() != 2 {
            return Err("INVALID_PAIR");
        }
        let left = tuple[0].as_u64().ok_or("INVALID_PAIR")?;
        let right = tuple[1].as_u64().ok_or("INVALID_PAIR")?;
        if left >= count || right >= count {
            return Err("INVALID_PAIR");
        }
        for id in [left, right] {
            let index = id as usize;
            if !seen[index] {
                seen[index] = true;
                nodes.push(id);
            }
        }
        if edges.len() < 200 {
            edges.push(json!([left, right]));
        }
        if nodes.len() >= 120 {
            break;
        }
    }
    let truncated = nodes.len() >= 120;
    nodes.truncate(120);
    Ok(json!({"node_indices": nodes, "edge_indices": edges, "truncated": truncated}))
}
fn main() {
    let mut input = Vec::new();
    let result = match io::stdin().take(MAX_BYTES + 1).read_to_end(&mut input) {
        Ok(_) if input.len() as u64 <= MAX_BYTES => serde_json::from_slice::<Value>(&input)
            .map_err(|_| "INVALID_JSON")
            .and_then(|request| project(&request)),
        _ => Err("REQUEST_TOO_LARGE"),
    };
    match result {
        Ok(value) => println!("{value}"),
        Err(error) => {
            eprintln!("Graph projection rejected: {error}");
            std::process::exit(2);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn order_and_threshold() {
        let request = json!({"schema":SCHEMA,"node_count":122,
            "pairs":(0..121).map(|n|json!([n,n+1])).collect::<Vec<_>>()});
        let result = project(&request).unwrap();
        assert_eq!(result["node_indices"][0], 0);
        assert_eq!(result["node_indices"][119], 119);
        assert_eq!(result["edge_indices"].as_array().unwrap().len(), 119);
        assert_eq!(result["truncated"], true);
    }
    #[test]
    fn privacy_and_bounds() {
        let good = json!({"schema":SCHEMA,"node_count":0,"pairs":[]});
        assert_eq!(project(&good).unwrap()["truncated"], false);
        let mut bad = good.clone();
        bad["uri"] = json!("secret");
        assert!(project(&bad).is_err());
        bad = good.clone();
        bad["pairs"] = json!([[0, 0]]);
        assert!(project(&bad).is_err());
        bad = good;
        bad["node_count"] = json!(true);
        assert!(project(&bad).is_err());
    }
}
