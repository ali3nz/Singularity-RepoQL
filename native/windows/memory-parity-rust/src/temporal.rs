//! Port of the pure temporal logic in harness/kit/lib/memory-temporal.mjs.
//! Unknown timestamps remain unknown; missing metadata is never synthesized.
use chrono::{DateTime, NaiveDate, NaiveDateTime, SecondsFormat, Utc};
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Match,
    NoMatch,
    Unknown,
    RequiresValidFrom,
    RequiresRecordedAt,
}

impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Match => "MATCH",
            Self::NoMatch => "NO_MATCH",
            Self::Unknown => "UNKNOWN_TEMPORAL_METADATA",
            Self::RequiresValidFrom => "UNKNOWN_TEMPORAL_METADATA_REQUIRES_KNOWN_VALID_FROM",
            Self::RequiresRecordedAt => "UNKNOWN_TEMPORAL_METADATA_REQUIRES_KNOWN_RECORDED_AT",
        }
    }
}

pub fn parse_iso(raw: &str) -> Option<i64> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(raw) {
        return Some(dt.timestamp_millis());
    }
    if let Ok(date) = NaiveDate::parse_from_str(raw, "%Y-%m-%d") {
        return Some(date.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis());
    }
    for format in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f"] {
        if let Ok(date) = NaiveDateTime::parse_from_str(raw, format) {
            return Some(date.and_utc().timestamp_millis());
        }
    }
    None
}

fn to_epoch(value: &Value) -> Option<i64> {
    if let Some(n) = value.as_i64() {
        return Some(n);
    }
    if let Some(n) = value.as_f64() {
        if n.is_finite() && n >= i64::MIN as f64 && n <= i64::MAX as f64 {
            return Some(n as i64);
        }
    }
    value.as_str().and_then(parse_iso)
}

