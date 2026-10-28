//! Deterministic engine routing helpers from kit/lib/engine-router.mjs.
//! This does NOT perform calls, mutate engine-state, acquire authority,
//! choose eligible providers under live state, or replace JS routing.
use serde_json::{json, Value};

const FREE: [&str; 6] = [
    "opencode-muse-free",
    "opencode-longcat",
    "opencode-space-bunny",
    "opencode-ling31",
    "openrouter-laguna-free",
    "openrouter-sante-free",
];
const VISION: [&str; 3] = [
    "opencode-muse-free",
    "opencode-longcat",
    "opencode-space-bunny",
];
const SOL_PLUS_FREE: [&str; 7] = [
    "openai-sol",
    "opencode-muse-free",
    "opencode-longcat",
    "opencode-space-bunny",
    "opencode-ling31",
    "openrouter-laguna-free",
    "openrouter-sante-free",
];

pub fn normalize_engine(engine: &str) -> &str {
    match engine {
        "openrouter-glm" => "openrouter-paid-reasoning",
        "sol" | "openai" => "openai-sol",
        _ => engine,
    }
}

fn is_premium_raw(engine: &str) -> bool {
    matches!(
        engine,
        "openai-sol" | "codex" | "cursor" | "openrouter-paid-reasoning"
    )
}

pub fn is_premium(engine: &str) -> bool {
    is_premium_raw(engine)
}

fn canonical_caller(raw: &str) -> &str {
    match raw {
        "coordinator" | "openchamber" | "opencode" => "coordinator",
        "buffy" => "buffy",
        "worker" => "worker",
        _ => "legacy",
    }
}

pub fn resolve_caller(env: &Value) -> String {
    let raw = env.get("ORCH_CALLER").filter(|v| !v.is_null());
    let text = match raw {
        None => "legacy".to_owned(),
        Some(Value::String(s)) => s.to_lowercase(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Array(_)) => "".to_owned(),
        Some(Value::Object(_)) => "[object object]".to_owned(),
        Some(Value::Null) => "legacy".to_owned(),
    };
    canonical_caller(&text).to_owned()
}

pub fn caller_authority(engine: &str, caller: &str) -> Value {
    let engine = normalize_engine(engine);
    if caller != "coordinator" {
        return json!({"allowed":true,"caller":caller});
    }
    if is_premium_raw(engine) {
        return json!({"allowed":false,"caller":caller,"rc":49,
          "error":format!("authority denied: caller=coordinator may not invoke premium engine \"{engine}\" (ticket 076 Option A) — route technical consultation through the requester")});
    }
    json!({"allowed":true,"caller":caller})
}

pub fn authority_stage(stage: &str) -> bool {
    matches!(stage, "plan" | "review" | "final-acceptance")
}

fn defaults() -> Value {
    json!({
        "NORMAL": FREE,
        "IMPLEMENTATION": FREE,
        "VISION": VISION,
        "PREMIUM_REASONING": SOL_PLUS_FREE,
        "PLANNER": SOL_PLUS_FREE,
        "REVIEW": SOL_PLUS_FREE,
        "FINAL_ACCEPTANCE": SOL_PLUS_FREE,
        "CONSULT": SOL_PLUS_FREE
    })
}

pub fn role_chains(cfg: &Value) -> Value {
    match cfg.pointer("/routing/roleChains") {
        Some(Value::Null) | None => defaults(),
        Some(v) => v.clone(),
    }
}

pub fn get_chain(cfg: &Value, role: &str) -> Value {
    if let Some(chain) = cfg.pointer("/routing/roleChains").and_then(|v| v.get(role)) {
        if let Some(arr) = chain.as_array() {
            if !arr.is_empty() {
                return Value::Array(arr.clone());
            }
        }
    }
    match role {
        "VISION" => json!(VISION),
        "PREMIUM_REASONING" => json!(SOL_PLUS_FREE),
        _ => json!(FREE),
    }
}

pub fn fallbacks(confidential: bool) -> Value {
    if confidential {
        json!([])
    } else {
        json!(FREE)
    }
}

pub fn apply_free_only_filter(
    candidates: &Value,
    free_only: bool,
    requested_engine: &str,
) -> Value {
    if !free_only || requested_engine != "auto" {
        return candidates.clone();
    }
    match candidates.as_array() {
        Some(list) => Value::Array(
            list.iter()
                .filter(|e| e.as_str() != Some("opencode-managed-muse"))
                .cloned()
                .collect(),
        ),
        None => Value::Null, // only arrays are admitted to this offline protocol
    }
}

