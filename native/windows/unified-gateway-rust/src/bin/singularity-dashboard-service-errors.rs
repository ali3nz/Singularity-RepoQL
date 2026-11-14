//! Read-only service error grouping: accepts neither log messages nor timestamps.
//! Group IDs and timestamp ranks are derived by the authenticated Python server.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{self, Read};

const SCHEMA: &str = "singularity-dashboard-service-errors/v1";
const MAX_BYTES: u64 = 350_000;
const MAX_EVENTS: usize = 10_000;

#[derive(Clone)]
struct Group {
    id: u64,
    count: u64,
    last_event: usize,
    last_rank: u64,
}

fn project(request: &Value) -> Result<Value, &'static str> {
    let obj = request.as_object().ok_or("INVALID_REQUEST")?;
    if obj.len() != 4 || obj.get("schema").and_then(Value::as_str) != Some(SCHEMA) {
        return Err("INVALID_SCHEMA");
    }
    let events = obj
        .get("events")
        .and_then(Value::as_array)
        .ok_or("INVALID_EVENTS")?;
    if events.len() > MAX_EVENTS {
        return Err("TOO_MANY_EVENTS");
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
    let mut groups: Vec<Group> = Vec::new();
    let mut locations: HashMap<u64, usize> = HashMap::new();
    for (i, event) in events.iter().enumerate() {
        let row = event.as_object().ok_or("INVALID_EVENT")?;
        if row.len() != 2 {
            return Err("INVALID_EVENT");
        }
        let id = row
            .get("group")
            .and_then(Value::as_u64)
            .ok_or("INVALID_GROUP")?;
        let rank = row
            .get("time_rank")
            .and_then(Value::as_u64)
            .ok_or("INVALID_RANK")?;
        if id >= events.len() as u64 || rank >= events.len() as u64 {
            return Err("INVALID_EVENT_INDEX");
        }
        if let Some(index) = locations.get(&id).copied() {
            let group = &mut groups[index];
            group.count += 1;
            group.last_event = i;
            group.last_rank = rank;
        } else {
            locations.insert(id, groups.len());
            groups.push(Group {
                id,
                count: 1,
                last_event: i,
                last_rank: rank,
            });
        }
    }
    groups.sort_by(|a, b| b.last_rank.cmp(&a.last_rank).then(a.id.cmp(&b.id)));
    let total = groups.len() as u64;
    let offset = page.saturating_sub(1).saturating_mul(size);
    let selected:Vec<Value>=groups.iter().enumerate().filter_map(|(i,group)| {
        let at=i as u64;
        if at>=offset && at-offset<size {
            Some(json!({"group_index":group.id,"count":group.count,"last_event":group.last_event}))
        } else { None }
    }).collect();
    Ok(json!({"total":total,"groups":selected}))
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
        Ok(v) => println!("{v}"),
        Err(err) => {
            eprintln!("Service error grouping rejected: {err}");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stable_groups_last_timestamp_and_count() {
        let req = json!({"schema":SCHEMA,"page":1,"page_size":3,"events":[
            {"group":0,"time_rank":1},{"group":1,"time_rank":0},
            {"group":0,"time_rank":2},{"group":1,"time_rank":2}]});
        assert_eq!(
            project(&req).unwrap(),
            json!({"total":2,"groups":[
            {"group_index":0,"count":2,"last_event":2},
            {"group_index":1,"count":2,"last_event":3}]})
        );
    }
    #[test]
    fn rejects_private_fields_and_indexes() {
        assert!(project(&json!({"schema":SCHEMA,"page":1,"page_size":3,
            "events":[{"group":0,"time_rank":0,"message":"secret"}]}))
        .is_err());
        assert!(project(&json!({"schema":SCHEMA,"page":1,"page_size":3,
            "events":[{"group":0,"time_rank":1}]}))
        .is_err());
    }
}
