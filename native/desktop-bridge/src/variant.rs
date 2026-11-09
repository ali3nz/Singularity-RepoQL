//! Native Windows install variants. This is the same policy file consumed by
//! the dashboard backend, preventing the Rust installer and UI from drifting.
use serde_json::{json, Value};

const VARIANTS: &str = include_str!("../../windows/variants.json");

pub fn profile(id: &str) -> Result<Value, &'static str> {
    let policy: Value = serde_json::from_str(VARIANTS).map_err(|_| "invalid embedded variant manifest")?;
    let row = policy.get("variants").and_then(|v| v.get(id)).ok_or("option must be 1, 2, 3 or 4")?;
    Ok(json!({"schema": 1, "variant": id.parse::<u8>().map_err(|_| "invalid variant number")?, "platform": "windows-native", "gui": row["gui"], "features": row["features"], "rustOfficeFeature": row["rustOfficeFeature"]}))
}

pub fn run() -> i32 {
    let mut args = std::env::args().skip(2);
    match (args.next(), args.next()) {
        (Some(id), None) => match profile(&id) {
            Ok(result) => { println!("{result}"); 0 },
            Err(message) => { eprintln!("{message}"); 2 }
        },
        _ => { eprintln!("usage: singularity-desktop-bridge variant 1|2|3|4"); 2 }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn variants_match_public_release_contract() {
        for id in ["1", "2", "3", "4"] {
            let p = profile(id).unwrap();
            assert_eq!(p["features"]["repoql_dashboard"], true);
            assert_eq!(p["features"]["tencent_connector"], true);
            assert_eq!(p["features"]["kanban"], true);
            assert_eq!(p["features"]["agent_chat"], true);
            assert_eq!(p["features"]["office"], id == "2" || id == "4");
            assert_eq!(p["rustOfficeFeature"], id == "2" || id == "4");
            assert_eq!(p["features"]["ghost"], false);
            assert_eq!(p["gui"], if id == "1" || id == "2" { "claude-desktop-code" } else { "openchamber-desktop" });
        }
        assert!(profile("0").is_err());
        assert!(profile("5").is_err());
    }
}
