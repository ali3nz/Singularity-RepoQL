//! Pure connector-inventory assessment port of verify_option2_connectors.evaluate().
//! Does NOT replace the authenticated RepoQL Windows preflight or live collection.
use serde_json::{json, Value};

pub fn evaluate(inventory: &Value) -> Value {
    let available = inventory.get("available").and_then(Value::as_bool) == Some(true);
    let rows = if available {
        inventory.get("connectors").and_then(Value::as_array)
    } else {
        None
    };
    let empty = Vec::new();
    let items = rows.unwrap_or(&empty);
    let mut checks = Vec::new();
    let mut all_active = true;
    for scheme in ["kanzo", "memorycore"] {
        let matches = items
            .iter()
            .filter(|v| v.get("id").and_then(Value::as_str) == Some(scheme))
            .collect::<Vec<_>>();
        let unique = matches.len() == 1;
        let active = unique && matches[0].get("active").and_then(Value::as_bool) == Some(true);
        let state = if unique {
            matches[0]
                .get("status")
                .cloned()
                .unwrap_or(json!("unknown"))
        } else {
            json!("missing_or_ambiguous")
        };
        checks.push(json!({"scheme":scheme,"unique":unique,"active":active,"state":state}));
        all_active &= active;
    }
    let complete = inventory.get("truncated").and_then(Value::as_bool) == Some(false);
    json!({"schema":"singularity-option2-repoql-connectors/v1", "registryComplete":complete,
        "inventoryAvailable":available,"connectorChecks":checks,
        "bothConnectorsActive":available && complete && all_active,
        "liveMcpCallsVerified":false,"releaseReady":false})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn connector_dupes_and_missing_are_refused() {
        let good = json!({"available":true,"truncated":false,"connectors":[
            {"id":"kanzo","active":true,"status":"ok"},
            {"id":"memorycore","active":true,"status":"ok"}]});
        assert_eq!(evaluate(&good)["bothConnectorsActive"], true);
        assert_eq!(evaluate(&good)["releaseReady"], false);
        let mut bad = good.clone();
        bad["connectors"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"kanzo","active":true}));
        assert_eq!(evaluate(&bad)["bothConnectorsActive"], false);
    }
}
