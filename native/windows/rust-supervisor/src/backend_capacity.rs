//! Pure, fail-closed worker admission policy; no Claude Code free-worker dependency.
//! Source contract only until cargo tests and Windows integration have run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Billing { Free, Subscription, Metered, Unknown }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dispatch { Ready, DeferredNoCapacity, Unverified, BillingDenied, ModelMissing }

#[derive(Clone, Copy, Debug)]
pub struct OpenCodeCapacity<'a> {
    pub provider: &'a str,
    pub model: &'a str,
    pub capacity: Option<u32>,
    pub active: Option<u32>,
    pub billing: Billing,
    pub paid_opt_in: bool,
    // Intentionally no claude_workers field: Claude Code is an independent
    // client, not the authority for Windows worker capacity.
}

pub fn decide(c: OpenCodeCapacity<'_>) -> Dispatch {
    if c.provider.trim().is_empty() || c.model.trim().is_empty() { return Dispatch::ModelMissing; }
    if !matches!(c.billing, Billing::Free) &&
       !(matches!(c.billing, Billing::Subscription) && c.paid_opt_in) {
        return Dispatch::BillingDenied;
    }
    match (c.capacity, c.active) {
        (Some(limit), Some(used)) if used >= limit => Dispatch::DeferredNoCapacity,
        (Some(limit), Some(used)) if used < limit => Dispatch::Ready,
        _ => Dispatch::Unverified,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn model() -> OpenCodeCapacity<'static> { OpenCodeCapacity {
        provider: "deepseek", model: "flash", capacity:Some(1), active:Some(0),
        billing:Billing::Free, paid_opt_in:false
    }}
    #[test] fn configured_open_code_works_without_claude_workers() {
        assert_eq!(decide(model()),Dispatch::Ready);
    }
    #[test] fn zero_capacity_never_creates_phantom_seats() {
        assert_eq!(decide(OpenCodeCapacity{capacity:Some(0),..model()}),Dispatch::DeferredNoCapacity);
    }
    #[test] fn unknown_capacity_does_not_authorize_dispatch() {
        assert_eq!(decide(OpenCodeCapacity{capacity:None,..model()}),Dispatch::Unverified);
    }
    #[test] fn paid_backend_requires_explicit_opt_in() {
        assert_eq!(decide(OpenCodeCapacity{billing:Billing::Subscription,..model()}),Dispatch::BillingDenied);
        assert_eq!(decide(OpenCodeCapacity{billing:Billing::Subscription,paid_opt_in:true,..model()}),Dispatch::Ready);
        assert_eq!(decide(OpenCodeCapacity{billing:Billing::Metered,paid_opt_in:true,..model()}),Dispatch::BillingDenied);
    }
}
