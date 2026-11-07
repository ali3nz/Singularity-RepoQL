"""Setup health + Repair for the dashboard (fleet#893 Z2/W7).

Thin, testable layer over `native/windows/provision/provisioner.py`:
  * `rows()` returns one honest status row per integration;
  * `repair()` runs the idempotent, independent provisioner (optionally one row);
  * `page_html()` is a self-contained page: plain-language state + one Fix action.

Nothing here talks to dockerhost, and no credential value is ever rendered.
"""
from __future__ import annotations

import html
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_PROVISIONER_DIR = HERE.parent / "native" / "windows" / "provision"

PLAIN = {
    "connected": "Connected",
    "needs-attention": "Needs attention",
    "not-available": "Not available",
}

ACTION = {
    "connected": "Check again",
    "needs-attention": "Fix",
    "not-available": "Details",
}


def provision_state_dir() -> Path:
    configured = os.environ.get("SINGULARITY_PROVISION_STATE_DIR")
    if configured:
        return Path(configured)
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / ".singularity")
    return Path(base) / "Singularity" / "provision"


def _provisioner():
    path = Path(os.environ.get("SINGULARITY_PROVISIONER_DIR", DEFAULT_PROVISIONER_DIR))
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))
    import provisioner  # noqa: PLC0415 - optional at runtime, required for Repair

    return provisioner


def rows() -> list[dict]:
    try:
        module = _provisioner()
    except Exception as exc:
        return [{
            "integration": "provisioner",
            "state": "not-available",
            "detail": f"provisioner module unavailable: {type(exc).__name__}",
        }]
    return module.Provisioner(provision_state_dir()).status()


def repair(only: list[str] | None = None) -> dict:
    module = _provisioner()
    return module.Provisioner(provision_state_dir()).repair(only)


def page_html(status_rows: list[dict]) -> str:
    items = []
    for row in status_rows:
        state = row.get("state", "not-available")
        name = html.escape(str(row.get("integration", "integration")))
        detail = html.escape(str(row.get("detail", "")))
        label = PLAIN.get(state, state)
        action = ACTION.get(state, "Fix")
        items.append(
            f'<li class="row {html.escape(state)}">'
            f'<div><strong>{name}</strong><span class="detail">{detail}</span></div>'
            f'<div class="right"><span class="badge">{html.escape(label)}</span>'
            f'<button data-integration="{name}">{html.escape(action)}</button></div></li>'
        )
    body = "\n".join(items) or '<li class="row">No integrations reported.</li>'
    payload = json.dumps(status_rows).replace("</", "<\\/")
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Setup health</title>
<style>
 body{{font:15px/1.5 system-ui,Segoe UI,sans-serif;margin:0;padding:32px;background:#0f1115;color:#e6e8ee}}
 h1{{font-size:20px;margin:0 0 4px}} p.sub{{color:#9aa3b2;margin:0 0 24px}}
 ul{{list-style:none;padding:0;margin:0;max-width:760px}}
 .row{{display:flex;justify-content:space-between;gap:16px;align-items:center;
   background:#171a21;border:1px solid #232833;border-radius:10px;padding:14px 16px;margin:0 0 10px}}
 .detail{{display:block;color:#9aa3b2;font-size:13px;margin-top:2px}}
 .right{{display:flex;gap:10px;align-items:center;white-space:nowrap}}
 .badge{{font-size:12px;padding:3px 8px;border-radius:999px;background:#232833;color:#c9d1e0}}
 .connected .badge{{background:#12351f;color:#7ee2a8}}
 .needs-attention .badge{{background:#3a2a10;color:#ffcc7a}}
 .not-available .badge{{background:#33191b;color:#ff9a9a}}
 button{{font:inherit;font-size:13px;padding:6px 12px;border-radius:8px;border:1px solid #3a4356;
   background:#1d2230;color:#e6e8ee;cursor:pointer}}
 button:disabled{{opacity:.5;cursor:default}}
 #msg{{max-width:760px;margin-top:16px;color:#9aa3b2;font-size:13px;white-space:pre-wrap}}
</style></head><body>
<h1>Setup health</h1>
<p class="sub">Each integration is independent. Fix only touches the row you choose.</p>
<ul id="rows">{body}</ul>
<div id="msg" role="status"></div>
<script>
 const initial = {payload};
 async function fix(name) {{
   const msg = document.getElementById('msg');
   msg.textContent = 'Working on ' + name + '...';
   try {{
     const res = await fetch('/api/setup/repair', {{
       method: 'POST', credentials: 'same-origin',
       headers: {{'Content-Type': 'application/json', 'X-Requested-With': 'repoql-dashboard'}},
       body: JSON.stringify({{only: [name]}}),
     }});
     const data = await res.json();
     const row = (data.results || []).find(r => r.integration === name);
     msg.textContent = row ? name + ': ' + row.action + ' - ' + row.detail : 'No result reported.';
     setTimeout(() => location.reload(), 900);
   }} catch (err) {{
     msg.textContent = 'Repair failed: ' + err;
   }}
 }}
 document.getElementById('rows').addEventListener('click', (event) => {{
   const button = event.target.closest('button[data-integration]');
   if (!button) return;
   fix(button.dataset.integration);
 }});
</script>
</body></html>"""
