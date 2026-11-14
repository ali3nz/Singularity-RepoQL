//! Authenticated Windows OpenMausBot inventory projections, read only.
//!
//! Python owns loopback authorization, session token handling, bounded HTTP
//! requests and model-change permissions. This process receives only filtered
//! GUI-visible identity and catalogue fields, no raw service responses.
use serde_json::{json, Value};
use std::io::{self, Read};

const LIMIT_BYTES: u64 = 2 * 1024 * 1024;
const NOTE: &str = "Bot presence is not native provisioning, Kanzo, Duo or Tencent verification.";

fn object_exact(value: &Value, required: &[&str]) -> Result<(), &'static str> {
    let obj = value.as_object().ok_or("INVALID_OBJECT")?;
    if obj.len() != required.len() || required.iter().any(|key| !obj.contains_key(*key)) {
        return Err("INVALID_OBJECT");
    }
    Ok(())
}

fn value_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, &'static str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or("INVALID_FIELD")
}

fn truncated(value: &str, count: usize) -> String {
    value.chars().take(count).collect()
}

fn project_models(payload: &Value) -> Result<Value, &'static str> {
    object_exact(payload, &["instances"])?;
    let raw = payload["instances"].as_array().ok_or("INVALID_INSTANCES")?;
    if raw.len() > 60 {
        return Err("INVALID_INSTANCES");
    }
    let mut providers = Vec::<Value>::new();
    for row in raw {
        object_exact(row, &["instanceId", "displayName", "available", "options"])?;
        let id = value_string(row, "instanceId")?;
        let name = value_string(row, "displayName")?;
        let available = row["available"].as_bool().ok_or("INVALID_AVAILABLE")?;
        let options = row["options"].as_array().ok_or("INVALID_OPTIONS")?;
        if options.len() > 200 {
            return Err("INVALID_OPTIONS");
        }
        let mut models = Vec::<Value>::new();
        for option in options {
            object_exact(option, &["id", "label"])?;
            models.push(json!({"id": truncated(value_string(option,"id")?,500),
                               "label": truncated(value_string(option,"label")?,200)}));
        }
        providers.push(json!({"id":truncated(id,200), "name":truncated(name,120),
                              "available":available, "models":models}));
    }
    providers.sort_by(|a, b| {
        let a_key = (
            !a["available"].as_bool().unwrap_or(false),
            a["name"].as_str().unwrap_or("").to_lowercase(),
        );
        let b_key = (
            !b["available"].as_bool().unwrap_or(false),
            b["name"].as_str().unwrap_or("").to_lowercase(),
        );
        a_key.cmp(&b_key)
    });
    Ok(json!({"available":true, "providers":providers}))
}

fn valid_bot_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn project_bots(payload: &Value) -> Result<Value, &'static str> {
    object_exact(payload, &["bots", "total", "truncated"])?;
    let bots = payload["bots"].as_array().ok_or("INVALID_BOTS")?;
    if bots.len() > 100 {
        return Err("INVALID_BOTS");
    }
    let total = payload["total"].as_u64().ok_or("INVALID_TOTAL")?;
    let over = payload["truncated"].as_bool().ok_or("INVALID_TRUNCATED")?;
    if total < bots.len() as u64 || (total > 100) != over {
        return Err("INVALID_TOTAL");
    }
    let mut projected = Vec::<Value>::new();
    for row in bots {
        object_exact(
            row,
            &[
                "id",
                "name",
                "working",
                "model",
                "chief_of_staff",
                "thread_id",
            ],
        )?;
        let id = value_string(row, "id")?;
        if !valid_bot_id(id) {
            return Err("INVALID_BOT_ID");
        }
        let name = value_string(row, "name")?;
        let working = row["working"].as_bool().ok_or("INVALID_WORKING")?;
        let chief = row["chief_of_staff"].as_bool().ok_or("INVALID_CHIEF")?;
        let thread = value_string(row, "thread_id")?;
        let model = &row["model"];
        object_exact(model, &["instance", "model"])?;
        let instance = value_string(model, "instance")?;
        let selected = value_string(model, "model")?;
        projected.push(json!({
            "id":id, "name":truncated(name,120), "working":working,
            "model":{"instance":truncated(instance,200), "model":truncated(selected,500)},
            "chief_of_staff":chief, "thread_id":truncated(thread,128),
            "registration":"not_verified", "duo":"not_verified",
            "kanzo":"not_verified", "memory":"not_verified"
        }));
    }
    Ok(json!({"available":true,"bots":projected,"total":total,
              "truncated":over,"source":"windows_loopback_openmausbot","note":NOTE}))
}

fn process(request: &Value) -> Result<Value, &'static str> {
    object_exact(request, &["mode", "payload"])?;
    match value_string(request, "mode")? {
        "models" => project_models(&request["payload"]),
        "bots" => project_bots(&request["payload"]),
        _ => Err("INVALID_MODE"),
    }
}

fn main() {
    let mut input = Vec::new();
    let result = match io::stdin().take(LIMIT_BYTES + 1).read_to_end(&mut input) {
        Ok(_) if input.len() as u64 <= LIMIT_BYTES => serde_json::from_slice::<Value>(&input)
            .map_err(|_| "INVALID_JSON")
            .and_then(|v| process(&v)),
        _ => Err("REQUEST_TOO_LARGE"),
    };
    match result {
        Ok(value) => println!("{value}"),
        Err(error) => {
            eprintln!("OpenMausBot inventory rejected: {error}");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn models_sorted_by_availability_then_name() {
        let got = process(&json!({"mode":"models","payload":{"instances":[
          {"instanceId":"z","displayName":"Zed","available":false,"options":[]},
          {"instanceId":"b","displayName":"beta","available":true,"options":[{"id":"m","label":"Model"}]},
          {"instanceId":"a","displayName":"Alpha","available":true,"options":[]}
        ]}})).unwrap();
        assert_eq!(got["providers"][0]["id"], "a");
        assert_eq!(got["providers"][1]["id"], "b");
        assert_eq!(got["providers"][2]["id"], "z");
    }
    #[test]
    fn bots_do_not_claim_unverified_registration() {
        let got = process(
            &json!({"mode":"bots","payload":{"total":1,"truncated":false,"bots":[
              {"id":"bot_A","name":"Alpha","working":true,
               "model":{"instance":"p","model":"m"}, "chief_of_staff":false,"thread_id":"thread1"}
            ]}}),
        )
        .unwrap();
        assert_eq!(got["bots"][0]["registration"], "not_verified");
        assert_eq!(got["bots"][0]["memory"], "not_verified");
        assert_eq!(got["bots"][0]["working"], true);
    }
    #[test]
    fn rejects_private_fields_and_forged_bots() {
        let injected = json!({"mode":"models","payload":{"instances":[],"token":"secret"}});
        assert!(process(&injected).is_err());
        let private = json!({"mode":"bots","payload":{"total":1,"truncated":false,"bots":[
          {"id":"bad/id","name":"x","working":false,"model":{"instance":"","model":""},
           "chief_of_staff":false,"thread_id":""}
        ]}});
        assert!(process(&private).is_err());
        assert!(process(&json!({"mode":"fake","payload":{}})).is_err());
    }
}
