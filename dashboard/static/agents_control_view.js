// Agents Control page (default model/effort, per-agent prompts, canonical AGENTS.md).
// Split out of app.js; shared helpers arrive through bindAgentsControl() so this
// module never imports app.js (a second URL would load app.js twice).


let APP, api, bytes, esc, modal, pageHead, pill, state, toast;
export function bindAgentsControl(deps) {
  ({APP, api, bytes, esc, modal, pageHead, pill, state, toast} = deps);
}

// ------------------------------------------------------------ Agents Control
// One page for the three things that shape every agent run: the default model
// and thinking effort, each agent's own prompt (model, effort, description and
// body), and the canonical AGENTS.md every projection is generated from.
//
// Thinking effort is not a separate setting in this fleet: it is the `#level`
// suffix on a model id, so this page edits the two halves and recomposes them.
// Every write is staged through the fleet config guard, and the page reports
// "applied" or "staged" from the guard's own return code rather than assuming
// either — a staged write is a real outcome, not a failure and not a success.
const AC_EFFORTS = ["", "off", "minimal", "low", "medium", "high", "xhigh", "max"];
let acState = null;

function acEffortOptions(selected) {
  return AC_EFFORTS.map((value) =>
    `<option value="${value}"${value === (selected || "") ? " selected" : ""}>${value || "unset — inherit"}</option>`).join("");
}

function acOutcome(payload) {
  if (!payload) return "no response";
  if (payload.changed === false) return "no change";
  if (payload.applied) return "applied";
  if (payload.staged || payload.rc === 2) return "staged for the next idle window";
  if (typeof payload.rc === "number") return `guard rc=${payload.rc}`;
  return "done";
}

function acWarnings(payload) {
  const list = Array.isArray(payload?.warnings) ? payload.warnings : [];
  return list.length ? ` — verify: ${list.join("; ")}` : "";
}

// The status strip states what the page can prove: how many agents were read,
// whether the guard would apply or defer, and whether the canonical file has a
// write waiting behind it.
function acStatusStrip(data) {
  const guard = data.guard || {};
  const canonical = data.canonical || {};
  const guardChip = guard.available === false
    ? `<span class="pill amber" title="${esc(guard.reason || "")}">guard unverified</span>`
    : (guard.active_turn
      ? `<span class="pill amber">turn active — writes stage</span>`
      : `<span class="pill green">idle — writes apply</span>`);
  const syncChip = canonical.staged
    ? `<span class="pill amber">AGENTS.md write staged</span>`
    : (canonical.available ? `<span class="pill green">AGENTS.md canonical</span>` : `<span class="pill red">AGENTS.md missing</span>`);
  return `<div class="ac-status">
    <span class="muted small">${data.count} agent${data.count === 1 ? "" : "s"} read from <code>${esc(data.directory || "")}</code></span>
    ${guardChip}${syncChip}
    ${data.errors ? `<span class="pill red">${data.errors} unreadable</span>` : ""}
    <span class="muted small" role="status" aria-live="polite" id="ac-notice"></span>
  </div>`;
}

function acDefaultsBlock(data) {
  const defaults = data.defaults || {};
  const pi = defaults.pi || {};
  const oc = defaults.opencode || {};
  const piMissing = pi.available === false;
  const ocMissing = oc.available === false;
  return `<section class="block" id="ac-defaults">
    <div class="block-title">Default model &amp; thinking effort <span class="tag">global fallback</span></div>
    <p class="muted small">What an agent or subagent inherits when its own prompt pins nothing. A per-agent <code>#effort</code> suffix still wins over this.</p>
    <div class="ac-grid">
      <label class="ac-field">Pi default model
        ${acModelButton("ac-pi-model", pi.default_model || "", piMissing)}
        <span class="muted small">${piMissing ? esc(pi.reason || "unavailable") : `provider ${esc(pi.default_provider || "—")}`}</span>
      </label>
      <label class="ac-field">Pi thinking effort
        <select id="ac-pi-think" ${piMissing ? "disabled" : ""}>${acEffortOptions(pi.default_thinking || "")}</select>
        <span class="muted small">${pi.model_levels ? `${pi.model_levels} model levels mapped` : "no level map"}</span>
      </label>
      <label class="ac-field">OpenCode model
        ${acModelButton("ac-oc-model", oc.model_id || "", ocMissing)}
        <span class="muted small">${ocMissing ? esc(oc.reason || "unavailable") : esc(oc.model || "")}</span>
      </label>
      <label class="ac-field">OpenCode effort
        <select id="ac-oc-effort" ${ocMissing ? "disabled" : ""}>${acEffortOptions(oc.effort || "")}</select>
      </label>
      <label class="ac-field">OpenCode small model
        ${acModelButton("ac-oc-small", oc.small_model || "", ocMissing)}
        <span class="muted small">used for titles and summaries</span>
      </label>
    </div>
    <div class="toolbar">
      <button class="btn primary" type="button" data-ac="apply-defaults">Apply defaults</button>
      <span class="muted small" id="ac-defaults-note"></span>
    </div>
  </section>`;
}