pub fn normalize_optional_timestamp(value: &Value, label: &str) -> Result<Option<String>, String> {
    if value.is_null() || value.as_str() == Some("") {
        return Ok(None);
    }
    let millis = value
        .as_str()
        .and_then(parse_iso)
        .ok_or_else(|| format!("memory-temporal: {label} present but not a valid ISO timestamp"))?;
    let dt = DateTime::<Utc>::from_timestamp_millis(millis)
        .ok_or_else(|| format!("memory-temporal: {label} out of range"))?;
    Ok(Some(dt.to_rfc3339_opts(SecondsFormat::Millis, true)))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Temporal {
    pub valid_from: Option<i64>,
    pub valid_to: Option<i64>,
    pub recorded_at: Option<i64>,
    pub unknown: bool,
}

fn parse_key(body: &str, key: &str) -> Result<Option<i64>, String> {
    let prefix = format!("{key}:");
    let found = body
        .lines()
        .find_map(|line| line.strip_prefix(prefix.as_str()));
    let Some(raw) = found else {
        return Ok(None);
    };
    let raw = raw.trim().trim_matches(|c| c == '\'' || c == '"');
    if raw.is_empty() {
        return Ok(None);
    }
    parse_iso(raw).map(Some).ok_or_else(|| {
        format!("memory-temporal: {key} present but not valid ISO in capsule frontmatter")
    })
}

pub fn extract_temporal(body: &str) -> Result<Temporal, String> {
    let valid_from = parse_key(body, "validFrom")?;
    let valid_to = parse_key(body, "validTo")?;
    let recorded_at = parse_key(body, "recordedAt")?;
    Ok(Temporal {
        unknown: valid_from.is_none() && valid_to.is_none() && recorded_at.is_none(),
        valid_from,
        valid_to,
        recorded_at,
    })
}

pub fn from_value(value: &Value) -> Result<Temporal, String> {
    let read = |key| -> Result<Option<i64>, String> {
        let Some(v) = value.get(key) else {
            return Ok(None);
        };
        if v.is_null() || v.as_str() == Some("") {
            return Ok(None);
        }
        to_epoch(v)
            .map(Some)
            .ok_or_else(|| format!("memory-temporal: candidate {key} present but not ISO"))
    };
    Ok(Temporal {
        valid_from: read("validFrom")?,
        valid_to: read("validTo")?,
        recorded_at: read("recordedAt")?,
        unknown: value
            .get("unknown")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

pub fn candidate_temporal(value: &Value) -> Result<Value, String> {
    let mut out = serde_json::Map::new();
    for key in ["validFrom", "validTo", "recordedAt"] {
        let raw = value.get(key).unwrap_or(&Value::Null);
        out.insert(
            key.to_owned(),
            serde_json::to_value(normalize_optional_timestamp(raw, key)?).unwrap(),
        );
    }
    if let (Some(from), Some(to)) = (
        out.get("validFrom").and_then(Value::as_str),
        out.get("validTo").and_then(Value::as_str),
    ) {
        if from > to {
            return Err(
                "memory-temporal: candidate validFrom <= validTo required when both present"
                    .to_owned(),
            );
        }
    }
    Ok(Value::Object(out))
}

pub fn current_truth(t: Option<&Temporal>, now_ms: i64) -> Verdict {
    let Some(t) = t else {
        return Verdict::Match;
    };
    if t.unknown {
        return Verdict::Match;
    }
    if t.valid_to.is_some_and(|to| now_ms >= to) || t.valid_from.is_some_and(|from| now_ms < from) {
        Verdict::NoMatch
    } else {
        Verdict::Match
    }
}

pub fn historical_truth(t: Option<&Temporal>, as_of: Option<i64>) -> Result<Verdict, String> {
    let Some(t) = t else {
        return Ok(Verdict::Unknown);
    };
    if t.unknown {
        return Ok(Verdict::Unknown);
    }
    let Some(from) = t.valid_from else {
        return Ok(Verdict::RequiresValidFrom);
    };
    let time = as_of.ok_or("memory-temporal: historicalTruth requires a known asOf (ISO)")?;
    Ok(if from > time || t.valid_to.is_some_and(|to| time >= to) {
        Verdict::NoMatch
    } else {
        Verdict::Match
    })
}

pub fn belief_truth(t: Option<&Temporal>, as_of: Option<i64>) -> Result<Verdict, String> {
    let Some(t) = t else {
        return Ok(Verdict::Unknown);
    };
    if t.unknown {
        return Ok(Verdict::Unknown);
    }
    let Some(recorded) = t.recorded_at else {
        return Ok(Verdict::RequiresRecordedAt);
    };
    let time = as_of.ok_or("memory-temporal: beliefTruth requires a known asOf (ISO)")?;
    Ok(if recorded <= time {
        Verdict::Match
    } else {
        Verdict::NoMatch
    })
}

pub fn check(input: &Value) -> Result<Value, String> {
    let temporal = if let Some(value) = input.get("temporal").filter(|v| !v.is_null()) {
        Some(from_value(value)?)
    } else if let Some(body) = input.get("capsuleBody").and_then(Value::as_str) {
        Some(extract_temporal(body)?)
    } else {
        None
    };
    let mode = input
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("current");
    let as_of = input.get("asOf").and_then(to_epoch);
    let verdict = match mode {
        "current" => {
            let now = input
                .get("now")
                .and_then(to_epoch)
                .unwrap_or_else(|| Utc::now().timestamp_millis());
            current_truth(temporal.as_ref(), now)
        }
        "historical" => historical_truth(temporal.as_ref(), as_of)?,
        "belief" => belief_truth(temporal.as_ref(), as_of)?,
        _ => return Err("unknown temporal mode".to_owned()),
    };
    Ok(json!({"ok":true, "verdict":verdict.as_str()}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_unknown_is_legacy_compatible() {
        let t = extract_temporal("---\ncategory: knowledge\n---\nBody").unwrap();
        assert_eq!(current_truth(Some(&t), 1_000), Verdict::Match);
        assert_eq!(
            historical_truth(Some(&t), Some(1_000)).unwrap(),
            Verdict::Unknown
        );
    }
    #[test]
    fn known_windows_and_historical_recovery() {
        let t = extract_temporal("validFrom: 2026-01-01T00:00:00Z\nvalidTo: 2026-02-01T00:00:00Z")
            .unwrap();
        assert_eq!(
            current_truth(Some(&t), parse_iso("2026-11-12T00:00:00Z").unwrap()),
            Verdict::NoMatch
        );
        assert_eq!(
            historical_truth(Some(&t), parse_iso("2026-01-15T00:00:00Z")).unwrap(),
            Verdict::Match
        );
    }
    #[test]
    fn invalid_time_never_becomes_unknown() {
        assert!(extract_temporal("validFrom: not-a-date").is_err());
        assert!(candidate_temporal(&json!({"validFrom":"bad"})).is_err());
    }
    #[test]
    fn belief_requires_real_recorded_time() {
        let t = extract_temporal("validFrom: 2026-01-01").unwrap();
        assert_eq!(
            belief_truth(Some(&t), Some(1)).unwrap(),
            Verdict::RequiresRecordedAt
        );
    }
}
