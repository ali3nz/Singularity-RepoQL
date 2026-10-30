# Milestone 55: native Claude Desktop Code-tab fresh-session memory proof plan

The existing legacy `scripts/acceptance-ordinary-session.mjs` uses the **standalone headless `claude` CLI** for capture and recall. That is not proof of the **native Claude Desktop Code tab** and must not be accepted as such. It is retained for its separate historical contract but excluded from native GUI signoff.

`native/windows/claude_complete_gui_acceptance_plan.py` creates a new, privately stored manual two-session experiment. Its first Code-tab prompt contains a random unique marker and a harmless three-digit value; its **second, fresh-session** prompt contains the marker but **not the value**. The operator must independently verify two distinct native GUI session identities, successful authenticated persistence into the correct Tencent scope, and recall in session two without prior transcript contamination.

Generate a new private plan on the authorized Windows machine (do not commit/upload it):

```powershell
python native/windows/claude_complete_gui_acceptance_plan.py --output C:\Private\native-gui-memory-plan.json
```

The generator checks output ancestry, refuses existing files, and never contacts Claude or Tencent. No result is marked passed simply because the model repeated the value, because a previous CLI run worked, or because a MemoryCore ledger exists. Screenshots, if captured, must be private/redacted. Native Claude Code tab events and real identity scopes require live verification.

Five targeted offline tests passed. Native GUI operations, two-session memory and production acceptance remain **NOT RUN / BLOCKED**. No broad suite was run.