// ---- Model picker (OpenChamber-style): searchable, grouped by provider, usable on a phone. ----
const AC_PROVIDER_NAMES = {
  openrouter: "OpenRouter", opencode: "OpenCode Zen", "opencode-go": "OpenCode Go", freebuff: "Freebuff",
  "freebuff-wg": "Freebuff (WG)", "openai-codex": "OpenAI Codex", openai: "OpenAI", "claude-oc": "Claude (OpenCode)",
  "claude-pro": "Claude Pro", nvidia_nim: "NVIDIA NIM", groq: "Groq", poolside: "Poolside", unsloth: "Unsloth", router: "Router",
};
const acProviderOf = (id) => id.includes("/") ? id.split("/")[0] : "other";
const acProviderLabel = (key) => AC_PROVIDER_NAMES[key] || key;
function acModelLabel(id) {
  if (!id) return "Not set";
  const rest = id.includes("/") ? id.split("/").slice(1).join("/") : id;
  const last = rest.split("/").pop();
  return last.replace(/[-_]+/g, " ").replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bGpt\b/g, "GPT");
}
function acCleanModels(data) {
  // Same set Pi Code shows (its catalogue minus the operator's hidden models).
  const names = new Map();
  const all = new Set();
  const picker = Array.isArray(data.picker_models) ? data.picker_models : [];
  for (const item of picker) { all.add(item.id); if (item.name) names.set(item.id, item.name); }
  if (!picker.length) {
    for (const id of data.known_models || []) {
      if (/^[A-Za-z0-9][\w.-]*\/[^\s:]+$/.test(id) && !/^https?\//.test(id)) all.add(id);
    }
  }
  const used = new Map();
  for (const agent of data.agents || []) {
    if (agent.model_id && (all.has(agent.model_id) || !picker.length)) used.set(agent.model_id, (used.get(agent.model_id) || 0) + 1);
  }
  return { all: [...all].sort(), used, names };
}
function acModelButton(id, value, disabled) {
  return `<button type="button" class="ac-model-btn" id="${id}" data-ac="pick-default-model" data-value="${esc(value)}"${disabled ? " disabled" : ""}>
    <span class="ac-model-name">${esc(acModelLabel(value))}</span><span class="ac-model-id">${esc(value || "tap to choose")}</span><span class="ac-chev" aria-hidden="true">›</span></button>`;
}
let acSheetStack = [];
function acOpenSheet(title, build, onClose) {
  const layer = document.createElement("div");
  layer.className = "ac-sheet-layer";
  layer.innerHTML = `<div class="ac-sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <header class="ac-sheet-head"><button type="button" class="ac-sheet-back" aria-label="Back">‹</button>
      <h2>${esc(title)}</h2><button type="button" class="ac-sheet-close" aria-label="Close">✕</button></header>
    <div class="ac-sheet-body"></div></div>`;
  document.body.append(layer);
  document.documentElement.classList.add("ac-sheet-open");
  const close = () => {
    layer.remove();
    if (onClose) onClose();
    acSheetStack = acSheetStack.filter((entry) => entry !== layer);
    if (!acSheetStack.length) document.documentElement.classList.remove("ac-sheet-open");
  };
  layer.querySelector(".ac-sheet-back").addEventListener("click", close);
  layer.querySelector(".ac-sheet-close").addEventListener("click", () => { [...acSheetStack].forEach((entry) => entry.querySelector(".ac-sheet-back").click()); });
  layer.addEventListener("click", (event) => { if (event.target === layer) close(); });
  layer.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.stopPropagation(); close(); } });
  acSheetStack.push(layer);
  build(layer.querySelector(".ac-sheet-body"), close);
  return close;
}

