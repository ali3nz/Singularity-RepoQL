//! Gate validation port from kit/lib/gate-parser.mjs.
//! All authorization decisions remain in JavaScript until golden and runtime parity are accepted.
use regex::Regex;
use serde_json::{json, Map, Value};
const SCHEMA: &str = "orchestration-gate-v2";
const MEMORY: &[&str] = &[
    "verify",
    "amend",
    "reject",
    "duplicate",
    "case_only",
    "needs_operator",
    "supersede_existing",
];

fn string<'a>(o: &'a Value, k: &str) -> &'a str {
    o.get(k).and_then(Value::as_str).unwrap_or("")
}
fn in_set(s: &str, vals: &[&str]) -> bool {
    vals.contains(&s)
}
fn nonempty_arr(o: &Value, k: &str) -> bool {
    o.get(k)
        .and_then(Value::as_array)
        .map(|x| !x.is_empty())
        .unwrap_or(false)
}
fn reject(g: &Value, error: String) -> Value {
    json!({"valid":false,"error":error,"gate":g})
}
fn levenshtein(a: &str, b: &str) -> usize {
    let right: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=right.len()).collect();
    for (i, left) in a.chars().enumerate() {
        let mut cur = vec![i + 1];
        for (j, rightc) in right.iter().enumerate() {
            cur.push(std::cmp::min(
                std::cmp::min(prev[j + 1] + 1, cur[j] + 1),
                prev[j] + usize::from(left != *rightc),
            ));
        }
        prev = cur;
    }
    prev[right.len()]
}
fn normalize(g: &mut Value) {
    let Some(o) = g.as_object_mut() else { return };
    for (bad, good) in [("setp", "step"), ("phaess", "phases")] {
        if let Some(v) = o.remove(bad) {
            o.insert(good.into(), v);
        }
    }
    for k in ["plan", "phases", "discoveryRequests", "fixPlan", "findings"] {
        if let Some(Value::Array(v)) = o.get_mut(k) {
            for e in v {
                if let Some(m) = e.as_object_mut() {
                    for (bad, good) in [("setp", "step"), ("phaess", "phases")] {
                        if let Some(v) = m.remove(bad) {
                            m.insert(good.into(), v);
                        }
                    }
                }
            }
        }
    }
}
fn tolerate_schema(g: &mut Value) {
    let Some(o) = g.as_object_mut() else { return };
    let Some(s) = o.get("schema").and_then(Value::as_str) else {
        return;
    };
    let flat: String = s
        .to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    let expected = "orchestrationgatev2";
    if flat == expected
        || (flat.len().abs_diff(expected.len()) <= 1 && levenshtein(&flat, expected) <= 1)
    {
        o.insert("schema".into(), json!(SCHEMA));
    }
}
fn escape_invalid(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c != '\\' {
            out.push(c);
            i += 1;
            continue;
        }
        if i + 1 >= chars.len() {
            out.push_str("\\\\");
            break;
        }
        let next = chars[i + 1];
        if matches!(next, '\\' | '/' | '"' | 'b' | 'f' | 'n' | 'r' | 't') {
            out.push('\\');
            out.push(next);
            i += 2;
            continue;
        }
        if next == 'u'
            && i + 5 < chars.len()
            && chars[i + 2..=i + 5].iter().all(|c| c.is_ascii_hexdigit())
        {
            out.push('\\');
            out.push('u');
            i += 2;
            continue;
        }
        out.push_str("\\\\");
        i += 1;
    }
    out
}
fn is_struct(c: char) -> bool {
    matches!(c, ',' | '}' | ']' | ':')
}
fn repair_quotes(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut inside = false;
    let mut last = '\0';
    let mut stack: Vec<char> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if inside {
            if c == '\\' {
                out.push(c);
                if i + 1 < chars.len() {
                    i += 1;
                    out.push(chars[i]);
                }
                i += 1;
                continue;
            }
            if c == '"' {
                let mut j = i + 1;
                while j < chars.len() && chars[j].is_whitespace() {
                    j += 1;
                }
                if j == chars.len() || is_struct(chars[j]) {
                    inside = false;
                    out.push(c);
                } else {
                    out.push_str("\\\"");
                }
                i += 1;
                continue;
            }
            out.push(c);
            i += 1;
            continue;
        }
        if c == '"' {
            if last == ':' || last == '[' || (last == ',' && stack.last() == Some(&'[')) {
                inside = true;
                out.push(c);
                i += 1;
                continue;
            }
            out.push(c);
            i += 1;
            while i < chars.len() {
                let key = chars[i];
                out.push(key);
                if key == '\\' && i + 1 < chars.len() {
                    i += 1;
                    out.push(chars[i]);
                } else if key == '"' {
                    break;
                }
                i += 1;
            }
            i += 1;
            continue;
        }
        if c == '{' || c == '[' {
            stack.push(c);
        } else if c == '}' || c == ']' {
            stack.pop();
        }
        if !c.is_whitespace() {
            last = c;
        }
        out.push(c);
        i += 1;
    }
    out
}

