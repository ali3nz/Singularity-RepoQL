//! JSON protocol intended for golden-testing Rust ports against the source JavaScript.
//! This module is deliberately offline and has no production side effects.
use crate::{
    bridge, deviation, doc_impact, effort, engine_router, engine_state, gate, nanny_observe,
    no_change, payload, phase_driver, run_summary, scope, worker,
};
use serde_json::{json, Value};

pub fn execute(request: &Value) -> Value {
    let op = request.get("op").and_then(Value::as_str).unwrap_or("");
    let options = request.get("options").cloned().unwrap_or_else(|| json!({}));
    match op {
        "nanny.observe" => nanny_observe::observe(request),
        "phase_driver.parse_progress" => {
            phase_driver::parse_progress(request.get("raw").unwrap_or(&Value::Null))
        }
        "phase_driver.compare" => json!(phase_driver::compare(
            request.get("a").unwrap_or(&Value::Null),
            request.get("b").unwrap_or(&Value::Null)
        )),
        "phase_driver.evaluate" => phase_driver::evaluate(request),
        "engine_state.claude_allowed" => json!(engine_state::claude_allowed(
            request.get("runMode").and_then(Value::as_str).unwrap_or(""),
            request.get("role").and_then(Value::as_str).unwrap_or("")
        )),
        "engine_router.normalize" => json!(engine_router::normalize_engine(
            request.get("engine").and_then(Value::as_str).unwrap_or("")
        )),
        "engine_router.caller" => json!(engine_router::resolve_caller(
            request.get("env").unwrap_or(&Value::Null)
        )),
        "engine_router.authority" => engine_router::caller_authority(
            request.get("engine").and_then(Value::as_str).unwrap_or(""),
            request
                .get("caller")
                .and_then(Value::as_str)
                .unwrap_or("legacy"),
        ),
        "engine_router.is_premium" => json!(engine_router::is_premium(
            request.get("engine").and_then(Value::as_str).unwrap_or("")
        )),
        "engine_router.authority_stage" => json!(engine_router::authority_stage(
            request.get("stage").and_then(Value::as_str).unwrap_or("")
        )),
        "engine_router.role_chains" => {
            engine_router::role_chains(request.get("cfg").unwrap_or(&Value::Null))
        }
        "engine_router.get_chain" => engine_router::get_chain(
            request.get("cfg").unwrap_or(&Value::Null),
            request.get("role").and_then(Value::as_str).unwrap_or(""),
        ),
        "engine_router.fallbacks" => {
            engine_router::fallbacks(request.get("confidential") == Some(&Value::Bool(true)))
        }
        "engine_router.free_filter" => engine_router::apply_free_only_filter(
            request.get("candidates").unwrap_or(&Value::Null),
            request.get("freeOnly") == Some(&Value::Bool(true)),
            request
                .get("requestedEngine")
                .and_then(Value::as_str)
                .unwrap_or("auto"),
        ),
        "engine_router.resolve_role" => engine_router::resolve_role(
            request.get("stage").and_then(Value::as_str).unwrap_or(""),
            request.get("caseState").unwrap_or(&Value::Null),
        ),
        "engine_router.engine_model" => engine_router::engine_model(
            request.get("engine").and_then(Value::as_str).unwrap_or(""),
            request.get("cfg").unwrap_or(&Value::Null),
        ),
        "deviation.classify" => deviation::classify(
            request.get("kind").unwrap_or(&Value::Null),
            request.get("detail").unwrap_or(&Value::Null),
        ),
        "doc_impact.classify" => {
            doc_impact::classify(request.get("changedFiles").unwrap_or(&Value::Null))
        }
        "doc_impact.render" => {
            doc_impact::render(request.get("classification").unwrap_or(&Value::Null))
        }
        "run_summary.build" => run_summary::build(request.get("inputs").unwrap_or(&Value::Null)),
        "no_change.can_reuse" => {
            no_change::can_reuse(request.get("values").unwrap_or(&Value::Null))
        }
        "no_change.hash_text" => json!(no_change::hash_text(
            request.get("text").and_then(Value::as_str).unwrap_or("")
        )),
        "worker.parse" => worker::parse(request.get("text").and_then(Value::as_str).unwrap_or("")),
        "worker.extract" => worker::extract(request.get("texts").unwrap_or(&Value::Null)),
        "worker.validate" => json!(worker::validate(
            request.get("record").unwrap_or(&Value::Null)
        )),
        "worker.decision" => worker::decision(request.get("extraction").unwrap_or(&Value::Null)),
        "scope.parse" => json!(scope::parse(
            request.get("text").and_then(Value::as_str).unwrap_or("")
        )),
        "scope.overlaps" => json!(scope::overlaps(
            request.get("a").unwrap_or(&Value::Null),
            request.get("b").unwrap_or(&Value::Null)
        )),
        "scope.decision" => scope::decision(
            request.get("mine").unwrap_or(&Value::Null),
            request.get("others").unwrap_or(&Value::Null),
        ),
        "gate.validate" => gate::validate(
            request.get("gate").cloned().unwrap_or(Value::Null),
            request.get("stage").and_then(Value::as_str).unwrap_or(""),
        ),
        "gate.parse" => match gate::parse(
            request.get("text").and_then(Value::as_str).unwrap_or(""),
            request.get("stage").and_then(Value::as_str).unwrap_or(""),
        ) {
            Ok(v) => v,
            Err(e) => json!({"error":e,"rc":47}),
        },
        "gate.writes_allowed" => json!(gate::writes_allowed(
            request.get("gate").unwrap_or(&Value::Null)
        )),
        "gate.fix_allowed" => json!(gate::fix_allowed(
            request.get("gate").unwrap_or(&Value::Null)
        )),
        "effort.top_variant" => json!(effort::top_variant(
            request.get("variants").unwrap_or(&Value::Null)
        )),
        "effort.resolve" => effort::resolve(
            request.get("model").and_then(Value::as_str).unwrap_or(""),
            &options,
        ),
        "effort.is_exempt" => json!(effort::is_exempt_model(
            request.get("model").and_then(Value::as_str).unwrap_or(""),
            options.get("exempt")
        )),
        "effort.rejection" => json!(effort::is_variant_rejection(
            request.get("text").and_then(Value::as_str).unwrap_or("")
        )),
        "effort.variant_flag" => json!(effort::variant_flag(
            request.get("variant").and_then(Value::as_str).unwrap_or("")
        )),
        "payload.budget" => payload::budget(request.get("files").unwrap_or(&Value::Null), &options),
        "payload.sha256" => json!(payload::sha256_of(
            request.get("text").and_then(Value::as_str).unwrap_or("")
        )),
        "payload.split" => match payload::split(
            request.get("text").and_then(Value::as_str).unwrap_or(""),
            request.get("cap").and_then(Value::as_u64).unwrap_or(8000) as usize,
        ) {
            Ok(chunks) => json!(chunks),
            Err(error) => json!({"error":error}),
        },
        "bridge.failure_class" => json!(bridge::failure_class(
            request.get("rc").and_then(Value::as_i64).unwrap_or(1)
        )),
        "bridge.premium_eligible" => json!(bridge::premium_eligible(
            request.get("value").unwrap_or(&Value::Null)
        )),
        "bridge.classify" => bridge::classify(
            request.get("result").unwrap_or(&Value::Null),
            request.get("engine").and_then(Value::as_str).unwrap_or(""),
        ),
        _ => json!({"error":"unsupported compat operation"}),
    }
}