// Resolves to the chosen model id, or null if dismissed.
function acPickModel(current) {
  return new Promise((resolve) => {
    const { all, used, names } = acCleanModels(acState || {});
    if (current && !all.includes(current)) all.unshift(current);
    let done = false;
    const finish = (value, close) => { if (done) return; done = true; resolve(value); close(); };
    acOpenSheet("Select model", (body, closeSheet) => {
      body.innerHTML = `<div class="ac-search"><input type="search" placeholder="Search models" aria-label="Search models" autocomplete="off" autocapitalize="off" spellcheck="false"></div><div class="ac-model-list" role="listbox"></div>`;
      const input = body.querySelector("input");
      const list = body.querySelector(".ac-model-list");
      const row = (id) => `<button type="button" class="ac-opt${id === current ? " selected" : ""}" role="option" data-id="${esc(id)}" aria-selected="${id === current}">
        <span class="ac-opt-main"><span class="ac-opt-name">${esc(names.get(id) || acModelLabel(id))}</span><span class="ac-opt-id">${esc(id)}</span></span>
        ${id === current ? '<span class="ac-check" aria-hidden="true">✓</span>' : ""}</button>`;
      const render = () => {
        const q = input.value.trim().toLowerCase();
        if (q) {
          const hits = all.filter((id) => id.toLowerCase().includes(q) || (names.get(id) || acModelLabel(id)).toLowerCase().includes(q));
          list.innerHTML = (hits.slice(0, 80).map(row).join("") || `<p class="ac-none">No model matches.</p>`) +
            (hits.length > 80 ? `<p class="ac-none">${hits.length - 80} more — keep typing to narrow.</p>` : "") +
            (!all.includes(input.value.trim()) && input.value.includes("/") ? `<button type="button" class="ac-opt ac-custom" data-id="${esc(input.value.trim())}"><span class="ac-opt-main"><span class="ac-opt-name">Use “${esc(input.value.trim())}”</span><span class="ac-opt-id">custom model id</span></span></button>` : "");
          return;
        }
        const inUse = [...used.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
        const groups = new Map();
        for (const id of all) { const key = acProviderOf(id); (groups.get(key) || groups.set(key, []).get(key)).push(id); }
        let html = "";
        if (inUse.length) html += `<section class="ac-group"><h3>In use by agents</h3>${inUse.map(row).join("")}</section>`;
        for (const [key, ids] of [...groups.entries()].sort((a, b) => acProviderLabel(a[0]).localeCompare(acProviderLabel(b[0])))) {
          const open = ids.includes(current);
          html += `<details class="ac-group"${open ? " open" : ""}><summary><span>${esc(acProviderLabel(key))}</span><span class="ac-count">${ids.length}</span></summary>${ids.map(row).join("")}</details>`;
        }
        list.innerHTML = html + `<p class="ac-none">Not listed? Type a full <code>provider/model</code> id above.</p>`;
      };
      input.addEventListener("input", render);
      list.addEventListener("click", (event) => {
        const opt = event.target.closest(".ac-opt");
        if (opt) finish(opt.getAttribute("data-id"), closeSheet);
      });
      render();
      const sel = list.querySelector(".ac-opt.selected");
      if (sel) setTimeout(() => sel.scrollIntoView({ block: "center" }), 30);
    }, () => { if (!done) { done = true; resolve(null); } });
  });
}

async function acPickDefault(button) {
  const choice = await acPickModel(button.dataset.value || "");
  if (choice == null) return;
  button.dataset.value = choice;
  button.querySelector(".ac-model-name").textContent = acModelLabel(choice);
  button.querySelector(".ac-model-id").textContent = choice;
}

// ---- Agent list + editor sheet ----
function acAgentRow(agent) {
  if (agent.error) {
    return `<div class="ac-card ac-bad" data-agent="${esc(agent.name)}"><strong>${esc(agent.name)}</strong><span class="muted small">unreadable: ${esc(agent.error)}</span></div>`;
  }
  const isBot = /^omb-[0-9a-f]{8,}/i.test(agent.name);
  const shown = isBot ? "Bot " + agent.name.slice(4, 12) : agent.name;
  const desc = isBot ? "OpenMausBot persistent bot · " + agent.name.slice(4, 12) + "…" : (agent.description || "no description");
  return `<div class="ac-card${isBot ? " ac-omb" : ""}" data-agent="${esc(agent.name)}" data-search="${esc((agent.name + " " + (agent.description || "") + " " + (agent.model_id || "")).toLowerCase())}">
    <label class="ac-pick-wrap"><input type="checkbox" class="ac-pick" aria-label="select ${esc(agent.name)}"></label>
    <button type="button" class="ac-card-main" data-ac="open-agent">
      <span class="ac-card-top"><strong>${esc(shown)}</strong>${isBot ? '<span class="pill ac-omb-pill">OpenMausBot</span>' : ""}
        ${agent.mode && !isBot ? `<span class="pill">${esc(agent.mode)}</span>` : ""}${agent.staged ? `<span class="pill amber">staged</span>` : ""}</span>
      <span class="ac-card-desc">${esc(desc)}</span>
      <span class="ac-card-meta"><span class="ac-chip">${esc(acModelLabel(agent.model_id))}</span>
        <span class="ac-chip ac-chip-effort">${esc(agent.effort || "inherit")}</span></span>
    </button><span class="ac-chev" aria-hidden="true">›</span></div>`;
}

function acAgentsBlock(data) {
  const histogram = Object.entries(data.effort_histogram || {})
    .map(([effort, count]) => `<span class="ac-hist"><code>${esc(effort)}</code> ${count}</span>`).join("");
  const agents = data.agents || [];
  const known = new Set((data.groups || []).map((g) => g.key));
  const groups = (data.groups || []).map((g) => ({ ...g, items: agents.filter((a) => (known.has(a.group) ? a.group : "specialists") === g.key) }))
    .filter((g) => g.items.length);
  const sections = groups.map((g) => `<section class="ac-group-block" data-group="${esc(g.key)}">
      <div class="ac-group-title"><label class="ac-group-pick"><input type="checkbox" class="ac-group-box" data-group="${esc(g.key)}" aria-label="select all in ${esc(g.label)}"> ${esc(g.label)}</label>
        <span class="tag">${g.items.length}</span></div>
      <div class="ac-cards" data-group-cards="${esc(g.key)}">${g.items.map(acAgentRow).join("")}</div>
    </section>`).join("");
  return `<section class="block" id="ac-agents">
    <div class="block-title">Agents <span class="tag">${data.count} agents</span></div>
    <div class="ac-search"><input type="search" id="ac-agent-search" placeholder="Search agents" aria-label="Search agents" autocomplete="off" spellcheck="false"></div>
    <div class="ac-bulk ac-bulk-bar">
      <div class="toolbar">
        <strong id="ac-sel-count" class="small">0 selected</strong>
        <button class="btn primary" type="button" data-ac="bulk-model">Change model…</button>
        <select id="ac-bulk-effort" aria-label="Effort for selected agents">${acEffortOptions("")}</select>
        <button class="btn" type="button" data-ac="bulk-effort">Set effort</button>
        <button class="btn" type="button" data-ac="pick-all">Select all</button>
        <button class="btn" type="button" data-ac="pick-none">Clear</button>
      </div>
      <div class="ac-hist-line">${histogram}</div>
      <span class="muted small" id="ac-bulk-note">Tick a group heading to select every agent in it, then choose a model.</span>
    </div>
    ${sections}
  </section>`;
}

function acSelectedAgents() {
  return [...document.querySelectorAll(".ac-pick:checked")]
    .map((box) => box.closest("[data-agent]")?.getAttribute("data-agent")).filter(Boolean);
}

function acSyncSelection() {
  const root = document.getElementById("ac-agents");
  if (!root) return;
  root.querySelectorAll(".ac-group-block").forEach((section) => {
    const boxes = [...section.querySelectorAll(".ac-pick")].filter((box) => !box.closest(".ac-card").hidden);
    const on = boxes.filter((box) => box.checked).length;
    const head = section.querySelector(".ac-group-box");
    if (head) { head.checked = !!boxes.length && on === boxes.length; head.indeterminate = on > 0 && on < boxes.length; }
  });
  const count = document.getElementById("ac-sel-count");
  if (count) count.textContent = `${acSelectedAgents().length} selected`;
}

async function acBulkModel() {
  const note = document.getElementById("ac-bulk-note");
  const picked = acSelectedAgents();
  if (!picked.length) {
    if (note) note.textContent = "Select at least one agent or group first.";
    return;
  }
  const currents = new Set(picked.map((n) => (acState?.agents || []).find((a) => a.name === n)?.model_id || ""));
  const choice = await acPickModel(currents.size === 1 ? [...currents][0] : "");
  if (choice == null) return;
  if (!window.confirm(`Set the model of ${picked.length} agent(s) to ${choice}?\n\n${picked.join(", ")}`)) return;
  if (note) note.textContent = `Applying ${choice} to ${picked.length} agent(s)…`;
  try {
    const result = await api("/api/agents-control/model", { method: "POST", body: { names: picked, model_id: choice } });
    const failed = (result.results || []).filter((item) => item.error);
    const text = `${result.changed || 0} of ${result.requested} changed${result.staged ? `, ${result.staged} staged until OpenChamber is idle` : ""}${failed.length ? `, ${failed.length} refused` : ""}`;
    if (note) note.textContent = text;
    toast("Bulk model", text, failed.length ? "error" : "");
    await acReload();
  } catch (error) {
    const message = error.message || "bulk model change failed";
    if (note) note.textContent = message;
    toast("Bulk model", message, "error");
  }
}

async function acOpenAgent(name) {
  const agent = (acState?.agents || []).find((item) => item.name === name);
  if (!agent) return;
  let model = agent.model_id || "";
  let effort = agent.effort || "";
  let detail = null;
  acOpenSheet(name, (body, close) => {
    const levels = ["", ...((acState && acState.thinking_levels) || AC_EFFORTS.filter(Boolean))];
    body.innerHTML = `<div class="ac-form">
      <p class="ac-form-desc">${esc(agent.description || "")}</p>
      <div class="ac-label">Model</div>
      <button type="button" class="ac-model-btn" id="ac-sheet-model"><span class="ac-model-name">${esc(acModelLabel(model))}</span><span class="ac-model-id">${esc(model || "tap to choose")}</span><span class="ac-chev" aria-hidden="true">›</span></button>
      <div class="ac-label">Thinking variant</div>
      <div class="ac-seg" role="radiogroup" aria-label="Thinking variant">${levels.map((level) =>
        `<button type="button" role="radio" class="ac-seg-opt${level === effort ? " on" : ""}" aria-checked="${level === effort}" data-level="${esc(level)}">${esc(level || "inherit")}</button>`).join("")}</div>
      <div class="ac-label">System prompt</div>
      <label class="ac-field"><span class="muted small">Description</span><textarea id="ac-sheet-desc" rows="2" spellcheck="false" disabled></textarea></label>
      <label class="ac-field"><span class="muted small">Body — frontmatter is preserved as-is; cap ${acState?.body_cap || 10000} characters</span><textarea id="ac-sheet-body" class="ac-body" rows="14" spellcheck="false" disabled></textarea></label>
      ${agent.is_redamon ? `<div class="ac-label">Scopes — what this agent may do</div>
      <p class="muted small">Each rule is an action, a resource and an allow or deny effect. Saved as the agent's permissions list.</p>
      <div id="ac-sheet-perms">${(agent.permissions || []).map(acPermRow).join("")}</div>
      <button type="button" class="btn" id="ac-perm-add">Add scope</button>` : ""}
      <p class="muted small" id="ac-sheet-note" role="status" aria-live="polite"></p>
      <div class="ac-sheet-actions"><button type="button" class="btn primary" id="ac-sheet-save">Save</button><button type="button" class="btn" id="ac-sheet-cancel">Cancel</button></div></div>`;
    const modelBtn = body.querySelector("#ac-sheet-model");
    const permsBox = body.querySelector("#ac-sheet-perms");
    if (permsBox) {
      body.querySelector("#ac-perm-add").addEventListener("click", () => {
        permsBox.insertAdjacentHTML("beforeend", acPermRow({ action: "", resource: "*", effect: "allow" }));
      });
      permsBox.addEventListener("click", (event) => {
        const remove = event.target.closest(".ac-perm-remove");
        if (remove) remove.closest("[data-perm]")?.remove();
      });
    }
    modelBtn.addEventListener("click", async () => {
      const choice = await acPickModel(model);
      if (choice == null) return;
      model = choice;
      modelBtn.querySelector(".ac-model-name").textContent = acModelLabel(model);
      modelBtn.querySelector(".ac-model-id").textContent = model;
    });
    body.querySelector(".ac-seg").addEventListener("click", (event) => {
      const opt = event.target.closest(".ac-seg-opt");
      if (!opt) return;
      effort = opt.getAttribute("data-level");
      body.querySelectorAll(".ac-seg-opt").forEach((node) => {
        const on = node === opt; node.classList.toggle("on", on); node.setAttribute("aria-checked", String(on));
      });
    });
    body.querySelector("#ac-sheet-cancel").addEventListener("click", close);
    const note = body.querySelector("#ac-sheet-note");
    const descField = body.querySelector("#ac-sheet-desc");
    const bodyField = body.querySelector("#ac-sheet-body");
    api(`/api/agents-control/agent?name=${encodeURIComponent(name)}`).then((result) => {
      detail = result;
      descField.value = result.description || ""; bodyField.value = result.body || "";
      descField.disabled = false; bodyField.disabled = !agent.editable_body;
      if (!agent.editable_body) note.textContent = "Prompt body exceeds the editor cap; model and effort can still be changed.";
    }).catch((error) => { note.textContent = `Prompt unavailable: ${error.message || "read failed"}`; });
    body.querySelector("#ac-sheet-save").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const changes = {};
      if (model !== (agent.model_id || "")) changes.model_id = model;
      if (effort !== (agent.effort || "")) changes.effort = effort;
      if (detail && descField.value.trim() !== (detail.description || "").trim()) changes.description = descField.value.trim();
      if (detail && agent.editable_body && bodyField.value !== (detail.body || "")) changes.body = bodyField.value;
      if (permsBox) {
        const rules = [...permsBox.querySelectorAll("[data-perm]")].map((row) => ({
          action: row.querySelector(".ac-perm-action").value.trim(),
          resource: row.querySelector(".ac-perm-resource").value.trim(),
          effect: row.querySelector(".ac-perm-effect").value,
        }));
        if (JSON.stringify(rules) !== JSON.stringify(agent.permissions || [])) changes.permissions = rules;
      }
      if (!Object.keys(changes).length) { note.textContent = "Nothing changed."; return; }
      button.disabled = true; note.textContent = "Saving…";
      try {
        const result = await api("/api/agents-control/agent", { method: "POST", body: { name, changes } });
        const text = `${name}: ${acOutcome(result)}${acWarnings(result)}`;
        toast("Agent", text);
        close();
        await acReload();
        acNotice(text);
      } catch (error) {
        note.textContent = error.message || "save failed";
        toast("Agent", error.message || "save failed", "error");
        button.disabled = false;
      }
    });
  });
}