pub fn resolve_role(stage: &str, case_state: &Value) -> Value {
    if let Some(role) = case_state.get("role") {
        let truthy = match role {
            Value::Null => false,
            Value::Bool(b) => *b,
            Value::Number(n) => n.as_f64().is_some_and(|v| v != 0.0),
            Value::String(s) => !s.is_empty(),
            _ => true,
        };
        if truthy {
            return role.clone();
        }
    }
    json!(match stage {
        "ask"
            if case_state
                .get("visionRequired")
                .is_some_and(|v| v != &Value::Bool(false)
                    && !v.is_null()
                    && v != &json!(0)
                    && v != &json!("")) =>
            "VISION",
        "ask" => "NORMAL",
        "final-acceptance" => "FINAL_ACCEPTANCE",
        "plan" => "PLANNER",
        "consult" => "CONSULT",
        "review" => "REVIEW",
        _ => "NORMAL",
    })
}

fn lookup_or(cfg: &Value, pointer: &str, fallback: Value) -> Value {
    cfg.pointer(pointer)
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(fallback)
}

pub fn engine_model(engine: &str, cfg: &Value) -> Value {
    match normalize_engine(engine) {
        "opencode-nemotron" => lookup_or(cfg, "/opencode/textModel", Value::Null),
        "opencode-space-bunny" => lookup_or(
            cfg,
            "/opencode/textModel",
            json!("opencode/space-bunny-free"),
        ),
        "opencode-ling31" => lookup_or(
            cfg,
            "/opencode/lingModel",
            json!("opencode/ling-3.1-flash-free"),
        ),
        "opencode-longcat" => lookup_or(
            cfg,
            "/opencode/longcatModel",
            json!("opencode/longcat-2.5-preview-free"),
        ),
        "opencode-muse" => lookup_or(
            cfg,
            "/opencode/museModel",
            lookup_or(cfg, "/opencode/textModelFallback", Value::Null),
        ),
        "opencode-muse-free" => lookup_or(
            cfg,
            "/opencode/museModel",
            json!("opencode/muse-spark-1.3-contributor-free"),
        ),
        "openrouter-laguna-free" => lookup_or(
            cfg,
            "/openrouter/lagunaFreeModel",
            json!("poolside/laguna-s-2.1:free"),
        ),
        "openrouter-sante-free" => lookup_or(
            cfg,
            "/openrouter/santeFreeModel",
            json!("inclusionai/ling-3.0-flash-sante:free"),
        ),
        "opencode-managed-muse" => lookup_or(
            cfg,
            "/opencode/managedMuseModel",
            json!("opencode-go/muse-spark-1.3-contributor#xhigh"),
        ),
        "openai-sol" => lookup_or(cfg, "/openaiSol/model", json!("catgpt-browser")),
        "fcc-ghost-vision" => lookup_or(
            cfg,
            "/fccGhost/visionModel",
            json!("nvidia_nim/meta/llama-3.2-11b-vision-instruct"),
        ),
        _ => Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn aliases_and_coordinator_boundary() {
        assert_eq!(
            normalize_engine("openrouter-glm"),
            "openrouter-paid-reasoning"
        );
        assert_eq!(caller_authority("sol", "coordinator")["allowed"], false);
        assert_eq!(
            caller_authority("openrouter-glm", "worker")["allowed"],
            true
        );
        assert_eq!(
            resolve_caller(&json!({"ORCH_CALLER":"OpenChamber"})),
            "coordinator"
        );
    }
    #[test]
    fn intentional_split_between_default_chains_and_chain_fallbacks() {
        assert_eq!(role_chains(&json!({}))["REVIEW"][0], "openai-sol");
        assert_eq!(get_chain(&json!({}), "REVIEW")[0], "opencode-muse-free");
        assert_eq!(
            get_chain(
                &json!({"routing":{"roleChains":{"REVIEW":["codex"]}}}),
                "REVIEW"
            )[0],
            "codex"
        );
    }
    #[test]
    fn free_only_never_removes_pins() {
        assert_eq!(
            apply_free_only_filter(
                &json!(["opencode-managed-muse", "openai-sol"]),
                true,
                "auto"
            ),
            json!(["openai-sol"])
        );
        assert_eq!(
            apply_free_only_filter(
                &json!(["opencode-managed-muse"]),
                true,
                "opencode-managed-muse"
            ),
            json!(["opencode-managed-muse"])
        );
    }
}