pub fn validate(mut g: Value, stage: &str) -> Value {
    if stage != "plan" {
        let mapped = match string(&g, "verdict") {
            "REMEDIATION_REQUIRED" | "REQUEST_CHANGES" | "request_changes" => Some("NEEDS_FIX"),
            "NEEDS_HUMAN_REVIEW" => Some("BLOCKED"),
            "approve" | "approved" | "ACCEPTED" | "ACCEPTED_WITH_NOTES" => Some("APPROVED"),
            _ => None,
        };
        if let Some(v) = mapped {
            if let Some(o) = g.as_object_mut() {
                o.insert("verdict".into(), json!(v));
            }
        }
    }
    let verdict = string(&g, "verdict").to_string();
    let eligible = if stage == "plan" {
        vec!["APPROVED", "NEEDS_DISCOVERY", "BLOCKED"]
    } else {
        vec!["APPROVED", "NEEDS_FIX", "NEEDS_EVIDENCE", "BLOCKED"]
    };
    if !eligible.contains(&verdict.as_str()) {
        return reject(
            &g,
            format!("verdict {} not in {}", verdict, eligible.join(",")),
        );
    }
    if stage == "plan" {
        let risk = string(&g, "risk");
        if !in_set(risk, &["LOW", "NORMAL", "HIGH", "CRITICAL"]) {
            return reject(&g, format!("risk {risk} invalid"));
        }
        let signoff = string(&g, "planSignoff");
        if verdict == "APPROVED" && signoff != "APPROVED" {
            return reject(&g, "verdict APPROVED requires planSignoff APPROVED".into());
        }
        if verdict != "APPROVED" && signoff == "APPROVED" {
            return reject(
                &g,
                format!("verdict {verdict} must have planSignoff NOT_APPROVED"),
            );
        }
        if verdict == "APPROVED" && !nonempty_arr(&g, "plan") {
            return reject(&g, "APPROVED plan requires non-empty plan[]".into());
        }
        if verdict == "NEEDS_DISCOVERY" && !nonempty_arr(&g, "discoveryRequests") {
            return reject(&g, "NEEDS_DISCOVERY requires discoveryRequests[]".into());
        }
    }
    if stage == "review" {
        if let Some(dispositions) = g.get("memoryDispositions") {
            if !dispositions.is_null() {
                let Some(entries) = dispositions.as_array() else {
                    return reject(&g, "memoryDispositions must be an array".into());
                };
                for entry in entries {
                    if !entry.is_object() {
                        return reject(&g, "memoryDispositions entries must be objects".into());
                    }
                    let candidate = string(entry, "candidateId");
                    if candidate.len() != 6
                        || !candidate.starts_with("MC")
                        || !candidate[2..].bytes().all(|b| b.is_ascii_digit())
                    {
                        return reject(
                            &g,
                            format!("memoryDispositions candidateId invalid: {candidate}"),
                        );
                    }
                    let disposition = string(entry, "disposition");
                    if !MEMORY.contains(&disposition) {
                        return reject(
                            &g,
                            format!("memoryDispositions disposition invalid: {disposition}"),
                        );
                    }
                }
            }
        }
        let signoff = string(&g, "fixPlanSignoff");
        if verdict == "APPROVED" && signoff != "NOT_REQUIRED" {
            return reject(
                &g,
                "verdict APPROVED requires fixPlanSignoff NOT_REQUIRED".into(),
            );
        }
        if verdict == "NEEDS_FIX" {
            if signoff != "APPROVED" {
                return reject(
                    &g,
                    "NEEDS_FIX requires fixPlanSignoff APPROVED (signed fix plan in same response)"
                        .into(),
                );
            }
            if !nonempty_arr(&g, "fixPlan") {
                return reject(&g, "NEEDS_FIX requires non-empty fixPlan[]".into());
            }
        }
        if verdict == "NEEDS_EVIDENCE" && signoff == "APPROVED" {
            return reject(
                &g,
                "NEEDS_EVIDENCE must not carry an approved fix plan".into(),
            );
        }
    }
    json!({"valid":true,"gate":g})
}