function acPermRow(rule) {
  return `<div class="ac-perm-row" data-perm>
    <input class="ac-perm-action" aria-label="Scope action" value="${esc(rule.action || "")}" spellcheck="false">
    <input class="ac-perm-resource" aria-label="Scope resource" value="${esc(rule.resource || "")}" spellcheck="false">
    <select class="ac-perm-effect" aria-label="Scope effect">
      <option value="allow"${rule.effect === "deny" ? "" : " selected"}>allow</option>
      <option value="deny"${rule.effect === "deny" ? " selected" : ""}>deny</option>
    </select>
    <button type="button" class="btn ac-perm-remove">Remove</button></div>`;
}

function acRedamonBlock(data) {
  const r = data.redamon;
  if (!r) return "";
  const rows = (r.agents || []).map((a) => `<div class="ac-card" data-agent="${esc(a.name)}">
    <button type="button" class="ac-card-main" data-ac="open-agent">
      <span class="ac-card-top"><strong>${esc(a.name)}</strong><span class="pill">RedAmon</span></span>
      <span class="ac-card-meta"><span class="ac-chip">${esc(acModelLabel(a.model_id))}</span>
        <span class="ac-chip ac-chip-effort">${esc(a.effort || "inherit")}</span>
        <span class="ac-chip">${(a.permissions || []).length} scope${(a.permissions || []).length === 1 ? "" : "s"}</span></span>
    </button><span class="ac-chev" aria-hidden="true">›</span></div>`).join("")
    || `<p class="muted small">No RedAmon agent definition was found in the OpenChamber agents directory.</p>`;
  const p = r.pi;
  const pi = p
    ? `<div class="ac-card" data-pi-redamon><button type="button" class="ac-card-main" data-ac="open-pi-redamon">
      <span class="ac-card-top"><strong>Pi Chamber · redamon</strong><span class="pill">Pi</span></span>
      <span class="ac-card-meta"><span class="ac-chip">${esc(acModelLabel(p.model))}</span>
        <span class="ac-chip ac-chip-effort">${esc(p.thinking || "unset")}</span>
        <span class="ac-chip">${(p.permissions || []).length} scope${(p.permissions || []).length === 1 ? "" : "s"}</span></span>
    </button><span class="ac-chev" aria-hidden="true">›</span></div>`
    : "";
  const shown = (r.roster_shown || []).includes("redamon") ? " checked" : "";
  return `<section class="block" id="ac-redamon">
    <div class="block-title">RedAmon subagents <span class="tag">${(r.agents || []).length}</span></div>
    <p class="muted small">Model, thinking effort, scopes and prompt for the RedAmon operator. Every change goes through the same guarded write as other agents. This page does not start or stop RedAmon's containers.</p>
    <div class="ac-cards">${rows}${pi}</div>
    <label class="ac-field ac-inline"><input type="checkbox" id="ac-roster-redamon"${shown}> Show RedAmon on the Pi Chamber agent roster</label>
    <p class="muted small" id="ac-roster-note" role="status" aria-live="polite"></p>
  </section>`;
}

