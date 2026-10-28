//! Pure reasoning-effort helpers migrated from kit/lib/effort.mjs.
//! Provider execution itself remains under the existing JS authority.
use regex::Regex;
use serde_json::{json, Value};

const ORDER: &[&str] = &["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const EXEMPT: &[&str] = &["claude-pro/claude-sonnet-*", "claude-pro/claude-opus-*"];

fn default_baked(model: &str) -> Option<&'static str> {
    match model {
        "openai/gpt-6-luna" | "openai/gpt-6-sol" => Some("max"),
        "opencode/muse-spark-1.3-contributor-free" => Some("xhigh"),
        "freebuff/glm-5.3-flash-max" => Some("high"),
        "claude-pro/claude-haiku-4-5"
        | "claude-pro/claude-fable-5"
        | "claude-pro/claude-fable-5-1"
        | "opencode/space-bunny-free" => Some("max"),
        _ => None,
    }
}

pub fn top_variant(variants: &Value) -> Option<String> {
    let values: Vec<String> = match variants {
        Value::Array(a) => a
            .iter()
            .map(|v| match v {
                Value::String(s) => s.to_lowercase(),
                _ => v.to_string().to_lowercase(),
            })
            .collect(),
        Value::Object(o) => o.keys().map(|k| k.to_lowercase()).collect(),
        _ => Vec::new(),
    };
    values
        .iter()
        .filter_map(|v| ORDER.iter().position(|x| x == v).map(|rank| (rank, v)))
        .max_by_key(|(rank, _)| *rank)
        .map(|(_, v)| v.clone())
}

fn glob_matches(model: &str, glob: &str) -> bool {
    let mut pattern = String::from("(?i)^");
    for ch in glob.chars() {
        match ch {
            '*' => pattern.push_str(".*"),
            '?' => pattern.push('.'),
            _ => pattern.push_str(&regex::escape(&ch.to_string())),
        }
    }
    pattern.push('$');
    Regex::new(&pattern)
        .map(|r| r.is_match(model))
        .unwrap_or(false)
}

pub fn is_exempt_model(model: &str, globs: Option<&Value>) -> bool {
    let base = model.split('#').next().unwrap_or(model);
    match globs {
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(Value::as_str)
            .any(|g| glob_matches(base, g)),
        Some(Value::Null) => false,
        Some(_) => false,
        None => EXEMPT.iter().any(|g| glob_matches(base, g)),
    }
}

pub fn resolve(model: &str, options: &Value) -> Value {
    let base = model.split('#').next().unwrap_or(model);
    if options.get("enforce") == Some(&Value::Bool(false)) {
        return json!({"variant":null,"reason":"enforce-off"});
    }
    if is_exempt_model(base, options.get("exempt")) {
        return json!({"variant":null,"reason":"exempt"});
    }
    if let Some(catalog) = options.get("catalog").and_then(Value::as_object) {
        if let Some(values) = catalog.get(base) {
            if let Some(v) = top_variant(values) {
                return json!({"variant":if v=="none" {None} else {Some(v)},"reason":"catalog"});
            }
            return json!({"variant":null,"reason":"no-variants"});
        }
    }
    let chosen = if let Some(baked) = options.get("baked").and_then(Value::as_object) {
        baked.get(base).and_then(Value::as_str)
    } else {
        default_baked(base)
    };
    match chosen {
        Some(v) if !v.is_empty() => json!({"variant":v,"reason":"baked-table"}),
        _ => json!({"variant":null,"reason":"no-variants"}),
    }
}

pub fn variant_flag(value: &str) -> String {
    if !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        format!("--variant '{value}'")
    } else {
        String::new()
    }
}

pub fn is_variant_rejection(value: &str) -> bool {
    let t = value.to_lowercase();
    (t.contains("variant") || t.contains("reasoning_effort") || t.contains("reasoning effort"))
        && [
            "unknown",
            "invalid",
            "unsupported",
            "not supported",
            "not a valid",
            "rejected",
            "unrecognized",
        ]
        .iter()
        .any(|w| t.contains(w))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn picks_highest_variant() {
        assert_eq!(
            top_variant(&json!(["none", "high", "xhigh", "low"])),
            Some("xhigh".into())
        );
        assert_eq!(top_variant(&json!(["nonsense"])), None);
        assert_eq!(
            resolve("claude-pro/claude-sonnet-5#high", &json!({}))["reason"],
            "exempt"
        );
        assert_eq!(resolve("openai/gpt-6-sol", &json!({}))["variant"], "max");
    }
    #[test]
    fn rejects_unsafe_flags() {
        assert_eq!(variant_flag("high"), "--variant 'high'");
        assert_eq!(variant_flag("high;rm -rf"), "");
    }
}