pub fn try_v2(text: &str, stage: &str) -> Option<Value> {
    let mut t = text.trim();
    let fence = Regex::new(r"```(?:json)?\s*([\s\S]*?)```").ok()?;
    if let Some(capture) = fence.captures(t) {
        if let Some(content) = capture.get(1) {
            t = content.as_str().trim();
        }
    }
    let a = t.find('{')?;
    let b = t.rfind('}')?;
    if b <= a {
        return None;
    }
    let slice = &t[a..=b];
    let quotes = repair_quotes(slice);
    let candidates = [
        slice.to_string(),
        escape_invalid(slice),
        quotes.clone(),
        escape_invalid(&quotes),
    ];
    let mut parsed = None;
    for cand in candidates {
        if let Ok(v) = serde_json::from_str::<Value>(&cand) {
            parsed = Some(v);
            break;
        }
    }
    let mut g = parsed?;
    if !g.is_object() {
        return None;
    }
    tolerate_schema(&mut g);
    normalize(&mut g);
    if string(&g, "schema") != SCHEMA || string(&g, "stage") != stage {
        return None;
    }
    Some(validate(g, stage))
}

pub fn try_legacy(text: &str, stage: &str) -> Option<Value> {
    let re=Regex::new(r#"(?i)VERDICT:?\s*[`*_'"\s]*\**\s*(APPROVED|NEEDS_WORK|NEEDS_EVIDENCE|CONFIRMED|CONTRADICTED|UNCERTAIN)"#).ok()?;
    let m = re.captures(text)?.get(1)?.as_str().to_ascii_uppercase();
    let approved = m == "APPROVED" || m == "CONFIRMED";
    let mapped = if approved {
        "APPROVED"
    } else if m == "NEEDS_WORK" {
        if stage == "plan" {
            "NEEDS_DISCOVERY"
        } else {
            "NEEDS_FIX"
        }
    } else if stage != "plan" && m == "NEEDS_EVIDENCE" {
        "NEEDS_EVIDENCE"
    } else {
        "BLOCKED"
    };
    let mut result = Map::new();
    result.insert("schema".into(), json!("legacy"));
    result.insert("stage".into(), json!(stage));
    result.insert("verdict".into(), json!(mapped));
    result.insert("legacyText".into(), json!(text));
    result.insert("compatibilityMode".into(), json!(true));
    if stage == "plan" && !approved {
        result.insert("valid".into(), json!(true));
    }
    Some(Value::Object(result))
}

pub fn parse(text: &str, stage: &str) -> Result<Value, String> {
    if let Some(mut v) = try_v2(text, stage) {
        if let Some(o) = v.as_object_mut() {
            o.insert("compatibilityMode".into(), json!(false));
        }
        return Ok(v);
    }
    if let Some(v) = try_legacy(text, stage) {
        return Ok(v);
    }
    Err(format!("invalid gate response for stage={stage}"))
}

pub fn writes_allowed(g: &Value) -> bool {
    string(g, "verdict") == "APPROVED" && string(g, "planSignoff") == "APPROVED"
}
pub fn fix_allowed(g: &Value) -> bool {
    string(g, "verdict") == "NEEDS_FIX" && string(g, "fixPlanSignoff") == "APPROVED"
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn plan_guards_and_aliases() {
        let g = json!({"schema":SCHEMA,"stage":"plan","verdict":"APPROVED","risk":"NORMAL","planSignoff":"APPROVED","plan":[{"setp":1}]});
        let v = parse(&g.to_string(), "plan").unwrap();
        assert_eq!(v["valid"], true);
        assert_eq!(v["gate"]["plan"][0]["step"], 1);
        assert!(writes_allowed(&v["gate"]));
        let v = validate(
            json!({"verdict":"APPROVED","risk":"NORMAL","planSignoff":"NOT_APPROVED","plan":[1]}),
            "plan",
        );
        assert_eq!(v["valid"], false);
    }
    #[test]
    fn review_safety() {
        let v = validate(
            json!({"verdict":"REMEDIATION_REQUIRED","fixPlanSignoff":"APPROVED","fixPlan":[1]}),
            "review",
        );
        assert_eq!(v["valid"], true);
        assert!(fix_allowed(&v["gate"]));
        assert_eq!(
            validate(
                json!({"verdict":"NEEDS_FIX","fixPlanSignoff":"NOT_REQUIRED"}),
                "review"
            )["valid"],
            false
        );
    }
}