async function acOpenPi() {
  const pi = acState?.redamon?.pi;
  if (!pi) return;
  let model = pi.model || "";
  let thinking = pi.thinking || "";
  acOpenSheet("Pi Chamber · redamon", (body, close) => {
    body.innerHTML = `<div class="ac-form">
      <p class="ac-form-desc">The Pi Chamber copy of the RedAmon operator. Its model, thinking and scopes change here; its prompt is not editable from this panel.</p>
      <div class="ac-label">Model</div>
      <button type="button" class="ac-model-btn" id="ac-pi-model"><span class="ac-model-name">${esc(acModelLabel(model))}</span><span class="ac-model-id">${esc(model || "tap to choose")}</span><span class="ac-chev" aria-hidden="true">›</span></button>
      <div class="ac-label">Thinking</div>
      <div class="ac-seg" role="radiogroup" aria-label="Pi thinking">${(acState?.thinking_levels || AC_EFFORTS.filter(Boolean)).map((level) =>
        `<button type="button" role="radio" class="ac-seg-opt${level === thinking ? " on" : ""}" aria-checked="${level === thinking}" data-level="${esc(level)}">${esc(level)}</button>`).join("")}</div>
      <div class="ac-label">Scopes — what this agent may do</div>
      <div id="ac-sheet-perms">${(pi.permissions || []).map(acPermRow).join("")}</div>
      <button type="button" class="btn" id="ac-perm-add">Add scope</button>
      <p class="muted small" id="ac-sheet-note" role="status" aria-live="polite"></p>
      <div class="ac-sheet-actions"><button type="button" class="btn primary" id="ac-sheet-save">Save</button><button type="button" class="btn" id="ac-sheet-cancel">Cancel</button></div></div>`;
    const note = body.querySelector("#ac-sheet-note");
    const permsBox = body.querySelector("#ac-sheet-perms");
    body.querySelector("#ac-perm-add").addEventListener("click", () => {
      permsBox.insertAdjacentHTML("beforeend", acPermRow({ action: "", resource: "*", effect: "allow" }));
    });
    permsBox.addEventListener("click", (event) => {
      const remove = event.target.closest(".ac-perm-remove");
      if (remove) remove.closest("[data-perm]")?.remove();
    });
    body.querySelector(".ac-seg").addEventListener("click", (event) => {
      const opt = event.target.closest(".ac-seg-opt");
      if (!opt) return;
      thinking = opt.getAttribute("data-level");
      body.querySelectorAll(".ac-seg-opt").forEach((node) => {
        const on = node === opt; node.classList.toggle("on", on); node.setAttribute("aria-checked", String(on));
      });
    });
    body.querySelector("#ac-pi-model").addEventListener("click", async () => {
      const choice = await acPickModel(model);
      if (choice == null) return;
      model = choice;
      body.querySelector("#ac-pi-model .ac-model-name").textContent = acModelLabel(model);
      body.querySelector("#ac-pi-model .ac-model-id").textContent = model;
    });
    body.querySelector("#ac-sheet-cancel").addEventListener("click", close);
    body.querySelector("#ac-sheet-save").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const changes = {};
      if (model !== (pi.model || "")) changes.model = model;
      if (thinking !== (pi.thinking || "")) changes.thinking = thinking;
      const rules = [...permsBox.querySelectorAll("[data-perm]")].map((row) => ({
        action: row.querySelector(".ac-perm-action").value.trim(),
        resource: row.querySelector(".ac-perm-resource").value.trim(),
        effect: row.querySelector(".ac-perm-effect").value,
      }));
      if (JSON.stringify(rules) !== JSON.stringify(pi.permissions || [])) changes.permissions = rules;
      if (!Object.keys(changes).length) { note.textContent = "Nothing changed."; return; }
      button.disabled = true; note.textContent = "Saving…";
      try {
        const result = await api("/api/agents-control/pi-redamon", { method: "POST", body: { changes } });
        const text = `Pi Chamber redamon: ${result.changed ? "saved" : "no change"}`;
        toast("Pi Chamber", text);
        close();
        await acReload();
        acNotice(text);
      } catch (error) {
        note.textContent = error.message || "save failed";
        toast("Pi Chamber", error.message || "save failed", "error");
        button.disabled = false;
      }
    });
  });
}

