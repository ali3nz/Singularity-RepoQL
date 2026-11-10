/* UX pack: Home health strip, remembered filters, slow-load recovery.
   Presentation only: read-only GETs, no route changes. */
(() => {
  "use strict";
  const nativeInstall = Boolean(window.__SINGULARITY_VARIANT__?.variant);
  const $ = (s, r = document) => r.querySelector(s);
  const app = () => document.getElementById("app");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const route = () => (location.hash.replace(/^#/, "") || "/").split("?")[0];
  const safeGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const safeSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

  /* ---- Home health strip ---- */
  const probes = [
    ["Dashboard", "/api/health", "/diagnostics"],
    ["Host", "/api/status", "/diagnostics"],
    ...(nativeInstall ? [] : [
      ["Harness", "/api/harness/health", "/harness"],
    ]),
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
  function refresh() { mountHealth(); restoreFilters(); watchSlow(); }
  const mo = new MutationObserver(() => { clearTimeout(t); t = setTimeout(refresh, 120); });
  function start() {
    const a = app(); if (a) mo.observe(a, { childList: true, subtree: true });
    window.addEventListener("hashchange", () => { setTimeout(refresh, 200); });
    refresh();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
