//! Read-only Windows Singularity release evidence checks.
//! These checks are never proof of publisher identity, deployment or service behavior.
pub mod connector_inventory;
pub mod doc_impact;
pub mod linux_candidates;
pub mod parity;
pub mod rust_locks;

pub mod acceptance;
pub mod upgrade;
