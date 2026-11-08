/* UI polish: remember nav group state, open the nav from the phone dock, mark pages that are loading. */
(() => {
  const KEY = "repoql.dashboard.nav.groups";
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (_) {}
  document.querySelectorAll("details.nav-more").forEach((d) => {
    if (saved[d.id] === true) d.open = true;
    d.addEventListener("toggle", () => {
      saved[d.id] = d.open;
      try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (_) {}
    });
  });
  // Keep the group that holds the current page open.
  const openCurrent = () => {
    document.querySelectorAll("details.nav-more").forEach((d) => {
      if (d.querySelector(".nav-link.active, .nav-link[aria-current]")) d.open = true;
    });
  };
  window.addEventListener("hashchange", () => setTimeout(openCurrent, 60));
  setTimeout(openCurrent, 400);
  const more = document.getElementById("dock-more");
  const toggle = document.getElementById("nav-toggle");
  if (more && toggle) more.addEventListener("click", () => toggle.click());
})();

// Overview counts: dim zeros, keep a short local history and draw a sparkline.
(function () {
  const KEY = 'repoql.dashboard.counts', MAX = 48;
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  const save = (h) => { try { localStorage.setItem(KEY, JSON.stringify(h)); } catch {} };
  function spark(vals) {
    const w = 120, h = 26, max = Math.max(...vals, 1), min = Math.min(...vals, 0), r = max - min || 1;
    const pts = vals.map((v, i) => [(i / (vals.length - 1)) * w, h - 2 - ((v - min) / r) * (h - 4)]);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
    return `<svg class="p-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path class="area" d="${d}L${w} ${h}L0 ${h}Z"/><path d="${d}"/></svg>`;
  }
  function update() {
    const hist = load(); let changed = false;
    document.querySelectorAll('.command-overview-value[id]').forEach((el) => {
      const txt = el.textContent.trim(), n = Number(txt.replace(/,/g, ''));
      el.dataset.zero = txt === '0' ? '1' : '0';
      if (!Number.isFinite(n) || txt === '') return;
      const arr = hist[el.id] || [], last = arr[arr.length - 1];
      if (!last || last[1] !== n || Date.now() - last[0] > 600000) { arr.push([Date.now(), n]); hist[el.id] = arr.slice(-MAX); changed = true; }
      const card = el.closest('.command-overview-card'), cur = card.querySelector('.p-spark');
      const vals = (hist[el.id] || arr).map((x) => x[1]);
      if (cur) cur.remove();
      if (vals.length >= 3 && new Set(vals).size > 1) el.insertAdjacentHTML('afterend', spark(vals));
    });
    if (changed) save(hist);
    const st = document.getElementById('command-live-status');
    if (st && st.dataset.t !== st.textContent) { st.dataset.t = st.textContent; st.classList.remove('tick'); void st.offsetWidth; st.classList.add('tick'); }
  }
  let t = null;
  new MutationObserver(() => { clearTimeout(t); t = setTimeout(update, 150); }).observe(document.getElementById('app') || document.body, { childList: true, subtree: true, characterData: true });
  update();
})();
