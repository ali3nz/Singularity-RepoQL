"""HTTP adapter for the Harness Control Center (ticket 789).

Kept separate from server.py so the RepoQL dashboard's own routes stay
unchanged. Every method returns plain JSON-serialisable data; mutations are
limited to the dashboard's own telemetry settings, validated by the store.
"""
from __future__ import annotations

from typing import Any


class HarnessAPI:
    def __init__(self, harness, rust=None):
        self.harness = harness
        self.rust = rust

    # -- read ---------------------------------------------------------
    def get(self, path: str, params: dict) -> Any:
        h = self.harness
        if path == "/api/harness/overview":
            return h.overview(params.get("range", "24h"))
        if path == "/api/harness/agents":
            return h.agents()
        if path == "/api/harness/runs":
            return h.runs(params)
        if path == "/api/harness/run":
            run_id = (params.get("id") or "").strip()
            if not run_id:
                raise ValueError("id is required")
            return h.run_detail(run_id)
        if path == "/api/harness/performance":
            return h.performance(params.get("range", "7d"))
        if path == "/api/harness/usage":
            return h.usage(params.get("range", "30d"))
        if path == "/api/harness/events":
            return h.events(params)
        if path == "/api/harness/health":
            return h.health()
        if path == "/api/harness/rust":
            # Fail-open: a missing Rust service is reported, never raised into
            # the page. The panel renders the reason instead of breaking.
            if self.rust is None:
                return {"available": False, "error": "not_configured"}
            return self.rust.status()
        if path == "/api/harness/nannies":
            return h.nannies()
        if path == "/api/harness/settings":
            return {"settings": h.settings_with_effective(), "audit": h.store.setting_audit()}
        if path == "/api/harness/schema":
            return {
                "schema_version": 1,
                "categories": {
                    "run": ["run_created", "run_thread_bound", "run_started", "stage_started",
                            "run_completed", "run_failed"],
                    "agent": ["agent_assigned", "agent_started", "agent_waiting", "agent_error"],
                    "model": ["model_call", "model_fallback"],
                    "tool": ["tool_call", "tool_denied", "tool_error", "ingest_initialized"],
                    "review": ["review_started", "review_completed", "review_failed"],
                    "operator": ["operator_alert", "closeout", "advisory_queued", "gate_decision",
                                 "setting_changed"],
                },
                "bounded_fields": {
                    "detail": "<=200 chars, secrets and long blobs redacted",
                    "tokens_in/tokens_out": "only when the provider record reports them",
                    "cost_usd": "provider-reported only; never estimated",
                    "duration_ms": "measured by the source ledger, null when unavailable",
                },
                "sources": {
                    "run_state": "kit/runs/<id>/state.json",
                    "run_log": "kit/runs/<id>/run.log",
                    "run_ledger": "kit/runs/state/run-ledger.jsonl",
                    "engine_usage": "kit/runs/engine-usage.jsonl",
                    "consult": "kit/runs/session-consult-*.json + transcript tail",
                    "alerts": "kit/runs/nanny-alerts.jsonl",
                    "closeouts": "documentation/.state/closeout-receipts/*.json",
                    "tool_audit": "openchamber capability-audit.jsonl (tail, sampled)",
                },
                "retention": {
                    "detail_days_default": 14,
                    "aggregate_days_default": 90,
                    "storage_budget_mb_default": 256,
                    "budget_includes": ["harness.db", "-wal", "-shm", "-journal"],
                },
            }
        raise FileNotFoundError(f"no such harness endpoint: {path}")

    # -- mutation -----------------------------------------------------
    def post(self, path: str, body: dict) -> Any:
        if path != "/api/harness/settings":
            raise FileNotFoundError(f"no such harness endpoint: {path}")
        key = str(body.get("key") or "").strip()
        if not key:
            raise ValueError("key is required")
        value = body.get("value")
        if value is None:
            raise ValueError("value is required")
        actor = str(body.get("actor") or "operator")[:60]
        return self.harness.store.update_setting(key, value, actor)
