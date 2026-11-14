//! Identity-free filtering and pagination of already authenticated RepoQL rows.
//! No knowledge names, URIs, search strings, credentials or records cross this boundary.
use serde_json::{json, Value};
use std::io::{self, Read};

const SCHEMA: &str = "singularity-dashboard-link-page/v1";
const MAX_BYTES: u64 = 120_000;
const MAX_ROWS: usize = 50_000;

fn project(request: &Value) -> Result<Value, &'static str> {
    let obj = request.as_object().ok_or("INVALID_REQUEST")?;
    if obj.len() != 4 || obj.get("schema").and_then(Value::as_str) != Some(SCHEMA) {
        return Err("INVALID_SCHEMA");
    }
    let matches = obj
        .get("matches")
        .and_then(Value::as_array)
        .ok_or("INVALID_MATCHES")?;
    if matches.len() > MAX_ROWS {
        return Err("TOO_MANY_MATCHES");
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
    let offset = page.saturating_sub(1).saturating_mul(size);
    let mut total = 0_u64;
    let mut indices = Vec::<usize>::new();
    for (i, flag) in matches.iter().enumerate() {
        let matched = flag.as_bool().ok_or("INVALID_MATCH_FLAG")?;
        if matched {
            if total >= offset && total - offset < size {
                indices.push(i);
            }
            total += 1;
        }
    }
    Ok(json!({"total": total, "indices": indices}))
}

fn main() {
    let mut buf = Vec::new();
    let result = match io::stdin().take(MAX_BYTES + 1).read_to_end(&mut buf) {
        Ok(_) if buf.len() as u64 <= MAX_BYTES => serde_json::from_slice::<Value>(&buf)
            .map_err(|_| "INVALID_JSON")
            .and_then(|v| project(&v)),
        _ => Err("REQUEST_TOO_LARGE"),
    };
    match result {
        Ok(value) => println!("{value}"),
        Err(code) => {
            eprintln!("Link page rejected: {code}");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pages_include_only_matching_indices() {
        let req = json!({"schema":SCHEMA,"matches":[true,false,true,true,false,true],"page":2,"page_size":2});
        assert_eq!(project(&req).unwrap(), json!({"total":4,"indices":[3,5]}));
    }
    #[test]
    fn paging_beyond_end_is_empty_but_total_is_correct() {
        let req =
            json!({"schema":SCHEMA,"matches":[true,false,true],"page":u64::MAX,"page_size":2});
        assert_eq!(project(&req).unwrap(), json!({"total":2,"indices":[]}));
    }
    #[test]
    fn reject_private_fields_and_malformed_flags() {
        assert!(project(
            &json!({"schema":SCHEMA,"matches":[],"page":1,"page_size":1,"uri":"secret"})
        )
        .is_err());
        assert!(project(&json!({"schema":SCHEMA,"matches":[1],"page":1,"page_size":1})).is_err());
        assert!(project(&json!({"schema":SCHEMA,"matches":[],"page":0,"page_size":1})).is_err());
    }
}