async function acSetRoster(box) {
  const note = document.getElementById("ac-roster-note");
  try {
    const result = await api("/api/agents-control/roster", { method: "POST", body: { name: "redamon", visible: box.checked } });
    if (note) note.textContent = result.visible ? "Shown on the Pi Chamber roster." : "Hidden from the Pi Chamber roster.";
  } catch (error) {
    box.checked = !box.checked;
    if (note) note.textContent = error.message || "save failed";
  }
}

function acCanonicalBlock(data) {
  const canonical = data.canonical || {};
  if (canonical.available === false) {
    return `<section class="block accent-red"><div class="block-title">Canonical AGENTS.md</div>
      <p class="muted small">${esc(canonical.reason || "not found")} at <code>${esc(canonical.path || "")}</code></p></section>`;
  }
  return `<section class="block" id="ac-canonical">
    <div class="block-title">Canonical AGENTS.md <span class="tag">single hand-edited source</span></div>
    <p class="muted small">Every other rule file is generated from this one. A write here is staged through the guard, and on apply the generator runs so the projections are proven to match — this page never assumes the sync happened.</p>
    <div class="ac-facts">
      <span><code>${esc(canonical.sha256.slice(0, 12))}</code></span>
      <span>${canonical.lines} lines</span>
      <span>${canonical.bytes} bytes</span>
      <span>modified ${esc(canonical.modified || "")}</span>
      ${canonical.sync_available ? "" : `<span class="pill amber">agents-md-sync unavailable</span>`}
      ${canonical.staged ? `<span class="pill amber">staged sha ${esc((canonical.staged_sha256 || "").slice(0, 12))}</span>` : ""}
    </div>
    <div class="toolbar">
      <button class="btn" type="button" data-ac="load-canonical">Load editor</button>
      <span class="muted small" id="ac-canonical-note"></span>
    </div>
    <div id="ac-canonical-editor"></div>
  </section>`;
}

function acHistoryBlock() {
  return `<section class="block" id="ac-history">
    <div class="block-title">Recent backups</div>
    <p class="muted small">Every write copies the file first. These are the newest batches under <code>/mnt/newdata/backups/agents-control/</code>.</p>
    <button class="btn" type="button" data-ac="load-history">Show backups</button>
    <div id="ac-history-body"></div>
  </section>`;
}

