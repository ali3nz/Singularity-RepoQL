//! Native Windows install variants. This is the same policy file consumed by
//! the dashboard backend, preventing the Rust installer and UI from drifting.
use serde_json::{json, Value};

const VARIANTS: &str = include_str!("../../windows/variants.json");

pub fn profile(id: &str) -> Result<Value, &'static str> {
    let policy: Value =
        serde_json::from_str(VARIANTS).map_err(|_| "invalid embedded variant manifest")?;
    let row = policy
        .get("variants")
        .and_then(|v| v.get(id))
        .ok_or("only Claude Code Full is supported")?;
    Ok(
        json!({"schema": 1, "variant": id.parse::<u8>().map_err(|_| "invalid variant number")?, "platform": "windows-native", "gui": row["gui"], "features": row["features"], "rustOfficeFeature": row["rustOfficeFeature"], "rustGhostFeature": row["rustGhostFeature"]}),
    )
}

pub fn run() -> i32 {
    let mut args = std::env::args().skip(2);
    match (args.next(), args.next()) {
        (Some(id), None) => match profile(&id) {
            Ok(result) => {
                println!("{result}");
                0
            }
            Err(message) => {
                eprintln!("{message}");
                2
            }
        },
        _ => {
            eprintln!("usage: singularity-desktop-bridge variant 2");
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn variants_match_public_release_contract() {
        for id in ["2"] {
            let p = profile(id).unwrap();
            for key in [
                "repoql_dashboard",
                "tencent_connector",
                "kanban",
                "agent_chat",
                "kanzo",
                "openmausbot",
                "memory",
                "office",
                "repoql_mcp",
            ] {
                assert_eq!(p["features"][key], true);
            }
            assert_eq!(p["features"]["ghost"], false);
            assert_eq!(p["rustOfficeFeature"], true);
            assert_eq!(p["gui"], "claude-desktop-code");
        }
        assert!(profile("1").is_err());
        assert!(profile("0").is_err());
        assert!(profile("5").is_err());
    }
}
