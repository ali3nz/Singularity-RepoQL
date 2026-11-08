/* UX pack: command palette (Ctrl/Cmd+K), Home health strip, dock active state,
   remembered filters, slow-load recovery. Presentation only: read-only GETs, no route changes. */
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const app = () => document.getElementById("app");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const route = () => (location.hash.replace(/^#/, "") || "/").split("?")[0];
  const safeGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const safeSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

  /* ---- Dock active state ---- */
  function markDock() {
    const r = route();
    document.querySelectorAll("#mobile-dock a[data-dock]").forEach((a) => {
      const d = a.dataset.dock;
      const on = d === "/" ? r === "/" : r === d || r.startsWith(d + "/");
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
  }

  /* ---- Command palette ---- */
  let pal, input, list, items = [], sel = 0, agentsLoaded = false, agentItems = [];
  function pages() {
    const seen = new Set();
    return [...document.querySelectorAll(".sidebar a.nav-link[data-nav]")].map((a) => {
      const label = (a.textContent || "").trim().replace(/\s+/g, " ");
      const grp = a.closest("details")?.querySelector("summary")?.textContent.trim() || "Pages";
      return { label, href: a.getAttribute("href"), group: grp };
    }).filter((p) => p.label && !seen.has(p.href) && seen.add(p.href));
  }
  async function loadAgents() {
    if (agentsLoaded) return; agentsLoaded = true;
    try {
      const r = await fetch("/api/agents-control", { credentials: "same-origin" });
      const j = await r.json();
      const arr = j.agents || j.items || [];
      agentItems = arr.filter((a) => a && a.name).map((a) => ({
        label: /^omb-[0-9a-f]{8,}/i.test(a.name) ? "Bot " + a.name.slice(4, 12) : a.name,
        href: "#/agents-control?agent=" + encodeURIComponent(a.name), group: "Agents" }));
    } catch {}
  }
  function render() {
    const q = input.value.trim().toLowerCase();
    const all = pages().concat(agentItems);
    items = all.filter((p) => !q || (p.group === "Agents" ? p.label : p.label + " " + p.group).toLowerCase().includes(q)).slice(0, 30);
    sel = Math.min(sel, Math.max(items.length - 1, 0));
    list.innerHTML = items.length
      ? items.map((p, i) => `<li role="option" aria-selected="${i === sel}"><a href="${esc(p.href)}"><span>${esc(p.label)}</span><small>${esc(p.group)}</small></a></li>`).join("")
      : `<li class="ux-empty">No match for “${esc(input.value)}”.</li>`;
  }
  function openPal() {
    if (!pal) {
      pal = document.createElement("div");
      pal.className = "ux-pal-scrim"; pal.hidden = true;
      pal.innerHTML = `<div class="ux-pal" role="dialog" aria-modal="true" aria-label="Command palette"><input type="text" placeholder="Jump to a page or agent…" autocomplete="off" aria-label="Search pages and agents"><ul role="listbox"></ul></div>`;
      document.body.appendChild(pal);
      input = $("input", pal); list = $("ul", pal);
      pal.addEventListener("mousedown", (e) => { if (e.target === pal) closePal(); });
      list.addEventListener("click", () => setTimeout(closePal, 0));
      input.addEventListener("input", () => { sel = 0; render(); });
      input.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") { sel = Math.min(sel + 1, items.length - 1); render(); e.preventDefault(); }
        else if (e.key === "ArrowUp") { sel = Math.max(sel - 1, 0); render(); e.preventDefault(); }
        else if (e.key === "Enter" && items[sel]) { location.hash = items[sel].href.replace(/^#/, ""); closePal(); }
        else if (e.key === "Escape") closePal();
        list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
      });
    }
    pal.hidden = false; input.value = ""; sel = 0; render(); input.focus();
    loadAgents().then(render);
  }
  function closePal() { if (pal) pal.hidden = true; }
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); pal && !pal.hidden ? closePal() : openPal(); }
  });
  window.RepoQLPalette = { open: openPal };
  function mountSearchButton() {
    const bar = $("#mobile-topbar"); if (!bar || $(".ux-search-btn", bar)) return;
    const b = document.createElement("button");
    b.type = "button"; b.className = "ux-search-btn"; b.setAttribute("aria-label", "Search pages and agents");
    b.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>';
    b.addEventListener("click", openPal);
    const mark = $(".mobile-brand-mark", bar);
    mark ? bar.insertBefore(b, mark) : bar.appendChild(b);
  }

  /* ---- Home health strip ---- */
  const probes = [
    ["Dashboard", "/api/health", "/diagnostics"],
    ["Host", "/api/status", "/diagnostics"],
    ["Harness", "/api/harness/health", "/harness"],
    ["Ghost", "/api/ghost/status", "/openmausbot?bot=ghost"],
  ];
  async function probe([name, url, link]) {
    try {
      const r = await fetch(url, { credentials: "same-origin" });
      if (!r.ok) return { name, link, s: "bad" };
      const d = await r.json();
      const warn = d && (d.ok === false || d.available === false || d.stale === true);
      return { name, link, s: warn ? "warn" : "ok" };
    } catch { return { name, link, s: "bad" }; }
  }
  let healthBusy = false;
  async function mountHealth() {
    const dash = $("#dash"); if (!dash || route() !== "/" || $(".ux-health")) return;
    if (healthBusy) return; healthBusy = true;
    const strip = document.createElement("div");
    strip.className = "ux-health"; strip.dataset.state = "idle"; strip.setAttribute("role", "status");
    strip.innerHTML = `<strong>Checking systems…</strong>`;
    dash.appendChild(strip);
    const res = await Promise.all(probes.map(probe));
    healthBusy = false;
    if (!strip.isConnected) return;
    const bad = res.filter((r) => r.s !== "ok");
    strip.dataset.state = bad.some((r) => r.s === "bad") ? "bad" : bad.length ? "warn" : "ok";
    strip.innerHTML = (bad.length
      ? `<strong>${bad.length} of ${res.length} need attention</strong><span class="muted small">${bad.map((r) => esc(r.name)).join(", ")}</span>`
      : `<strong>All systems normal</strong><span class="muted small">${res.length} checks passed · ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>`)
      + `<span class="ux-dots">${res.map((r) => `<a class="ux-chip" data-s="${r.s}" href="#${r.link}">${esc(r.name)}</a>`).join("")}</span>`;
  }

  /* ---- Remembered filters ---- */
  const FKEY = "repoql.dashboard.filters";
  const fload = () => { try { return JSON.parse(safeGet(FKEY) || "{}"); } catch { return {}; } };
  function fieldId(el) { return el.id || el.name || el.getAttribute("aria-label") || el.placeholder || ""; }
  function restoreFilters() {
    const saved = fload()[route()]; if (!saved) return;
    document.querySelectorAll("#app input[type=search], #app input[type=text], #app select").forEach((el) => {
      if (el.dataset.uxRestored) return;
      const id = fieldId(el);
      if (!id || !(id in saved) || el.value === saved[id]) return;
      el.dataset.uxRestored = "1";
      el.value = saved[id];
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  document.addEventListener("input", (e) => {
    const el = e.target;
    if (!(el instanceof HTMLElement) || !el.closest("#app") || !el.matches("input[type=search],input[type=text],select")) return;
    const id = fieldId(el); if (!id) return;
    const all = fload(); const r = route();
    (all[r] = all[r] || {})[id] = el.value;
    safeSet(FKEY, JSON.stringify(all));
  }, true);

  /* ---- Slow-load recovery ---- */
  let slowTimer = null;
  function watchSlow() {
    clearTimeout(slowTimer);
    slowTimer = setTimeout(() => {
      const l = $("#app > .loading, #app .loading");
      if (!l || l.querySelector(".ux-state")) return;
      const box = document.createElement("div");
      box.className = "ux-state"; box.dataset.kind = "error";
      box.innerHTML = `<strong>This is taking longer than usual</strong><span>The data source may be slow or unavailable.</span><button type="button">Retry</button>`;
      $("button", box).addEventListener("click", () => location.reload());
      l.appendChild(box);
    }, 12000);
  }

  /* ---- Wiring ---- */
  let t = null;
  function refresh() { mountSearchButton(); markDock(); mountHealth(); restoreFilters(); watchSlow(); }
  const mo = new MutationObserver(() => { clearTimeout(t); t = setTimeout(refresh, 120); });
  function start() {
    const a = app(); if (a) mo.observe(a, { childList: true, subtree: true });
    window.addEventListener("hashchange", () => { markDock(); setTimeout(refresh, 200); });
    refresh();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