export async function viewAgentsControl() {
  APP.innerHTML = pageHead("Agents Control",
    "Default model and thinking effort, per-agent prompts, and the canonical AGENTS.md") +
    `<div id="ac-root" aria-live="polite"><div class="loading">Reading agent configuration…</div></div>`;
  const root = document.getElementById("ac-root");
  if (!root) return;
  root.addEventListener("click", acClick);
  root.addEventListener("change", (event) => {
    if (event.target.id === "ac-roster-redamon") return acSetRoster(event.target);
    if (event.target.classList?.contains("ac-group-box")) {
      const key = event.target.getAttribute("data-group");
      root.querySelectorAll(`[data-group-cards="${key}"] .ac-card:not([hidden]) .ac-pick`).forEach((box) => { box.checked = event.target.checked; });
      return acSyncSelection();
    }
    if (event.target.classList?.contains("ac-pick")) acSyncSelection();
  });
  root.addEventListener("input", (event) => {
    if (event.target.id !== "ac-agent-search") return;
    const q = event.target.value.trim().toLowerCase();
    root.querySelectorAll("#ac-agents .ac-card").forEach((card) => { card.hidden = !!q && !(card.dataset.search || "").includes(q); });
    root.querySelectorAll("#ac-agents .ac-group-block").forEach((sec) => { sec.hidden = !!q && !sec.querySelector(".ac-card:not([hidden])"); });
    acSyncSelection();
  });
  acState = null;
  await acReload();
}

async function acReload() {
  const root = document.getElementById("ac-root");
  if (!root) return;
  const signal = state.routeAbort?.signal;
  let data;
  try {
    data = await api("/api/agents-control");
  } catch (error) {
    if (signal?.aborted || !root.isConnected) return;
    root.innerHTML = `<div class="block accent-red"><div class="block-title">Agents Control unavailable</div>
      <p class="muted small">${esc(error.message || "read failed")}</p>
      <p class="muted small">The page reports only what it can read. Nothing is presented as healthy by default.</p></div>`;
    return;
  }
  if (signal?.aborted || !root.isConnected) return;
  acState = data;
  root.innerHTML = acStatusStrip(data) + acDefaultsBlock(data) + acAgentsBlock(data) +
    acRedamonBlock(data) + acCanonicalBlock(data) + acHistoryBlock();
}

function acNotice(text, tone) {
  const node = document.getElementById("ac-notice");
  if (node) node.textContent = text;
  if (tone === "error") toast("Agents Control", text, "error");
}

async function acApplyDefaults() {
  const note = document.getElementById("ac-defaults-note");
  const body = {};
  const read = (id) => document.getElementById(id);
  const piModel = read("ac-pi-model");
  const piThink = read("ac-pi-think");
  const ocModel = read("ac-oc-model");
  const ocEffort = read("ac-oc-effort");
  const ocSmall = read("ac-oc-small");
  if (piModel && !piModel.disabled) body.pi_model = (piModel.dataset.value || "").trim();
  if (piThink && !piThink.disabled) body.pi_thinking = piThink.value;
  if (ocModel && !ocModel.disabled) body.opencode_model = (ocModel.dataset.value || "").trim();
  if (ocEffort && !ocEffort.disabled) body.opencode_effort = ocEffort.value;
  if (ocSmall && !ocSmall.disabled) body.opencode_small_model = (ocSmall.dataset.value || "").trim();
  const button = document.querySelector('[data-ac="apply-defaults"]');
  if (button) button.disabled = true;
  if (note) note.textContent = "Applying…";
  try {
    const result = await api("/api/agents-control/defaults", { method: "POST", body });
    const lines = Object.entries(result.results || {}).map(([surface, detail]) => {
      if (detail.ok === false) return `${surface}: not changed — ${detail.reason || "unavailable"}`;
      const parts = [];
      if (detail.changed && detail.changed.length) parts.push(detail.changed.join(", "));
      if (detail.applied) parts.push("applied");
      if (detail.staged) parts.push("staged for the next idle window");
      if (detail.verified === false) parts.push("READ-BACK MISMATCH");
      return `${surface}: ${parts.join(" · ") || "no change"}`;
    });
    const text = lines.join(" | ");
    if (note) note.textContent = text;
    toast("Defaults", text);
    await acReload();
  } catch (error) {
    if (note) note.textContent = error.message || "failed";
    toast("Defaults", error.message || "failed", "error");
  } finally {
    const again = document.querySelector('[data-ac="apply-defaults"]');
    if (again) again.disabled = false;
  }
}

async function acLoadCanonical() {
  const host = document.getElementById("ac-canonical-editor");
  if (!host) return;
  host.innerHTML = `<div class="loading">Reading canonical AGENTS.md…</div>`;
  let detail;
  try {
    detail = await api("/api/agents-control/canonical");
  } catch (error) {
    host.innerHTML = `<div class="block accent-red"><p class="muted small">${esc(error.message || "read failed")}</p></div>`;
    return;
  }
  if (!host.isConnected) return;
  host.innerHTML = `<section class="ac-prompt">
    <label class="ac-field">Canonical text
      <textarea id="ac-canonical-text" class="ac-body" rows="26" spellcheck="false"></textarea>
    </label>
    <div class="ac-facts">
      <span id="ac-canonical-count">${detail.content.length} characters</span>
      <span>starts with a heading</span>
      <span class="muted small">unchanged sha <code>${esc((detail.sha256 || "").slice(0, 12))}</code></span>
    </div>
    <div class="toolbar">
      <label class="ac-inline muted small"><input type="checkbox" id="ac-canonical-confirm"> I reviewed this change and want it staged</label>
      <button class="btn primary" type="button" data-ac="save-canonical" disabled>Stage AGENTS.md write</button>
      <button class="btn" type="button" data-ac="close-canonical">Close</button>
      <span class="muted small" id="ac-canonical-note"></span>
    </div>
    <div id="ac-canonical-result"></div>
  </section>`;
  const textarea = document.getElementById("ac-canonical-text");
  // Assigned as a property, not interpolated into markup: the canonical text is
  // 20 KB and must never round-trip through HTML escaping.
  textarea.value = detail.content;
  const count = document.getElementById("ac-canonical-count");
  const confirm = document.getElementById("ac-canonical-confirm");
  const stage = document.querySelector('[data-ac="save-canonical"]');
  textarea.addEventListener("input", () => {
    if (count) count.textContent = `${textarea.value.length} characters`;
  });
  confirm?.addEventListener("change", () => {
    if (stage) stage.disabled = !confirm.checked;
  });
}

