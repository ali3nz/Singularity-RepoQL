// run_state.rs — journal-authoritative run state for the Rust coordinator.
//
// Authority model (reviewed with Sol, 2026-10-24):
//   * `journal.jsonl` is the ONLY authority. Every committed operation is one
//     complete, fsynced line.
//   * `state.json` is a derived projection. It is rebuilt from the journal when
//     missing, stale or corrupt, and a direct writer that bypasses this module
//     is overwritten by the next verified operation.
//   * `authority.json` describes the projection (revision, journal digest,
//     fencing epoch). It is written only here.
//   * Mutations require a live lease with a matching fencing epoch. A lease
//     expires, so a crashed or paused coordinator cannot commit later: it must
//     re-acquire and receives a higher epoch.
//   * Revisions are compare-and-swap: a stale expectedRev is refused without
//     touching persistent state.
//
// This module does not dispatch external effects. It records durable effect
// intents and their reported outcomes; an `unknown` outcome stays pending and
// is never treated as failure or success. Only an explicit `resolve` (after the
// adapter probed the external system) may close it.

use chrono::{DateTime, SecondsFormat, Utc};
use fs2::FileExt;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const RUN_STATE_SCHEMA: &str = "orchestra-run-state/2";
pub const AUTHORITY_SCHEMA: &str = "orchestra-state-authority/1";
pub const JOURNAL_FILE: &str = "journal.jsonl";
pub const STATE_FILE: &str = "state.json";
pub const LEASE_FILE: &str = "owner.json";
pub const AUTHORITY_FILE: &str = "authority.json";
pub const EPOCH_FILE: &str = "epoch.json";
pub const LOCK_FILE: &str = "runstate.lock";
pub const MAX_JOURNAL_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_RECORDS: usize = 100_000;
pub const MAX_LINE_BYTES: usize = 1024 * 1024;
pub const MAX_STATE_BYTES: usize = 1024 * 1024;
pub const DEFAULT_LEASE_MS: u64 = 60_000;
pub const MAX_LEASE_MS: u64 = 3_600_000;

pub const STATES: [&str; 8] = [
    "PLANNED",
    "RUNNING",
    "COMPLETED",
    "COMPLETED_UNREVIEWED",
    "COMPLETED_OPERATOR_ACCEPTED",
    "NEEDS_HUMAN_REVIEW",
    "REMEDIATION_EXHAUSTED",
    "ABORTED",
];

/// A state with NO outgoing transition. `COMPLETED_UNREVIEWED` is deliberately
/// NOT final: the coordinator's own table (and the operator acceptance path)
/// moves it to COMPLETED_OPERATOR_ACCEPTED or ABORTED. Finality here must match
/// `transition_allowed`, or a legal acceptance is refused as TERMINAL_FINALITY.
pub fn is_terminal(state: &str) -> bool {
    matches!(
        state,
        "COMPLETED" | "COMPLETED_OPERATOR_ACCEPTED" | "ABORTED"
    )
}

/// Mirrors the accepted JavaScript coordinator's state transitions. A missing
/// state is treated as PLANNED only on adoption of a legacy run.
pub fn transition_allowed(from: &str, to: &str) -> bool {
    match from {
        "PLANNED" => matches!(to, "RUNNING" | "ABORTED"),
        "RUNNING" => matches!(
            to,
            "COMPLETED"
                | "COMPLETED_UNREVIEWED"
                | "NEEDS_HUMAN_REVIEW"
                | "REMEDIATION_EXHAUSTED"
                | "ABORTED"
        ),
        "NEEDS_HUMAN_REVIEW" => {
            matches!(to, "RUNNING" | "COMPLETED_OPERATOR_ACCEPTED" | "ABORTED")
        }
        "REMEDIATION_EXHAUSTED" => {
            matches!(to, "RUNNING" | "NEEDS_HUMAN_REVIEW" | "ABORTED")
        }
        "COMPLETED_UNREVIEWED" => matches!(to, "COMPLETED_OPERATOR_ACCEPTED" | "ABORTED"),
        // Terminal finality: no resurrection, including through stale callbacks.
        _ => false,
    }
}

/// Test-only crash injection at the durability boundaries that matter for
/// recovery. Inert unless ORCHESTRA_FAULT names the point.
fn fault_point(name: &str) {
    if let Ok(spec) = std::env::var("ORCHESTRA_FAULT") {
        if spec.split(',').any(|point| point.trim() == name) {
            std::process::abort();
        }
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn iso_ms(ms: u64) -> String {
    DateTime::<Utc>::from(UNIX_EPOCH + std::time::Duration::from_millis(ms))
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temp)
        .map_err(|e| format!("write {temp:?}: {e}"))?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    fs::rename(&temp, path).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        if let Ok(dir) = fs::File::open(parent) {
            let _ = dir.sync_all();
        }
    }
    Ok(())
}

pub fn digest_of(value: &Value) -> String {
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    format!("{:x}", hasher.finalize())
}

#[derive(Debug, Clone)]
pub struct Lease {
    pub owner_id: String,
    pub epoch: u64,
    pub acquired_at_ms: u64,
    pub renewed_at_ms: u64,
    pub expires_at_ms: u64,
}

fn read_lease(dir: &Path) -> Option<Lease> {
    let text = fs::read_to_string(dir.join(LEASE_FILE)).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    Some(Lease {
        owner_id: v.get("ownerId")?.as_str()?.to_string(),
        epoch: v.get("epoch")?.as_u64()?,
        acquired_at_ms: v.get("acquiredAtMs").and_then(Value::as_u64).unwrap_or(0),
        renewed_at_ms: v.get("renewedAtMs").and_then(Value::as_u64).unwrap_or(0),
        expires_at_ms: v.get("expiresAtMs").and_then(Value::as_u64).unwrap_or(0),
    })
}

fn write_lease(dir: &Path, lease: &Lease) -> Result<(), String> {
    let body = json!({
        "schema": AUTHORITY_SCHEMA,
        "ownerId": lease.owner_id,
        "epoch": lease.epoch,
        "acquiredAtMs": lease.acquired_at_ms,
        "renewedAtMs": lease.renewed_at_ms,
        "expiresAtMs": lease.expires_at_ms,
        "acquiredAt": iso_ms(lease.acquired_at_ms),
        "renewedAt": iso_ms(lease.renewed_at_ms),
        "expiresAt": iso_ms(lease.expires_at_ms),
    });
    atomic_write(
        &dir.join(LEASE_FILE),
        serde_json::to_vec_pretty(&body)
            .map_err(|e| e.to_string())?
            .as_slice(),
    )
}

/// Monotonic fencing counter, independent of the lease file: releasing a lease
/// must never make an old epoch reusable.
fn same_owner(expected: &str, presented: &str) -> bool {
    let a = expected.as_bytes();
    let b = presented.as_bytes();
    if a.len() != b.len() || a.is_empty() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn read_epoch(dir: &Path) -> u64 {
    fs::read_to_string(dir.join(EPOCH_FILE))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("epoch").and_then(Value::as_u64))
        .unwrap_or(0)
}

fn write_epoch(dir: &Path, epoch: u64) -> Result<(), String> {
    atomic_write(
        &dir.join(EPOCH_FILE),
        serde_json::to_vec_pretty(&json!({"schema": AUTHORITY_SCHEMA, "epoch": epoch}))
            .map_err(|e| e.to_string())?
            .as_slice(),
    )
}

pub struct RunStore {
    dir: PathBuf,
}

#[derive(Debug, Clone)]
struct Record {
    #[allow(dead_code)]
    seq: u64,
    value: Value,
}

