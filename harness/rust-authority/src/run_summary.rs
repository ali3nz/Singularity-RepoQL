//! Pure run-summary string builder from kit/lib/run-summary.mjs.
//! Caller must supply the date to reproduce the JS output deterministically.
//! This port does not write the run-summary.md file.
use crate::deviation::js_text;
use serde_json::{json, Value};

fn nullish<'a>(value: Option<&'a Value>, default: &'a Value) -> &'a Value {
    value.filter(|x| !x.is_null()).unwrap_or(default)
}
fn field_or<'a>(v: &'a Value, key: &str, default: &'a Value) -> &'a Value {
    nullish(v.get(key), default)
}
fn item_list(v: &Value, empty: &str) -> String {
    match v.as_array() {
        Some(items) if !items.is_empty() => items
            .iter()
            .map(|item| format!("- {}", js_text(Some(item))))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => empty.to_owned(),
    }
}
fn objective_slice(value: &str) -> String {
    // JS String.slice(0,1200) operates on UTF-16 code units. Replace an
    // isolated high surrogate with the replacement scalar in Rust output.
    let mut units = 0;
    let mut out = String::new();
    for ch in value.chars() {
        let needed = ch.len_utf16();
        if units + needed > 1200 {
            if units < 1200 {
                out.push('\u{fffd}');
            }
            break;
        }
        out.push(ch);
        units += needed;
    }
    out
}

pub fn build(v: &Value) -> Value {
    let empty = json!("");
    let unknown = json!("unknown");
    let unnumbered = json!("unnumbered");
    let untitled = json!("untitled");
    let pre = json!("unnumbered (pre-rollout)");
    let not_recorded = json!("(not recorded)");
    let date_fallback = json!("DATE_REQUIRED_FOR_PARITY");
    let run_number = v.get("runNumber").filter(|x| !x.is_null());
    let case = field_or(v, "caseId", &unknown);
    let type_default = json!("orchestration");
    let run_type = field_or(v, "runType", &type_default);
    let title = field_or(v, "title", &untitled);
    let headline = if let Some(number) = run_number {
        let n = js_text(Some(number));
        let pad = if n.len() < 3 {
            format!("{}{}", "0".repeat(3 - n.len()), n)
        } else {
            n
        };
        let display = v
            .get("title")
            .filter(|x| !x.is_null())
            .or_else(|| v.get("caseId").filter(|x| !x.is_null()))
            .unwrap_or(&untitled);
        format!("Run {pad} | {}", js_text(Some(display)))
    } else {
        format!(
            "{} {} | {}",
            js_text(Some(run_type)),
            js_text(Some(field_or(v, "caseId", &unnumbered))),
            js_text(Some(title))
        )
    };
    let objective = field_or(v, "objective", &not_recorded);
    let date = field_or(v, "date", &date_fallback);
    let outcome_default = json!("ACCEPTED");
    let outcome = field_or(v, "outcome", &outcome_default);
    let mut lines = vec![
        format!("# {headline}"),
        "".into(),
        "## Identity".into(),
        "".into(),
        format!(
            "- Run number: {}",
            js_text(Some(run_number.unwrap_or(&pre)))
        ),
        format!("- Case ID: {}", js_text(Some(case))),
        format!("- Type: {}", js_text(Some(run_type))),
        format!("- Date: {}", js_text(Some(date))),
        "".into(),
        "## Objective".into(),
        "".into(),
        objective_slice(&js_text(Some(objective))),
        "".into(),
    ];
    for (title, key, fallback) in [
        ("Important decisions", "decisions", "- (none recorded)"),
        (
            "Changed components",
            "changedComponents",
            "- (none recorded)",
        ),
        ("Validation", "validation", "- (none recorded)"),
        ("Known residuals", "residuals", "- (none)"),
        (
            "Durable memory references",
            "memoryRefs",
            "- (no durable knowledge staged)",
        ),
    ] {
        lines.push(format!("## {title}"));
        lines.push(String::new());
        lines.push(item_list(v.get(key).unwrap_or(&empty), fallback));
        lines.push(String::new());
    }
    lines.push("## Final outcome".into());
    lines.push(String::new());
    lines.push(js_text(Some(outcome)));
    lines.push(String::new());
    json!(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pre_rollout_includes_required_sections() {
        let result = build(&json!({"date":"2026-10-24"}));
        let text = result.as_str().unwrap();
        assert!(text.starts_with("# orchestration unnumbered | untitled\n"));
        assert!(text.contains("- Run number: unnumbered (pre-rollout)"));
        assert!(text.ends_with("## Final outcome\n\nACCEPTED\n"));
    }
}
