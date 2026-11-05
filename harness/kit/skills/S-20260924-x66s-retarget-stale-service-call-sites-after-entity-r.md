---
id: S-20260924-x66s
created: 2026-09-24T03:55:42.544Z
sourceRun: 2026-09-24T01-30-17
area: homeassistant maintenance
tags: [service-discovery, notify-retarget, repair-validation, plan-amendment, backup-before-edit, homeassistant-automations]
successCount: 1
usedIn: []
stale: false
---

# Retarget stale service call sites after entity rename
When Home Assistant repairs report service_not_found after a device rename/re-pair, do not assume the original service entity id still exists. Discover live service names via service_list or list_issues before editing. Count call sites with grep before sizing the plan — initial estimates can be wrong (this task went from an assumed 3 hits to 11). Runtime-validate repair targets (e.g., input_text entities) before dismissing stale repairs, especially if they predate a known config break. Always back up the config file with a timestamped name before editing. When retargeting notify calls after a rename, replace the deprecated action with notify.send_message plus target.entity_id pointing to the live entity id discovered at runtime — never invent entity ids. Let discovery output drive plan amendments rather than proceeding from stale assumptions.

## When this applies
- service_not_found repair
- notify entity renamed
- mobile_app_iphone not found
- stale repairs after device re-pair
- retarget notify call sites
- input_text set_value validation