#[derive(Debug, Clone)]
pub struct Projection {
    pub rev: u64,
    pub state: Value,
    pub records: usize,
    pub pending: Vec<Value>,
    /// EVERY effect operation ever journalled, settled or not, keyed by opId.
    /// Duplicate detection and idempotency are decided from this map: an opId
    /// that already settled must never be accepted as a fresh intent.
    pub ops: BTreeMap<String, Value>,
    pub last_seq: u64,
}

impl RunStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    #[allow(dead_code)] // used by module tests and future compaction
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn journal_path(&self) -> PathBuf {
        self.dir.join(JOURNAL_FILE)
    }

    fn state_path(&self) -> PathBuf {
        self.dir.join(STATE_FILE)
    }

    fn lock(&self) -> Result<fs::File, String> {
        fs::create_dir_all(&self.dir).map_err(|e| format!("create dir: {e}"))?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.dir.join(LOCK_FILE))
            .map_err(|e| format!("open lock: {e}"))?;
        file.lock_exclusive().map_err(|e| format!("lock: {e}"))?;
        Ok(file)
    }

    fn read_records(&self) -> Result<Vec<Record>, String> {
        let path = self.journal_path();
        if !path.exists() {
            return Ok(Vec::new());
        }
        let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
        if meta.len() > MAX_JOURNAL_BYTES {
            return Err("JOURNAL_TOO_LARGE".into());
        }
        let file = fs::File::open(&path).map_err(|e| e.to_string())?;
        let mut reader = BufReader::new(file);
        let mut line = Vec::new();
        let mut records = Vec::new();
        let mut seq = 0u64;
        loop {
            line.clear();
            let read = reader
                .read_until(b'\n', &mut line)
                .map_err(|e| e.to_string())?;
            if read == 0 {
                break;
            }
            // A torn trailing line is not a committed record: every accepted
            // record ends with a newline (written and fsynced as one unit).
            if line.last() != Some(&b'\n') {
                break;
            }
            if line.len() > MAX_LINE_BYTES {
                return Err("JOURNAL_LINE_TOO_LARGE".into());
            }
            let value: Value = match serde_json::from_slice(&line) {
                Ok(v) => v,
                Err(_) => return Err("JOURNAL_CORRUPT".into()),
            };
            seq += 1;
            records.push(Record { seq, value });
            if records.len() > MAX_RECORDS {
                return Err("JOURNAL_TOO_MANY_RECORDS".into());
            }
        }
        Ok(records)
    }

    /// A crash can leave a partial line (no trailing newline) at the journal
    /// tail. Replay ignores it, but a following append would concatenate onto
    /// it and produce a line no replay can parse. Truncate the incomplete tail
    /// under the run lock before any mutation, so the append starts clean.
    fn repair_tail(&self) -> Result<bool, String> {
        let path = self.journal_path();
        let meta = match fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => return Ok(false),
        };
        if meta.len() == 0 {
            return Ok(false);
        }
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .map_err(|e| format!("open journal: {e}"))?;
        let mut last = [0u8; 1];
        file.seek(SeekFrom::End(-1)).map_err(|e| e.to_string())?;
        file.read_exact(&mut last).map_err(|e| e.to_string())?;
        if last[0] == b'\n' {
            return Ok(false);
        }
        let len = meta.len();
        let mut buf = vec![0u8; 8192];
        let mut pos = len;
        let mut cut = 0u64;
        'scan: while pos > 0 {
            let start = pos.saturating_sub(buf.len() as u64);
            let n = (pos - start) as usize;
            file.seek(SeekFrom::Start(start))
                .map_err(|e| e.to_string())?;
            file.read_exact(&mut buf[..n]).map_err(|e| e.to_string())?;
            for i in (0..n).rev() {
                if buf[i] == b'\n' {
                    cut = start + i as u64 + 1;
                    break 'scan;
                }
            }
            pos = start;
        }
        file.set_len(cut).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        Ok(true)
    }

    fn append(&self, record: Value) -> Result<(), String> {
        let mut line = serde_json::to_vec(&record).map_err(|e| e.to_string())?;
        if line.len() > MAX_LINE_BYTES {
            return Err("RECORD_TOO_LARGE".into());
        }
        line.push(b'\n');
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.journal_path())
            .map_err(|e| format!("open journal: {e}"))?;
        file.write_all(&line).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Replays the journal into a projection. `state.json` is never an input to
    /// a decision; it is only ever rebuilt from committed journal records.
    pub fn replay(&self) -> Result<Projection, String> {
        let records = self.read_records()?;
        let mut rev = 0u64;
        let mut state: Option<Value> = None;
        let mut ops: BTreeMap<String, Value> = BTreeMap::new();
        for record in &records {
            let value = &record.value;
            let kind = value.get("kind").and_then(Value::as_str).unwrap_or("");
            let record_rev = value.get("rev").and_then(Value::as_u64).unwrap_or(rev + 1);
            match kind {
                "create" | "apply" | "adopt" => {
                    if let Some(doc) = value.get("state").filter(|v| v.is_object()) {
                        state = Some(doc.clone());
                    } else if kind == "create" {
                        // Legacy create records carry the document under `run`.
                        let mut next = value.get("run").cloned().unwrap_or_else(|| json!({}));
                        next["runState"] = json!(next
                            .get("runState")
                            .and_then(Value::as_str)
                            .unwrap_or("PLANNED"));
                        state = Some(next);
                    }
                    rev = record_rev;
                }
                "transition" | "cancel" => {
                    let to = value.get("to").and_then(Value::as_str).unwrap_or("");
                    if let Some(current) = state.as_mut() {
                        current["runState"] = json!(to);
                        if let Some(reason) = value.get("reason").and_then(Value::as_str) {
                            current["lastError"] = json!(reason);
                        }
                        if to == "ABORTED" {
                            current["abortedAt"] = value.get("at").cloned().unwrap_or(Value::Null);
                        }
                    }
                    rev = record_rev;
                }
                "checkpoint" => {
                    if let Some(current) = state.as_mut() {
                        if let Some(stage) = value.get("stage").filter(|v| !v.is_null()) {
                            current["currentStage"] = stage.clone();
                        }
                        if let Some(done) = value.get("completedThrough") {
                            current["completedThrough"] = done.clone();
                        }
                    }
                    rev = record_rev;
                }
                "intent" => {
                    if let Some(op_id) = value.get("opId").and_then(Value::as_str) {
                        ops.insert(
                            op_id.to_string(),
                            json!({
                                "opId": op_id,
                                "effect": value.get("effect").or_else(|| value.get("op")),
                                "stage": value.get("stage"),
                                "payloadDigest": value.get("payloadDigest"),
                                "at": value.get("at"),
                                "outcome": Value::Null,
                            }),
                        );
                    }
                    rev = record_rev;
                }
                "intent_result" => {
                    if let Some(op_id) = value.get("opId").and_then(Value::as_str) {
                        let outcome = value
                            .get("outcome")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown")
                            .to_string();
                        let entry = ops.entry(op_id.to_string()).or_insert_with(|| {
                            json!({
                                "opId": op_id,
                                "effect": Value::Null,
                                "stage": Value::Null,
                                "payloadDigest": Value::Null,
                                "at": value.get("at"),
                            })
                        });
                        entry["outcome"] = json!(outcome);
                        for key in ["remoteId", "errorClass", "detail"] {
                            if let Some(field) = value.get(key) {
                                entry[key] = field.clone();
                            }
                        }
                    }
                    rev = record_rev;
                }
                _ => {}
            }
        }
        let mut pending = Vec::new();
        for (op_id, entry) in &ops {
            let settled = matches!(
                entry.get("outcome").and_then(Value::as_str),
                Some("done") | Some("failed")
            );
            if !settled {
                pending.push(json!({
                    "opId": op_id,
                    "op": entry.get("effect"),
                    "stage": entry.get("stage"),
                    "since": entry.get("at"),
                    "outcome": entry.get("outcome"),
                }));
            }
        }
        Ok(Projection {
            rev,
            state: state.unwrap_or_else(|| json!({"runState":"UNINITIALIZED","rev":0})),
            records: records.len(),
            pending,
            ops,
            last_seq: records.last().map(|r| r.seq).unwrap_or(0),
        })
    }

    fn project(&self, projection: &Projection) -> Result<(), String> {
        let mut bytes = serde_json::to_vec_pretty(&projection.state).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        atomic_write(&self.state_path(), &bytes)?;
        let lease = read_lease(&self.dir);
        let now = now_ms();
        let authority = json!({
            "schema": AUTHORITY_SCHEMA,
            "stateAuthority": "rust",
            "runId": self.dir.file_name().and_then(|n| n.to_str()).unwrap_or(""),
            "rev": projection.rev,
            "journalRecords": projection.records,
            "stateDigest": digest_of(&projection.state),
            "pendingIntents": projection.pending.len(),
            "ownerId": lease.as_ref().map(|l| l.owner_id.clone()),
            "epoch": lease.as_ref().map(|l| l.epoch),
            "leaseExpiresAtMs": lease.as_ref().map(|l| l.expires_at_ms),
            "updatedAtMs": now,
            "updatedAt": iso_ms(now),
        });
        atomic_write(
            &self.dir.join(AUTHORITY_FILE),
            serde_json::to_vec_pretty(&authority)
                .map_err(|e| e.to_string())?
                .as_slice(),
        )
    }

    pub fn read(&self) -> Result<Value, String> {
        let projection = self.replay()?;
        let lease = read_lease(&self.dir);
        Ok(json!({
            "ok": true,
            "schema": RUN_STATE_SCHEMA,
            "rev": projection.rev,
            "state": projection.state,
            "journalRecords": projection.records,
            "pending": projection.pending,
            "digest": digest_of(&projection.state),
            "lease": lease.map(|l| json!({
                "ownerId": l.owner_id,
                "epoch": l.epoch,
                "expiresAtMs": l.expires_at_ms,
                "expired": l.expires_at_ms < now_ms(),
            })),
        }))
    }

    /// Reads the projection without holding the run lock (dashboard path).
    pub fn peek(&self) -> Result<Value, String> {
        let projection = self.replay()?;
        let lease = read_lease(&self.dir);
        Ok(json!({
            "schema": RUN_STATE_SCHEMA,
            "rev": projection.rev,
            "state": projection.state,
            "journalRecords": projection.records,
            "pending": projection.pending,
            "digest": digest_of(&projection.state),
            "lease": lease.map(|l| json!({
                "ownerId": l.owner_id,
                "epoch": l.epoch,
                "expiresAtMs": l.expires_at_ms,
            })),
        }))
    }

    /// Fencing check. An epoch alone is not identity: the lease must still be
    /// held by the same owner id, or a restarted coordinator that happened to
    /// see the same number could commit.
    fn require_owner(&self, op: &Value) -> Result<Lease, String> {
        let lease = read_lease(&self.dir).ok_or("NO_OWNER")?;
        let epoch = op
            .get("epoch")
            .and_then(Value::as_u64)
            .ok_or("MISSING_EPOCH")?;
        let owner_id = op
            .get("ownerId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or("MISSING_OWNER_ID")?;
        if epoch != lease.epoch {
            return Err("STALE_EPOCH".into());
        }
        if !same_owner(&lease.owner_id, owner_id) {
            return Err("NOT_OWNER".into());
        }
        if lease.expires_at_ms < now_ms() {
            return Err("LEASE_EXPIRED".into());
        }
        Ok(lease)
    }

    fn renew(&self, lease: &Lease) -> Result<(), String> {
        let now = now_ms();
        let ttl = lease.expires_at_ms.saturating_sub(lease.renewed_at_ms);
        write_lease(
            &self.dir,
            &Lease {
                renewed_at_ms: now,
                expires_at_ms: now + ttl.min(MAX_LEASE_MS),
                ..lease.clone()
            },
        )
    }

    fn commit(
        &self,
        projection: &mut Projection,
        mut record: Value,
        expected_rev: Option<u64>,
        tail_repaired: bool,
    ) -> Result<Value, String> {
        if let Some(expected) = expected_rev {
            if expected != projection.rev {
                return Err(format!("STALE_REV:{}", projection.rev));
            }
        }
        let rev = projection.rev + 1;
        record["rev"] = json!(rev);
        record["seq"] = json!(projection.last_seq + 1);
        record["at"] = json!(iso_ms(now_ms()));
        fault_point("journal_before_append");
        self.append(record)?;
        fault_point("journal_after_append");
        *projection = self.replay()?;
        self.project(projection)?;
        fault_point("projection_after_write");
        Ok(json!({
            "ok": true,
            "rev": projection.rev,
            "state": projection.state,
            "digest": digest_of(&projection.state),
            "tailRepaired": tail_repaired,
        }))
    }

    fn validate_state(&self, projection: &Projection, next: &Value) -> Result<(), String> {
        if !next.is_object() {
            return Err("INVALID_STATE".into());
        }
        let bytes = serde_json::to_vec(next).map_err(|e| e.to_string())?;
        if bytes.len() > MAX_STATE_BYTES {
            return Err("STATE_TOO_LARGE".into());
        }
        let current = projection.state.clone();
        let from = current
            .get("runState")
            .and_then(Value::as_str)
            .unwrap_or("UNINITIALIZED");
        let to = next
            .get("runState")
            .and_then(Value::as_str)
            .unwrap_or("UNINITIALIZED");
        if !STATES.contains(&to) {
            return Err(format!("UNKNOWN_STATE:{to}"));
        }
        if from != to {
            if is_terminal(from) {
                return Err("TERMINAL_FINALITY".into());
            }
            if !transition_allowed(from, to) {
                return Err(format!("ILLEGAL_TRANSITION:{from}->{to}"));
            }
        }
        // Immutable identity: a run cannot be re-pointed at another task/run.
        for key in ["runId", "startedAt"] {
            if let (Some(a), Some(b)) = (current.get(key), next.get(key)) {
                if a != b && !a.is_null() && !b.is_null() {
                    return Err(format!("IMMUTABLE_FIELD:{key}"));
                }
            }
        }
        let completed = next
            .get("completedThrough")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let previous = current
            .get("completedThrough")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if completed < previous {
            return Err("NON_MONOTONIC_COMPLETED".into());
        }
        if let Some(phase) = next.get("currentPhase").filter(|v| !v.is_null()) {
            let phase = phase.as_u64().ok_or("INVALID_CURRENT_PHASE")?;
            let total = next
                .get("phases")
                .and_then(Value::as_array)
                .map(|p| p.len() as u64)
                .unwrap_or(0);
            if total > 0 && phase > total.max(completed) {
                return Err("PHASE_OUT_OF_RANGE".into());
            }
        }
        Ok(())
    }

    /// Explicit operations only: there is no generic state mutation endpoint.
    pub fn execute(&self, op: &Value) -> Result<Value, String> {
        let action = op
            .get("action")
            .and_then(Value::as_str)
            .ok_or("missing action")?;
        let _lock = self.lock()?;
        if action == "read" {
            return self.read();
        }
        // Every mutating action starts from a journal whose tail is complete.
        let repaired_tail = self.repair_tail()?;
        if action == "recover" {
            let projection = self.replay()?;
            self.project(&projection)?;
            return Ok(json!({
                "ok": true,
                "rev": projection.rev,
                "journalRecords": projection.records,
                "digest": digest_of(&projection.state),
            }));
        }
        if action == "verify" {
            // Proves the projection is the journal's projection. A direct
            // writer that bypassed the authority is overwritten here.
            let projection = self.replay()?;
            let expected = digest_of(&projection.state);
            let actual = fs::read_to_string(self.state_path())
                .ok()
                .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                .map(|v| digest_of(&v));
            let repaired = actual.as_deref() != Some(expected.as_str());
            self.project(&projection)?;
            return Ok(json!({
                "ok": true,
                "rev": projection.rev,
                "digest": expected,
                "repaired": repaired,
            }));
        }
        if action == "lease" {
            let lease = read_lease(&self.dir);
            return Ok(json!({
                "ok": true,
                "lease": lease.map(|l| json!({
                    "ownerId": l.owner_id,
                    "epoch": l.epoch,
                    "expiresAtMs": l.expires_at_ms,
                    "expired": l.expires_at_ms < now_ms(),
                })),
            }));
        }
        if action == "acquire" {
            let owner_id = op
                .get("ownerId")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or("missing ownerId")?;
            let ttl = op
                .get("ttlMs")
                .and_then(Value::as_u64)
                .unwrap_or(DEFAULT_LEASE_MS)
                .clamp(1_000, MAX_LEASE_MS);
            let now = now_ms();
            if let Some(existing) = read_lease(&self.dir) {
                if existing.expires_at_ms >= now && existing.owner_id != owner_id {
                    return Ok(json!({
                        "ok": false,
                        "reason": "OWNER_ALIVE",
                        "owner": existing.owner_id,
                        "epoch": existing.epoch,
                        "expiresAtMs": existing.expires_at_ms,
                        "since": iso_ms(existing.acquired_at_ms),
                    }));
                }
            }
            let epoch = read_epoch(&self.dir)
                .max(read_lease(&self.dir).map(|l| l.epoch).unwrap_or(0))
                .max(
                    fs::read_to_string(self.dir.join(AUTHORITY_FILE))
                        .ok()
                        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                        .and_then(|v| v.get("epoch").and_then(Value::as_u64))
                        .unwrap_or(0),
                )
                + 1;
            write_epoch(&self.dir, epoch)?;
            let lease = Lease {
                owner_id: owner_id.to_string(),
                epoch,
                acquired_at_ms: now,
                renewed_at_ms: now,
                expires_at_ms: now + ttl,
            };
            write_lease(&self.dir, &lease)?;
            return Ok(json!({
                "ok": true,
                "epoch": epoch,
                "expiresAtMs": lease.expires_at_ms,
                "rev": self.replay()?.rev,
            }));
        }
        if action == "heartbeat" {
            let lease = self.require_owner(op)?;
            self.renew(&lease)?;
            return Ok(json!({
                "ok": true,
                "epoch": lease.epoch,
                "expiresAtMs": read_lease(&self.dir).map(|l| l.expires_at_ms),
            }));
        }
        if action == "rollback" {
            // Retiring the authority is decided against the CURRENT lease under
            // the same run lock every mutation takes — never from a cached
            // marker, which can be stale after an owner release + re-acquire.
            let confirm = op.get("confirm").and_then(Value::as_str).unwrap_or("");
            let run_id = op.get("runId").and_then(Value::as_str).unwrap_or("");
            if confirm.is_empty() || confirm != run_id {
                return Ok(json!({
                    "ok": false,
                    "reason": "ROLLBACK_CONFIRM_REQUIRED",
                    "detail": "rollback requires confirm == runId",
                }));
            }
            if let Some(lease) = read_lease(&self.dir) {
                if lease.expires_at_ms >= now_ms() {
                    return Ok(json!({
                        "ok": false,
                        "reason": "OWNER_ALIVE",
                        "owner": lease.owner_id,
                        "epoch": lease.epoch,
                        "expiresAtMs": lease.expires_at_ms,
                    }));
                }
            }
            let stamp = now_ms();
            let mut retired = Vec::new();
            for (file, target) in [
                (AUTHORITY_FILE, format!("authority.rollback-{stamp}.json")),
                (JOURNAL_FILE, format!("journal.rust-{stamp}.jsonl")),
                (LEASE_FILE, format!("owner.rollback-{stamp}.json")),
            ] {
                let from = self.dir.join(file);
                if from.exists() {
                    fs::rename(&from, self.dir.join(target))
                        .map_err(|e| format!("retire {file}: {e}"))?;
                    retired.push(json!(file));
                }
            }
            return Ok(json!({
                "ok": true,
                "rollback": true,
                "retired": retired,
                "quiescedAtMs": stamp,
            }));
        }
        if action == "release" {
            let lease = self.require_owner(op)?;
            let _ = fs::remove_file(self.dir.join(LEASE_FILE));
            // Refresh the projection so authority.json no longer advertises a
            // live lease to the rollback guard or the dashboard.
            if let Ok(projection) = self.replay() {
                let _ = self.project(&projection);
            }
            return Ok(json!({"ok": true, "released": true, "epoch": lease.epoch}));
        }

        let mut projection = self.replay()?;
        if action == "adopt" {
            let lease = self.require_owner(op)?;
            if projection.rev > 0 {
                return Ok(json!({"ok": true, "already": true, "rev": projection.rev}));
            }
            let text = fs::read_to_string(self.state_path()).map_err(|_| "NO_STATE_FILE")?;
            if text.len() > MAX_STATE_BYTES {
                return Err("STATE_TOO_LARGE".into());
            }
            let mut doc: Value = serde_json::from_str(&text).map_err(|_| "STATE_CORRUPT")?;
            if !doc.is_object() {
                return Err("INVALID_STATE".into());
            }
            if doc.get("runId").is_none() {
                let name = self.dir.file_name().and_then(|n| n.to_str()).unwrap_or("");
                doc["runId"] = json!(name);
            }
            let run_state = doc
                .get("runState")
                .and_then(Value::as_str)
                .unwrap_or("PLANNED")
                .to_string();
            if !STATES.contains(&run_state.as_str()) {
                return Err(format!("UNKNOWN_STATE:{run_state}"));
            }
            let digest = digest_of(&doc);
            let out = self.commit(
                &mut projection,
                json!({
                    "kind": "adopt",
                    "state": doc,
                    "digest": digest,
                    "epoch": lease.epoch,
                    "adoptedFrom": "state.json",
                }),
                None,
                repaired_tail,
            )?;
            return Ok(out);
        }
        if action == "create" {
            if projection.rev > 0 {
                return Ok(json!({"ok": false, "reason": "ALREADY_EXISTS", "rev": projection.rev}));
            }
            let lease = self.require_owner(op)?;
            let provided = op
                .get("state")
                .filter(|v| v.is_object())
                .cloned()
                .unwrap_or_else(|| json!({}));
            let run_id = op
                .get("runId")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or("missing runId")?;
            if run_id.contains('/') || run_id.contains("..") {
                return Err("invalid runId".into());
            }
            let mut run = Map::new();
            run.insert("runId".into(), json!(run_id));
            for key in ["task", "mode", "runNumber", "runTitle"] {
                if let Some(v) = op.get(key) {
                    run.insert(key.into(), v.clone());
                }
            }
            for key in ["phases", "workers"] {
                if let Some(v) = op.get(key) {
                    run.insert(key.into(), v.clone());
                }
            }
            if let Some(obj) = provided.as_object() {
                for (k, v) in obj {
                    run.insert(k.clone(), v.clone());
                }
            }
            if run.get("runState").and_then(Value::as_str).is_none() {
                run.insert("runState".into(), json!("PLANNED"));
            }
            run.remove("rev");
            run.insert("ownerEpoch".into(), json!(lease.epoch));
            let doc = Value::Object(run);
            let digest = digest_of(&doc);
            return self.commit(
                &mut projection,
                json!({"kind": "create", "state": doc, "digest": digest, "epoch": lease.epoch}),
                None,
                repaired_tail,
            );
        }
        if action == "apply" {
            if projection.rev == 0 {
                return Err("NOT_ADOPTED".into());
            }
            let epoch = op
                .get("epoch")
                .and_then(Value::as_u64)
                .ok_or("MISSING_EPOCH")?;
            self.require_owner(op)?;
            let expected = op
                .get("expectedRev")
                .and_then(Value::as_u64)
                .ok_or("missing expectedRev")?;
            if expected != projection.rev {
                return Err(format!("STALE_REV:{}", projection.rev));
            }
            let mut next = op.get("state").cloned().ok_or("missing state")?;
            // A document that never set runState (legacy fixture paths) means
            // "no lifecycle change", not an invalid state.
            if next.get("runState").and_then(Value::as_str).is_none() {
                let current = projection
                    .state
                    .get("runState")
                    .and_then(Value::as_str)
                    .unwrap_or("PLANNED");
                next["runState"] = json!(current);
            }
            self.validate_state(&projection, &next)?;
            let from = projection
                .state
                .get("runState")
                .and_then(Value::as_str)
                .unwrap_or("UNINITIALIZED")
                .to_string();
            let to = next
                .get("runState")
                .and_then(Value::as_str)
                .unwrap_or("UNINITIALIZED")
                .to_string();
            let digest = digest_of(&next);
            return self.commit(
                &mut projection,
                json!({
                    "kind": "apply",
                    "from": from,
                    "to": to,
                    "digest": digest,
                    "epoch": epoch,
                    "state": next,
                }),
                Some(expected),
                repaired_tail,
            );
        }
        if action == "transition" || action == "cancel" {
            let expected = op
                .get("expectedRev")
                .and_then(Value::as_u64)
                .ok_or("missing expectedRev")?;
            let epoch = op
                .get("epoch")
                .and_then(Value::as_u64)
                .ok_or("MISSING_EPOCH")?;
            self.require_owner(op)?;
            if expected != projection.rev {
                return Err(format!("STALE_REV:{}", projection.rev));
            }
            let from = projection
                .state
                .get("runState")
                .and_then(Value::as_str)
                .unwrap_or("UNINITIALIZED")
                .to_string();
            let to = if action == "cancel" {
                "ABORTED".to_string()
            } else {
                op.get("to")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string()
            };
            if !STATES.contains(&to.as_str()) {
                return Ok(json!({"ok":false,"reason":"UNKNOWN_STATE","to":to}));
            }
            if !transition_allowed(&from, &to) {
                return Ok(json!({"ok":false,"reason":"ILLEGAL_TRANSITION","from":from,"to":to}));
            }
            let mut record = json!({"kind":"transition","from":from,"to":to,"epoch":epoch});
            if let Some(reason) = op.get("reason").and_then(Value::as_str) {
                record["reason"] = json!(reason);
            }
            if action == "cancel" {
                record["kind"] = json!("cancel");
            }
            self.commit(&mut projection, record, Some(expected), repaired_tail)
        } else if action == "checkpoint" {
            let expected = op
                .get("expectedRev")
                .and_then(Value::as_u64)
                .ok_or("missing expectedRev")?;
            let epoch = op
                .get("epoch")
                .and_then(Value::as_u64)
                .ok_or("MISSING_EPOCH")?;
            self.require_owner(op)?;
            let mut record = json!({"kind":"checkpoint","epoch":epoch});
            for key in ["stage", "completedThrough"] {
                if let Some(value) = op.get(key) {
                    record[key] = value.clone();
                }
            }
            self.commit(&mut projection, record, Some(expected), repaired_tail)
        } else if action == "intent" {
            let epoch = op
                .get("epoch")
                .and_then(Value::as_u64)
                .ok_or("MISSING_EPOCH")?;
            self.require_owner(op)?;
            let op_id = op
                .get("opId")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or("missing opId")?;
            let effect = op
                .get("effect")
                .or_else(|| op.get("op"))
                .cloned()
                .unwrap_or(Value::Null);
            let payload_digest = op.get("payloadDigest").cloned().unwrap_or(Value::Null);
            // Effect eligibility is decided HERE, under the same run lock the
            // cancellation transition takes. A JavaScript pre-check can race a
            // cancel; this cannot (Sol gate, 2026-10-25 finding 1).
            let run_state = projection
                .state
                .get("runState")
                .and_then(Value::as_str)
                .unwrap_or("UNINITIALIZED");
            if is_terminal(run_state)
                || matches!(
                    run_state,
                    "COMPLETED" | "COMPLETED_UNREVIEWED" | "COMPLETED_OPERATOR_ACCEPTED"
                )
            {
                return Ok(json!({
                    "ok": false,
                    "reason": "RUN_FINISHED",
                    "runState": run_state,
                    "rev": projection.rev,
                }));
            }
            // Idempotency covers the WHOLE journal, not just the pending set:
            // an opId that already settled must never be re-executed as a new
            // intent, and a reused opId with a different payload is a conflict.
            if let Some(existing) = projection.ops.get(op_id) {
                let same_payload = existing
                    .get("payloadDigest")
                    .cloned()
                    .unwrap_or(Value::Null)
                    == payload_digest;
                let existing_effect = existing.get("effect").cloned().unwrap_or(Value::Null);
                if !same_payload || (!existing_effect.is_null() && existing_effect != effect) {
                    return Ok(json!({
                        "ok": false,
                        "reason": "OP_ID_CONFLICT",
                        "opId": op_id,
                        "rev": projection.rev,
                    }));
                }
                let outcome = existing.get("outcome").cloned().unwrap_or(Value::Null);
                return Ok(json!({
                    "ok": true,
                    "duplicate": true,
                    "settled": matches!(outcome.as_str(), Some("done") | Some("failed")),
                    "pending": matches!(outcome.as_str(), Some("unknown") | None),
                    "outcome": outcome,
                    "remoteId": existing.get("remoteId").cloned().unwrap_or(Value::Null),
                    "errorClass": existing.get("errorClass").cloned().unwrap_or(Value::Null),
                    "rev": projection.rev,
                }));
            }
            let mut record = json!({"kind":"intent","opId":op_id,"effect":effect,"epoch":epoch});
            for key in ["stage", "payloadDigest"] {
                if let Some(value) = op.get(key) {
                    record[key] = value.clone();
                }
            }
            self.commit(&mut projection, record, None, repaired_tail)
        } else if action == "result" || action == "resolve" {
            let epoch = op
                .get("epoch")
                .and_then(Value::as_u64)
                .ok_or("MISSING_EPOCH")?;
            self.require_owner(op)?;
            let op_id = op
                .get("opId")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or("missing opId")?;
            let outcome = op.get("outcome").and_then(Value::as_str).unwrap_or("");
            let allowed: &[&str] = if action == "resolve" {
                &["done", "failed"]
            } else {
                &["done", "failed", "unknown"]
            };
            if !allowed.contains(&outcome) {
                return Ok(json!({"ok":false,"reason":"INVALID_OUTCOME"}));
            }
            match projection.ops.get(op_id) {
                None => {
                    return Ok(json!({"ok":false,"reason":"NO_PENDING_INTENT","opId":op_id}));
                }
                Some(existing) => {
                    let recorded = existing.get("outcome").cloned().unwrap_or(Value::Null);
                    if matches!(recorded.as_str(), Some("done") | Some("failed")) {
                        // A settled operation is closed for good: a late or
                        // duplicated acknowledgement must not rewrite history.
                        return Ok(json!({
                            "ok": false,
                            "reason": "ALREADY_SETTLED",
                            "opId": op_id,
                            "outcome": recorded,
                            "rev": projection.rev,
                        }));
                    }
                }
            }
            let mut record =
                json!({"kind":"intent_result","opId":op_id,"outcome":outcome,"epoch":epoch});
            for key in ["remoteId", "errorClass", "detail"] {
                if let Some(value) = op.get(key) {
                    record[key] = value.clone();
                }
            }
            self.commit(&mut projection, record, None, repaired_tail)
        } else {
            Err(format!("unsupported action: {action}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_root(label: &str) -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "runstate-{label}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn created(label: &str) -> (RunStore, u64) {
        let store = RunStore::new(temp_root(label));
        let acquired = store
            .execute(&json!({"action":"acquire","ownerId":"test","ttlMs":600000}))
            .unwrap();
        let epoch = acquired["epoch"].as_u64().unwrap();
        let out = store
            .execute(&json!({"action":"create","epoch":epoch,"ownerId":"test","runId":label,"task":"t","phases":[{"n":1}],"workers":["alpha"]}))
            .unwrap();
        assert_eq!(out["ok"], true);
        (store, epoch)
    }

    fn doc(store: &RunStore) -> Value {
        store.execute(&json!({"action":"read"})).unwrap()["state"].clone()
    }

    #[test]
    fn create_projects_planned_state() {
        let (store, _) = created("create");
        let read = store.execute(&json!({"action":"read"})).unwrap();
        assert_eq!(read["state"]["runState"], "PLANNED");
        assert_eq!(read["rev"], 1);
        assert_eq!(read["state"]["phases"].as_array().unwrap().len(), 1);
        let authority: Value =
            serde_json::from_str(&fs::read_to_string(store.dir().join(AUTHORITY_FILE)).unwrap())
                .unwrap();
        assert_eq!(authority["stateAuthority"], "rust");
        assert_eq!(authority["rev"], 1);
    }

    #[test]
    fn stale_revision_is_refused_without_writing() {
        let (store, epoch) = created("stale");
        let first = store
            .execute(&json!({"action":"transition","epoch":epoch,"ownerId":"test","expectedRev":1,"to":"RUNNING"}))
            .unwrap();
        assert_eq!(first["rev"], 2);
        let stale = store
            .execute(&json!({"action":"transition","epoch":epoch,"ownerId":"test","expectedRev":1,"to":"COMPLETED"}))
            .unwrap_err();
        assert!(stale.starts_with("STALE_REV"));
        let read = store.execute(&json!({"action":"read"})).unwrap();
        assert_eq!(read["rev"], 2);
        assert_eq!(read["state"]["runState"], "RUNNING");
    }

    #[test]
    fn illegal_transition_is_refused() {
        let (store, epoch) = created("illegal");
        let out = store
            .execute(&json!({"action":"transition","epoch":epoch,"ownerId":"test","expectedRev":1,"to":"COMPLETED"}))
            .unwrap();
        assert_eq!(out["ok"], false);
        assert_eq!(out["reason"], "ILLEGAL_TRANSITION");
        assert_eq!(store.execute(&json!({"action":"read"})).unwrap()["rev"], 1);
    }

    #[test]
    fn terminal_state_cannot_be_resurrected() {
        let (store, epoch) = created("terminal");
        store
            .execute(&json!({"action":"transition","epoch":epoch,"ownerId":"test","expectedRev":1,"to":"RUNNING"}))
            .unwrap();
        store
            .execute(&json!({"action":"transition","epoch":epoch,"ownerId":"test","expectedRev":2,"to":"COMPLETED"}))
            .unwrap();
        let late = store
            .execute(&json!({"action":"transition","epoch":epoch,"ownerId":"test","expectedRev":3,"to":"RUNNING"}))
            .unwrap();
        assert_eq!(late["ok"], false);
        assert_eq!(late["reason"], "ILLEGAL_TRANSITION");
    }

    #[test]
    fn cancel_is_terminal_and_idempotent_reporting() {
        let (store, epoch) = created("cancel");
        store
            .execute(&json!({"action":"transition","epoch":epoch,"ownerId":"test","expectedRev":1,"to":"RUNNING"}))
            .unwrap();
        let cancelled = store
            .execute(
                &json!({"action":"cancel","epoch":epoch,"ownerId":"test","expectedRev":2,"reason":"operator stop"}),
            )
            .unwrap();
        assert_eq!(cancelled["state"]["runState"], "ABORTED");
        let again = store
            .execute(&json!({"action":"cancel","epoch":epoch,"ownerId":"test","expectedRev":3,"reason":"again"}))
            .unwrap();
        assert_eq!(again["ok"], false);
        assert_eq!(again["reason"], "ILLEGAL_TRANSITION");
    }

    #[test]
    fn intent_is_durable_and_idempotent() {
        let (store, epoch) = created("intent");
        let first = store
            .execute(&json!({"action":"intent","epoch":epoch,"ownerId":"test","opId":"op-1","op":"dispatch"}))
            .unwrap();
        assert_eq!(first["ok"], true);
        let duplicate = store
            .execute(&json!({"action":"intent","epoch":epoch,"ownerId":"test","opId":"op-1","op":"dispatch"}))
            .unwrap();
        assert_eq!(duplicate["duplicate"], true);
        assert_eq!(duplicate["rev"], first["rev"]);
        let read = store.execute(&json!({"action":"read"})).unwrap();
        assert_eq!(read["pending"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn unknown_outcome_stays_pending_until_resolved() {
        let (store, epoch) = created("unknown");
        store
            .execute(&json!({"action":"intent","epoch":epoch,"ownerId":"test","opId":"op-x","op":"send"}))
            .unwrap();
        store
            .execute(&json!({"action":"result","epoch":epoch,"ownerId":"test","opId":"op-x","outcome":"unknown"}))
            .unwrap();
        let read = store.execute(&json!({"action":"read"})).unwrap();
        assert_eq!(read["pending"].as_array().unwrap().len(), 1);
        assert_eq!(read["state"]["runState"], "PLANNED");
        let resolved = store
            .execute(&json!({"action":"resolve","epoch":epoch,"ownerId":"test","opId":"op-x","outcome":"done"}))
            .unwrap();
        assert_eq!(resolved["ok"], true);
        let read = store.execute(&json!({"action":"read"})).unwrap();
        assert_eq!(read["pending"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn projection_is_rebuilt_from_journal_after_corruption() {
        let (store, epoch) = created("rebuild");
        store
            .execute(&json!({"action":"transition","epoch":epoch,"ownerId":"test","expectedRev":1,"to":"RUNNING"}))
            .unwrap();
        let dir = store.dir().to_path_buf();
        fs::write(dir.join(STATE_FILE), b"{corrupt").unwrap();
        let recovered = store.execute(&json!({"action":"recover"})).unwrap();
        assert_eq!(recovered["rev"], 2);
        let read = store.execute(&json!({"action":"read"})).unwrap();
        assert_eq!(read["state"]["runState"], "RUNNING");
    }

    #[test]
    fn direct_writer_is_detected_and_repaired() {
        let (store, epoch) = created("verify");
        store
            .execute(&json!({"action":"transition","epoch":epoch,"ownerId":"test","expectedRev":1,"to":"RUNNING"}))
            .unwrap();
        // Simulate a legacy writer bypassing the authority.
        let mut rogue = doc(&store);
        rogue["runState"] = json!("COMPLETED");
        fs::write(
            store.dir().join(STATE_FILE),
            serde_json::to_vec(&rogue).unwrap(),
        )
        .unwrap();
        let verified = store.execute(&json!({"action":"verify"})).unwrap();
        assert_eq!(verified["repaired"], true);
        let after = doc(&store);
        assert_eq!(after["runState"], "RUNNING");
    }

    #[test]
    fn torn_trailing_line_is_not_a_committed_record() {
        let (store, epoch) = created("torn");
        store
            .execute(&json!({"action":"transition","epoch":epoch,"ownerId":"test","expectedRev":1,"to":"RUNNING"}))
            .unwrap();
        let journal = store.dir().join(JOURNAL_FILE);
        let mut text = fs::read_to_string(&journal).unwrap();
        text.push_str("{\"kind\":\"transition\",\"to\":\"COMPLETED\"");
        fs::write(&journal, text).unwrap();
        let read = store.execute(&json!({"action":"read"})).unwrap();
        assert_eq!(read["rev"], 2);
        assert_eq!(read["state"]["runState"], "RUNNING");
    }

    #[test]
    fn stale_epoch_cannot_commit() {
        let (store, epoch) = created("epoch");
        let out = store
            .execute(
                &json!({"action":"transition","epoch":epoch + 1,"ownerId":"test","expectedRev":1,"to":"RUNNING"}),
            )
            .unwrap_err();
        assert_eq!(out, "STALE_EPOCH");
        assert_eq!(store.execute(&json!({"action":"read"})).unwrap()["rev"], 1);
    }

    #[test]
    fn foreign_live_lease_blocks_acquisition() {
        let (store, _) = created("owner");
        let out = store
            .execute(&json!({"action":"acquire","ownerId":"other","ttlMs":600000}))
            .unwrap();
        assert_eq!(out["ok"], false);
        assert_eq!(out["reason"], "OWNER_ALIVE");
    }

    #[test]
    fn expired_lease_allows_acquisition_and_refuses_the_stale_epoch() {
        let (store, epoch) = created("expiry");
        // Force the lease to expire without waiting.
        let mut lease = read_lease(store.dir()).unwrap();
        lease.expires_at_ms = now_ms() - 1;
        write_lease(store.dir(), &lease).unwrap();
        let stale = store
            .execute(&json!({"action":"apply","epoch":epoch,"ownerId":"test","ownerId":"test","expectedRev":1,"state":doc(&store)}))
            .unwrap_err();
        assert_eq!(stale, "LEASE_EXPIRED");
        let acquired = store
            .execute(&json!({"action":"acquire","ownerId":"next","ttlMs":60000}))
            .unwrap();
        assert_eq!(acquired["ok"], true);
        assert_eq!(acquired["epoch"], epoch + 1);
        let old = store
            .execute(&json!({"action":"apply","epoch":epoch,"ownerId":"test","ownerId":"test","expectedRev":1,"state":doc(&store)}))
            .unwrap_err();
        assert_eq!(old, "STALE_EPOCH");
    }

    #[test]
    fn apply_validates_terminal_finality_and_monotonic_progress() {
        let (store, epoch) = created("apply");
        let mut state = doc(&store);
        state["runState"] = json!("RUNNING");
        state["completedThrough"] = json!(1);
        let out = store
            .execute(&json!({"action":"apply","epoch":epoch,"ownerId":"test","ownerId":"test","expectedRev":1,"state":state}))
            .unwrap();
        assert_eq!(out["rev"], 2);
        let mut backwards = doc(&store);
        backwards["completedThrough"] = json!(0);
        let refused = store
            .execute(&json!({"action":"apply","epoch":epoch,"ownerId":"test","ownerId":"test","expectedRev":2,"state":backwards}))
            .unwrap_err();
        assert_eq!(refused, "NON_MONOTONIC_COMPLETED");
        // finish, then a stale callback tries to move it back
        let mut done = doc(&store);
        done["runState"] = json!("COMPLETED");
        store
            .execute(&json!({"action":"apply","epoch":epoch,"ownerId":"test","ownerId":"test","expectedRev":2,"state":done}))
            .unwrap();
        let mut resurrect = doc(&store);
        resurrect["runState"] = json!("RUNNING");
        let refused = store
            .execute(&json!({"action":"apply","epoch":epoch,"ownerId":"test","ownerId":"test","expectedRev":3,"state":resurrect}))
            .unwrap_err();
        assert_eq!(refused, "TERMINAL_FINALITY");
    }

    #[test]
    fn adopt_imports_an_existing_state_file_once() {
        let dir = temp_root("adopt");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(STATE_FILE),
            serde_json::to_vec(&json!({"runId":"legacy","runState":"NEEDS_HUMAN_REVIEW","completedThrough":2,"task":"t"})).unwrap(),
        )
        .unwrap();
        let store = RunStore::new(&dir);
        let epoch = store
            .execute(&json!({"action":"acquire","ownerId":"test","ttlMs":600000}))
            .unwrap()["epoch"]
            .as_u64()
            .unwrap();
        let first = store
            .execute(&json!({"action":"adopt","epoch":epoch,"ownerId":"test"}))
            .unwrap();
        assert_eq!(first["rev"], 1);
        let second = store
            .execute(&json!({"action":"adopt","epoch":epoch,"ownerId":"test"}))
            .unwrap();
        assert_eq!(second["already"], true);
        assert_eq!(doc(&store)["runState"], "NEEDS_HUMAN_REVIEW");
        // A held run may resume, but not jump straight to COMPLETED.
        let mut jump = doc(&store);
        jump["runState"] = json!("COMPLETED");
        let refused = store
            .execute(&json!({"action":"apply","epoch":epoch,"ownerId":"test","ownerId":"test","expectedRev":1,"state":jump}))
            .unwrap_err();
        assert!(refused.starts_with("ILLEGAL_TRANSITION"));
    }

    #[test]
    fn parallel_writers_produce_one_winner_per_revision() {
        let (store, epoch) = created("parallel");
        let dir = store.dir().to_path_buf();
        let mut handles = Vec::new();
        for i in 0..4 {
            let dir = dir.clone();
            let mut state = doc(&store);
            state["runState"] = json!("RUNNING");
            state["lastError"] = json!(format!("w{i}"));
            handles.push(std::thread::spawn(move || {
                let s = RunStore::new(dir);
                s.execute(&json!({"action":"apply","epoch":epoch,"ownerId":"test","ownerId":"test","expectedRev":1,"state":state}))
            }));
        }
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        let wins = results
            .iter()
            .filter(|r| r.as_ref().map(|v| v["ok"] == true).unwrap_or(false))
            .count();
        let stale = results
            .iter()
            .filter(|r| matches!(r, Err(e) if e.starts_with("STALE_REV")))
            .count();
        assert_eq!(wins, 1, "exactly one CAS writer may commit: {results:?}");
        assert_eq!(stale, 3, "losers must be refused as stale: {results:?}");
        assert_eq!(store.execute(&json!({"action":"read"})).unwrap()["rev"], 2);
    }

    // ---- review findings 2026-10-25 (Sol gate) ------------------------------

    #[test]
    fn settled_operation_id_is_never_reused() {
        let (store, epoch) = created("ops");
        let intent = json!({"action":"intent","epoch":epoch,"ownerId":"test","opId":"dispatch-1","effect":"worker.dispatch","payloadDigest":"aaa"});
        let first = store.execute(&intent).unwrap();
        assert_eq!(first["ok"], true);
        assert_eq!(first.get("duplicate"), None);
        store
            .execute(&json!({"action":"result","epoch":epoch,"ownerId":"test","opId":"dispatch-1","outcome":"done","remoteId":"t-1"}))
            .unwrap();
        let settled_rev = store.execute(&json!({"action":"read"})).unwrap()["rev"].clone();

        // Same id + same payload: replay the recorded outcome, commit nothing.
        let again = store.execute(&intent).unwrap();
        assert_eq!(again["ok"], true);
        assert_eq!(again["duplicate"], true);
        assert_eq!(again["settled"], true);
        assert_eq!(again["outcome"], "done");
        assert_eq!(
            store.execute(&json!({"action":"read"})).unwrap()["rev"],
            settled_rev
        );

        // Same id + different payload: a conflict, never a fresh intent.
        let mut conflicting = intent.clone();
        conflicting["payloadDigest"] = json!("bbb");
        let refused = store.execute(&conflicting).unwrap();
        assert_eq!(refused["ok"], false);
        assert_eq!(refused["reason"], "OP_ID_CONFLICT");
        assert_eq!(
            store.execute(&json!({"action":"read"})).unwrap()["rev"],
            settled_rev
        );
        assert_eq!(
            store.execute(&json!({"action":"read"})).unwrap()["journalRecords"],
            json!(3)
        );
    }

    #[test]
    fn replayed_failure_preserves_its_error_class() {
        // Sol gate round 2 (2026-10-25): a replayed intent must hand back the
        // ORIGINAL failure classification, never a generic label.
        let (store, epoch) = created("replay-class");
        let intent = json!({"action":"intent","epoch":epoch,"ownerId":"test","opId":"dispatch-q","effect":"worker.dispatch","payloadDigest":"ccc"});
        store.execute(&intent).unwrap();
        store
            .execute(&json!({"action":"result","epoch":epoch,"ownerId":"test","opId":"dispatch-q","outcome":"failed","errorClass":"QUOTA"}))
            .unwrap();
        let replay = store.execute(&intent).unwrap();
        assert_eq!(replay["duplicate"], true);
        assert_eq!(replay["settled"], true);
        assert_eq!(replay["outcome"], "failed");
        assert_eq!(replay["errorClass"], "QUOTA");
        assert_eq!(replay["remoteId"], Value::Null);
    }

    #[test]
    fn late_result_for_a_settled_operation_is_refused() {
        let (store, epoch) = created("late");
        store
            .execute(&json!({"action":"intent","epoch":epoch,"ownerId":"test","opId":"op-1","effect":"x","payloadDigest":"p"}))
            .unwrap();
        store
            .execute(&json!({"action":"result","epoch":epoch,"ownerId":"test","opId":"op-1","outcome":"done"}))
            .unwrap();
        let rev = store.execute(&json!({"action":"read"})).unwrap()["rev"].clone();
        let late = store
            .execute(&json!({"action":"result","epoch":epoch,"ownerId":"test","opId":"op-1","outcome":"failed"}))
            .unwrap();
        assert_eq!(late["ok"], false);
        assert_eq!(late["reason"], "ALREADY_SETTLED");
        assert_eq!(late["outcome"], "done");
        assert_eq!(
            store.execute(&json!({"action":"read"})).unwrap()["rev"],
            rev
        );
    }

    #[test]
    fn operator_acceptance_moves_a_completed_unreviewed_run() {
        let (store, epoch) = created("acceptance");
        store
            .execute(&json!({"action":"transition","epoch":epoch,"ownerId":"test","expectedRev":1,"to":"RUNNING"}))
            .unwrap();
        let running = store.execute(&json!({"action":"read"})).unwrap()["rev"]
            .as_u64()
            .unwrap();
        store
            .execute(&json!({"action":"transition","epoch":epoch,"ownerId":"test","expectedRev":running,"to":"COMPLETED_UNREVIEWED"}))
            .unwrap();
        let unreviewed = store.execute(&json!({"action":"read"})).unwrap()["rev"]
            .as_u64()
            .unwrap();

        // The coordinator's writeState path is `apply`, not `transition`.
        let mut state = doc(&store);
        state["runState"] = json!("COMPLETED_OPERATOR_ACCEPTED");
        let accepted = store
            .execute(&json!({"action":"apply","epoch":epoch,"ownerId":"test","expectedRev":unreviewed,"state":state}))
            .unwrap();
        assert_eq!(accepted["ok"], true);
        assert_eq!(accepted["state"]["runState"], "COMPLETED_OPERATOR_ACCEPTED");

        // A genuinely final state still refuses resurrection.
        let rev = store.execute(&json!({"action":"read"})).unwrap()["rev"]
            .as_u64()
            .unwrap();
        let mut resurrect = doc(&store);
        resurrect["runState"] = json!("RUNNING");
        let refused = store
            .execute(&json!({"action":"apply","epoch":epoch,"ownerId":"test","expectedRev":rev,"state":resurrect}))
            .unwrap_err();
        assert_eq!(refused, "TERMINAL_FINALITY");
    }

    #[test]
    fn cancelled_run_refuses_a_direct_intent_under_the_lock() {
        let (store, epoch) = created("cancelled-intent");
        store
            .execute(&json!({"action":"transition","epoch":epoch,"ownerId":"test","expectedRev":1,"to":"RUNNING"}))
            .unwrap();
        let rev = store.execute(&json!({"action":"read"})).unwrap()["rev"]
            .as_u64()
            .unwrap();
        store
            .execute(&json!({"action":"cancel","epoch":epoch,"ownerId":"test","expectedRev":rev,"reason":"operator cancel"}))
            .unwrap();
        let before = store.execute(&json!({"action":"read"})).unwrap();
        let refused = store
            .execute(&json!({"action":"intent","epoch":epoch,"ownerId":"test","opId":"late-op","effect":"post","payloadDigest":"p"}))
            .unwrap();
        assert_eq!(refused["ok"], false);
        assert_eq!(refused["reason"], "RUN_FINISHED");
        let after = store.execute(&json!({"action":"read"})).unwrap();
        assert_eq!(after["rev"], before["rev"]);
        assert_eq!(after["journalRecords"], before["journalRecords"]);
    }

    #[test]
    fn torn_tail_is_repaired_before_the_next_append() {
        let (store, epoch) = created("torn");
        let path = store.dir().join(JOURNAL_FILE);
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"{\"kind\":\"transition\",\"rev\":99")
            .unwrap();
        file.sync_all().unwrap();

        let out = store
            .execute(&json!({"action":"checkpoint","epoch":epoch,"ownerId":"test","expectedRev":1,"stage":"phase-1"}))
            .unwrap();
        assert_eq!(out["ok"], true);
        assert_eq!(out["tailRepaired"], true);
        let records = store.read_records().unwrap();
        assert_eq!(records.last().unwrap().value["kind"], "checkpoint");
        assert_eq!(store.execute(&json!({"action":"read"})).unwrap()["rev"], 2);
    }

    #[test]
    fn rollback_refusal_uses_the_live_lease_not_the_cached_marker() {
        let (store, epoch) = created("rollback");
        // Owner A releases (the marker now says "free"), then owner B acquires.
        store
            .execute(&json!({"action":"release","epoch":epoch,"ownerId":"test"}))
            .unwrap();
        let acquired = store
            .execute(&json!({"action":"acquire","ownerId":"second","ttlMs":600000}))
            .unwrap();
        assert!(acquired["epoch"].as_u64().unwrap() > epoch);
        let marker: Value =
            serde_json::from_str(&fs::read_to_string(store.dir().join(AUTHORITY_FILE)).unwrap())
                .unwrap();
        assert!(marker["leaseExpiresAtMs"].is_null());

        let refused = store
            .execute(&json!({"action":"rollback","runId":"rollback","confirm":"rollback"}))
            .unwrap();
        assert_eq!(refused["ok"], false);
        assert_eq!(refused["reason"], "OWNER_ALIVE");
        assert_eq!(refused["owner"], "second");
        assert!(store.dir().join(JOURNAL_FILE).exists());
    }

    #[test]
    fn rollback_retires_the_authority_only_after_the_lease_expires() {
        let (store, epoch) = created("rollback-ok");
        store
            .execute(&json!({"action":"release","epoch":epoch,"ownerId":"test"}))
            .unwrap();
        let wrong = store
            .execute(&json!({"action":"rollback","runId":"rollback-ok","confirm":"other"}))
            .unwrap();
        assert_eq!(wrong["reason"], "ROLLBACK_CONFIRM_REQUIRED");
        let ok = store
            .execute(&json!({"action":"rollback","runId":"rollback-ok","confirm":"rollback-ok"}))
            .unwrap();
        assert_eq!(ok["ok"], true);
        assert!(!store.dir().join(JOURNAL_FILE).exists());
        assert!(!store.dir().join(AUTHORITY_FILE).exists());
        assert!(ok["retired"].as_array().unwrap().len() >= 2);
        // The document survives; a fresh acquisition re-adopts it.
        assert!(store.dir().join(STATE_FILE).exists());
    }
}
