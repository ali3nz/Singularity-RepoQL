//! Native Rust equivalents of selected Windows Singularity memory policy functions.
//!
//! This is an isolated source candidate. Existing JavaScript and Python remain
//! authoritative until a native Windows build and differential tests pass.
//! It does not own Kanzo authorization, MemoryCore calls, or orchestration.

pub mod answerability;
pub mod authority;
pub mod candidate_lifecycle;
pub mod candidate_policy;
pub mod conflict_signals;
pub mod doc_ingest;
pub mod document_learning;
pub mod hook_capture;
pub mod lineage;
pub mod main_proxy;
pub mod memory_impact;
pub mod payload_budget;
pub mod promotion;
pub mod ranking;
pub mod reconcile;
pub mod source_policy;
pub mod synthesis_spec;
pub mod task_recovery;
pub mod temporal;
pub mod tombstone;
pub mod windows_acceptance;