async function acSaveCanonical() {
  const textarea = document.getElementById("ac-canonical-text");
  const note = document.getElementById("ac-canonical-note");
  const result_host = document.getElementById("ac-canonical-result");
  if (!textarea) return;
  if (note) note.textContent = "Staging…";
  try {
    const result = await api("/api/agents-control/canonical", {
      method: "POST", body: { content: textarea.value },
    });
    const sync = result.sync || {};
    const syncText = sync.ran
      ? (sync.ok ? "sync ok — projections regenerated" : `sync FAILED (rc=${sync.rc}) — check the projections`)
      : (sync.reason || "sync not run");
    const summary = `${acOutcome(result)} · ${syncText}`;
    if (note) note.textContent = summary;
    if (result_host) {
      const tail = Array.isArray(sync.tail) && sync.tail.length
        ? `<pre class="ac-log">${esc(sync.tail.join("\n"))}</pre>` : "";
      result_host.innerHTML = `<div class="ac-facts"><span class="pill ${sync.ok === false ? "amber" : "green"}">${esc(syncText)}</span>
        ${result.backup ? `<span class="muted small">backup ${esc(result.backup)}</span>` : ""}</div>${tail}`;
    }
    toast("AGENTS.md", summary, sync.ok === false ? "error" : "");
    await acReload();
    // The editor was replaced by the reload; reopen it so the operator can
    // confirm the staged sha rather than losing their place.
    const reopen = document.getElementById("ac-canonical-editor");
    if (reopen && !reopen.childElementCount) await acLoadCanonical();
  } catch (error) {
    const message = error.message || "stage failed";
    if (note) note.textContent = message;
    toast("AGENTS.md", message, "error");
  }
}

async function acLoadHistory() {
  const host = document.getElementById("ac-history-body");
  if (!host) return;
  host.innerHTML = `<div class="loading">Reading backups…</div>`;
  let data;
  try {
    data = await api("/api/agents-control/history?limit=12");
  } catch (error) {
    host.innerHTML = `<p class="muted small">${esc(error.message || "read failed")}</p>`;
    return;
  }
  if (!host.isConnected) return;
  if (data.available === false) {
    host.innerHTML = `<p class="muted small">No backup root yet at <code>${esc(data.path || "")}</code>. The first write creates it.</p>`;
    return;
  }
  if (!data.batches.length) {
    host.innerHTML = `<p class="muted small">No batches yet — nothing has been written from this page.</p>`;
    return;
  }
  host.innerHTML = `<div class="ac-table-wrap"><table class="data ac-table">
    <thead><tr><th>Batch</th><th>Files</th><th>Recorded</th></tr></thead>
    <tbody>${data.batches.map((batch) => `<tr>
      <td><code>${esc(batch.stamp)}</code></td>
      <td>${batch.files.map((file) => esc(file)).join("<br>") || "—"}</td>
      <td class="muted small">${esc((batch.manifest || "").split("\n").length ? batch.manifest.split("\n").slice(0, 3).join(" · ") : "no manifest")}</td>
    </tr>`).join("")}</tbody></table></div>`;
}

async function acBulkEffort() {
  const select = document.getElementById("ac-bulk-effort");
  const note = document.getElementById("ac-bulk-note");
  const picked = acSelectedAgents();
  if (!picked.length) {
    if (note) note.textContent = "Select at least one agent.";
    return;
  }
  const effort = select ? select.value : "";
  if (note) note.textContent = `Applying ${effort || "unset"} to ${picked.length} agent(s)…`;
  try {
    const result = await api("/api/agents-control/effort", {
      method: "POST", body: { names: picked, effort },
    });
    const changed = result.changed || 0;
    const failed = (result.results || []).filter((item) => item.error);
    const text = `${changed} of ${result.requested} changed${failed.length ? `, ${failed.length} refused` : ""}`;
    if (note) note.textContent = text;
    toast("Bulk effort", text, failed.length ? "error" : "");
    await acReload();
  } catch (error) {
    const message = error.message || "bulk apply failed";
    if (note) note.textContent = message;
    toast("Bulk effort", message, "error");
  }
}

function acClick(event) {
  const button = event.target.closest("button[data-ac]");
  if (!button) return;
  const action = button.getAttribute("data-ac");
  const row = button.closest("tr");
  if (action === "open-agent") return acOpenAgent(button.closest("[data-agent]")?.getAttribute("data-agent"));
  if (action === "open-pi-redamon") return acOpenPi();
  if (action === "pick-default-model") return acPickDefault(button);
  if (action === "apply-defaults") return acApplyDefaults();
  if (action === "load-canonical") return acLoadCanonical();
  if (action === "save-canonical") return acSaveCanonical();
  if (action === "close-canonical") {
    const host = document.getElementById("ac-canonical-editor");
    if (host) host.innerHTML = "";
    return;
  }
  if (action === "load-history") return acLoadHistory();
  if (action === "bulk-effort") return acBulkEffort();
  if (action === "bulk-model") return acBulkModel();
  if (action === "pick-all") {
    document.querySelectorAll("#ac-agents .ac-card:not([hidden]) .ac-pick").forEach((box) => { box.checked = true; });
    return acSyncSelection();
  }
  if (action === "pick-none") {
    document.querySelectorAll(".ac-pick").forEach((box) => { box.checked = false; });
    return acSyncSelection();
  }
}

