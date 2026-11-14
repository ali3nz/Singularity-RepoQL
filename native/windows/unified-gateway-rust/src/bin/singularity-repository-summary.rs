//! Pure repository accounting. No paths, URIs, credentials, logs, or identities.
//! Caller owns source attribution and authorisation. Accept positional indexes only.
use serde_json::{json, Value};
use std::io::{self, Read};

const MAX_BYTES: u64 = 512 * 1024;
const MAX_ROWS: usize = 4096;
const MAX_EVENTS: usize = 20000;
const MAX_COUNT: u64 = 1_000_000_000_000;
const SCHEMA: &str = "singularity-repository-summary/v1";

fn count(value: &Value) -> Result<Option<u64>, &'static str> {
    if value.is_null() {
        return Ok(None);
    }
    match value.as_u64() {
        Some(n) if n <= MAX_COUNT => Ok(Some(n)),
        _ => Err("INVALID_COUNT"),
    }
}

fn indexes(request: &Value, key: &str, size: usize) -> Result<Vec<usize>, &'static str> {
    let array = request
        .get(key)
        .and_then(Value::as_array)
        .ok_or("INVALID_INDEXES")?;
    if array.len() > MAX_EVENTS {
        return Err("TOO_MANY_EVENTS");
    }
    array
        .iter()
        .map(|item| {
            let index = item.as_u64().ok_or("INVALID_INDEX")?;
            let index = usize::try_from(index).map_err(|_| "INVALID_INDEX")?;
            if index >= size {
                return Err("INVALID_INDEX");
            }
            Ok(index)
        })
        .collect()
}

fn project(request: &Value) -> Result<Value, &'static str> {
    let obj = request.as_object().ok_or("INVALID_REQUEST")?;
    if obj.len() != 4 || obj.get("schema").and_then(Value::as_str) != Some(SCHEMA) {
        return Err("INVALID_REQUEST");
    }
    let rows = obj
        .get("rows")
        .and_then(Value::as_array)
        .ok_or("INVALID_ROWS")?;
    if rows.len() > MAX_ROWS {
        return Err("TOO_MANY_ROWS");
    }
    let failed = indexes(request, "failed_indices", rows.len())?;
    let exclusions = indexes(request, "exclusion_indices", rows.len())?;
    if failed.len() + exclusions.len() > MAX_EVENTS {
        return Err("TOO_MANY_EVENTS");
    }
    let mut failures = vec![0_u64; rows.len()];
    let mut excluded = vec![0_u64; rows.len()];
    for index in failed {
        failures[index] += 1;
    }
    for index in exclusions {
        excluded[index] += 1;
    }
    let mut result = Vec::with_capacity(rows.len());
    for (index, row) in rows.iter().enumerate() {
        let fields = row.as_object().ok_or("INVALID_ROW")?;
        if fields.len() != 4 {
            return Err("INVALID_ROW");
        }
        let override_status = fields
            .get("override")
            .and_then(Value::as_bool)
            .ok_or("INVALID_ROW")?;
        let available = fields
            .get("available")
            .and_then(Value::as_bool)
            .ok_or("INVALID_ROW")?;
        let file_count = count(fields.get("file_count").ok_or("INVALID_ROW")?)?;
        let indexed_count = count(fields.get("indexed_count").ok_or("INVALID_ROW")?)?;
        let status = if override_status {
            "override"
        } else if !available {
            "unavailable"
        } else if failures[index] > 0 {
            "errors"
        } else if file_count.unwrap_or(0) > 0
            && indexed_count.is_some()
            && indexed_count < file_count
        {
            "indexing"
        } else {
            "indexed"
        };
        result.push(
            json!({"excluded": excluded[index], "failed": failures[index], "status_code": status}),
        );
    }
    Ok(Value::Array(result))
}

fn main() {
    let mut bytes = Vec::new();
    let result = match io::stdin().take(MAX_BYTES + 1).read_to_end(&mut bytes) {
        Ok(_) if bytes.len() as u64 <= MAX_BYTES => serde_json::from_slice::<Value>(&bytes)
            .map_err(|_| "INVALID_JSON")
            .and_then(|value| project(&value)),
        _ => Err("REQUEST_TOO_LARGE"),
    };
    match result {
        Ok(value) => println!("{value}"),
        Err(error) => {
            eprintln!("Repository summary rejected: {error}");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prioritizes_override_availability_and_errors() {
        let request = json!({"schema":SCHEMA,
            "rows":[
                {"override":true,"available":false,"file_count":10,"indexed_count":0},
                {"override":false,"available":false,"file_count":10,"indexed_count":0},
                {"override":false,"available":true,"file_count":10,"indexed_count":0},
                {"override":false,"available":true,"file_count":10,"indexed_count":9},
                {"override":false,"available":true,"file_count":0,"indexed_count":0}
            ],"failed_indices":[2,2],"exclusion_indices":[0,3,3]});
        let output = project(&request).unwrap();
        assert_eq!(output[0]["status_code"], "override");
        assert_eq!(output[1]["status_code"], "unavailable");
        assert_eq!(output[2]["status_code"], "errors");
        assert_eq!(output[2]["failed"], 2);
        assert_eq!(output[3]["status_code"], "indexing");
        assert_eq!(output[3]["excluded"], 2);
        assert_eq!(output[4]["status_code"], "indexed");
    }
    #[test]
    fn refuses_extra_or_private_data() {
        let good = json!({"schema":SCHEMA,"rows":[],"failed_indices":[],"exclusion_indices":[]});
        assert_eq!(project(&good).unwrap(), json!([]));
        let mut bad = good.clone();
        bad["root_uri"] = json!("secret");
        assert!(project(&bad).is_err());
        bad = good;
        bad["rows"] =
            json!([{"override":false,"available":true,"file_count":true,"indexed_count":null}]);
        assert!(project(&bad).is_err());
        bad["rows"] = json!([]);
        bad["failed_indices"] = json!([0]);
        assert!(project(&bad).is_err());
    }
}
