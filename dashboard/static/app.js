import {createKnowledgeGraph, relationshipDetails, sparkChart, numeric} from './observability.js';
import {renderKnowledgeGuide} from './repoql_guidance.js';
import {mountGhost} from './ghost/dashboard.js';
import {initNavigationUI, navPathFor} from './navigation_ui.js';
import {renderRepoqlCheatSheet, bindRepoqlCheatSheet} from './repoql_cheatsheet.js';
import {renderMemoryArchitecturePage, bindMemoryArchitecturePage, renderOrchestraWorkflowPage, bindOrchestraWorkflowPage} from './workflow_graphs.js';
// RepoQL Control — dark neon block management UI.
// Vanilla ES module: no build step, no framework, no extra dependency.

const SECRET_KEY = "repoql.dashboard.secret";
const APP = document.getElementById("app");
const TOASTS = document.getElementById("toasts");
const CONN = document.getElementById("conn");
const CONN_LABEL = document.getElementById("connLabel");
const HOST_LINE = document.getElementById("hostLine");

// repoql-host.service runs with CPUQuota=400% (4 cores). CPU samples are
// recorded as percent of one core; display them as a percentage of that quota.
const CPU_QUOTA_CORES = 4;
const CPU_QUOTA_LABEL = "4-core quota";
const quotaPct = (value) => (value == null ? value : value / CPU_QUOTA_CORES);

const state = {
  token: null,
  cleanup: null,
  timers: new Set(),
  cpuSeries: null,
  cpuBucket: 60,
  routeEpoch: 0,
  routeAbort: null,
};

// ---------------------------------------------------------------- utilities

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

const fmt = (value) => (value === null || value === undefined || value === "" ? "—" : Number(value).toLocaleString("en-US"));

// Presentation-only metadata fallback. Never apply to document/editor content.
const displayLabel = (value, fallback = "—") =>
  value == null || String(value).trim() === "" || /^unknown$/i.test(String(value).trim()) ? fallback : value;

function bytes(value) {
  if (value === null || value === undefined) return "—";
  let size = Number(value);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${index === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
}

// Pure Tencent memory-editor row helpers. Hoisted to module scope so the node
// regression tests can import them without any DOM or network activity (they
// carry no state and are shared verbatim by mountTencentMemoryEditor).
function rowsOf(payload) {
  const data = payload?.data ?? payload;
  for (const rows of [data?.items,data?.records,data?.memories,data?.rows,
    data?.data?.items,data?.data?.records]) if (Array.isArray(rows)) return rows;
  return [];
}
function contentOf(record) {
  return typeof record?.body === 'string' ? record.body
    : typeof record?.content === 'string' ? record.content
    : typeof record?.text === 'string' ? record.text : null;
}
// Discovery-request token: each discovery takes a token before its await; only
// the token that is still current may publish. Used by the Tencent memory editor
// so an out-of-order reply from a previous team or button cannot repopulate the
// editor, and so a team change invalidates pending discovery + record loads.
function createDiscoveryGuard() {
  let seq = 0;
  return {
    take() { return ++seq; },
    isCurrent: (token) => token === seq,
    invalidate() { ++seq; },
  };
}

function duration(seconds) {
  if (seconds === null || seconds === undefined) return "—";
  const total = Math.max(0, Math.round(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${total % 60}s`;
  return `${total}s`;
}

function relative(iso) {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const delta = Math.round((Date.now() - then) / 1000);
  if (delta < 5) return "just now";
  if (delta < 90) return `${delta}s ago`;
  if (delta < 5400) return `${Math.round(delta / 60)}m ago`;
  if (delta < 172800) return `${Math.round(delta / 3600)}h ago`;
  return `${Math.round(delta / 86400)}d ago`;
}

function clock(tsSeconds, bucketSeconds = 0) {
  const date = new Date(tsSeconds * 1000);
  if (bucketSeconds >= 3600) {
    return date.toLocaleString("en-GB", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function setConn(stateName, label) {
  CONN.dataset.state = stateName;
  CONN_LABEL.textContent = label;
}

function toast(title, message, tone = "") {
  const node = document.createElement("div");
  node.className = `toast ${tone}`;
  node.innerHTML = `<strong>${esc(title)}</strong>${esc(message)}`;
  TOASTS.appendChild(node);
  setTimeout(() => node.remove(), tone === "error" ? 9000 : 5200);
}

function captureSecret() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const fromHash = params.get("k");
  if (fromHash) {
    sessionStorage.setItem(SECRET_KEY, fromHash);
    history.replaceState(null, "", location.pathname);
  }
  try {
    state.token = sessionStorage.getItem(SECRET_KEY);
  } catch {
    state.token = null;
  }
}

class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.token) headers.set("Authorization", `Bearer ${state.token}`);
  if (options.body) headers.set("Content-Type", "application/json");
  if ((options.method || "GET") !== "GET") headers.set("X-Requested-With", "repoql-dashboard");
  const hub = new AbortController();
  const owner = state.routeAbort?.signal;
  const onNavigation = () => hub.abort('route_changed');
  if (owner?.aborted) hub.abort('route_changed');
  else owner?.addEventListener('abort', onNavigation, {once:true});
  const timer = setTimeout(() => hub.abort('timeout'), options.timeoutMs ?? 120000);
  try {
    const response = await fetch(path, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: hub.signal,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { error: text };
    }
    if (!response.ok) {
      if (response.status === 401) {
        showSignpost(payload?.message);
        throw new ApiError(payload?.message || "unauthorised", 401, payload?.code);
      }
      throw new ApiError(payload?.error || `HTTP ${response.status}`, response.status, payload?.code);
    }
    setConn("live", "live");
    return payload;
  } catch (error) {
    if (error.name === "AbortError") {
      if (hub.signal.reason === 'route_changed') throw new ApiError('navigation_cancelled', -1);
      throw new ApiError('request timed out', 0);
    }
    if (!(error instanceof ApiError)) {
      setConn("error", "disconnected");
      throw new ApiError(error.message || "network error", 0);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    owner?.removeEventListener('abort', onNavigation);
  }
}

function showSignpost(message) {
  state.cleanup?.();
  APP.innerHTML = `
    <div class="signpost">
      <div class="card">
        <h1>Fresh dashboard link required</h1>
        <p>${esc(message || "This tab holds no valid dashboard key.")}</p>
        <p>On the dashboard host, run <code>python3 dashboard/server.py link</code> and open the printed link
        (the key travels in the URL fragment and is stored only for this tab).</p>
      </div>
    </div>`;
  setConn("error", "locked");
}

// -------------------------------------------------------------- hash router

function parseRoute() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, query] = raw.split("?");
  return { path: path || "/", params: Object.fromEntries(new URLSearchParams(query || "")) };
}

function setParams(patch, { replace = true } = {}) {
  const route = parseRoute();
  const params = { ...route.params, ...patch };
  for (const [key, value] of Object.entries(params)) {
    if (value === "" || value === null || value === undefined) delete params[key];
  }
  const query = new URLSearchParams(params).toString();
  const target = `#${route.path}${query ? `?${query}` : ""}`;
  if (replace) history.replaceState(null, "", target);
  else location.hash = target;
}

function href(path, params = {}) {
  const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== "" && value != null)).toString();
  return `#${path}${query ? `?${query}` : ""}`;
}

// Swap a retired hash for its canonical one without adding a history entry
// (replaceState does not fire hashchange), then read the canonical route back.
function replaceRoute(target) {
  history.replaceState(null, "", target);
  return parseRoute();
}

function markNav(path) {
  const links = [...document.querySelectorAll('[data-nav]')];
  // An exact sidebar entry wins; retired and detail routes resolve through the
  // same map navigation_ui.js uses (see navPathFor), so drawer and view agree.
  const target = navPathFor(path, links.map(link => link.dataset.nav));
  const active = links.find(link => link.dataset.nav === target) || null;
  links.forEach(link => link.classList.toggle('active', link === active));
}

// Guards views against out-of-order responses: a slow older request must never
// overwrite the result of a newer filter or tab change.
function sequencer(isActive = () => true) {
  let current = 0;
  return () => {
    const id = ++current;
    return () => id === current && isActive();
  };
}

// Search callbacks belong to the route that created them. Aborting that route
// clears pending work and prevents even an already-queued callback from running.
function debounceForRoute(fn, ms, signal) {
  let handle;
  const cancel = () => clearTimeout(handle);
  signal?.addEventListener("abort", cancel, { once: true });
  return (...args) => {
    cancel();
    if (signal?.aborted) return;
    handle = setTimeout(() => {
      if (!signal?.aborted) fn(...args);
    }, ms);
  };
}

function schedule(fn, ms) {
  const id = setInterval(() => {
    if (document.hidden) return;
    fn();
  }, ms);
  state.timers.add(id);
  return id;
}

function clearTimers() {
  for (const id of state.timers) clearInterval(id);
  state.timers.clear();
}

async function route() {
  const epoch = ++state.routeEpoch;
  state.routeAbort?.abort('route_changed');
  state.routeAbort = new AbortController();
  try { state.cleanup?.(); } catch (error) { console.warn('View cleanup failed', error); }
  state.cleanup = null;
  clearTimers();
  const { path, params } = parseRoute();
  markNav(path);
  if (state.routeEpoch > 1) window.scrollTo(0, 0);
  try {
    if (path === "/ghost") return viewGhostOperations();
    if (path === "/unified/graph") return await viewUnifiedGraph();
    if (path === "/unified/tencent") return await viewTencentNative();
    if (path === "/unified/tencent-advanced") return await viewTencentNative();
    if (path === "/repoql/control") return await viewRepoqlNative();
    if (path === "/architecture/memory") { APP.innerHTML = renderMemoryArchitecturePage(); const binding = bindMemoryArchitecturePage(); state.cleanup = () => binding?.dispose(); return; }
    if (path === "/architecture/orchestra") { APP.innerHTML = renderOrchestraWorkflowPage(); const binding = bindOrchestraWorkflowPage(); state.cleanup = () => binding?.dispose(); return; }
    if (path === "/repoql/cheat-sheet") { APP.innerHTML = renderRepoqlCheatSheet(); return bindRepoqlCheatSheet(); }
    if (path === "/knowledge/connectors") return await viewConnectors();
    if (path === "/knowledge/connections") return await viewLinks({...params, collection: params.collection || "see_also"}, true);

    if (path === "/unified/usage") return await viewUnifiedUsage();
    if (path === "/") return await viewDashboard();
    if (path === "/repositories/view") return await viewRepository(params);
    if (path === "/repositories") {
      // Retired standalone route: the same view is the Repositories tab of
      // Indexing. replaceState keeps a single history entry, so Back returns to
      // the page before the old link instead of bouncing through a redirect.
      const canonical = replaceRoute(href("/indexing", { tab: "repositories", q: params.q, status: params.status }));
      return await viewIndexing(canonical.params);
    }
    if (path === "/indexing") return await viewIndexing(params);
    if (path === "/diagnostics") return await viewDiagnostics(params);
    if (path === "/cpu" || path === "/errors" || path === "/excluded") {
      // Retired standalone routes: CPU & Performance, Errors and Excluded Files
      // are the three tabs of Diagnostics. Keep their query parameters.
      const tab = path === "/cpu" ? "" : path === "/errors" ? "errors" : "excluded";
      const canonical = replaceRoute(href("/diagnostics", {
        tab,
        period: path === "/cpu" ? params.period : undefined,
        kind: path === "/errors" ? params.kind : undefined,
        q: path === "/errors" ? params.q : undefined,
      }));
      return await viewDiagnostics(canonical.params);
    }
    if (path === "/links") return await viewLinks(params);
    if (path === "/harness") return await viewHarnessOverview(params);
    if (path === "/harness/agents") return await viewHarnessAgents();
    if (path === "/harness/runs") return await viewHarnessRuns(params);
    if (path === "/harness/run") return await viewHarnessRun(params);
    if (path === "/harness/performance") return await viewHarnessPerformance(params);
    if (path === "/harness/usage") { location.hash = '#/unified/usage'; return; }
    if (path === "/harness/events") return await viewHarnessEvents(params);
    if (path === "/harness/settings") return await viewHarnessSettings(params);
    if (path === "/kanban") return await viewKanban();
    if (path === "/office") return await viewOffice();
    if (path === "/agentchat") return await viewAgentChat();
    if (path.startsWith("/knowledge/item")) return await viewKnowledgeItem(params);
    if (path.startsWith("/knowledge/")) return await viewKnowledge(path.split("/")[2] || "all", params);
    APP.innerHTML = `<div class="empty">No such page.</div>`;
  } catch (error) {
    if (epoch !== state.routeEpoch || error.status === -1 || error.status === 401) return;
    APP.innerHTML = `<div class="block accent-red"><div class="block-title">Request failed</div>
      <p class="muted">${esc(error.message)}</p>
      <button class="btn" onclick="location.reload()">Retry</button></div>`;
    setConn("error", "error");
  }
}

async function viewGhostOperations() {
  const epoch=state.routeEpoch;
  APP.innerHTML=pageHead('Ghost Operations','Persistent agent · Live activity, schedule, memory, and authorized operator controls') +
    '<section id="ghost-integrated" aria-label="Ghost Operations"><div class="loading">Loading Ghost controls…</div></section>';
  // The original Ghost markup and styles are reused, but mounted in this page.
  // No external application, nested browsing context, or duplicate controls.
  const response=await fetch('/ghost/index.html',{cache:'no-store',signal:state.routeAbort?.signal});
  if(!response.ok)throw new Error('Ghost interface unavailable');
  const markup=new DOMParser().parseFromString(await response.text(),'text/html');
  if(epoch!==state.routeEpoch)return;
  const host=document.getElementById('ghost-integrated');
  if(!host)return;
  const style=markup.querySelector('style'),shell=markup.querySelector('.shell');
  if(!style||!shell)throw new Error('Ghost interface assets missing');
  const shadow=host.attachShadow({mode:'open'});
  const css=document.createElement('style');css.textContent=style.textContent;
  shadow.append(css,document.importNode(shell,true));
  state.cleanup=mountGhost(shadow);
}

// -------------------------------------------------------------- shared views

function pageHead(title, subtitle, actions = "") {
  return `<div class="page-head">
    <div><h1>${esc(title)}</h1><div class="sub">${esc(subtitle)}</div></div>
    <div class="actions">${actions}</div>
  </div>`;
}

function pill(status) {
  const map = {
    indexed: "green", served: "green", ready: "green", live: "green", ok: "green", resolved: "green",
    indexing: "cyan", analyze: "cyan", running: "cyan", sweep: "cyan",
    errors: "red", failed: "red", broken: "red", error: "red", unavailable: "red", invalid: "red",
    pending: "amber", "pending-reconcile": "amber", waiting: "amber", warning: "amber", unresolved: "amber",
    degraded: "amber", offline: "red",
  };
  const tone = map[String(status || "").toLowerCase()] || "";
  return `<span class="pill ${tone}">${esc(displayLabel(status, "Not reported"))}</span>`;
}

function categoryChip(category) {
  if (displayLabel(category, null) === null) return "";
  const key = String(category || "uncategorised").toLowerCase();
  return `<span class="chip ${esc(key)}">${esc(category || "uncategorised")}</span>`;
}

function statusPill(status) {
  const tone = { indexed: "green", indexing: "cyan", errors: "red", unavailable: "red", served: "green" }[status] || "";
  return `<span class="pill ${tone}">${esc(displayLabel(status, "Not reported"))}</span>`;
}

function pagerBlock(page, pageSize, total, onPage) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const node = document.createElement("div");
  node.className = "pager";
  node.innerHTML = `<div>${fmt(total)} record${total === 1 ? "" : "s"} · page ${page} / ${pages}</div>
    <div class="pages">
      <button class="btn small" data-page="prev" ${page <= 1 ? "disabled" : ""}>Prev</button>
      <button class="btn small" data-page="next" ${page >= pages ? "disabled" : ""}>Next</button>
    </div>`;
  node.querySelector('[data-page="prev"]')?.addEventListener("click", () => onPage(page - 1));
  node.querySelector('[data-page="next"]')?.addEventListener("click", () => onPage(page + 1));
  return node;
}

// ------------------------------------------------------------------ page tabs
// Consolidated pages keep one sidebar entry and expose their former routes as
// tabs. A tab is a real link, not a hidden-panel button, so reload,
// open-in-new-tab, Back/Forward and deep links all use the hash router and the
// view lifecycle (timers, aborts, cleanup) exactly once per tab.

const DIAGNOSTICS_TABS = [
  { id: "cpu", label: "CPU & Performance", href: () => href("/diagnostics") },
  { id: "errors", label: "Errors", href: () => href("/diagnostics", { tab: "errors" }) },
  { id: "excluded", label: "Excluded Files", href: () => href("/diagnostics", { tab: "excluded" }) },
];
const DIAGNOSTICS_SUBTITLES = {
  cpu: "RepoQL host process CPU, measured from its own process and stored independently of any browser.",
  errors: "Indexing failures, analyzer parse errors and service-level warnings from the RepoQL host.",
  excluded: "Live mount-root .repoqlignore rules and dashboard-managed exclusion history.",
};
const INDEXING_TABS = [
  { id: "files", label: "Index & Files", href: () => href("/indexing") },
  { id: "repositories", label: "Repositories", href: () => href("/indexing", { tab: "repositories" }) },
];
const INDEXING_SUBTITLES = {
  files: "Index state, queue, operation history and the file inventory.",
  repositories: "Every source RepoQL serves, with its index state and availability.",
};

function diagnosticsTabOf(params = {}) {
  return DIAGNOSTICS_TABS.some(tab => tab.id === params.tab) ? params.tab : "cpu";
}

function indexingTabOf(params = {}) {
  return params.tab === "repositories" ? "repositories" : "files";
}

function tabStrip(tabs, active, label) {
  return `<nav class="page-tabs" aria-label="${esc(label)}">${tabs.map(tab =>
    `<a class="page-tab" href="${tab.href()}"${tab.id === active ? ' aria-current="page"' : ""}>${esc(tab.label)}</a>`).join("")}</nav>`;
}

// ---------------------------------------------------------------- dashboard

async function viewDashboard() {
  APP.innerHTML = pageHead("Dashboard", "Live state of the RepoQL host, its index, its knowledge and its CPU footprint.") +
    `<div id="dash" class="stack"><div class="loading">Reading RepoQL state…</div></div>`;

  const host = document.getElementById("dash");
  const next = sequencer();

  const refresh = async () => {
    const isCurrent = next();
    const data = await api("/api/overview");
    if (!isCurrent()) return;
    const s = data.service;
    const p = data.performance;
    const uptime = duration(s.uptime_seconds);
    const progress = data.indexing.progress_percent;
    const verdictTone = s.verdict?.includes("ready") ? "green" : s.verdict?.includes("usable") ? "cyan" : "amber";
    host.innerHTML = `
      <div class="grid cols-3">
        <a class="block link" href="${href("/indexing")}">
          <div class="block-title">RepoQL status <span class="tag">host ${esc(s.version || "")}</span></div>
          <div class="metric cyan"><span class="value">${esc(displayLabel(s.verdict, "Not reported"))}</span></div>
          <dl class="kv">
            <dt>Uptime</dt><dd>${esc(uptime)}</dd>
            <dt>PID</dt><dd>${esc(s.pid ?? "—")}</dd>
            <dt>Phase</dt><dd>${esc(s.phase || "—")}</dd>
            <dt>Last activity</dt><dd>${esc(s.last_activity || "—")}</dd>
            <dt>Semantic</dt><dd class="${s.semantic_percent === 100 ? "ok" : "warn"}">${esc(s.semantic_percent ?? "—")}%</dd>
            <dt>Account</dt><dd class="${s.account_authenticated ? "ok" : "warn"}">${s.account_authenticated ? "authenticated" : "anonymous"}</dd>
          </dl>
          <div class="small muted" style="margin-top:10px">last log line: ${esc((s.current_activity || "—").slice(0, 120))}</div>
        </a>

        <a class="block link accent-blue" href="${href("/indexing")}">
          <div class="block-title">Indexing <span class="tag">${progress == null ? "" : progress + "%"}</span></div>
          <div class="metric blue"><span class="value">${fmt(data.indexing.total_files)}</span><span class="unit">files</span></div>
          <div class="progress"><span style="width:${progress ?? 0}%"></span></div>
          <dl class="kv">
            <dt>Indexed</dt><dd class="ok">${fmt(data.indexing.complete)}</dd>
            <dt>Pending</dt><dd>${fmt(data.indexing.pending)}</dd>
            <dt>Processing</dt><dd>${fmt(data.indexing.active)}</dd>
            <dt>Failed</dt><dd class="${data.indexing.failed ? "err" : ""}">${fmt(data.indexing.failed)}</dd>
            <dt>Excluded (dashboard)</dt><dd>${fmt(data.indexing.excluded_rows)}</dd>
            <dt>Last complete</dt><dd>${esc(data.indexing.last_complete?.ts || "—")}</dd>
          </dl>
        </a>

        <a class="block link accent-purple" href="${href("/indexing", { tab: "repositories" })}">
          <div class="block-title">Repositories</div>
          <div class="metric purple"><span class="value">${fmt(data.repositories.total)}</span><span class="unit">registered</span></div>
          <dl class="kv">
            <dt>Indexed</dt><dd class="ok">${fmt(data.repositories.indexed)}</dd>
            <dt>Indexing now</dt><dd>${fmt(data.repositories.indexing)}</dd>
            <dt>With errors</dt><dd class="${data.repositories.errors ? "err" : ""}">${fmt(data.repositories.errors)}</dd>
            <dt>Unavailable</dt><dd>${fmt(data.repositories.unavailable)}</dd>
            <dt>System mounts</dt><dd>${fmt(data.repositories.system_mounts)}</dd>
          </dl>
        </a>

        <a class="block link" href="${href("/knowledge/all")}">
          <div class="block-title">Knowledge</div>
          <div class="metric cyan"><span class="value">${fmt(data.knowledge.concept)}</span><span class="unit">concept capsules</span></div>
          <dl class="kv">
            <dt>Wisdom</dt><dd>${fmt(data.knowledge.wisdom)}</dd>
            <dt>Principles</dt><dd>${fmt(data.knowledge.principle)}</dd>
            <dt>Rules</dt><dd>${fmt(data.knowledge.rule)}</dd>
            <dt>Shapes</dt><dd>${fmt(data.knowledge.shape)}</dd>
            <dt>Links / relationships</dt><dd>${fmt(data.knowledge.links)}</dd>
          </dl>
        </a>

        <a class="block link accent-green" href="${href("/diagnostics")}">
          <div class="block-title">Performance <span class="tag">${esc(p.now.available ? "live" : "no host")}</span></div>
          <div class="metric green"><span class="value">${p.now.available && p.now.cpu_pct != null ? quotaPct(p.now.cpu_pct).toFixed(1) : "—"}</span><span class="unit">% of ${CPU_QUOTA_LABEL}</span></div>
          <div id="mini-chart" class="chart-wrap"></div>
          <dl class="kv">
            <dt>Average (24h)</dt><dd>${p.avg_24h == null ? "—" : quotaPct(p.avg_24h).toFixed(1) + "%"}</dd>
            <dt>Peak (24h)</dt><dd>${p.peak_24h == null ? "—" : quotaPct(p.peak_24h).toFixed(1) + "%"}</dd>
            <dt>Samples (24h)</dt><dd>${fmt(p.samples_24h)}</dd>
            <dt>Last sample</dt><dd>${esc(p.last_sample || "—")}</dd>
          </dl>
        </a>

        <a class="block link ${data.errors.indexing_failures || data.errors.service_errors ? "accent-red" : ""}" href="${href("/diagnostics", { tab: "errors" })}">
          <div class="block-title">Errors</div>
          <div class="metric ${data.errors.indexing_failures ? "red" : "green"}"><span class="value">${fmt(data.errors.indexing_failures)}</span><span class="unit">indexing failures</span></div>
          <dl class="kv">
            <dt>Parse warnings</dt><dd>${fmt(data.errors.parse_warnings)}</dd>
            <dt>Service warnings</dt><dd class="${data.errors.service_warnings ? "warn" : ""}">${fmt(data.errors.service_warnings)}</dd>
            <dt>Service errors</dt><dd class="${data.errors.service_errors ? "err" : ""}">${fmt(data.errors.service_errors)}</dd>
            <dt>Log window</dt><dd>${fmt((data.errors.recent?.info || 0) + (data.errors.recent?.warning || 0) + (data.errors.recent?.error || 0))} lines</dd>
          </dl>
        </a>
      </div>

      <div class="grid cols-2">
        <a class="block link accent-cyan workflow-link-card" href="${href("/architecture/memory")}">
          <div class="block-title">Memory architecture workflow</div>
          <div class="subtle-hero">Temporal memory, capture pipeline, tombstones, retrieval and governed write-back shown as an interactive graph.</div>
          <div class="hero-pills">
            <span class="pill cyan">RepoQL primary</span>
            <span class="pill purple">Tencent MemoryCore</span>
            <span class="pill green">Temporal memory</span>
            <span class="pill amber">Tombstones</span>
          </div>
        </a>
        <a class="block link accent-purple workflow-link-card" href="${href("/architecture/orchestra")}">
          <div class="block-title">Harness & orchestra workflow</div>
          <div class="subtle-hero">Mode-aware orchestration for Solo, Duo, Quad and Super, including hooks, gates, agent chat and freebuff/openchamber pools.</div>
          <div class="hero-pills">
            <span class="pill blue">Solo</span>
            <span class="pill cyan">Duo</span>
            <span class="pill purple">Quad</span>
            <span class="pill green">Super</span>
          </div>
        </a>
      </div>

      <div class="block">
        <div class="block-title">Recent host activity <span class="tag">repoql-host log</span></div>
        <div id="activity" class="mono small"></div>
      </div>`;

    const chart = document.getElementById("mini-chart");
    if (chart) renderChart(chart, p.series, { bucketSeconds: p.bucket_seconds, height: 92, label: "CPU % of " + CPU_QUOTA_LABEL, scale: 1 / CPU_QUOTA_CORES, compact: true });

    const feed = await api("/api/activity?limit=12").catch(() => ({ rows: [] }));
    document.getElementById("activity").innerHTML = feed.rows.map((row) => `
      <div style="display:grid;grid-template-columns:150px 60px 1fr;gap:10px;padding:4px 0;border-bottom:1px solid rgba(22,32,47,.6)">
        <span class="muted">${esc(row.ts)}</span>
        <span class="${row.level.startsWith("E") || row.level.startsWith("F") ? "err" : row.level.startsWith("W") ? "warn" : "muted"}">${esc(row.level)}</span>
        <span>${esc(row.msg.slice(0, 220))}</span>
      </div>`).join("") || `<div class="empty">No log lines in the current window.</div>`;

    HOST_LINE.textContent = `pid ${s.pid ?? "—"} · v${s.version ?? "?"} · ${s.phase ?? "?"}`;
  };

  await refresh();
  schedule(() => refresh().catch(() => {}), 10000);
}

// ------------------------------------------------------------ chart + graph

function renderChart(wrap, series, { bucketSeconds = 60, height = 230, compact = false, scale = 1, label = "CPU %" } = {}) {
  wrap.innerHTML = "";
  const points = (series || [])
    .filter((point) => point.avg !== null && point.avg !== undefined)
    .map((point) => ({
      ...point,
      avg: point.avg == null ? point.avg : point.avg * scale,
      peak: point.peak == null ? point.peak : point.peak * scale,
    }));
  if (!points.length) {
    wrap.innerHTML = `<div class="empty">No CPU measurements in this window yet. The collector samples every 30s.</div>`;
    return;
  }
  const width = Math.max(320, wrap.clientWidth || 640);
  const pad = { top: 12, right: 8, bottom: compact ? 4 : 18, left: compact ? 4 : 34 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const peakValue = Math.max(...points.map((point) => point.peak ?? point.avg), 1);
  const maxY = Math.max(10, Math.ceil(peakValue / 10) * 10);
  const xAt = (index) => pad.left + (points.length === 1 ? innerW / 2 : (index / (points.length - 1)) * innerW);
  const yAt = (value) => pad.top + innerH - (Math.min(value, maxY) / maxY) * innerH;

  const line = points.map((point, index) => `${index === 0 ? "M" : "L"}${xAt(index).toFixed(1)},${yAt(point.avg).toFixed(1)}`).join(" ");
  const area = `${line} L${xAt(points.length - 1).toFixed(1)},${(pad.top + innerH).toFixed(1)} L${xAt(0).toFixed(1)},${(pad.top + innerH).toFixed(1)} Z`;
  const ticks = compact ? [] : [0, 0.5, 1].map((ratio) => {
    const value = maxY * ratio;
    return `<line x1="${pad.left}" y1="${yAt(value)}" x2="${width - pad.right}" y2="${yAt(value)}" stroke="rgba(31,51,72,.65)" stroke-dasharray="2 4"/>
      <text x="${pad.left - 6}" y="${yAt(value) + 3}" text-anchor="end" fill="#4d5c72" font-size="9" font-family="monospace">${value.toFixed(0)}</text>`;
  }).join("");

  wrap.innerHTML = `
    <svg class="chart" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="RepoQL CPU usage — ${label}">
      <defs>
        <linearGradient id="cpuFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#26e6ff" stop-opacity="0.35"/>
          <stop offset="100%" stop-color="#26e6ff" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${ticks}
      <path d="${area}" fill="url(#cpuFill)"/>
      <path d="${line}" fill="none" stroke="#26e6ff" stroke-width="1.6" stroke-linejoin="round"/>
      <circle cx="${xAt(points.length - 1)}" cy="${yAt(points[points.length - 1].avg)}" r="2.6" fill="#35ffa4"/>
      <line id="hoverLine" x1="0" y1="${pad.top}" x2="0" y2="${pad.top + innerH}" stroke="rgba(38,230,255,.55)" stroke-dasharray="3 3" style="display:none"/>
    </svg>
    ${compact ? "" : `<div class="chart-legend">
      <span><i></i>${label} · average per ${bucketSeconds >= 60 ? Math.round(bucketSeconds / 60) + "m" : bucketSeconds + "s"} bucket</span>
      <span class="muted">${clock(points[0].ts, bucketSeconds)} → ${clock(points[points.length - 1].ts, bucketSeconds)}</span>
    </div>`}
    <div class="chart-tip" id="tip" style="display:none"></div>`;

  const svg = wrap.querySelector("svg");
  const tip = wrap.querySelector("#tip");
  const hoverLine = wrap.querySelector("#hoverLine");
  svg.addEventListener("mousemove", (event) => {
    const rect = svg.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * width;
    const ratio = Math.min(1, Math.max(0, (x - pad.left) / innerW));
    const index = Math.round(ratio * (points.length - 1));
    const point = points[index];
    hoverLine.setAttribute("x1", xAt(index));
    hoverLine.setAttribute("x2", xAt(index));
    hoverLine.style.display = "";
    tip.style.display = "";
    tip.style.left = `${(xAt(index) / width) * rect.width}px`;
    tip.style.top = `${(yAt(point.avg) / height) * rect.height}px`;
    tip.innerHTML = `${clock(point.ts, bucketSeconds)}<br>avg ${point.avg.toFixed(1)}% · peak ${(point.peak ?? point.avg).toFixed(1)}%`;
  });
  svg.addEventListener("mouseleave", () => {
    tip.style.display = "none";
    hoverLine.style.display = "none";
  });
}

// Deterministic force-directed layout (Fruchterman-Reingold) for the small
// stored-relationship graph. Same input always yields the same picture.
function connectionLayout(ordered, edges, width, height, minDistance = 26) {
  const n = ordered.length, index = new Map(ordered.map((node, i) => [node.id, i]));
  const xs = new Float64Array(n), ys = new Float64Array(n);
  ordered.forEach((node, i) => { const a = i * 2.39996323, r = 18 * Math.sqrt(i + 0.5); xs[i] = Math.cos(a) * r * 1.6; ys[i] = Math.sin(a) * r; });
  const links = edges.map(edge => [index.get(edge.source), index.get(edge.target)]).filter(([a, b]) => a !== undefined && b !== undefined && a !== b);
  const k = Math.sqrt((width * height) / Math.max(1, n)) * 0.9;
  let temp = width / 8;
  for (let it = 0; it < 320; it++) {
    const fx = new Float64Array(n), fy = new Float64Array(n);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      let dx = xs[i] - xs[j], dy = ys[i] - ys[j]; let d2 = dx * dx + dy * dy;
      if (d2 < 0.01) { dx = 0.1 * ((i * 7 + j) % 5 - 2); dy = 0.1; d2 = 0.02; }
      const f = (k * k) / d2; fx[i] += dx * f; fy[i] += dy * f; fx[j] -= dx * f; fy[j] -= dy * f;
    }
    for (const [a, b] of links) {
      const dx = xs[a] - xs[b], dy = ys[a] - ys[b], d = Math.hypot(dx, dy) || 0.01, f = d / k;
      fx[a] -= dx * f; fy[a] -= dy * f; fx[b] += dx * f; fy[b] += dy * f;
    }
    for (let i = 0; i < n; i++) {
      fx[i] -= xs[i] * 0.035; fy[i] -= ys[i] * 0.06; // elliptical gravity fills the wide canvas
      const d = Math.hypot(fx[i], fy[i]) || 1, step = Math.min(d, temp);
      xs[i] += fx[i] / d * step; ys[i] += fy[i] / d * step;
    }
    temp = Math.max(0.6, temp * 0.985);
  }
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const padX = 110, padY = 50;
  const sx = (width - padX * 2) / Math.max(1, maxX - minX), sy = (height - padY * 2) / Math.max(1, maxY - minY);
  const sc = Math.min(sx, sy * 1.25), cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const scY = Math.min(sy, sc);
  const px = Array.from(xs, (x) => width / 2 + (x - cx) * sc), py = Array.from(ys, (y) => height / 2 + (y - cy) * scY);
  // Screen-space collision pass so no two nodes overlap after scaling.
  const minD = minDistance;
  for (let it = 0; it < 80; it++) {
    let movedAny = false;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const dx = px[i] - px[j], dy = py[i] - py[j], d = Math.hypot(dx, dy);
      if (d < minD) { const push = (minD - d) / 2, ux = d ? dx / d : 1, uy = d ? dy / d : 0;
        px[i] += ux * push; py[i] += uy * push; px[j] -= ux * push; py[j] -= uy * push; movedAny = true; }
    }
    for (let i = 0; i < n; i++) { px[i] = Math.max(40, Math.min(width - 40, px[i])); py[i] = Math.max(30, Math.min(height - 30, py[i])); }
    if (!movedAny) break;
  }
  return new Map(ordered.map((node, i) => [node.id, { x: px[i], y: py[i] }]));
}

function renderGraph(container, { nodes = [], edges = [], focus = null }) {
  container.innerHTML = '';
  if (!nodes.length) {
    container.innerHTML = '<div class="empty">No stored knowledge relationships to draw.</div>';
    return;
  }
  // These are the actual stored see-also edges, not inferred dependencies.
  const compact = container.clientWidth < 600;
  const width = compact ? 560 : 960, height = compact ? 600 : 540;
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const related = edges.filter(edge => nodeById.has(edge.source) && nodeById.has(edge.target));
  const degrees = new Map(nodes.map(node => [node.id, 0]));
  related.forEach(edge => {
    degrees.set(edge.source, (degrees.get(edge.source) || 0) + 1);
    degrees.set(edge.target, (degrees.get(edge.target) || 0) + 1);
  });
  const ordered = [...nodes].sort((a, b) => (degrees.get(b.id) - degrees.get(a.id)) || String(a.id).localeCompare(String(b.id)));
  const positions = connectionLayout(ordered, related, width, height, compact ? 36 : 26);
  const colorFor = category => ({wisdom:'#b18aff',principle:'#4cfcbe',rule:'#69a8ff',shape:'#ffd27b',knowledge:'#39eaff'}[category] || '#78bbdb');
  // One visible stroke per pair; the inspector still lists every actual stored relationship.
  const visualEdges = [], pairs = new Set();
  for (const edge of related) {
    if (edge.source === edge.target) continue;
    const pair = JSON.stringify([edge.source, edge.target].sort());
    if (!pairs.has(pair)) { pairs.add(pair); visualEdges.push(edge); }
  }
  const edgesMarkup = visualEdges.map((edge, index) => {
    const a = positions.get(edge.source), b = positions.get(edge.target);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, bend = index % 2 ? 0.12 : -0.12;
    const color = colorFor(nodeById.get(edge.source)?.category);
    return `<path class="conn-fiber" style="--fiber:${color}" data-from="${esc(edge.source)}" data-to="${esc(edge.target)}" d="M${a.x.toFixed(1)} ${a.y.toFixed(1)} Q${(mx - (b.y - a.y) * bend).toFixed(1)} ${(my + (b.x - a.x) * bend).toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}"/>`;
  }).join('');
  const nodesMarkup = ordered.map(node => {
    const p = positions.get(node.id), degree = degrees.get(node.id);
    const r = (compact ? 6.5 : 4.2) + Math.min(6, Math.sqrt(degree) * 1.4);
    const left = p.x > width * 0.78;
    return `<g class="conn-neuron" tabindex="0" role="button" aria-pressed="false" aria-label="Inspect ${esc(node.name)}" data-uri="${esc(node.id)}" transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})" style="--neuron:${colorFor(node.category)}">
      <circle class="conn-neuron-hit" r="18"/>
      <circle class="conn-neuron-halo" r="${(r*2.3).toFixed(1)}" fill="${colorFor(node.category)}"/>
      <circle class="conn-neuron-core" r="${r.toFixed(1)}" stroke="${colorFor(node.category)}"/>
      <text class="conn-neuron-label" x="${left ? -(r+8).toFixed(1) : (r+8).toFixed(1)}" y="4"${left ? ' text-anchor="end"' : ''}>${esc(String(node.name).slice(0, 34))}</text>
    </g>`;
  }).join('');
  container.innerHTML = `<section class="conn-visual" aria-label="Interactive RepoQL connections map">
    <div class="conn-visual-bar">
      <div class="conn-zoom-controls" role="group" aria-label="Graph zoom">
        <button class="btn small" type="button" data-graph-action="out" aria-label="Zoom out"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg></button>
        <button class="btn small" type="button" data-graph-action="reset" aria-label="Reset graph"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10a8 8 0 1 1 1 8M4 4v6h6"/></svg></button>
        <button class="btn small" type="button" data-graph-action="in" aria-label="Zoom in"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M12 5v14"/></svg></button>
      </div>
    </div>
    <div class="conn-viewport" tabindex="0" aria-label="Relationship map. Drag to pan, scroll or pinch to zoom, select a neuron to reveal its connections.">
      <svg class="conn-svg" viewBox="0 0 ${width} ${height}" role="group" aria-label="Stored RepoQL relationship map"><defs>
        <radialGradient id="conn-halo"><stop stop-color="#133a64" stop-opacity=".28"/><stop offset="1" stop-color="#070d21" stop-opacity="0"/></radialGradient>
        <filter id="conn-glow" x="-180%" y="-180%" width="460%" height="460%"><feGaussianBlur stdDeviation="3.3" result="g"/><feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      </defs>
      <ellipse cx="${width/2}" cy="${height/2}" rx="${width/2-10}" ry="${height/2-10}" fill="url(#conn-halo)"/>
      <g class="conn-camera">${edgesMarkup}${nodesMarkup}</g></svg>
    </div>
    <div class="conn-inspector" aria-live="polite" hidden></div>
  </section>`;
  const viewport = container.querySelector('.conn-viewport');
  const camera = container.querySelector('.conn-camera');
  const inspector = container.querySelector('.conn-inspector');
  let scale = 1, dx = 0, dy = 0, selected = null;
  const pointers = new Map();
  let pinch = null, moved = false, dragDistance = 0;
  const clamp = (v, low, high) => Math.max(low, Math.min(high, v));
  const update = () => {
    camera.setAttribute('transform', `translate(${dx} ${dy}) scale(${scale})`);
    // Zoom and focus never reveal labels; only explicit selection does.
  };
  function viewPoint(clientX, clientY) {
    const svg = container.querySelector('.conn-svg'), matrix = svg.getScreenCTM();
    if (!matrix) return {x:width/2,y:height/2};
    const point = svg.createSVGPoint(); point.x = clientX; point.y = clientY;
    return point.matrixTransform(matrix.inverse());
  }
  function zoom(next, at={x:width/2,y:height/2}) {
    const old = scale;
    scale = clamp(next, .65, 5);
    dx = at.x - (at.x - dx) * (scale / old);
    dy = at.y - (at.y - dy) * (scale / old);
    update();
  }
  function clearSelection() {
    selected = null;
    container.querySelectorAll('.selected,.linked').forEach(el => el.classList.remove('selected','linked'));
    container.querySelectorAll('.conn-neuron').forEach(el => el.setAttribute('aria-pressed','false'));
    container.querySelector('.conn-visual')?.classList.remove('has-selection');
    inspector.textContent = ''; inspector.hidden = true;
  }
  function inspect(uri) {
    const node = nodeById.get(uri);
    if (!node) return;
    selected = uri;
    container.querySelectorAll('.conn-neuron').forEach(el => { const on = el.dataset.uri === uri; el.classList.toggle('selected', on); el.setAttribute('aria-pressed', String(on)); });
    inspector.hidden = false;
    const linkedIds = new Set();
    container.querySelectorAll('.conn-fiber').forEach(el => { const on = el.dataset.from === uri || el.dataset.to === uri; el.classList.toggle('selected', on); if (on) linkedIds.add(el.dataset.from === uri ? el.dataset.to : el.dataset.from); });
    container.querySelectorAll('.conn-neuron').forEach(el => el.classList.toggle('linked', linkedIds.has(el.dataset.uri)));
    container.querySelector('.conn-visual')?.classList.add('has-selection');
    const neighbors = related.filter(edge => edge.source === uri || edge.target === uri).map(edge => {
      const other = nodeById.get(edge.source === uri ? edge.target : edge.source);
      return other ? `<button type="button" class="conn-neighbor" data-inspect="${esc(other.id)}"><span class="conn-neighbor-dot" style="--neuron-color:${colorFor(other.category)}"></span>${esc(other.name)}<span class="muted small">${esc(edge.type || 'SEE_ALSO')}</span></button>` : '';
    });
    inspector.innerHTML = `<div class="conn-inspector-head"><div><span class="conn-kicker">SELECTED MEMORY</span><strong>${esc(node.name)}</strong><span class="muted small">${esc(node.category || 'uncategorised')} · ${neighbors.length} stored connections</span></div><a class="btn small primary" href="${href('/knowledge/item',{uri})}">View memory</a></div>
      <div class="conn-neighbors">${neighbors.join('') || '<span class="muted small">No stored connections in this view.</span>'}</div>`;
    inspector.querySelectorAll('[data-inspect]').forEach(el => el.addEventListener('click', () => inspect(el.dataset.inspect)));
  }
  container.querySelectorAll('.conn-neuron').forEach(el => {
    el.addEventListener('click', () => {if (!moved) inspect(el.dataset.uri);});
    el.addEventListener('keydown', event => {if(event.key === 'Enter' || event.key === ' '){event.preventDefault();inspect(el.dataset.uri);}});
  });
  container.querySelectorAll('[data-graph-action]').forEach(el => el.addEventListener('click', () => {
    if (el.dataset.graphAction === 'reset') {scale=1;dx=0;dy=0;clearSelection();update();}
    else zoom(scale*(el.dataset.graphAction==='in'?1.32:1/1.32));
  }));
  viewport.addEventListener('click',event=>{if(!moved && !event.target.closest('.conn-neuron'))clearSelection();});
  viewport.addEventListener('wheel', event => {
    event.preventDefault();
    zoom(scale*(event.deltaY<0?1.16:1/1.16),viewPoint(event.clientX,event.clientY));
  },{passive:false});
  viewport.addEventListener('pointerdown',event => {
    if(event.button !== 0 && event.pointerType === 'mouse')return;
    moved = false;dragDistance = 0;
    pointers.set(event.pointerId,viewPoint(event.clientX,event.clientY));
    if (!event.target.closest('.conn-neuron')) viewport.setPointerCapture?.(event.pointerId);
    if(pointers.size===2){const [a,b]=[...pointers.values()];pinch={distance:Math.hypot(a.x-b.x,a.y-b.y),scale,mid:{x:(a.x+b.x)/2,y:(a.y+b.y)/2}};}
  });
  viewport.addEventListener('pointermove',event => {
    if(!pointers.has(event.pointerId))return;
    const next=viewPoint(event.clientX,event.clientY),last=pointers.get(event.pointerId);
    pointers.set(event.pointerId,next);
    if(pointers.size===2){const [a,b]=[...pointers.values()];const mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
      if(!pinch)pinch={distance:Math.hypot(a.x-b.x,a.y-b.y),scale,mid};
      dx+=mid.x-pinch.mid.x;dy+=mid.y-pinch.mid.y;
      zoom(pinch.scale*Math.hypot(a.x-b.x,a.y-b.y)/Math.max(1,pinch.distance),mid);
      pinch.mid=mid;moved=true;
    }else if(pointers.size===1){dragDistance+=Math.hypot(next.x-last.x,next.y-last.y);if(dragDistance>5){dx+=next.x-last.x;dy+=next.y-last.y;moved=true;update();}}
  });
  const release=event=>{pointers.delete(event.pointerId);if(pointers.size<2)pinch=null;};
  viewport.addEventListener('pointerup',release);
  viewport.addEventListener('pointercancel',release);
  viewport.addEventListener('lostpointercapture',release);
  viewport.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();clearSelection();return;}if(event.target!==viewport)return;
    if(event.key==='+' || event.key==='='){event.preventDefault();zoom(scale*1.2);}
    if(event.key==='-'){event.preventDefault();zoom(scale/1.2);}
    if(event.key.startsWith('Arrow')){event.preventDefault();dx+=event.key==='ArrowRight'?-22:event.key==='ArrowLeft'?22:0;dy+=event.key==='ArrowDown'?-22:event.key==='ArrowUp'?22:0;update();}
  });
  // Pointer click events fire after pointerup; clear the drag latch in the next task.
  viewport.addEventListener('pointerup',()=>setTimeout(()=>{moved=false;},0));
  update();
}

// -------------------------------------------------------------- repositories

// Repositories is the second tab of Indexing. The former standalone page head
// (title, subtitle, Import button) is rendered by viewIndexing for this tab.
async function mountRepositories(panel, params) {
  const owner = state.routeAbort?.signal;
  const query = params.q || "";
  const status = params.status || "";
  panel.innerHTML = `<div class="toolbar">
       <input class="input wide" id="repo-search" placeholder="Search name, source or path…" value="${esc(query)}">
       <select class="select" id="repo-status">
         <option value="">All statuses</option>
         ${["indexed", "indexing", "errors", "unavailable"].map((value) => `<option value="${value}" ${value === status ? "selected" : ""}>${value}</option>`).join("")}
       </select>
       <span class="muted small" id="repo-count"></span>
     </div>
     <div id="repo-table" class="table-wrap"><div class="loading">Loading repositories…</div></div>`;

  const table = document.getElementById("repo-table");
  const search = document.getElementById("repo-search");
  const statusSelect = document.getElementById("repo-status");
  let current = { q: query, status };
  const next = sequencer(() => !owner?.aborted);

  const load = async () => {
    if (owner?.aborted) return;
    const isCurrent = next();
    const data = await api("/api/repos");
    if (!isCurrent()) return;
    let rows = data.repositories;
    if (current.status) rows = rows.filter((row) => row.status === current.status);
    if (current.q) {
      const needle = current.q.toLowerCase();
      rows = rows.filter((row) => [row.root, row.directory, row.kind].filter(Boolean).join(" ").toLowerCase().includes(needle));
    }
    document.getElementById("repo-count").textContent =
      `${rows.length} of ${data.repositories.length} repositories · ${data.system_mounts.length} system mounts (read-only)`;
    table.innerHTML = `
      <table class="data">
        <thead><tr>
          <th>Repository</th><th>Status</th><th class="right">Files</th><th class="right">Failed</th>
          <th>Last activity <span class="muted">(log window)</span></th><th>Actions</th>
        </tr></thead>
        <tbody>
          ${rows.map((row) => `
            <tr>
              <td>
                <a href="${href("/repositories/view", { root: row.root })}" class="mono">${esc(row.root)}</a>
                <div class="uri small">${esc(row.directory || "—")}</div>
              </td>
              <td>${statusPill(row.status)} ${row.available ? "" : `<span class="pill red">source missing</span>`}</td>
              <td class="num">${fmt(row.indexed_count)}<span class="muted"> / ${fmt(row.file_count)}</span></td>
              <td class="num ${row.failed ? "" : "muted"}">${fmt(row.failed)}</td>
              <td class="small">${esc(row.last_activity || "—")}</td>
              <td class="nowrap">
                <a class="btn small ghost" href="${href("/repositories/view", { root: row.root })}">View</a>
                <button class="btn small" data-reindex="${esc(row.root)}">Reindex</button>
                <button class="btn small danger" data-remove="${esc(row.root)}">Remove</button>
              </td>
            </tr>`).join("") || `<tr><td colspan="6" class="empty">No repositories match this filter.</td></tr>`}
        </tbody>
      </table>
      ${data.system_mounts.length ? `<div class="small muted" style="padding:10px 12px">
        System mounts (not removable): ${data.system_mounts.map((mount) => `<span class="chip">${esc(mount.root)} · ${fmt(mount.file_count)}</span>`).join(" ")}
      </div>` : ""}`;

    table.querySelectorAll("[data-reindex]").forEach((button) => {
      button.addEventListener("click", () => reindex(button.dataset.reindex, button));
    });
    table.querySelectorAll("[data-remove]").forEach((button) => {
      button.addEventListener("click", () => removeRepository(button.dataset.remove));
    });
  };

  const updateParams = () => {
    if (owner?.aborted) return;
    current = { q: search.value.trim(), status: statusSelect.value };
    setParams({ q: current.q, status: current.status });
    load().catch((error) => { if (!owner?.aborted && error.status !== -1) toast("Repositories", error.message, "error"); });
  };

  search.addEventListener("input", debounceForRoute(updateParams, 250, owner));
  statusSelect.addEventListener("change", updateParams);
  document.getElementById("import-btn").addEventListener("click", importDialog);

  await load();
  if (!owner?.aborted) schedule(() => load().catch(() => {}), 15000);
}

async function reindex(root, button) {
  button.disabled = true;
  try {
    const result = await api("/api/repos/reindex", { method: "POST", body: { root } });
    toast("Reindex requested", result.message || root, "success");
  } catch (error) {
    if (error.status === 409) {
      toast("RepoQL is busy", `${error.message} — retry when the sweep is idle.`, "error");
    } else {
      toast("Reindex failed", error.message, "error");
    }
  } finally {
    button.disabled = false;
  }
}

function modal(html, onMount) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<div class="modal">${html}</div>`;
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) backdrop.remove();
  });
  document.body.appendChild(backdrop);
  onMount?.(backdrop);
  return backdrop;
}

function importDialog() {
  modal(`
    <h3>Import repository</h3>
    <p>RepoQL registers the source and indexes it through its existing indexing pipeline.
      Supported: <span class="mono">github://owner/repo</span>, any git remote
      (<span class="mono">https://host/repo.git</span>, <span class="mono">ssh://</span>, <span class="mono">git@host:path</span>),
      <span class="mono">s3://bucket/prefix</span>, or an existing local directory.</p>
    <label for="import-uri">Repository source</label>
    <input class="input mono" id="import-uri" placeholder="github://owner/repo" autocomplete="off">
    <div class="small muted" style="margin-top:10px">Credentials are used by RepoQL from its own environment; nothing is stored or shown here.</div>
    <div class="row">
      <button class="btn ghost" id="cancel">Cancel</button>
      <button class="btn primary" id="confirm">Import</button>
    </div>`, (backdrop) => {
    const input = backdrop.querySelector("#import-uri");
    const confirm = backdrop.querySelector("#confirm");
    input.focus();
    backdrop.querySelector("#cancel").addEventListener("click", () => backdrop.remove());
    confirm.addEventListener("click", async () => {
      const uri = input.value.trim();
      if (!uri) return;
      confirm.disabled = true;
      confirm.textContent = "Importing…";
      try {
        const result = await api("/api/repos/import", { method: "POST", body: { uri }, timeoutMs: 900000 });
        backdrop.remove();
        toast(result.ok ? "Import started" : "Import reported a problem", result.message || uri, result.ok ? "success" : "error");
        if (result.repository) location.hash = href("/repositories/view", { root: result.repository });
        else route();
      } catch (error) {
        confirm.disabled = false;
        confirm.textContent = "Import";
        toast("Import failed", error.message, "error");
      }
    });
  });
}

function removeRepository(root) {
  modal(`
    <h3>Remove repository</h3>
    <p>This unregisters <span class="mono">${esc(root)}</span> from RepoQL and drops its indexed rows and
      derived knowledge from the graph. RepoQL deletes only its own cache clone; a directory imported
      in place is never deleted or modified.</p>
    <label for="confirm-root">Type the repository root to confirm</label>
    <input class="input mono" id="confirm-root" placeholder="${esc(root)}" autocomplete="off">
    <div class="row">
      <button class="btn ghost" id="cancel">Cancel</button>
      <button class="btn danger" id="confirm" disabled>Remove repository</button>
    </div>`, (backdrop) => {
    const input = backdrop.querySelector("#confirm-root");
    const confirm = backdrop.querySelector("#confirm");
    input.focus();
    input.addEventListener("input", () => {
      confirm.disabled = input.value.trim() !== root;
    });
    backdrop.querySelector("#cancel").addEventListener("click", () => backdrop.remove());
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      confirm.textContent = "Removing…";
      try {
        const result = await api("/api/repos/remove", { method: "POST", body: { root, confirm: input.value.trim() }, timeoutMs: 1800000 });
        backdrop.remove();
        toast(result.ok ? "Repository removed" : "Removal reported a problem", result.message || root, result.ok ? "success" : "error");
        route();
      } catch (error) {
        confirm.disabled = false;
        confirm.textContent = "Remove repository";
        toast("Removal failed", error.message, "error");
      }
    });
  });
}

async function viewRepository(params) {
  const root = params.root || "";
  if (!root) {
    APP.innerHTML = pageHead("Repository", "No repository selected.") +
      tabStrip(INDEXING_TABS, "repositories", "Indexing sections") +
      `<div class="empty">Pick a repository from the list.</div>`;
    return;
  }
  // Detail keeps its own route (and cannot be a tab), but it belongs to the
  // Repositories tab of Indexing, so the tab strip stays visible and the back
  // link lands on that tab.
  APP.innerHTML = pageHead(root, "Repository detail, index inventory and associated knowledge.",
    `<a class="btn ghost" href="${href("/indexing", { tab: "repositories" })}">Back to repositories</a>`) +
    tabStrip(INDEXING_TABS, "repositories", "Indexing sections") +
    `<div id="repo-detail"><div class="loading">Loading repository…</div></div>`;

  const next = sequencer();
  const load = async () => {
    const isCurrent = next();
    const data = await api(`/api/repos/detail?root=${encodeURIComponent(root)}`);
    if (!isCurrent()) return;
    const repo = data.repository;
    document.getElementById("repo-detail").innerHTML = `
      <div class="grid cols-3">
        <div class="block">
          <div class="block-title">Identity</div>
          <dl class="kv">
            <dt>State</dt><dd>${statusPill(repo.status || repo.state)}</dd>
            <dt>Kind</dt><dd>${esc(repo.kind || "—")}</dd>
            <dt>Analysis</dt><dd>${esc(repo.analysis || "—")}</dd>
            <dt>Watching</dt><dd>${repo.watching ? "yes" : "no"}</dd>
            <dt>Mounted</dt><dd>${esc(repo.mounted_at || "—")}</dd>
            <dt>Available</dt><dd class="${repo.available === false ? "err" : "ok"}">${repo.available === false ? "source missing" : "on disk"}</dd>
          </dl>
          <div class="field" style="margin-top:12px"><span class="label">Local path</span>
            <span class="value mono">${esc(repo.directory || "—")}</span></div>
        </div>
        <div class="block accent-blue">
          <div class="block-title">Inventory</div>
          <div class="metric blue"><span class="value">${fmt(repo.indexed_count)}</span><span class="unit">indexed / ${fmt(repo.file_count)} files</span></div>
          <div class="progress"><span style="width:${repo.file_count ? Math.min(100, (repo.indexed_count / repo.file_count) * 100) : 0}%"></span></div>
          <dl class="kv">
            <dt>Embedded</dt><dd>${fmt(repo.embedded_count)} (${Math.round(repo.embed_pct ?? 0)}%)</dd>
            <dt>Size</dt><dd>${bytes(repo.total_bytes)}</dd>
            <dt>Failed files</dt><dd class="${data.failed_files.length ? "err" : ""}">${fmt(data.failed_files.length)}</dd>
            <dt>Exclusions</dt><dd>${fmt(data.exclusions.length)}</dd>
          </dl>
        </div>
        <div class="block accent-purple">
          <div class="block-title">Content mix</div>
          <div class="chips">
            ${data.content_categories.map((row) => `<span class="chip">${esc(row.category)} · ${fmt(row.n)}</span>`).join("") || `<span class="muted">no files</span>`}
          </div>
          ${repo.languages ? `<div class="small muted" style="margin-top:14px">${esc(repo.languages.split(",").slice(0, 8).join(", "))}</div>` : ""}
        </div>
      </div>

      <div class="grid cols-2" style="margin-top:14px">
        <div class="block">
          <div class="block-title">Sample files <span class="tag">first 25</span></div>
          <div class="table-wrap"><table class="data">
            <thead><tr><th>Path</th><th class="right">Size</th><th>Kind</th></tr></thead>
            <tbody>${data.sample_files.map((file) => `<tr>
              <td class="mono">${esc(file.uri)}</td><td class="num">${bytes(file.byte_size)}</td>
              <td class="muted small">${esc(file.content_category || "—")}</td></tr>`).join("") || `<tr><td colspan="3" class="empty">No indexed files.</td></tr>`}</tbody>
          </table></div>
        </div>
        <div class="block">
          <div class="block-title">Knowledge records <span class="tag">${fmt(data.knowledge.length)}</span></div>
          <div class="table-wrap"><table class="data">
            <thead><tr><th>Name</th><th>Category</th></tr></thead>
            <tbody>${data.knowledge.map((row) => `<tr>
              <td><a href="${href("/knowledge/item", { uri: row.canonical_uri })}">${esc(row.name)}</a></td>
              <td>${categoryChip(row.category || "uncategorised")}</td></tr>`).join("") || `<tr><td colspan="2" class="empty">No knowledge records from this source.</td></tr>`}</tbody>
          </table></div>
        </div>
      </div>

      ${data.failed_files.length ? `<div class="block accent-red" style="margin-top:14px">
        <div class="block-title">Indexing failures</div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>File</th><th>Error</th><th>Stage</th><th></th></tr></thead>
          <tbody>${data.failed_files.map((file) => `<tr>
            <td class="mono">${esc(file.uri)}</td><td class="truncate small">${esc(file.error)}</td>
            <td class="small">${esc(file.stage || "—")}</td>
            <td><button class="btn small" data-exclude="${esc(file.uri)}" data-error="${esc(file.error)}">Exclude From Indexing</button></td>
          </tr>`).join("")}</tbody>
        </table></div></div>` : ""}

      ${data.exclusions.length ? `<div class="block accent-amber" style="margin-top:14px">
        <div class="block-title">Excluded files from this repository</div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>File</th><th>Pattern</th><th>Excluded</th><th>State</th></tr></thead>
          <tbody>${data.exclusions.map((row) => `<tr>
            <td class="mono">${esc(row.uri)}</td><td class="mono small">${esc(row.pattern)}</td>
            <td class="small">${esc(row.excluded_at)}</td><td>${pill(row.state)}</td></tr>`).join("")}</tbody>
        </table></div></div>` : ""}`;

    document.querySelectorAll("[data-exclude]").forEach((button) => {
      button.addEventListener("click", () => excludeDialog(button.dataset.exclude, button.dataset.error));
    });
  };

  await load();
  schedule(() => load().catch(() => {}), 20000);
}

// ------------------------------------------------------------------ indexing

async function viewIndexing(params) {
  const tab = indexingTabOf(params);
  const actions = tab === "repositories" ? `<button class="btn primary" id="import-btn">Import Repository</button>` : "";
  APP.innerHTML = pageHead("Indexing", INDEXING_SUBTITLES[tab], actions) +
    tabStrip(INDEXING_TABS, tab, "Indexing sections") +
    `<div id="indexing-panel"></div>`;
  const panel = document.getElementById("indexing-panel");
  if (tab === "repositories") return mountRepositories(panel, params);
  return mountIndexingFiles(panel, params);
}

async function mountIndexingFiles(panel, params) {
  const owner = state.routeAbort?.signal;
  const query = params.q || "";
  const status = params.status || "indexed";
  const page = Number(params.page || 1);
  panel.innerHTML = `<div id="index-stats" class="stack"><div class="loading">Reading index state…</div></div>
     <div class="block" style="margin-top:14px">
       <div class="block-title">File inventory</div>
       <div class="toolbar">
         <input class="input wide" id="file-search" placeholder="Search file path or URI…" value="${esc(query)}">
         <select class="select" id="file-status">
           ${["indexed", "pending", "processing", "failed", "excluded"].map((value) => `<option value="${value}" ${value === status ? "selected" : ""}>${value}</option>`).join("")}
         </select>
         <span class="small muted" id="file-total"></span>
       </div>
       <div id="file-table" class="table-wrap"><div class="loading">Loading files…</div></div>
       <div id="file-pager"></div>
     </div>`;

  const current = { q: query, status, page };
  const table = () => document.getElementById("file-table");
  const pager = () => document.getElementById("file-pager");
  const search = document.getElementById("file-search");
  const statusSelect = document.getElementById("file-status");

  const nextStats = sequencer(() => !owner?.aborted);
  const nextFiles = sequencer(() => !owner?.aborted);

  const loadStats = async () => {
    if (owner?.aborted) return;
    const isCurrent = nextStats();
    const data = await api("/api/indexing");
    if (!isCurrent()) return;
    const engine = data.engine || {};
    const progress = data.progress_percent ?? 0;
    document.getElementById("index-stats").innerHTML = `
      <div class="grid cols-3">
        <div class="block">
          <div class="block-title">Corpus</div>
          <div class="metric blue"><span class="value">${fmt(engine.total_files)}</span><span class="unit">total files</span></div>
          <div class="progress"><span style="width:${progress}%"></span></div>
          <dl class="kv">
            <dt>Complete</dt><dd class="ok">${fmt(engine.complete)}</dd>
            <dt>Pending</dt><dd>${fmt(engine.pending)}</dd>
            <dt>Active</dt><dd>${fmt(engine.active)}</dd>
            <dt>Failed</dt><dd class="${engine.failed ? "err" : ""}">${fmt(engine.failed)}</dd>
            <dt>Skipped</dt><dd>${fmt(engine.skipped)}</dd>
            <dt>State</dt><dd>${pill(engine.state)}</dd>
          </dl>
        </div>
        <div class="block accent-green">
          <div class="block-title">Semantic + last complete</div>
          <div class="metric green"><span class="value">${fmt(engine.semantic_percent)}%</span><span class="unit">semantic</span></div>
          <dl class="kv">
            <dt>Semantic ready</dt><dd>${engine.semantic_ready ? "yes" : "no"}</dd>
            <dt>Structure embedded</dt><dd>${fmt(engine.structure_embedded)}</dd>
            <dt>Last complete</dt><dd>${esc(data.activity?.last_complete?.ts || "—")}</dd>
            <dt>Sweep</dt><dd>${data.activity?.sweep ? `${data.activity.sweep.percent}% · ${data.activity.sweep.state}` : "—"}</dd>
            <dt>Last activity</dt><dd>${esc(data.activity?.last_activity || "—")}</dd>
          </dl>
        </div>
        <div class="block accent-amber">
          <div class="block-title">Queue</div>
          <div class="metric amber"><span class="value">${fmt(Object.values(data.queue_counts || {}).reduce((a, b) => a + b, 0))}</span><span class="unit">work items</span></div>
          <dl class="kv">
            ${Object.entries(data.queue_counts || {}).map(([key, value]) => `<dt>${esc(key)}</dt><dd>${fmt(value)}</dd>`).join("") || `<dt>Queue</dt><dd>empty</dd>`}
          </dl>
        </div>
      </div>
      <div class="grid cols-2" style="margin-top:14px">
        <div class="block">
          <div class="block-title">Operation history <span class="tag">Operations table</span></div>
          <div class="table-wrap"><table class="data">
            <thead><tr><th>Kind</th><th>State</th><th class="right">Total</th><th class="right">Failed</th><th>Started</th><th>Completed</th></tr></thead>
            <tbody>${data.operations.map((row) => `<tr>
              <td class="mono">${esc(row.kind)}</td><td>${pill(row.state)}</td>
              <td class="num">${fmt(row.total)}</td><td class="num ${row.failed ? "" : "muted"}">${fmt(row.failed)}</td>
              <td class="small">${esc((row.started_at || "").replace("T", " ").slice(0, 19))}</td>
              <td class="small">${esc((row.completed_at || "—").replace("T", " ").slice(0, 19))}</td>
            </tr>`).join("") || `<tr><td colspan="6" class="empty">No operations recorded.</td></tr>`}</tbody>
          </table></div>
        </div>
        <div class="block">
          <div class="block-title">Live host log <span class="tag">last 40 lines</span></div>
          <div class="mono small" style="max-height:320px;overflow:auto">
            ${data.recent_lines.slice().reverse().map((row) => `<div style="display:grid;grid-template-columns:130px 46px 1fr;gap:8px;padding:3px 0">
              <span class="muted">${esc(row.ts.slice(11))}</span>
              <span class="${row.level.startsWith("E") ? "err" : row.level.startsWith("W") ? "warn" : "muted"}">${esc(row.level)}</span>
              <span>${esc(row.msg.slice(0, 180))}</span></div>`).join("") || `<div class="empty">No log lines.</div>`}
          </div>
        </div>
      </div>`;
  };

  const loadFiles = async () => {
    if (owner?.aborted) return;
    const isCurrent = nextFiles();
    table().innerHTML = `<div class="loading">Loading files…</div>`;
    const data = await api(`/api/files?page=${current.page}&status=${encodeURIComponent(current.status)}&q=${encodeURIComponent(current.q)}&page_size=50`);
    if (!isCurrent()) return;
    document.getElementById("file-total").textContent = `${fmt(data.total)} matching files`;
    const headers = current.status === "failed"
      ? ["File", "Error", "Stage", "Failures", "Since", ""]
      : current.status === "excluded"
        ? ["File", "Repository", "Pattern", "Excluded", "State", ""]
        : ["File", "Kind", "Size", "Modified", "Status"];
    const rows = data.rows.map((row) => {
      if (current.status === "failed") {
        return `<tr><td class="mono">${esc(row.uri)}</td><td class="truncate small">${esc(row.error)}</td>
          <td class="small">${esc(row.stage || "—")}</td><td class="num">${fmt(row.failures)}</td>
          <td class="small">${esc(row.transitioned_at || "—")}</td>
          <td><button class="btn small" data-exclude="${esc(row.uri)}" data-error="${esc(row.error)}">Exclude From Indexing</button></td></tr>`;
      }
      if (current.status === "excluded") {
        return `<tr><td class="mono">${esc(row.uri)}</td><td class="mono small">${esc(row.mount_root)}</td>
          <td class="mono small">${esc(row.pattern)}</td><td class="small">${esc(row.excluded_at)}</td>
          <td>${pill(row.state)}</td>
          <td><a class="btn small ghost" href="${href("/diagnostics", { tab: "excluded" })}">Manage</a></td></tr>`;
      }
      if (current.status === "pending" || current.status === "processing") {
        return `<tr><td class="mono">${esc(row.uri)}</td><td>${pill(row.status)}</td><td class="small">${esc(row.queue || "—")}</td>
          <td class="small">${esc(row.enqueued_at || "—")}</td><td class="num">${fmt(row.failures)}</td></tr>`;
      }
      return `<tr><td class="mono">${esc(row.uri)}</td><td class="small muted">${esc(row.content_category || "—")}</td>
        <td class="num">${bytes(row.byte_size)}</td><td class="small">${esc((row.mtime || "").replace("T", " ").slice(0, 19))}</td>
        <td>${pill(row.status)}</td></tr>`;
    }).join("");
    table().innerHTML = `<table class="data"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
      <tbody>${rows || `<tr><td colspan="${headers.length}" class="empty">No files match.</td></tr>`}</tbody></table>`;
    pager().innerHTML = "";
    pager().appendChild(pagerBlock(data.page, data.page_size, data.total, (next) => {
      current.page = next;
      setParams({ page: next });
      loadFiles().catch((error) => { if (!owner?.aborted && error.status !== -1) toast("Files", error.message, "error"); });
    }));
    table().querySelectorAll("[data-exclude]").forEach((button) => {
      button.addEventListener("click", () => excludeDialog(button.dataset.exclude, button.dataset.error));
    });
  };

  search.addEventListener("input", debounceForRoute(() => {
    current.q = search.value.trim();
    current.page = 1;
    setParams({ q: current.q, page: 1 });
    loadFiles().catch(() => {});
  }, 300, owner));
  statusSelect.addEventListener("change", () => {
    if (owner?.aborted) return;
    current.status = statusSelect.value;
    current.page = 1;
    setParams({ status: current.status, page: 1 });
    loadFiles().catch(() => {});
  });

  await Promise.all([loadStats(), loadFiles()]);
  if (!owner?.aborted) schedule(() => loadStats().catch(() => {}), 8000);
  if (!owner?.aborted) schedule(() => loadFiles().catch(() => {}), 15000);
}

// --------------------------------------------------------------- diagnostics
// CPU & Performance, Errors and Excluded Files are one sidebar page. Each tab
// mounts the panel its standalone route used to render; the requests, polling,
// cancellation and cleanup below are the same code, not a parallel copy.

async function viewDiagnostics(params) {
  const tab = diagnosticsTabOf(params);
  const period = params.period || "1h";
  const actions = tab === "cpu"
    ? `<div class="seg" id="periods">${["1h", "6h", "24h", "7d", "30d"].map((value) => `<button data-period="${value}" class="${value === period ? "active" : ""}">${value.toUpperCase()}</button>`).join("")}</div>`
    : "";
  APP.innerHTML = pageHead("Diagnostics", DIAGNOSTICS_SUBTITLES[tab], actions) +
    tabStrip(DIAGNOSTICS_TABS, tab, "Diagnostics sections") +
    `<div id="diagnostics-panel"></div>`;
  const panel = document.getElementById("diagnostics-panel");
  if (tab === "errors") return mountErrors(panel, params);
  if (tab === "excluded") return mountExcluded(panel);
  return mountCpu(panel, params);
}

async function mountCpu(panel, params) {
  const owner = state.routeAbort?.signal;
  let period = params.period || "1h";
  panel.innerHTML = `<div id="cpu-body" class="stack"><div class="loading">Loading CPU history…</div></div>`;

  const body = document.getElementById("cpu-body");
  const next = sequencer(() => !owner?.aborted);
  const load = async () => {
    if (owner?.aborted) return;
    const isCurrent = next();
    const data = await api(`/api/cpu?period=${period}`);
    if (!isCurrent()) return;
    const stats = data.stats;
    const latest = data.series.length ? data.series[data.series.length - 1] : null;
    body.innerHTML = `
      <div class="grid cols-3">
        <div class="block accent-green">
          <div class="block-title">Current</div>
          <div class="metric green"><span class="value">${latest && latest.avg != null ? quotaPct(latest.avg).toFixed(1) : "—"}</span><span class="unit">% of ${CPU_QUOTA_LABEL}</span></div>
          <dl class="kv">
            <dt>Peak in window</dt><dd>${stats.peak == null ? "—" : quotaPct(stats.peak).toFixed(1) + "%"}</dd>
            <dt>Average in window</dt><dd>${stats.avg == null ? "—" : quotaPct(stats.avg).toFixed(1) + "%"}</dd>
            <dt>Samples</dt><dd>${fmt(stats.samples)}</dd>
            <dt>Measurement gaps</dt><dd class="${stats.gaps ? "warn" : ""}">${fmt(stats.gaps)}</dd>
            <dt>Last measurement</dt><dd>${esc(stats.last_sample || "—")}</dd>
          </dl>
        </div>
        <div class="block">
          <div class="block-title">Selected window</div>
          <div class="metric cyan"><span class="value">${period.toUpperCase()}</span></div>
          <dl class="kv">
            <dt>Bucket</dt><dd>${data.bucket_seconds >= 60 ? data.bucket_seconds / 60 + " min" : data.bucket_seconds + " s"}</dd>
            <dt>Retention</dt><dd>${data.retention_days} days</dd>
            <dt>Measured by</dt><dd>systemd timer, 30 s</dd>
          </dl>
          <div class="small muted" style="margin-top:12px">Samples are collected by <span class="mono">repoql-cpu-collector.timer</span>, not by this page.</div>
        </div>
        <div class="block">
          <div class="block-title">Method</div>
          <div class="small muted" style="line-height:1.7">
            <span class="mono">cpu_pct = Δ(utime+stime) ÷ CLK_TCK ÷ Δseconds × 100</span><br>
            read from <span class="mono">/proc/&lt;repoql-host-pid&gt;/stat</span>. The collector stores raw
            process CPU; the dashboard normalizes the display to RepoQL's 4-core CPU quota
            (<span class="mono">CPUQuota=400%</span>). Whole-host CPU is never reported as RepoQL usage.
            Periods without measurements stay empty rather than being interpolated.
          </div>
        </div>
      </div>
      <div class="block" style="margin-top:14px">
        <div class="block-title">RepoQL CPU history <span class="tag">${period.toUpperCase()}</span></div>
        <div id="cpu-chart" class="chart-wrap"></div>
      </div>`;

    state.cpuSeries = data.series;
    state.cpuBucket = data.bucket_seconds;
    drawCpuChart();
  };

  const drawCpuChart = () => {
    const chart = document.getElementById("cpu-chart");
    if (!chart || !state.cpuSeries) return;
    renderChart(chart, state.cpuSeries, { bucketSeconds: state.cpuBucket, height: 260, label: "CPU % of " + CPU_QUOTA_LABEL, scale: 1 / CPU_QUOTA_CORES });
  };

  let resizeHandle;
  const onResize = () => {
    clearTimeout(resizeHandle);
    resizeHandle = setTimeout(drawCpuChart, 160);
  };
  window.addEventListener("resize", onResize);
  state.cleanup = () => {
    window.removeEventListener("resize", onResize);
    clearTimeout(resizeHandle);
  };

  document.getElementById("periods").addEventListener("click", (event) => {
    const button = event.target.closest("[data-period]");
    if (!button || owner?.aborted) return;
    period = button.dataset.period;
    document.querySelectorAll("#periods button").forEach((node) => node.classList.toggle("active", node === button));
    setParams({ period });
    load().catch((error) => { if (!owner?.aborted && error.status !== -1) toast("CPU", error.message, "error"); });
  });

  await load();
  if (!owner?.aborted) schedule(() => load().catch(() => {}), 30000);
}

// -------------------------------------------------------------------- errors

async function mountErrors(panel, params) {
  const owner = state.routeAbort?.signal;
  let kind = params.kind || "indexing";
  let query = params.q || "";
  panel.innerHTML = `<div class="toolbar">
       <div class="seg" id="error-tabs">
         ${[["indexing", "Indexing failures"], ["parse", "Parse errors"], ["service", "Service log"]].map(([value, label]) => `<button data-kind="${value}" class="${value === kind ? "active" : ""}">${label}</button>`).join("")}
       </div>
       <input class="input wide" id="error-search" placeholder="Search message or file…" value="${esc(query)}">
       <span class="small muted" id="error-total"></span>
     </div>
     <div id="error-table" class="table-wrap"><div class="loading">Loading errors…</div></div>`;

  const table = document.getElementById("error-table");
  const search = document.getElementById("error-search");
  const next = sequencer(() => !owner?.aborted);

  const load = async () => {
    if (owner?.aborted) return;
    const isCurrent = next();
    const data = await api(`/api/errors?kind=${kind}&q=${encodeURIComponent(query)}&page_size=100`);
    if (!isCurrent()) return;
    document.getElementById("error-total").textContent = `${fmt(data.total)} ${kind === "service" ? "distinct warnings/errors" : "errors"}`;
    if (kind === "service") {
      table.innerHTML = `<table class="data"><thead><tr><th>Last seen</th><th>Level</th><th>Count</th><th>Component</th><th>Message</th></tr></thead>
        <tbody>${data.rows.map((row) => `<tr>
          <td class="small">${esc(row.last_ts)}</td><td>${pill(row.level === "ERR" || row.level === "FTL" ? "error" : "warning")}</td>
          <td class="num">${fmt(row.count)}</td><td class="mono small">${esc(row.component)}</td>
          <td class="truncate small">${esc(row.message)}</td></tr>`).join("") || `<tr><td colspan="5" class="empty">No warnings or errors in the current log window.</td></tr>`}</tbody></table>`;
      return;
    }
    if (kind === "parse") {
      table.innerHTML = `<table class="data"><thead><tr><th>Recorded</th><th>Kind</th><th>Severity</th><th>File</th><th>Message</th></tr></thead>
        <tbody>${data.rows.map((row) => `<tr>
          <td class="small">${esc((row.created_at || "").replace("T", " ").slice(0, 19))}</td>
          <td class="mono small">${esc(row.kind)}</td><td>${pill(row.severity)}</td>
          <td class="mono small">${esc(row.uri || "—")}</td>
          <td class="truncate small">${esc(row.message)}</td></tr>`).join("") || `<tr><td colspan="5" class="empty">No parse errors recorded.</td></tr>`}</tbody></table>`;
      return;
    }
    table.innerHTML = `<table class="data"><thead><tr><th>File</th><th>Component</th><th>Message</th><th class="right">Count</th><th>Since</th><th></th></tr></thead>
      <tbody>${data.rows.map((row) => `<tr>
        <td class="mono">${esc(row.uri)}</td><td class="small">${esc(row.component)}</td>
        <td class="truncate small">${esc(row.message)}</td><td class="num">${fmt(row.count)}</td>
        <td class="small">${esc(row.timestamp || "—")}</td>
        <td><button class="btn small" data-exclude="${esc(row.uri)}" data-error="${esc(row.message)}">Exclude Failed File</button></td>
      </tr>`).join("") || `<tr><td colspan="6" class="empty">No indexing failures recorded. failed_files is empty.</td></tr>`}</tbody></table>`;
    table.querySelectorAll("[data-exclude]").forEach((button) => {
      button.addEventListener("click", () => excludeDialog(button.dataset.exclude, button.dataset.error));
    });
  };

  document.getElementById("error-tabs").addEventListener("click", (event) => {
    const button = event.target.closest("[data-kind]");
    if (!button || owner?.aborted) return;
    kind = button.dataset.kind;
    document.querySelectorAll("#error-tabs button").forEach((node) => node.classList.toggle("active", node === button));
    setParams({ kind });
    load().catch((error) => { if (!owner?.aborted && error.status !== -1) toast("Errors", error.message, "error"); });
  });
  search.addEventListener("input", debounceForRoute(() => {
    query = search.value.trim();
    setParams({ q: query });
    load().catch(() => {});
  }, 300, owner));

  await load();
  if (!owner?.aborted) schedule(() => load().catch(() => {}), 30000);
}

function excludeDialog(uri, error) {
  modal(`
    <h3>Exclude from indexing</h3>
    <p>The rule is written to the mount's <span class="mono">.repoqlignore</span> — RepoQL's own exclusion
      mechanism — so future indexing passes skip this exact file. The original file is not deleted or modified.</p>
    <div class="field"><span class="label">File</span><span class="value mono">${esc(uri)}</span></div>
    ${error ? `<div class="field" style="margin-top:10px"><span class="label">Recorded error</span><span class="value small">${esc(error)}</span></div>` : ""}
    <label for="exclude-reason">Reason (optional)</label>
    <input class="input" id="exclude-reason" placeholder="e.g. parser failure on generated file">
    <div class="row">
      <button class="btn ghost" id="cancel">Cancel</button>
      <button class="btn primary" id="confirm">Exclude From Indexing</button>
    </div>`, (backdrop) => {
    const reason = backdrop.querySelector("#exclude-reason");
    backdrop.querySelector("#cancel").addEventListener("click", () => backdrop.remove());
    backdrop.querySelector("#confirm").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const result = await api("/api/excluded", { method: "POST", body: { uri, error, reason: reason.value.trim() } });
        backdrop.remove();
        toast("Exclusion written", `${result.exclusion.pattern} → ${result.exclusion.ignore_file}`, "success");
        route();
      } catch (requestError) {
        button.disabled = false;
        toast("Exclusion failed", requestError.message, "error");
      }
    });
  });
}

// ------------------------------------------------------------------ excluded

async function mountExcluded(panel) {
  const owner = state.routeAbort?.signal;
  panel.innerHTML = `<div id="excluded-body"><div class="loading">Loading exclusions…</div></div>`;

  const next = sequencer(() => !owner?.aborted);
  const load = async () => {
    if (owner?.aborted) return;
    const isCurrent = next();
    const data = await api("/api/excluded");
    if (!isCurrent()) return;
    document.getElementById("excluded-body").innerHTML = `
      <div class="block">
        <div class="block-title">Dashboard-managed records <span class="tag">${fmt(data.total)}</span></div>
        ${data.total === 0 ? `<div class="empty">No dashboard-managed records. Actual mount-root RepoQL rules appear below.</div>` : `
        <div class="table-wrap"><table class="data">
          <thead><tr><th>File</th><th>Repository</th><th>Original error</th><th>Excluded</th><th>State</th><th></th></tr></thead>
          <tbody>${data.rows.map((row) => `<tr>
            <td class="mono">${esc(row.uri)}<div class="uri small">${esc(row.pattern)} in ${esc(row.ignore_file)}</div></td>
            <td class="mono small">${esc(row.mount_root)}</td>
            <td class="truncate small">${esc(row.original_error || row.reason || "—")}</td>
            <td class="small">${esc(row.excluded_at)}</td>
            <td>${pill(row.state)}</td>
            <td><button class="btn small danger" data-unexclude="${esc(row.id)}">Remove Exclusion</button></td>
          </tr>`).join("")}</tbody>
        </table></div>`}
      </div>
      <div class="block" style="margin-top:14px">
        <div class="block-title">RepoQL ignore rules <span class="tag">${fmt(data.native_total)} entries in ${fmt(data.scanned_mounts)} registered mounts</span></div>
        ${!data.native_rules?.length ? '<div class="empty">No readable mount-root .repoqlignore patterns found. This does not prove RepoQL has no other exclusion mechanisms.</div>' : `
          <div class="table-wrap"><table class="data"><thead><tr><th>Pattern</th><th>Mount</th><th>Source</th><th>Line</th></tr></thead>
          <tbody>${data.native_rules.map(rule=>`<tr><td class="mono">${esc(rule.pattern)}</td><td class="mono small">${esc(rule.mount_root)}</td>
            <td class="small">${esc(rule.ignore_file)}</td><td>${fmt(rule.line)}</td></tr>`).join('')}</tbody></table></div>`}
        ${(data.unavailable_mounts||[]).length ? `<p class="muted small">Unreadable mounts: ${data.unavailable_mounts.map(m=>esc(m.root)+' ('+esc(m.reason)+')').join(', ')}</p>` : ''}
        <p class="small muted">These are observed source-file patterns, including operator-created rules. Only dashboard-managed entries above can be removed here. Rules elsewhere or exclusions not stored in a mount-root .repoqlignore are not claimed.</p>
      </div>
      <div class="block accent-amber" style="margin-top:14px">
        <div class="block-title">How exclusions work here</div>
        <div class="small muted" style="line-height:1.75">
          RepoQL reads <span class="mono">.repoqlignore</span> from the root of each mount; this dashboard appends one
          delimited block per file and records it so it can be removed exactly. Removing an exclusion restores
          eligibility — it does not claim the file already indexed successfully. Rules survive service restarts
          because they live in the mount, not in a process. Managed git clones can be re-cloned on refresh, which
          may discard clone-local rules; the recorded state stays visible here so that drift is not silent.
        </div>
      </div>`;

    document.querySelectorAll("[data-unexclude]").forEach((button) => {
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          const result = await api("/api/excluded/remove", { method: "POST", body: { id: button.dataset.unexclude } });
          toast("Exclusion removed", result.note, "success");
          load();
        } catch (error) {
          button.disabled = false;
          toast("Removal failed", error.message, "error");
        }
      });
    });
  };

  await load();
  if (!owner?.aborted) schedule(() => load().catch(() => {}), 30000);
}

// ----------------------------------------------------------------- knowledge

const KNOWLEDGE_TITLES = {
  wisdom: ["Wisdom", "Wisdom records stored in the RepoQL concept index."],
  principle: ["Principles", "Principles / invariants stored as their own knowledge category."],
  rule: ["Rules", "Rule records stored in the RepoQL concept index."],
  shape: ["Shapes", "Shape records stored in the RepoQL concept index."],
  knowledge: ["Knowledge", "Knowledge records stored in the RepoQL concept index."],
  all: ["Concepts", "Every concept record in the RepoQL index, with its category preserved."],
  uncategorised: ["Uncategorised", "Concept records without a category in the index."],
};


async function viewKnowledge(category, params) {
  const [title, subtitle] = KNOWLEDGE_TITLES[category] || KNOWLEDGE_TITLES.all;
  let query = params.q || "";
  let page = Number(params.page || 1);
  APP.innerHTML = pageHead(title, subtitle) + renderKnowledgeGuide(category) +
    `<div class="toolbar">
       <input class="input wide" id="knowledge-search" placeholder="Search name or invariant…" value="${esc(query)}">
       <select class="select" id="knowledge-category">
         ${Object.keys(KNOWLEDGE_TITLES).filter((key) => key !== "all").map((key) => `<option value="${key}" ${key === category ? "selected" : ""}>${KNOWLEDGE_TITLES[key][0]}</option>`).join("")}
         <option value="all" ${category === "all" ? "selected" : ""}>All concepts</option>
       </select>
       <span class="small muted" id="knowledge-total"></span>
     </div>
     <div id="knowledge-table" class="table-wrap"><div class="loading">Loading knowledge…</div></div>
     <div id="knowledge-pager"></div>`;

  const table = () => document.getElementById("knowledge-table");
  const pager = () => document.getElementById("knowledge-pager");
  const next = sequencer();

  const load = async () => {
    const isCurrent = next();
    const data = await api(`/api/knowledge?category=${encodeURIComponent(category)}&q=${encodeURIComponent(query)}&page=${page}&page_size=50`);
    if (!isCurrent()) return;
    document.getElementById("knowledge-total").textContent = `${fmt(data.total)} records`;
    const counts = data.counts || {};
    table().innerHTML = `
      <table class="data">
        <thead><tr><th>Name</th><th>Category</th><th>Invariant</th><th class="right">See also</th><th></th></tr></thead>
        <tbody>${data.rows.map((row) => `<tr>
          <td><a class="mono" href="${href("/knowledge/item", { uri: row.canonical_uri })}">${esc(row.name)}</a>
            ${row.subcategory ? `<div class="uri small">${esc(row.subcategory)}</div>` : ""}</td>
          <td>${categoryChip(row.category || "uncategorised")}</td>
          <td class="truncate small">${esc(row.invariant || "—")}</td>
          <td class="num">${fmt(row.see_also_count)}</td>
          <td><a class="btn small ghost" href="${href("/knowledge/item", { uri: row.canonical_uri })}">Open</a></td>
        </tr>`).join("") || `<tr><td colspan="5" class="empty">No records match.</td></tr>`}</tbody>
      </table>
      <div class="small muted" style="padding:10px 12px">
        ${Object.entries(counts).map(([key, value]) => `${esc(key)} ${fmt(value)}`).join(" · ")}
      </div>`;
    pager().innerHTML = "";
    pager().appendChild(pagerBlock(data.page, data.page_size, data.total, (next) => {
      page = next;
      setParams({ page });
      load().catch((error) => toast("Knowledge", error.message, "error"));
    }));
  };

  const debounce = (fn, ms = 300) => {
    let handle;
    return (...args) => {
      clearTimeout(handle);
      handle = setTimeout(() => fn(...args), ms);
    };
  };

  document.getElementById("knowledge-search").addEventListener("input", debounce((event) => {
    query = event.target.value.trim();
    page = 1;
    setParams({ q: query, page: 1 });
    load().catch(() => {});
  }));
  document.getElementById("knowledge-category").addEventListener("change", (event) => {
    location.hash = href(`/knowledge/${event.target.value}`, { q: query });
  });

  await load();
  schedule(() => load().catch(() => {}), 60000);
}

function frontMatter(text) {
  if (!text || !text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) return {};
  const block = text.slice(3, end);
  const fields = {};
  let currentKey = null;
  for (const line of block.split("\n")) {
    const listItem = line.match(/^\s*-\s+(.*)$/);
    if (listItem && currentKey) {
      if (!Array.isArray(fields[currentKey])) fields[currentKey] = [];
      fields[currentKey].push(listItem[1].replace(/^["']|["']$/g, ""));
      continue;
    }
    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (pair) {
      currentKey = pair[1];
      fields[currentKey] = pair[2] ? pair[2].replace(/^["']|["']$/g, "") : [];
    }
  }
  return fields;
}

async function viewKnowledgeItem(params) {
  const uri = params.uri || "";
  APP.innerHTML = pageHead("Knowledge record", uri, `<a class="btn ghost" href="${href("/knowledge/all")}">Back to concepts</a>`) +
    `<div id="knowledge-item"><div class="loading">Loading record…</div></div>`;
  const data = await api(`/api/knowledge/item?uri=${encodeURIComponent(uri)}`);
  const record = data.record;
  const meta = frontMatter(data.content?.text || "");
  const tags = Array.isArray(meta.tags) ? meta.tags : meta.tags ? [meta.tags] : [];
  document.getElementById("knowledge-item").innerHTML = `
    <div class="grid cols-2">
      <div class="block">
        <div class="block-title">Record <span class="tag">${esc(data.category || "uncategorised")}</span></div>
        <div class="metric cyan"><span class="value" style="font-size:19px">${esc(record.name)}</span></div>
        <div class="detail-list" style="margin-top:14px">
          <div class="field"><span class="label">Invariant</span><span class="value">${esc(record.invariant || "—")}</span></div>
          ${record.why ? `<div class="field"><span class="label">Why</span><span class="value small">${esc(record.why)}</span></div>` : ""}
          ${record.example ? `<div class="field"><span class="label">Example</span><span class="value small">${esc(record.example)}</span></div>` : ""}
          ${record.boundary_text ? `<div class="field"><span class="label">Boundary</span><span class="value small">${esc(record.boundary_text)}</span></div>` : ""}
          <div class="field"><span class="label">Canonical URI</span><span class="value mono">${esc(record.canonical_uri)}</span></div>
          <div class="field"><span class="label">Source file</span><span class="value mono">${esc(record.file_uri)}</span></div>
          ${record.start_line ? `<div class="field"><span class="label">Lines</span><span class="value mono">${record.start_line}–${record.end_line}</span></div>` : ""}
          ${meta.relevance ? `<div class="field"><span class="label">Relevance</span><span class="value mono small">${esc(meta.relevance)}</span></div>` : ""}
        </div>
        ${tags.length ? `<div class="tag-row">${tags.map((tag) => `<span class="chip">${esc(tag)}</span>`).join("")}</div>` : ""}
      </div>

      <div class="block accent-purple">
        <div class="block-title">See also <span class="tag">capsules.see_also</span></div>
        ${data.see_also.length ? `<div class="stack" style="gap:8px">${data.see_also.map((link) => `
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:center">
            <span>${link.resolved ? `<a href="${href("/knowledge/item", { uri: link.uri })}">${esc(link.name)}</a>` : esc(link.name)}</span>
            ${link.resolved ? categoryChip(link.category || "uncategorised") : `<span class="pill amber">unresolved</span>`}
          </div>`).join("")}</div>` : `<div class="empty">No see-also links recorded for this record.</div>`}
        <div class="block-title" style="margin-top:20px">Stored edges</div>
        ${data.related_edges.length || data.inbound_edges.length ? `<div class="stack small" style="gap:6px">
          ${data.related_edges.map((edge) => `<div class="small mono">→ ${esc(edge.type)} ${esc(edge.destination_uri || "")}</div>`).join("")}
          ${data.inbound_edges.map((edge) => `<div class="small mono">← ${esc(edge.type)} ${esc(edge.source_uri || "")}</div>`).join("")}
        </div>` : `<div class="empty">No stored edges for this record.</div>`}
      </div>
    </div>

    <div class="block" style="margin-top:14px">
      <div class="block-title">Document <span class="tag">rql read ${esc(record.file_uri)}</span></div>
      ${data.content.available
        ? `<pre class="doc">${esc(data.content.text)}</pre>`
        : `<div class="empty">Document content unavailable: ${esc(data.content.error || "not indexed")}</div>`}
    </div>

    ${data.markdown_links.length ? `<div class="block" style="margin-top:14px">
      <div class="block-title">Document links <span class="tag">markdown_links</span></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Target</th><th>Text</th><th>Status</th><th>Line</th></tr></thead>
        <tbody>${data.markdown_links.map((link) => `<tr>
          <td class="mono small">${esc(link.destination_uri)}</td><td class="small">${esc(link.link_text || "")}</td>
          <td>${pill(link.status)}</td><td class="num">${fmt(link.start_line)}</td></tr>`).join("")}</tbody>
      </table></div></div>` : ""}`;
}

// --------------------------------------------------------------------- links

async function viewLinks(params, connections = false) {
  let collection = params.collection || "see_also";
  let query = params.q || "";
  let status = params.status || "";
  let page = Number(params.page || 1);
  const graphHost = `<div id="graph" class="conn-graph-host"><div class="conn-loading"><div class="ug-loader"><i></i><i></i><i></i></div><span>Laying out stored relationships…</span></div></div>`;
  APP.innerHTML = pageHead(connections ? "RepoQL Connections" : "Links & relationships", "Stored RepoQL relationships: see-also references, graph edges, composition and document links. These are not inferred dependencies.") +
    `${connections ? graphHost : ""}
     <div class="block-title conn-table-title">${connections ? "Relationship records" : ""}</div>
     <div class="toolbar">
       <div class="seg" id="link-tabs">
         ${Object.entries({ see_also: "See also", refers_to: "REFERS_TO", composition: "Composition", markdown: "Markdown links" })
          .map(([value, label]) => `<button data-collection="${value}" class="${value === collection ? "active" : ""}">${label}</button>`).join("")}
       </div>
       <input class="input wide" id="link-search" placeholder="Search source, target or record…" value="${esc(query)}">
       <select class="select" id="link-status">
         <option value="">All statuses</option>
         ${["resolved", "unresolved", "broken", "invalid"].map((value) => `<option value="${value}" ${value === status ? "selected" : ""}>${value}</option>`).join("")}
       </select>
       <span class="small muted" id="link-total"></span>
     </div>
     <div id="link-table" class="table-wrap"><div class="loading">Loading relationships…</div></div>
     <div id="link-pager"></div>
     ${connections ? "" : `<div style="margin-top:14px">${graphHost}</div>`}`;

  const next = sequencer();
  const load = async () => {
    const isCurrent = next();
    const data = await api(`/api/links?collection=${collection}&q=${encodeURIComponent(query)}&status=${encodeURIComponent(status)}&page=${page}&page_size=${connections ? 25 : 50}`);
    if (!isCurrent()) return;
    document.getElementById("link-total").textContent = `${fmt(data.total)} relationships`;
    const rows = data.rows.map((row) => {
      const source = row.source_name || row.source_uri;
      const target = row.target_name || row.target_uri || row.destination_uri;
      return `<tr>
        <td>${row.source_uri ? `<a class="mono small" href="${href("/knowledge/item", { uri: row.source_uri })}">${esc(source)}</a>` : esc(source)}
          <div class="small">${categoryChip(row.source_category)}</div></td>
        <td class="mono small">${esc(row.type || "—")}</td>
        <td>${row.target_uri ? `<a class="mono small" href="${href("/knowledge/item", { uri: row.target_uri })}">${esc(target)}</a>` : `<span class="mono small">${esc(target)}</span>`}
          ${row.target_category ? `<div class="small">${categoryChip(row.target_category)}</div>` : ""}</td>
        <td class="small">${esc(row.provenance || "—")}</td>
        <td>${row.status ? pill(row.status) : row.resolved === false ? `<span class="pill amber">unresolved</span>` : `<span class="pill green">stored</span>`}</td>
      </tr>`;
    }).join("");
    document.getElementById("link-table").innerHTML = `<table class="data">
      <thead><tr><th>Source</th><th>Type</th><th>Target</th><th>Provenance</th><th>Status</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="5" class="empty">No relationships match.</td></tr>`}</tbody></table>`;
    const pagerHost = document.getElementById("link-pager");
    pagerHost.innerHTML = "";
    pagerHost.appendChild(pagerBlock(data.page, data.page_size, data.total, (next) => {
      page = next;
      setParams({ page });
      load().catch((error) => toast("Links", error.message, "error"));
    }));
    const counts = data.counts || {};
    document.getElementById("link-tabs").dataset.counts = JSON.stringify(counts);
  };

  const loadGraph = async () => {
    const data = await api(`/api/links/graph?focus=${encodeURIComponent(params.focus || "")}`);
    renderGraph(document.getElementById("graph"), data);
  };

  const debounce = (fn, ms = 300) => {
    let handle;
    return (...args) => {
      clearTimeout(handle);
      handle = setTimeout(() => fn(...args), ms);
    };
  };

  document.getElementById("link-tabs").addEventListener("click", (event) => {
    const button = event.target.closest("[data-collection]");
    if (!button) return;
    collection = button.dataset.collection;
    page = 1;
    document.querySelectorAll("#link-tabs button").forEach((node) => node.classList.toggle("active", node === button));
    document.getElementById("link-total").textContent = "loading…";
    setParams({ collection, page: 1 });
    load().catch((error) => toast("Links", error.message, "error"));
  });
  document.getElementById("link-search").addEventListener("input", debounce((event) => {
    query = event.target.value.trim();
    page = 1;
    setParams({ q: query, page: 1 });
    load().catch(() => {});
  }));
  document.getElementById("link-status").addEventListener("change", (event) => {
    status = event.target.value;
    page = 1;
    setParams({ status, page: 1 });
    load().catch(() => {});
  });

  await Promise.all([load(), loadGraph().catch(() => {})]);
  schedule(() => load().catch(() => {}), 45000);
}

// ---------------------------------------------------------------- connectors

async function viewConnectors() {
  APP.innerHTML = pageHead('RepoQL Connectors', 'Source ingestion connectors · Separate from stored concept and code relationships') + `
    <div class="connectors-intro block">
      <div><span class="conn-kicker">EXTERNAL SOURCE INGESTION</span><h2>Connect outside knowledge to RepoQL</h2>
        <p class="muted">Connectors transform records from supported systems into material RepoQL can index and cite. They are not knowledge graph relationships or agent MCP connections.</p></div>
      <a class="btn" href="https://github.com/RepoQL/RepoQL/tree/main/plugins/repoql/skills/installing-connectors" target="_blank" rel="noopener noreferrer">Official connector guidance</a>
    </div>
    <div class="connector-toolbar toolbar"><input class="input wide" id="connector-search" type="search" placeholder="Filter installed connectors…" aria-label="Filter installed connectors"><button class="btn" id="connector-refresh" type="button">Refresh</button></div>
    <div id="connector-state" class="muted small" aria-live="polite">Reading installed RepoQL connector inventory…</div>
    <div id="connector-list" class="connector-grid"></div>
    <div class="block connector-reference"><div class="block-title">Connector lifecycle</div>
      <div class="connector-guide-grid"><div><strong>Install</strong><p class="muted small">Inspect the connector manifest and configure any required credentials privately on the RepoQL host.</p></div>
      <div><strong>Import</strong><p class="muted small">Import an external account or source through the connector into the host's index.</p></div>
      <div><strong>Verify</strong><p class="muted small">Check imported documents, update behaviour, and search results against source evidence.</p></div></div>
      <p class="muted small">Connector installation and credential changes are deliberately handled through the installed version of RepoQL and its <code>help:///skills/installing-connectors/SKILL.md</code> manual. This view is read only.</p>
    </div>`;
  const stateNode=document.getElementById('connector-state');
  const listNode=document.getElementById('connector-list');
  const input=document.getElementById('connector-search');
  const refresh=document.getElementById('connector-refresh');
  let connectors=[];
  const statusLabel=value=>{
    const key=String(value||'').toLowerCase();
    return {active:'Active',stale:'Stale',failed:'Failed',waiting:'Waiting',installed:'Installed',current:'Current (unverified)'}[key]||value||'Installed';
  };
  const draw=()=>{
    const q=input.value.trim().toLowerCase();
    const items=connectors.filter(c=>[c.name,c.id,c.version,c.description,c.status,c.import_state,c.freshness].join(' ').toLowerCase().includes(q));
    listNode.innerHTML=items.map(c=>`<article class="connector-card" data-active="${c.active===true?'true':'false'}">
      <div class="connector-card-top"><span class="connector-symbol" aria-hidden="true">◎</span><span class="connector-state-pill"${c.active===true?' data-active="true"':''}>${esc(statusLabel(c.status))}</span></div>
      <h3>${esc(c.name)}</h3><p class="muted small">${esc(c.description||'External source connector')}</p>
      <div class="connector-meta"><span>${esc(c.id||'RepoQL connector')}</span>${typeof c.files==='number'?`<span>${c.files.toLocaleString()} files</span>`:''}${c.version?`<span>v${esc(c.version)}</span>`:''}</div>
    </article>`).join('') || `<div class="empty connector-empty">${connectors.length?'No connectors match this search.':'No installed connectors reported by RepoQL.'}</div>`;
  };
  const load=async()=>{
    refresh.disabled=true;
    stateNode.textContent='Reading installed RepoQL connector inventory…';
    try{
      const result=await api('/api/connectors');
      if(!document.getElementById('connector-list'))return;
      if (result.available === false) throw new Error('Connector inventory unsupported');
      connectors=Array.isArray(result.connectors)?result.connectors:[];
      const active=Number.isInteger(result.active)?result.active:connectors.filter(c=>c.active===true).length;
      stateNode.textContent=`${active} active · ${connectors.length} installed connector${connectors.length===1?'':'s'} · ${result.source||'RepoQL host'} · read only`;
      draw();
    }catch(error){
      if(!document.getElementById('connector-list'))return;
      stateNode.textContent='Connector inventory unavailable on this installed RepoQL host.';
      listNode.innerHTML=`<div class="block connector-empty"><strong>Live inventory not available</strong><p class="muted small">The installed RepoQL CLI must support JSON connector enumeration. No installed connectors are inferred from imports or fabricated.</p></div>`;
    }finally{if(document.getElementById('connector-refresh'))refresh.disabled=false;}
  };
  input.addEventListener('input',draw);
  refresh.addEventListener('click',load);
  await load();
}

// -------------------------------------------------------------- bootstrapping

initNavigationUI();
captureSecret();
// window.__RQDASH_ACCESS__ is set by the server when a Cloudflare Access JWT
// vouched for this browser on the public hostname; no capability key is needed.
if (!state.token && !window.__RQDASH_ACCESS__) {
  showSignpost("This tab holds no dashboard key.");
} else {
  window.addEventListener("hashchange", route);
  route();
}

// ---------------------------------------------------------------- harness
// Ticket 789: Harness Control Center. Everything here is rendered from the
// harness telemetry store (existing kit ledgers ingested by
// harness_telemetry.py). No prompt, response, tool body or credential is
// available to this UI; missing measurements are never invented.

const HARNESS_RANGES = [["1h", "1h"], ["6h", "6h"], ["24h", "24h"], ["7d", "7d"], ["30d", "30d"], ["90d", "90d"]];

// Dashboard refresh (seconds) is the operator-controlled setting held
// server-side (Settings page). Every harness response carries the current
// value; views pick it up on their next scheduled load and apply it on their
// next remount. 30000 ms is only the pre-first-response default.
const HARNESS_DEFAULT_REFRESH_MS = 30000;
let harnessRefreshMs = HARNESS_DEFAULT_REFRESH_MS;
function applyHarnessRefresh(seconds) {
  const n = Number(seconds);
  if (Number.isFinite(n) && n >= 5 && n <= 600) harnessRefreshMs = n * 1000;
}
function harnessInterval() { return Math.max(5000, harnessRefreshMs); }

// Telemetry stores no prompt-derived titles: label a run by its structural kind.
function runLabel(run) {
  const kind = String(run.kind || "").trim();
  return kind ? kind + " run" : "(untitled run)";
}

function harnessRangeBar(path, params) {
  const current = params.range || "24h";
  return `<div class="toolbar">${HARNESS_RANGES.map(([value, label]) =>
    `<a class="btn small ${current === value ? "primary" : ""}" href="${href(path, { ...params, range: value })}">${label}</a>`).join("")}
    <span class="grow"></span><span class="muted mono" id="harness-updated"></span></div>`;
}

function ms(value) {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 90000) return `${(n / 1000).toFixed(1)} s`;
  const minutes = Math.round(n / 60000);
  if (minutes < 120) return `${minutes} min`;
  return `${(minutes / 60).toFixed(1)} h`;
}

function metricBlock(title, value, unit = "", tone = "", sub = "", link = null) {
  if (displayLabel(value, null) === null) return "";
  const body = `<div class="block ${link ? "link" : ""} ${tone ? `accent-${tone}` : ""}" ${link ? `data-href="${esc(link)}"` : ""}>
    <div class="block-title">${esc(title)}</div>
    <div class="metric ${tone}"><span class="value">${esc(value)}</span>${unit ? `<span class="unit">${esc(unit)}</span>` : ""}</div>
    ${sub ? `<div class="muted small">${esc(sub)}</div>` : ""}</div>`;
  return body;
}

function dataTable(columns, rows, renderRow, empty = "No data in this range.") {
  if (!rows || !rows.length) return `<div class="empty">${esc(empty)}</div>`;
  return `<div class="table-wrap"><table class="data"><thead><tr>${columns.map(c => `<th>${esc(c)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map(renderRow).join("")}</tbody></table></div>`;
}

// Rust state authority: the writer of run state since the 2026-10-25 cutover.
// Rendered fail-open — an unreachable service is shown as a status, never as a
// broken page, because the telemetry panels must keep working.
function rustAuthorityBlock(r) {
  if (!r || r.available === false) {
    return `<div class="block" style="margin-top:14px">
      <div class="block-title">State authority <span class="tag">rust</span> <span class="tag amber">unavailable</span></div>
      <p class="muted">${esc(r?.error || "not configured")} · expected at ${esc(r?.baseUrl || "the loopback authority service")}. Run state stays with the Rust authority; this panel only reports it.</p>
    </div>`;
  }
  const h = r.health || {};
  const a = r.authority || {};
  const runs = a.runs || [];
  const leases = a.activeLeases ?? 0;
  const journalRecords = runs.reduce((n, x) => n + Number(x.journalRecords || 0), 0);
  return `<div class="block" style="margin-top:14px">
    <div class="block-title">State authority <span class="tag green">rust</span> <span class="tag">${esc(a.transport || h.authorityTransport || "unix-peercred")}</span></div>
    <dl class="kv">
      <dt>Ownership</dt><dd class="ok">${esc(a.stateAuthority || h.stateAuthority || "rust")} owns run state · read-only dashboard surface</dd>
      <dt>Adopted runs</dt><dd>${fmt(a.managedRuns)} of ${fmt(a.totalRuns)} in the run tree</dd>
      <dt>Active leases</dt><dd class="${leases ? "ok" : ""}">${fmt(leases)}</dd>
      <dt>Committed journal records</dt><dd>${fmt(journalRecords)}</dd>
    </dl>
    ${runs.length ? dataTable(["Run", "State", "Rev", "Epoch", "Lease", "Journal"], runs.slice(0, 12), (x) => `<tr>
      <td class="mono">${esc(x.runId)}</td><td>${pill(x.state)}</td>
      <td class="mono">${fmt(x.rev)}</td><td class="mono">${fmt(x.epoch)}</td>
      <td>${x.leaseActive ? '<span class="tag green">held</span>' : '<span class="tag">free</span>'}</td>
      <td class="mono">${fmt(x.journalRecords)}</td></tr>`) : '<p class="muted">No run has been adopted by the Rust authority yet.</p>'}
  </div>`;
}

async function viewHarnessOverview(params) {
  const range = params.range || "24h";
  APP.innerHTML = pageHead("Harness Control Center", "Live state of the AI Orchestra harness: runs, agents, models, reviews and bounded telemetry health.") +
    harnessRangeBar("/harness", params) + `<div id="harness-body"><div class="loading">Reading harness telemetry…</div></div>`;
  const body = document.getElementById("harness-body");
  const next = sequencer();
  async function load() {
    const mine = next();
    const [o, h, rust] = await Promise.all([
      api(`/api/harness/overview?range=${encodeURIComponent(range)}`),
      api("/api/harness/health"),
      api("/api/harness/rust").catch((error) => ({ available: false, error: String(error?.message ?? error) })),
    ]);
    if (!mine()) return;
    applyHarnessRefresh(h?.dashboard_refresh_seconds ?? o?.telemetry?.dashboard_refresh_seconds);
    const t = o.telemetry || h || {};
    const health = h || t;
    const budgetPct = Number(health.budget_pct || 0);
    body.innerHTML = `
      <div class="grid cols-3">
        ${metricBlock("Active runs", fmt(o.active_runs), "", "cyan", "runs currently in flight")}
        ${metricBlock("Active agents", fmt(o.active_agents), "", "purple", "kit seats + live desktop sessions")}
        ${metricBlock("Desktop sessions", fmt(o.desktop_sessions), "", "cyan", "live Freebuff Desktop sessions")}
        ${metricBlock("Success rate", o.success_rate == null ? "—" : `${Math.round(o.success_rate * 100)}`, "%", "green", `${fmt(o.completed)} completed · ${fmt(o.failed)} failed`)}
        ${metricBlock("Median completion", ms(o.median_ms), "", "", `average ${ms(o.avg_ms)}`)}
      </div>
      ${rustAuthorityBlock(rust)}
      <div class="block" style="margin-top:14px">
        <div class="block-title">Telemetry health <span class="tag">${health.enabled ? "enabled" : "disabled"}</span></div>
        <dl class="kv">
          <dt>Collector last ingest</dt><dd class="${health.last_ingest ? "ok" : "err"}">${esc(relative(health.last_ingest))}</dd>
          <dt>Storage</dt><dd>${bytes(health.storage_bytes)} / ${bytes(health.budget_bytes)} (${budgetPct}%)</dd>
          <dt>Detail events retained</dt><dd>${fmt(health.events)} · oldest ${esc(relative(health.oldest_event))}</dd>
          <dt>Retention</dt><dd>${esc(String(health.detail_days))} d detail · ${esc(String(health.aggregate_days))} d aggregates</dd>
          <dt>Dropped / sampled out</dt><dd>${fmt(health.dropped_events)} / ${fmt(health.sampled_out)}</dd>
          <dt>Ingest errors</dt><dd class="${health.ingest_errors ? "err" : "ok"}">${fmt(health.ingest_errors)}</dd>
          <dt>Last error</dt><dd class="${health.last_error ? "err" : "ok"}">${esc(health.last_error || "none")}</dd>
        </dl>
        <div class="progress ${budgetPct > 90 ? "red" : budgetPct > 70 ? "purple" : "green"}"><span style="width:${Math.min(100, budgetPct)}%"></span></div>
      </div>
      <div class="block" style="margin-top:14px">
        <div class="block-title">Recent significant events</div>
        ${dataTable(["Time", "Category", "Event", "Detail", "Count"], o.alerts || [], (a) => `<tr>
          <td class="mono">${esc(relative(a.ts))}</td><td>${esc(a.kind || a.category)}</td>
          <td>${pill(a.severity || a.status)}</td><td class="wrap">${esc(a.detail || "")}</td>
          <td class="mono">${a.occurrences > 1 ? fmt(a.occurrences) : ""}</td></tr>`, "No significant events in this range.")}
      </div>`;
    const stamp = document.getElementById("harness-updated");
    if (stamp) stamp.textContent = `updated ${new Date().toLocaleTimeString("en-GB")}`;
  }
  await load();
  schedule(() => load().catch(() => {}), harnessInterval());
}

async function viewHarnessAgents() {
  APP.innerHTML = pageHead("Live Agents", "Active orchestra runs with their coordinator and worker seats, plus your Freebuff Desktop sessions.") +
    `<div id="harness-body"><div class="loading">Reading active runs…</div></div>`;
  const body = document.getElementById("harness-body");
  const next = sequencer();
  async function load() {
    const mine = next();
    const data = await api("/api/harness/agents");
    if (!mine()) return;
    const runs = data.runs || [];
    const sessions = data.sessions || [];
    if (!runs.length && !sessions.length) {
      body.innerHTML = `<div class="block"><div class="block-title">Nothing live right now</div>
        <p class="muted">No orchestra run is in flight and no Freebuff Desktop session was active in the last two hours.
        Historical runs remain in Execution History; start a desktop chat or a kit run and this page updates within 60 s.</p></div>`;
      return;
    }
    const sessionBlock = sessions.length ? `<div class="block accent-cyan" style="margin-bottom:14px">
      <div class="block-title">Freebuff Desktop <span class="tag">${sessions.length} session${sessions.length === 1 ? "" : "s"} · last 2 h</span></div>
      <div class="harness-tree">
        ${sessions.map((x) => `<div class="harness-node">
          <span class="node-dot"></span>
          <div><strong>${esc(x.harness || "freebuff")}</strong>
            <div class="muted small">${esc(x.model || "model not recorded")} · ${esc(x.agent_mode || "—")} · ${esc(x.execution_mode || "—")} · ${fmt(x.messages)} msgs</div>
            <div class="muted small mono">${esc(String(x.session_id).slice(0, 8))}${x.last_turn_outcome ? " · last turn " + esc(x.last_turn_outcome) : ""}</div></div>
          <span class="pill ${x.live ? "green" : "amber"}">${esc(x.live ? (x.state || "live") : "stale")}</span>
          <span class="muted mono small">${esc(relative(x.last_activity))}</span>
        </div>`).join("")}
      </div>
      <p class="muted small">Session metadata only — titles, prompts and message bodies are never read or stored.</p>
    </div>` : "";
    const runBlocks = runs.map((r) => {
      const started = Date.parse(r.started_at || "");
      const elapsed = Number.isNaN(started) ? null : Date.now() - started;
      const agents = r.agents || [];
      return `<div class="block ${r.stale ? "accent-amber" : "accent-cyan"}" style="margin-bottom:14px">
        <div class="block-title">${esc(r.run_id)} <span class="tag">${esc(r.mode || "mode?")} · ${r.stale ? "STALE" : "live"}</span></div>
        <div class="harness-title">${esc(r.title || runLabel(r))}</div>
        <div class="toolbar" style="margin-top:10px">
          ${pill(r.state)} ${pill("stage " + (r.stage || "—"))}
          <span class="muted mono">elapsed ${ms(elapsed)} · updated ${esc(relative(r.updated_at))}${r.stale ? " · no update for 15+ min" : ""}</span>
        </div>
        <div class="harness-tree">
          <div class="harness-node coordinator"><span class="node-dot"></span>
            <div><strong>coordinator</strong><div class="muted small">orchestrates · ${esc(r.roster || "default roster")}</div></div>
            <span class="pill cyan">${esc(r.stage || "—")}</span></div>
          ${agents.map((a) => `<div class="harness-node">
            <span class="node-dot"></span>
            <div><strong>${esc(a.agent)}</strong><div class="muted small">${esc(a.model || "model not recorded")} · ${esc(a.provider || "provider?")}</div></div>
            <span class="pill ${a.status === "error" ? "red" : a.status === "waiting" ? "amber" : "green"}">${esc(a.status)}</span>
            <span class="muted mono small">${ms(a.duration_ms)}</span></div>`).join("") || `<div class="muted small" style="padding-left:18px">no seats recorded yet</div>`}
        </div>
      </div>`;
    }).join("");
    body.innerHTML = sessionBlock + runBlocks;
  }
  await load();
  schedule(() => load().catch(() => {}), 15000);
}

async function viewHarnessRuns(params) {
  const query = { ...params };
  APP.innerHTML = pageHead("Execution History", "Searchable runs with stage timeline, review iterations and outcome.") + `
    <div class="toolbar">
      <input class="input wide" id="h-q" placeholder="search run id or title" value="${esc(params.q || "")}">
      <select class="select" id="h-status">${["", "active", "completed", "failed"].map(v => `<option value="${v}" ${params.status === v ? "selected" : ""}>${v || "any status"}</option>`).join("")}</select>
      <select class="select" id="h-mode">${["", "custom", "consult", "run"].map(v => `<option value="${v}" ${params.mode === v ? "selected" : ""}>${v || "any mode"}</option>`).join("")}</select>
      <input class="input" id="h-agent" placeholder="agent" value="${esc(params.agent || "")}">
      <input class="input" id="h-model" placeholder="model" value="${esc(params.model || "")}">
      <button class="btn primary" id="h-filter">Filter</button>
      <a class="btn" href="${href("/harness/runs", {})}">Reset</a>
    </div>
    <div id="harness-body"><div class="loading">Reading run history…</div></div>`;
  const apply = () => {
    const patch = { q: document.getElementById("h-q").value.trim(), status: document.getElementById("h-status").value,
      mode: document.getElementById("h-mode").value, agent: document.getElementById("h-agent").value.trim(),
      model: document.getElementById("h-model").value.trim(), range: params.range || "30d", page: "" };
    location.hash = href("/harness/runs", patch);
  };
  document.getElementById("h-filter").addEventListener("click", apply);
  document.getElementById("h-q").addEventListener("keydown", (e) => { if (e.key === "Enter") apply(); });
  const body = document.getElementById("harness-body");
  const data = await api(`/api/harness/runs?${new URLSearchParams(query).toString()}`);
  const page = Number(data.page || 1);
  body.innerHTML = dataTable(["Started", "Run", "Mode", "State", "Stage", "Duration", "Seats"], data.runs, (r) => {
    const a = Date.parse(r.started_at || ""), b = Date.parse(r.ended_at || "");
    const dur = !Number.isNaN(a) && !Number.isNaN(b) ? b - a : null;
    return `<tr class="clickable" data-href="${esc(href("/harness/run", { id: r.run_id }))}">
      <td class="mono">${esc(r.started_at || "—")}</td>
      <td><strong>${esc(r.run_id)}</strong><div class="muted small wrap">${esc(r.title || runLabel(r))}</div></td>
      <td>${esc(r.mode || "—")}</td><td>${pill(r.status)}</td><td>${esc(r.stage || "—")}</td>
      <td class="mono">${ms(dur)}</td><td class="mono">${esc(String(r.workers || ""))} seats</td></tr>`;
  });
  body.insertAdjacentHTML("beforeend", `<div class="pager"><div>${fmt(data.total)} runs · page ${page}</div><div class="pages">
    <button class="btn small" id="h-prev" ${page <= 1 ? "disabled" : ""}>Prev</button>
    <button class="btn small" id="h-next" ${page * data.page_size >= data.total ? "disabled" : ""}>Next</button></div></div>`);
  document.querySelectorAll("[data-href]").forEach((node) => node.addEventListener("click", () => { location.hash = node.dataset.href.replace(/^#/, ""); }));
  document.getElementById("h-prev")?.addEventListener("click", () => { location.hash = href("/harness/runs", { ...query, page: page - 1 }); });
  document.getElementById("h-next")?.addEventListener("click", () => { location.hash = href("/harness/runs", { ...query, page: page + 1 }); });
}

async function viewHarnessRun(params) {
  const id = params.id || "";
  APP.innerHTML = pageHead("Run detail", "One run's measured timeline. No prompts, responses or tool output are stored.") +
    `<div id="harness-body"><div class="loading">Reading ${esc(id)}…</div></div>`;
  const body = document.getElementById("harness-body");
  const d = await api(`/api/harness/run?id=${encodeURIComponent(id)}`);
  const r = d.run;
  const a = Date.parse(r.started_at || ""), b = Date.parse(r.ended_at || "");
  body.innerHTML = `
    <div class="block">
      <div class="block-title">${esc(r.run_id)} <span class="tag">${esc(r.mode || "")}</span></div>
      <div class="harness-title">${esc(r.title || runLabel(r))}</div>
      <dl class="kv">
        <dt>State</dt><dd>${pill(r.status)} ${esc(r.state || "")}</dd>
        <dt>Stage</dt><dd>${esc(r.stage || "—")}</dd>
        <dt>Started / ended</dt><dd>${esc(r.started_at || "—")} → ${esc(r.ended_at || "—")}</dd>
        <dt>Duration</dt><dd>${ms(!Number.isNaN(a) && !Number.isNaN(b) ? b - a : null)}</dd>
        <dt>Seats</dt><dd>${esc(String(r.workers || "—"))}</dd>
        <dt>Review iterations</dt><dd>${fmt(d.review_iterations)}</dd>
        <dt>Review correlation</dt><dd class="wrap">${esc(d.review_correlation)}</dd>
        <dt>Outcome</dt><dd>${pill(d.outcome)}</dd>
      </dl>
    </div>
    <div class="block" style="margin-top:14px"><div class="block-title">Stage timeline</div>
      ${dataTable(["Stage", "Title", "Started", "Duration"], d.stages, (s) => `<tr>
        <td class="mono">${esc(s.stage)}</td><td class="wrap">${esc(s.title || "")}</td>
        <td class="mono">${esc(relative(s.started_at))}</td><td class="mono">${ms(s.duration_ms)}</td></tr>`, "No stage transitions recorded for this run.")}
    </div>
    <div class="block" style="margin-top:14px"><div class="block-title">Events</div>
      ${dataTable(["Time", "Category", "Event", "Agent", "Status", "Detail"], d.events, (e) => `<tr>
        <td class="mono">${esc(e.ts)}</td><td>${esc(e.category)}</td><td>${esc(e.kind)}</td>
        <td>${esc(e.agent || "—")}</td><td>${pill(e.status || "")}</td><td class="wrap">${esc(e.detail || "")}</td></tr>`, "No events recorded.")}
    </div>`;
}

async function viewHarnessPerformance(params) {
  const range = params.range || "7d";
  APP.innerHTML = pageHead("Performance", "Measured completion, stage, model and tool latency. Missing samples are shown as missing, never estimated.") +
    harnessRangeBar("/harness/performance", params) + `<div id="harness-body"><div class="loading">Computing…</div></div>`;
  const body = document.getElementById("harness-body");
  async function load() {
  const p = await api(`/api/harness/performance?range=${encodeURIComponent(range)}`);
  if (p?.refresh_seconds) applyHarnessRefresh(p.refresh_seconds);
  const c = p.completion_ms;
  const cov = p.coverage || {};
  body.innerHTML = `
    ${cov.window_fully_covered === false ? `<div class="block accent-amber" style="margin-bottom:14px"><div class="block-title">Coverage note</div><p class="muted small">${esc(cov.note || "window extends past retained detail events; per-event metrics cover only the retained range")}${cov.earliest_event ? ` · earliest retained event ${esc(cov.earliest_event)}` : ""}.${fmt(cov.terminal_in_window)} terminal-status runs in range have no recorded end timestamp and are counted as ${fmt(p.completion_incomplete)} incomplete, never estimated from file times.</p></div>` : ""}
    <div class="grid cols-3">
      ${metricBlock("Completion p50", ms(c.p50), "", "cyan", `${fmt(c.samples)} completed runs measured${p.completion_incomplete ? ` · ${fmt(p.completion_incomplete)} without end timestamp` : ""}`)}
      ${metricBlock("Completion p95", ms(c.p95), "", "purple", "sample-size dependent")}
      ${metricBlock("Completion p99", ms(c.p99), "", "", "sample-size dependent")}
      ${metricBlock("Model latency p50", ms(p.model_latency_ms.p50), "", "blue", `${fmt(p.model_latency_ms.samples)} calls`)}
      ${metricBlock("Model latency p95", ms(p.model_latency_ms.p95), "", "amber", "provider-observed")}
      ${metricBlock("Tool latency", "unavailable", "", "amber", p.tool_latency_ms.unavailable_reason)}
      ${metricBlock("Fallbacks", fmt(p.fallbacks), "", "amber", "provider fallback events")}
      ${metricBlock("Retries", fmt(p.retries), "", "", `${ms(p.retry_attempt_ms)} retry-attempt time — ${esc(p.retry_definition)}`)}
      ${metricBlock("Review iterations", fmt(p.review_iterations), "", "purple", "Sol consult turns")}
    </div>
    <div class="block" style="margin-top:14px"><div class="block-title">Daily completed run throughput</div><div id="h-perf-chart" class="ob-chart"></div></div>
    <div class="grid cols-2" style="margin-top:14px">
      <div class="block"><div class="block-title">Throughput per day</div>
        ${dataTable(["Day", "Completed runs"], Object.entries(p.throughput_per_day || {}).sort(), ([day, n]) => `<tr><td class="mono">${esc(day)}</td><td>${fmt(n)}</td></tr>`, "No completions in range.")}
      </div>
      <div class="block"><div class="block-title">Stage durations</div>
        ${dataTable(["Stage", "Title", "Duration"], p.stage_duration_ms || [], (s) => `<tr><td class="mono">${esc(s.stage)}</td><td class="wrap">${esc(s.title || "")}</td><td class="mono">${ms(s.ms)}</td></tr>`, "No closed stage intervals recorded.")}
      </div>
    </div>
    <div class="block" style="margin-top:14px"><div class="block-title">Failed terminal runs</div>
      <div class="metric red"><span class="value">${fmt(p.failed_or_abandoned)}</span><span class="unit">runs</span></div>
      <p class="muted small">Failed terminal runs never enter completion duration or throughput. ${fmt(p.completion_incomplete)} further terminal runs closed without a recorded end timestamp and are excluded rather than estimated.</p>
      <div class="muted small">${esc(p.sample_note)}</div></div>`;
  sparkChart(document.getElementById('h-perf-chart'), Object.entries(p.throughput_per_day||{}).sort().map(([day,completed])=>({day,completed})), [{key:'completed',label:'Completed runs',color:'#47aaff'}]);
  }
  await load();
  schedule(() => load().catch((error)=>{if(document.getElementById("harness-body")) toast("Harness refresh",error.message,"error")}), harnessInterval());
}
async function viewHarnessEvents(params) {
  const query = { range: params.range || "24h", category: params.category || "", severity: params.severity || "", limit: 120 };
  APP.innerHTML = pageHead("Important Events", "Failures, repeated model errors, fallbacks, review rejections, interruptions and gate decisions. Identical events are collapsed with a count.") + `
    <div class="toolbar">
      <select class="select" id="h-cat">${["", "run", "agent", "model", "tool", "review", "operator"].map(v => `<option value="${v}" ${query.category === v ? "selected" : ""}>${v || "any category"}</option>`).join("")}</select>
      <select class="select" id="h-sev">${["", "info", "warn", "error", "critical"].map(v => `<option value="${v}" ${query.severity === v ? "selected" : ""}>${v || "any severity"}</option>`).join("")}</select>
      ${HARNESS_RANGES.map(([value, label]) => `<a class="btn small ${query.range === value ? "primary" : ""}" href="${href("/harness/events", { ...query, range: value })}">${label}</a>`).join("")}
      <button class="btn" id="h-apply">Apply</button>
    </div>
    <div id="harness-body"><div class="loading">Reading events…</div></div>`;
  document.getElementById("h-apply").addEventListener("click", () => {
    location.hash = href("/harness/events", { ...query, category: document.getElementById("h-cat").value, severity: document.getElementById("h-sev").value });
  });
  const body = document.getElementById("harness-body");
  const e = await api(`/api/harness/events?${new URLSearchParams(query).toString()}`);
  body.innerHTML = dataTable(["Time", "Category", "Event", "Severity", "Run", "Agent", "Detail", "Count"], e.events, (ev) => `<tr>
    <td class="mono">${esc(ev.ts)}</td><td>${esc(ev.category)}</td><td>${esc(ev.kind)}</td><td>${pill(ev.severity || "")}</td>
    <td class="mono">${ev.run_id ? `<a href="${href("/harness/run", { id: ev.run_id })}">${esc(ev.run_id)}</a>` : "—"}</td>
    <td>${esc(ev.agent || "—")}</td><td class="wrap">${esc(ev.detail || "")}</td><td class="mono">${ev.occurrences > 1 ? fmt(ev.occurrences) : ""}</td></tr>`, "No events match these filters.");
}

async function viewHarnessSettings(params) {
  APP.innerHTML = pageHead("Nannies and Settings", "Effective state of fleet nannies plus the dashboard's own bounded telemetry controls.") +
    `<div id="harness-body"><div class="loading">Reading settings…</div></div>`;
  const body = document.getElementById("harness-body");
  const [n, s] = await Promise.all([api("/api/harness/nannies"), api("/api/harness/settings")]);
  const settings = n.settings || {};
  body.innerHTML = `
    <div class="block"><div class="block-title">Telemetry controls</div>
      <p class="muted small">These controls affect only this dashboard's telemetry. Review, lease, asset-safety and compliance gates stay with their authoritative systems and are not configurable here.</p>
      <div class="table-wrap"><table class="data"><thead><tr><th>Setting</th><th>Requested</th><th>Effective</th><th>Control</th></tr></thead><tbody>
        ${Object.values(settings).map((row) => `<tr>
          <td><strong>${esc(row.label)}</strong><div class="muted small">${esc(row.key)}</div></td>
          <td class="mono">${esc(row.value)}</td><td class="mono wrap">${esc(row.effective)}</td>
          <td>${row.kind === "bool"
            ? `<button class="btn small" data-toggle="${esc(row.key)}" data-value="${row.value === "true" ? "false" : "true"}">${row.value === "true" ? "Disable" : "Enable"}</button>`
            : `<input class="input" style="min-width:90px" data-set="${esc(row.key)}" value="${esc(row.value)}">
               <button class="btn small" data-save="${esc(row.key)}">Save</button>`}</td></tr>`).join("")}
      </tbody></table></div>
      <div id="h-saved" class="muted small" style="margin-top:8px"></div>
      <div class="table-wrap" style="margin-top:12px"><table class="data"><thead><tr><th>When</th><th>Setting</th><th>Old</th><th>New</th><th>Actor</th></tr></thead><tbody>
        ${(s.audit || []).map((a) => `<tr><td class="mono">${esc(a.ts)}</td><td class="mono">${esc(a.key)}</td><td class="mono">${esc(a.old_value || "")}</td><td class="mono">${esc(a.new_value || "")}</td><td>${esc(a.actor || "")}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">No setting changes yet.</td></tr>`}
      </tbody></table></div>
    </div>
    <div class="block" style="margin-top:14px"><div class="block-title">Nannies</div>
      <p class="muted small">${esc(n.note)}</p>
      <div class="table-wrap"><table class="data"><thead><tr><th>Nanny</th><th>Purpose</th><th>Configured</th><th>Effective</th><th>Last trigger</th><th>Source</th></tr></thead><tbody>
        ${(n.nannies || []).map((x) => `<tr><td><strong>${esc(x.name)}</strong><div class="muted small">${esc(x.unit)}</div></td>
          <td class="wrap">${esc(x.purpose)}</td><td>${pill(x.configured)}</td><td>${pill(x.effective)}</td>
          <td class="mono small">${esc(x.last_trigger || "—")}</td><td class="mono small">${esc(x.source)}</td></tr>`).join("")}
      </tbody></table></div>
      <p class="muted small">Nanny timers are read-only here (${esc("managed by systemd unit files")}); no dashboard control can bypass a mandatory gate.</p>
      <div class="block-title" style="margin-top:16px">Last alerts</div>
      ${dataTable(["Nanny", "Severity", "When", "Detail"], n.last_alerts || [], (a) => `<tr><td>${esc(a.name)}</td><td>${pill(a.last_decision)}</td><td class="mono">${esc(relative(a.last_ts))}</td><td class="wrap">${esc(a.detail)}</td></tr>`, "No alerts recorded.")}
    </div>`;
  const save = async (key, value) => {
    const out = document.getElementById("h-saved");
    try {
      const r = await api("/api/harness/settings", { method: "POST", body: { key, value } });
      if (key === "dashboard_refresh_seconds") applyHarnessRefresh(r.value);
      out.textContent = `${key}: ${r.old} → ${r.value} (effective: ${r.effective})`;
      toast("Setting saved", `${key} = ${r.value}`);
      await viewHarnessSettings(params);
    } catch (e) {
      out.textContent = e.message;
      toast("Setting refused", e.message, "error");
    }
  };
  document.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", () => save(b.dataset.toggle, b.dataset.value)));
  document.querySelectorAll("[data-save]").forEach((b) => b.addEventListener("click", () => {
    const input = document.querySelector(`[data-set="${b.dataset.save}"]`);
    save(b.dataset.save, input ? input.value : "");
  }));
}

// Keep Office on the authenticated dashboard origin. A separate Office hostname
// requires its own Cloudflare login even when the dashboard already works.
async function viewKanban() {
  APP.innerHTML = pageHead('Kanban Board', 'Kanzo tasks shared with your coding agents over MCP') +
    `<section id="kanban-body"><div class="loading">Connecting to Kanzo…</div></section>`;
  const body = document.getElementById('kanban-body');
  try {
    // The authenticated API issues a narrowly scoped, HttpOnly iframe cookie.
    await api('/api/embed/kanzo/handshake');
  } catch (error) {
    if (!body.isConnected) return;
    body.innerHTML = `<div class="block accent-amber"><div class="block-title">Kanzo unavailable</div>
      <p class="muted">The local Kanzo board is not running or cannot be reached. Confirm the Kanzo service is listening on 127.0.0.1:4242.</p>
      <button id="kanban-retry" class="btn small">Retry</button></div>`;
    document.getElementById('kanban-retry')?.addEventListener('click', viewKanban);
    return;
  }
  if (!body.isConnected) return;
  body.innerHTML = `<div class="block"><div class="block-title">Kanzo <span class="tag green">connected</span></div>
    <iframe class="kanban-view-embed" title="Kanzo Kanban board" src="/embed/kanzo/"
      referrerpolicy="no-referrer" loading="eager"></iframe>
    <a class="native-panel-open" href="/embed/kanzo/" target="_blank" rel="noopener noreferrer">Open Kanzo in a separate tab</a></div>`;
}

async function viewOffice() {
  APP.innerHTML = pageHead("Claude Office view", "Live office scene via protected HTTPS, on or off your home network.") +
    `<div id="office-body"><div class="loading">Probing office…</div></div>`;
  const body = document.getElementById("office-body");
  let st = { available: false };
  try { st = await api("/api/harness/office"); } catch {}
  if (st.available !== true) {
    body.innerHTML = `<div class="block"><div class="block-title">Claude Office <span class="tag amber">unavailable</span></div>
      <p class="muted">${esc(st.reason || "not reachable on local port 8001")}</p></div>`;
    return;
  }
  const frame_src = st.embed_url;
  if (!frame_src) {
    body.innerHTML = `<div class="block"><div class="block-title">Office <span class="tag amber">no launch URL</span></div>
      <p class="muted">Set CLAUDE_OFFICE_EMBED_URL on the dashboard service first.</p></div>`;
    return;
  }
  await api('/api/embed/office/handshake');
  const frame = `<iframe class="office-view-embed" title="Claude Office live view" src="${esc(frame_src)}"
      allow="clipboard-write" referrerpolicy="no-referrer" loading="lazy"></iframe>`;
  body.innerHTML = `
    <div class="block">
      <div class="block-title">Office <span class="tag green">live</span>
        <span style="margin-left:auto"></span>
        <a class="btn small" href="${esc(frame_src)}" target="_blank" rel="noopener noreferrer">Open in new tab</a>
      </div>
      ${frame}
      <div class="muted small" style="margin-top:10px" id="office-note">
        Uses this dashboard session through Cloudflare. No second Office login or local-network access is needed.
        If the viewer fails to load, press Retry.
        <button id="office-retry" class="btn small" style="margin-left:8px">Retry</button>
      </div>
    </div>`;
  document.getElementById("office-retry")?.addEventListener("click", () => viewOffice());
}

// Unified Rust data plane UI, inherits authenticated api() and existing routing.

// Unified Systems: bounded browser graph, Tencent management, fleet usage.
// No external CDN or browser-side upstream credentials.
async function viewUnifiedGraph() {
  const NET_ICON='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="6" r="2.2"/><circle cx="18" cy="5" r="2.2"/><circle cx="12" cy="13" r="2.6"/><circle cx="5" cy="19" r="2.2"/><circle cx="19" cy="18" r="2.2"/><path d="M6.8 7.2 10.3 11.4M16.3 6.6 13.6 11M7 17.9l3-3M14.5 14.6l3 2.4"/></svg>';
  const BRAIN_ICON='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3.5a3 3 0 0 0-3 3 3 3 0 0 0-2.5 4.6A3.2 3.2 0 0 0 5 17a3 3 0 0 0 4 2.6V3.5z"/><path d="M15 3.5a3 3 0 0 1 3 3 3 3 0 0 1 2.5 4.6A3.2 3.2 0 0 1 19 17a3 3 0 0 1-4 2.6V3.5z"/><path d="M9 9H7.2M9 14H6.8M15 9h1.8M15 14h2.2"/></svg>';
  APP.innerHTML=`<section class="ug-hero">
      <div class="ug-hero-copy"><span class="arch-eyebrow">Unified systems · Live</span><h1>Live memory graph</h1>
        <p>RepoQL knowledge and Tencent MemoryCore records in one read-through network. Select any node or connection to inspect its real linked records; annotations change dashboard labels only, never the source.</p></div>
      <div class="graph-stats ug-stats" id="ug-stats" aria-live="polite">
        <div><span class="graph-stat-number">—</span><span>Nodes</span></div><div><span class="graph-stat-number">—</span><span>Connections</span></div><div><span class="graph-stat-number">—</span><span>Sources online</span></div></div>
    </section>
    <div class="ug-toolbar graph-controls">
      <div class="ug-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>
        <input id="ug-search" class="input wide" type="search" placeholder="Find a topic, entity or relationship" aria-label="Search graph"></div>
      <div class="ug-chips" role="group" aria-label="Sources">
        <label class="graph-toggle ug-chip rq"><input type="checkbox" id="ug-repoql" checked><i></i>RepoQL</label>
        <label class="graph-toggle ug-chip tx"><input type="checkbox" id="ug-tencent" checked><i></i>Tencent</label>
        <label class="graph-toggle ug-chip mem"><input type="checkbox" id="ug-memories"><i></i>Memories</label>
        <label class="graph-toggle ug-chip cross"><input type="checkbox" id="ug-cross" checked><i></i>Cross-system</label>
      </div>
      <div class="ug-viz" id="ug-mode" role="radiogroup" aria-label="Visualisation">
        <button type="button" role="radio" class="ug-viz-btn" data-mode="network" aria-checked="false">${NET_ICON}<span>Network</span></button>
        <button type="button" role="radio" class="ug-viz-btn" data-mode="neural" aria-checked="true">${BRAIN_ICON}<span>Brain</span></button>
        <i class="ug-viz-glider" aria-hidden="true"></i>
      </div>
      <div class="ug-tools">
        <label class="ug-limit"><span>Nodes</span><select class="select" id="ug-limit" aria-label="Max graph nodes"><option>250</option><option selected>500</option><option>1000</option><option>1500</option></select></label>
        <div class="ug-zoom" role="group" aria-label="Zoom">
          <button class="btn" id="ug-zoom-out" aria-label="Zoom out">−</button><button class="btn" id="ug-fit" aria-label="Fit network">Fit</button><button class="btn" id="ug-zoom-in" aria-label="Zoom in">+</button>
        </div>
        <button class="btn primary" id="ug-reload">↻ Refresh</button>
      </div>
    </div>
    <div class="unified-graph-layout">
      <div class="graph-stage">
        <canvas id="ug-canvas" class="unified-graph-canvas" tabindex="0" role="img" aria-label="Interactive network. Select any node or link to inspect relationships. Drag to pan, pinch with two fingers or scroll to zoom."></canvas>
        <div class="ug-legend" aria-hidden="true"><span class="rq"><i></i>RepoQL</span><span class="tx"><i></i>Tencent</span><span class="mem"><i></i>Memories</span><span class="cross"><i></i>Cross-system link</span></div>
        <div class="ug-loading" id="ug-loading" role="status"><div class="ug-loader"><i></i><i></i><i></i></div><strong>Mapping knowledge network…</strong><span>Reading RepoQL and Tencent MemoryCore. A cold load can take around 10 seconds.</span></div>
        <p class="graph-touch-help ug-help">Drag to pan · scroll or pinch to zoom · tap a node to inspect · Esc clears</p>
      </div>
      <aside class="graph-side"><section class="block graph-details" id="ug-detail" aria-label="Relationship inspector"><div class="ug-empty-insp"><div class="ug-empty-orb"></div><strong>Nothing selected</strong><span>Select a node or connection in the graph, or pick a topic below.</span></div></section>
      <section class="block"><div class="block-title">Source health <span class="muted small" id="ug-info">Loading…</span></div><div id="ug-sources" class="graph-source-list muted">Checking…</div></section></aside>
    </div>
    <div class="block"><div class="block-title">Explore visible topics <span class="tag" id="ug-visible-count"></span></div><div class="unified-node-list" id="ug-results"></div></div>`;
  const el=id=>document.getElementById(id);
  let raw={nodes:[],edges:[],sources:[]}, graph=raw, annotations={}, active=null, disposed=false, refreshing=false;
  const sourceChecks=()=>['repoql','tencent','memories'].filter(k=>el('ug-'+k)?.checked);
  const alive=()=>!disposed&&Boolean(el('ug-canvas'));
  const edgeKey=e=>'edge:'+String(e.id||`${e.source}|${e.type||'link'}|${e.target}`);
  function annotated(data){return {...data,
    nodes:(data.nodes||[]).map(n=>({...n,display_label:annotations[n.id]?.display_label||n.label,annotation_notes:annotations[n.id]?.notes||''})),
    edges:(data.edges||[]).map(e=>({...e,annotation_notes:annotations[edgeKey(e)]?.notes||'',display_label:annotations[edgeKey(e)]?.display_label||e.type}))};}
  // Brain is the default (operator 2026-10-26); an explicit later choice persists under the v2 key.
  let initialMode='neural';try{if(localStorage.getItem('repoql.graph.mode.v2')==='network')initialMode='network';}catch{}
  const setModeUI=(mode)=>{el('ug-mode').dataset.active=mode;el('ug-mode').querySelectorAll('[data-mode]').forEach(b=>{const on=b.dataset.mode===mode;b.setAttribute('aria-checked',String(on));b.tabIndex=on?0:-1;});};
  setModeUI(initialMode);
  const viewer=createKnowledgeGraph(el('ug-canvas'),{mode:initialMode,onSelect:(node,edges,edge)=>{
    active=node?{kind:'node',id:node.id}:edge?{kind:'edge',id:edgeKey(edge)}:null;
    renderInspector(node,edge);
  }});
  function renderInspector(node,edge){const area=el('ug-detail');if(!area)return;
    if(!node&&!edge){area.innerHTML='<div class="ug-empty-insp"><div class="ug-empty-orb"></div><strong>Nothing selected</strong><span>Select a node or connection in the graph, or pick a topic below.</span></div>';return;}
    const item=node||edge,key=node?node.id:edgeKey(edge),notes=annotations[key]||{},label=notes.display_label||'',
      caption=node?(node.display_label||node.label):(edge.display_label||edge.type||'Relationship');
    const connections=node?relationshipDetails(viewer.getVisible(),node.id):[];
    const edgesById=new Map(viewer.getVisible().edges.map(e=>[edgeKey(e),e]));
    const neighborRows=connections.sort((a,b)=>String(a.type).localeCompare(String(b.type))).slice(0,120).map((conn)=>{
      const other=conn.other;
      return `<div class="graph-connection"><button class="graph-jump" data-jump="${esc(conn.otherId)}">${esc(other?.display_label||other?.label||conn.otherId)}</button>
        <span class="graph-relationship-type">${esc(conn.direction)} · ${esc(conn.type||'connected')}</span>
        <button class="btn small" data-edge="${esc(edgeKey(conn))}" aria-label="Inspect relationship">Inspect</button></div>`;
    });
    const endpoints=edge?`<div class="graph-edge-endpoints"><button class="btn small" data-jump="${esc(edge.source)}">${esc(viewer.getVisible().nodes.find(n=>n.id===edge.source)?.display_label||edge.source)}</button>
      <span>→ ${esc(edge.type||'linked')} →</span><button class="btn small" data-jump="${esc(edge.target)}">${esc(viewer.getVisible().nodes.find(n=>n.id===edge.target)?.display_label||edge.target)}</button></div>`:'';
    const source=node?node.source_system:edge.source_system;
    const external=(node?.source_system==='repoql'||node?.source_system==='memories')?`<a class="btn small" href="${href('/knowledge/item',{uri:node.source_id})}">Open authoritative RepoQL record</a>`:
      node?.source_system==='tencent'?'<a class="btn small" href="#/unified/tencent">Tencent memory control</a>':'';
    area.innerHTML=`<div class="block-title">${node?'Topic':'Relationship'} inspector</div>
      <h2 class="inspector-title">${esc(caption)}</h2><div class="inspector-meta">${pill(source)} ${node?categoryChip(node.category):pill(edge.verified?'verified':'source relationship')}</div>
      <p class="muted small wrap">${esc(node?.source_id||edge.id||key)}</p>
      ${node?`<p class="small">${fmt(connections.length)} visible connected topics. Click a relationship below to inspect its direction and provenance.</p>`:''}
      ${endpoints}
      <p class="small">Provenance: <span class="mono">${esc(item.provenance||'source API')}</span></p>
      ${external}
      ${node?`<div class="graph-connection-list">${neighborRows.join('')||'<p class="muted small">No visible links. Raise the node limit or enable the other source if the graph is sampled.</p>'}</div>${connections.length>120?'<p class="muted small">Showing first 120 links.</p>':''}`:''}
      <div class="graph-edit"><div class="block-title">Visual annotation</div><p class="muted small">Changes the dashboard label and notes only. Native RepoQL/Tencent data is not altered.</p>
      <label for="ug-edit-label">Display label</label><input id="ug-edit-label" class="input" maxlength="150" value="${esc(label)}" placeholder="Optional dashboard label">
      <label for="ug-edit-note">Notes</label><textarea id="ug-edit-note" rows="3" maxlength="2500" placeholder="Optional dashboard notes">${esc(notes.notes||'')}</textarea>
      <div class="toolbar"><button id="ug-save" class="btn primary">Save annotation</button><button id="ug-delete" class="btn small" ${!notes.revision?'disabled':''}>Clear annotation</button></div></div>`;
    area.querySelectorAll('[data-jump]').forEach(b=>b.addEventListener('click',()=>viewer.focus(b.dataset.jump)));
    area.querySelectorAll('[data-edge]').forEach(b=>b.addEventListener('click',()=>viewer.focusEdge(edgesById.get(b.dataset.edge)?.id)));
    const mutate=async(remove)=>{const payload={id:key,expected_revision:notes.revision||0,display_label:el('ug-edit-label').value,
      notes:el('ug-edit-note').value,delete:remove,confirm:'SAVE GRAPH ANNOTATION'};
      try{const result=await api('/api/graph/annotations',{method:'POST',body:payload});if(!alive())return;
        if(result?.annotation)annotations[key]=result.annotation;else delete annotations[key];
        graph=annotated(raw);viewer.update(graph);applyFilters(false);
        if(node)viewer.focus(node.id);else viewer.focusEdge(edge.id);
        toast('Annotation',remove?'Annotation cleared':'Dashboard annotation saved');
      }catch(error){if(alive())toast('Annotation',error.message,'error')}};
    el('ug-save').addEventListener('click',()=>mutate(false));
    el('ug-delete').addEventListener('click',()=>mutate(true));
  }
  function applyFilters(fit=false){if(!alive())return;
    viewer.filter({sources:sourceChecks(),cross:el('ug-cross').checked,query:el('ug-search').value});
    const filtered=viewer.getVisible();if(fit)viewer.fit();
    el('ug-visible-count').textContent=`${fmt(filtered.nodes.length)} topics shown`;
    const ranked=[...filtered.nodes].sort((a,b)=>Number(b.degree||0)-Number(a.degree||0));
    el('ug-results').innerHTML=ranked.slice(0,90).map(n=>`<button class="btn small graph-result" data-node="${esc(n.id)}"><span class="result-dot ${n.source_system==='tencent'?'tx':n.source_system==='memories'?'mem':'rq'}"></span>${esc(n.display_label||n.label)}</button>`).join('')||'<span class="muted small">No matching topics. Adjust search or filters.</span>';
    el('ug-results').querySelectorAll('[data-node]').forEach(b=>b.addEventListener('click',()=>viewer.focus(b.dataset.node)));
  }
  const loading=(on,msg)=>{const box=el('ug-loading');if(!box)return;box.classList.toggle('show',on);box.classList.toggle('error',Boolean(msg));
    if(msg){box.querySelector('strong').textContent='Graph unavailable';box.querySelector('span').textContent=msg;}};
  // A toggle (or limit change) made while a request is in flight must not be lost: it is coalesced
  // here and the graph is fetched again with the latest checkbox/limit once the request settles.
  let loadPending=false;
  async function load(){if(!alive())return;if(refreshing){loadPending=true;return;}refreshing=true;el('ug-reload').disabled=true;
    if(!raw.nodes?.length)loading(true);
    try{const [data,meta]=await Promise.all([api('/api/unified/graph?'+new URLSearchParams({repoql:'true',tencent:'true',memories:el('ug-memories').checked?'true':'false',limit:el('ug-limit').value}),{timeoutMs:80000}),
      api('/api/graph/annotations').catch(()=>({annotations:{}}))]);
      if(!alive())return;if(data?.available===false)throw new Error(data.error||'Unified graph unavailable');
      annotations=meta.annotations||{};raw=data;graph=annotated(raw);viewer.update(graph);applyFilters(true);
      el('ug-info').textContent=`Updated ${relative(data.retrieved_at)}${data.truncated?' · sampled graph':''}`;
      el('ug-stats').innerHTML=`<div><span class="graph-stat-number">${fmt(data.nodes?.length)}</span><span>Nodes</span></div>
        <div><span class="graph-stat-number">${fmt(data.edges?.length)}</span><span>Connections</span></div>
        <div><span class="graph-stat-number">${fmt((data.sources||[]).filter(s=>s.available).length)} / ${fmt((data.sources||[]).length)}</span><span>Sources online</span></div>`;
      el('ug-sources').innerHTML=(data.sources||[]).map(s=>`<div class="graph-source-row"><span>${esc(s.name)}</span>${pill(s.available?'online':'unavailable')}</div>${!s.available?`<p class="muted small">${esc(s.error||'No response from source')}</p>`:''}`).join('')||'No source information';
      if(active){if(active.kind==='node')viewer.focus(active.id);else viewer.focusEdge(active.id.replace(/^edge:/,''));}
      loading(false);
    }catch(error){if(alive()&&!raw.nodes?.length)loading(true,error.message||'Unified graph unavailable');throw error;}
    finally{refreshing=false;if(alive()){el('ug-reload').disabled=false;if(loadPending){loadPending=false;load().catch(e=>{if(alive())toast('Graph',e.message,'error')});}}}
  }
  for(const id of ['ug-repoql','ug-tencent','ug-cross'])el(id).addEventListener('change',()=>applyFilters(true));
  el('ug-search').addEventListener('input',()=>applyFilters(true));
  el('ug-limit').addEventListener('change',()=>load().catch(e=>{if(alive())toast('Graph',e.message,'error')}));
  // Memories are fetched only while their option is on (thousands of linkless files): a toggle refetches.
  el('ug-memories').addEventListener('change',()=>load().catch(e=>{if(alive())toast('Graph',e.message,'error')}));
  el('ug-reload').addEventListener('click',()=>load().catch(e=>{if(alive())toast('Graph',e.message,'error')}));
  el('ug-fit').addEventListener('click',()=>viewer.fit());
  el('ug-zoom-in').addEventListener('click',()=>viewer.zoomBy(1.3));
  el('ug-zoom-out').addEventListener('click',()=>viewer.zoomBy(1/1.3));
  const chooseMode=(mode)=>{setModeUI(mode);viewer.setMode(mode);try{localStorage.setItem('repoql.graph.mode.v2',mode)}catch{}};
  el('ug-mode').addEventListener('click',e=>{const b=e.target.closest('button[data-mode]');if(b)chooseMode(b.dataset.mode)});
  el('ug-mode').addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();
    const next=el('ug-mode').dataset.active==='neural'?'network':'neural';chooseMode(next);el('ug-mode').querySelector(`[data-mode="${next}"]`)?.focus();});
  state.cleanup=()=>{disposed=true;viewer.dispose()};
  await load().catch(e=>{if(alive())toast('Graph',e.message,'error')});schedule(()=>load().catch(e=>{if(alive())toast('Graph refresh',e.message,'error')}),60000);
}

// Embed the original upstream applications instead of reproducing their controls.
// URLs come only from authenticated server configuration (never query parameters).
async function viewNativePanel(kind) {
  const tencent = kind === 'tencent';
  const name = tencent ? 'Tencent Control Panel' : 'RepoQL Control Panel';
  APP.innerHTML = pageHead(name, 'Original application embedded without modifying its controls or credentials.') +
    `<section id="native-panel-host" class="native-panel-shell"><div class="loading">Loading native panel configuration…</div></section>`;
  const host = document.getElementById('native-panel-host');
  const config = await api('/api/embed/panels');
  const target = config?.[kind];
  if (!host?.isConnected) return;
  if (!target?.configured || !target.url) {
    host.innerHTML = `<div class="block accent-amber"><div class="block-title">Native panel not configured</div>
      <p class="muted small">Configure the authenticated HTTPS or existing same-origin embed URL on the dashboard service. The original application and its login remain authoritative.</p></div>`;
    return;
  }
  if (kind === 'repoql' || kind === 'tencent') {
    // Establish a short-lived HttpOnly navigation cookie through the existing
    // authenticated API call. An iframe cannot attach the sessionStorage bearer.
    try {
      await api('/api/embed/' + kind + '/handshake');
    } catch (error) {
      if (host.isConnected) host.innerHTML = `<div class="block accent-amber"><div class="block-title">${esc(name)} login unavailable</div><p class="muted small">The dashboard could not establish the native panel session. Check the upstream service and its proxy configuration. No manual token entry is needed.</p></div>`;
      return;
    }
    if (!host.isConnected) return;
  }
  // Tencent runs in its own document. We cannot inject a theme into a
  // cross-origin iframe, so use a reversible, presentation-only dark filter.
  // The upstream application, credentials and requests remain untouched.
  const themeKey = 'repoql.tencent.force_dark';
  let tencentDark = true;
  if (tencent) {
    try { tencentDark = localStorage.getItem(themeKey) !== 'false'; } catch {}
    const themeBar = document.createElement('div');
    themeBar.className = 'tencent-theme-bar';
    const themeLabel = document.createElement('label');
    themeLabel.className = 'tencent-theme-switch';
    const themeToggle = document.createElement('input');
    themeToggle.type = 'checkbox';
    themeToggle.id = 'tencent-force-dark';
    themeToggle.checked = tencentDark;
    themeToggle.setAttribute('aria-label', 'Force dark appearance for Tencent panel');
    const labelText = document.createElement('span');
    labelText.textContent = 'Dark appearance';
    const hint = document.createElement('span');
    hint.className = 'tencent-theme-hint';
    hint.textContent = 'Visual filter only · charts and images may change colour';
    themeLabel.append(themeToggle, labelText);
    themeBar.append(themeLabel, hint);
    host.replaceChildren(themeBar);
    themeToggle.addEventListener('change', () => {
      tencentDark = themeToggle.checked;
      const currentFrame = host.querySelector('.native-panel-frame');
      currentFrame?.classList.toggle('tencent-dark-forced', tencentDark);
      try { localStorage.setItem(themeKey, String(tencentDark)); } catch {}
    });
  }
  const frame = document.createElement('iframe');
  frame.title = name;
  frame.className = 'native-panel-frame';
  if (tencent && tencentDark) frame.classList.add('tencent-dark-forced');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('loading', 'eager');
  frame.src = target.url;
  if (tencent) host.appendChild(frame);
  else host.replaceChildren(frame);
  const nav = document.createElement('a');
  nav.href = target.url;
  nav.target = '_blank';
  nav.rel = 'noopener noreferrer';
  nav.className = 'native-panel-open';
  nav.textContent = 'Open original panel in a separate tab';
  // Available if the upstream refuses framing (CSP, cookies or authentication).
  host.appendChild(nav);
}
async function viewTencentNative() { return viewNativePanel('tencent'); }
async function viewRepoqlNative() { return viewNativePanel('repoql'); }

// Live OpenChamber invocation coverage is intentionally not added to Orchestra
// ledger totals: the same underlying model call may appear in both sources.
function renderOpenChamberCoverage(payload, selectedDays = 90) {
  if(payload?.available===false) return `<p class="muted">${esc(payload.reason||'No OpenChamber snapshot')}</p>`;
  if(!payload||payload.schema!=='openchamber-coverage/1') return '<p class="muted">OpenChamber summary unavailable</p>';
  const period=payload.windows?.[String(selectedDays)] || payload;
  const total=period.totals||{};
  const rows=Object.entries(period.by_provider||{}).sort((a,b)=>Number(b[1].tokens||0)-Number(a[1].tokens||0));
  return `<p class="small">All OpenChamber assistant calls, including direct sessions. Independent coverage view, not added to Orchestra or Freebuff sums because overlapping calls are not independently identifiable.</p>
    <div class="grid cols-3">
      ${metricBlock('OpenChamber calls',fmt(total.calls),'',"cyan",`${fmt(total.missing_token_calls)} without exact primary receipts`)}
      ${metricBlock('Measured tokens',fmt(total.tokens),'',"purple",`${fmt(total.measured_calls)} measured calls; five OpenChamber components`)}
      ${metricBlock('Unmeasured calls',fmt(total.missing_token_calls),'',"",'No provider token receipt; excluded from measured tokens')}
    </div><p class="muted small">Snapshot ${esc(payload.captured_at)} · selected ${esc(selectedDays)} days · ${esc(payload.timezone)} · all-provider direct session view (90-day retained source).</p>
    ${dataTable(['Provider','Calls','With tokens','Total tokens','Unmeasured'],rows,([name,r])=>`<tr><td>${esc(displayLabel(name, 'Unattributed'))}</td><td>${fmt(r.calls)}</td><td>${fmt(r.measured_calls)}</td><td>${fmt(r.tokens)}</td><td>${fmt(r.missing_token_calls)}</td></tr>`,'No sources measured')}`;
}

async function viewUnifiedUsage() {
  APP.innerHTML=pageHead('Fleet AI Usage', 'Measured tokens and source coverage. Financial estimates are not displayed.')+`
    <div class="unified-topline"><span class="live-beacon"><i></i> FLEET TELEMETRY</span><span class="muted small">Measured receipts only · no inferred tokens</span></div>
    <div class="toolbar"><select id="usage-period" class="select"><option value="1">1 day</option><option value="7">7 days</option><option value="30" selected>30 days</option><option value="90">90 days</option></select><button id="usage-reload" class="btn primary">Refresh</button><span id="usage-age" class="muted small"></span></div>
    <div id="usage-summary" class="grid cols-3"></div>
    <div class="block" style="margin-top:14px"><div class="block-title">Daily input and output tokens</div><div id="usage-token-chart" class="ob-chart"></div></div>
    <details class="block" style="margin-top:14px"><summary>OpenChamber provider breakdown · separate coverage</summary><div id="usage-openchamber">Loading source coverage…</div></details>
    <details class="block" id="fb-details" style="margin-top:14px">
      <summary>Freebuff token breakdown and receipts</summary>
      <p class="muted small">Included Freebuff usage, not API expenditure. Cached input is already inside input; fresh input = input − cached (clamped). Total = input + output. Reasoning is a subset of output and is never added again. This panel is Freebuff-only; the fleet totals above include every source.</p>
      <div id="fb-summary" class="grid cols-3"></div>
      <div class="toolbar" style="margin-top:12px"><select id="fb-host" class="select"><option value="all">All Freebuff hosts</option></select><select id="fb-model" class="select"><option value="all">All models</option></select><span id="fb-count" class="muted small"></span></div>
      <div class="grid cols-2" style="margin-top:12px">
        <div class="block"><div class="block-title">Daily Freebuff tokens (filtered)</div><div id="fb-chart" class="ob-chart"></div></div>
        <div class="block"><div class="block-title">Receipt coverage</div><div id="fb-coverage"></div></div>
      </div>
      <details class="block" style="margin-top:12px"><summary>Recent Freebuff receipts</summary><div class="table-wrap"><div id="fb-events"></div></div></details>
      <p class="muted small" style="margin-top:12px"><strong>Receipt limitations.</strong> Some runs have no provider receipt or incomplete token measurements, so totals may understate usage. Filters and charts cover all matching receipts; the table shows only the newest 50. Cached input is already inside input; reasoning is already inside output. Missing values are not estimated.</p>
    </details>
    <details class="block" style="margin-top:14px"><summary>Freebuff allowance · not tokens</summary><div id="fb-allowance"></div></details>
    <details class="block" style="margin-top:14px"><summary>Source coverage and collection health</summary>
      <p class="muted small">Sol consultations run through CatGPT: their thinking tokens are free and unmetered, and CatGPT send/receive receipts are not counted as model or Codex Pro token usage. Sol review activity is reported by Harness telemetry.</p><div id="usage-sources"></div></details>
    <details class="block" style="margin-top:14px"><summary>Recent token receipts</summary><div class="table-wrap"><div id="usage-events"></div></div></details>`;
  let disposed=false,seq=0;
  const reportedLabel=v=>displayLabel(v);
  const box=(label,value,sub='')=>`<div class="block usage-stat"><div class="block-title">${esc(label)}</div><div class="unified-metric">${esc(value)}</div><div class="muted small">${esc(sub)}</div></div>`;
  const available=()=>!disposed&&document.getElementById('usage-summary')!==null;
  const sum=(rows,key)=>{let value=0,seen=0;for(const row of rows){const n=numeric(row[key]);if(n!==null){value+=n;seen++;}}return {value:seen?value:null,seen};};
  let fbData=null, fbSeq=0;
  function renderAllowance(a){
    const target=document.getElementById('fb-allowance');if(!target)return;
    if(!a||a.available===false){target.innerHTML=`<p>${pill('unavailable')} ${esc(a?.error||'allowance source unavailable')}</p><p class="muted small">Freebucks are allowance units, not tokens or money. Nothing is inferred.</p>`;return;}
    const f=a.freebucks||{};
    target.innerHTML=`<div class="grid cols-3">${box('Freebucks balance',fmt(f.balance),'Allowance units, not money')}${box('Daily remaining',fmt(f.dailyRemaining),'Resets '+reportedLabel(f.dailyResetAt))}${box('Wallet',fmt(f.walletBalance),'Plan '+reportedLabel(f.planId))}</div>
      <p class="muted small">Daily limit ${fmt(f.dailyLimit)} · used ${fmt(f.dailySpent)} · monthly bonus ${fmt(f.monthlyBonus)}. Source: Freebuff session API (${esc(displayLabel(a.host,'local'))}); read ${esc(reportedLabel(a.refreshed_at))}. Not added to token totals.</p>`;
  }
  function fbFilterQuery(){
    const host=document.getElementById('fb-host')?.value||'all';
    const model=document.getElementById('fb-model')?.value||'all';
    const days=document.getElementById('usage-period')?.value||'30';
    const q=new URLSearchParams({days});
    if(host!=='all')q.set('host',host);
    if(model!=='all')q.set('model',model);
    return {host,model,q:q.toString()};
  }
  function renderFreebuff(){
    if(!fbData||!document.getElementById('fb-summary'))return;
    const all=Array.isArray(fbData.events)?fbData.events:[];
    const hostSel=document.getElementById('fb-host'), modelSel=document.getElementById('fb-model');
    const prevHost=hostSel.value||'all', prevModel=modelSel.value||'all';
    // Filter by the observed event host, not the source id (host rows expose both).
    const hosts=[...new Set((fbData.hosts||[]).map(h=>String(h.host||h.id||'').replace(/^freebuff-/,'')).filter(Boolean))].sort();
    const models=[...new Set((fbData.hosts||[]).flatMap(h=>(h.models||[]).map(m=>m.model)).filter(Boolean))].sort();
    hostSel.innerHTML='<option value="all">All Freebuff hosts</option>'+hosts.map(h=>`<option value="${esc(h)}">${esc(h)}</option>`).join('');
    modelSel.innerHTML='<option value="all">All models</option>'+models.map(m=>`<option value="${esc(m)}">${esc(displayLabel(m,'Unattributed'))}</option>`).join('');
    hostSel.value=hosts.includes(prevHost)?prevHost:'all';
    modelSel.value=models.includes(prevModel)?prevModel:'all';
    // Server-side filtered block over EVERY matching event. The event array is only
    // the newest page, so a sample total is never presented as a complete total.
    const filtered=fbData.filtered||null;
    const sampleOnly=!filtered;
    const inp=sampleOnly?sum(all,'input_tokens'):{value:filtered.input_tokens,seen:filtered.input_token_events};
    const out=sampleOnly?sum(all,'output_tokens'):{value:filtered.output_tokens,seen:filtered.output_token_events};
    const total=sampleOnly?sum(all,'total_tokens'):{value:filtered.total_tokens,seen:filtered.total_token_events};
    const measured=sampleOnly?all.length:(filtered.events||0);
    const incomplete=sampleOnly?all.filter(e=>e.usage_incomplete).length:(filtered.incomplete_events||0);
    const suffix=sampleOnly?' · sample only':'';
    document.getElementById('fb-summary').innerHTML=
      box('Input tokens (gross)',fmt(inp.value),`${fmt(inp.seen)} receipts · includes cached prefix${suffix}`)+
      box('Output tokens',fmt(out.value),`${fmt(out.seen)} receipts · includes reasoning${suffix}`)+
      box('Total tokens',fmt(total.value),`${fmt(incomplete)} incomplete receipts included; cache and reasoning not added twice`);
    const eventsTotal=Number.isFinite(Number(fbData.events_total))?Number(fbData.events_total):measured;
    const collectorFailed=(fbData.collector||{}).ok===false;
    document.getElementById('fb-count').innerHTML=`${fmt(eventsTotal)} measured runs in this window${fbData.events_truncated?` · table shows newest ${fmt(all.length)}`:''}${sampleOnly?' · totals limited to that sample':''}${collectorFailed?' '+pill('error')+' <span class="small">collector error — showing last successful data</span>':''}`;
    const daily=filtered&&Array.isArray(filtered.daily)?filtered.daily:null;
    let dailyRows=daily;
    if(!dailyRows){const dailyMap=new Map();for(const row of all){const day=String(row.timestamp||'').slice(0,10);if(!day)continue;const bucket=dailyMap.get(day)||{day,input_tokens:null,fresh_input_tokens:null,output_tokens:null};for(const key of ['input_tokens','fresh_input_tokens','output_tokens']){const n=numeric(row[key]);if(n!==null)bucket[key]=(bucket[key]||0)+n;}dailyMap.set(day,bucket);}dailyRows=[...dailyMap.values()].sort((a,b)=>a.day.localeCompare(b.day));}
    sparkChart(document.getElementById('fb-chart'),dailyRows,[{key:'input_tokens',label:'Input (gross)',color:'#4aabff'},{key:'fresh_input_tokens',label:'Fresh input',color:'#26e6ff'},{key:'output_tokens',label:'Output',color:'#bd96ff'}],{empty:'No timestamped Freebuff receipts in this filter.'});
    const exactIn=sampleOnly?sum(all.filter(e=>!e.usage_incomplete),'input_tokens'):{value:filtered.exact_input_tokens};
    const exactOut=sampleOnly?sum(all.filter(e=>!e.usage_incomplete),'output_tokens'):{value:filtered.exact_output_tokens};
    const collector=fbData.collector||{}, chosts=Array.isArray(collector.hosts)?collector.hosts:[];
    const hostRows=(fbData.hosts||[]).map(h=>{const c=chosts.find(x=>x.source_id===h.id)||{};const state=c.status&&c.status!=='ok'?c.status:(c.error?'error':h.status);return `<tr><td>${esc(h.label||h.id)}</td><td>${pill(reportedLabel(state))}</td><td>${fmt(h.events)}</td><td class="small">${esc(h.latest_at||'none in window')}</td><td class="small">${esc(reportedLabel(h.account_ref))}</td><td class="small">${fmt(c.runs)} runs · ${fmt(c.runs_no_assistant)} without assistant · ${fmt(c.runs_assistant_without_metrics)} assistant without metrics · ${fmt(c.receipts_without_tokens)} receipt without tokens · ${fmt(c.duplicates)} duplicates${c.error?' · '+esc(c.error):''}</td></tr>`;}).join('');
    document.getElementById('fb-coverage').innerHTML=`<div class="table-wrap"><table class="data"><thead><tr><th>Host</th><th>State</th><th>Events</th><th>Latest</th><th>Account ref</th><th>Collector coverage (all time)</th></tr></thead><tbody>${hostRows||'<tr><td colspan="6" class="muted">No Freebuff collector output.</td></tr>'}</tbody></table></div>
      <p class="small">Complete receipts only: ${fmt(exactIn.value)} input / ${fmt(exactOut.value)} output. All receipts: ${fmt(inp.value)} input / ${fmt(out.value)} output. Missing measurements show —, never zero.${collector.collected_at?` Last collection ${esc(collector.collected_at)}; collector ok=${collector.ok===true?'yes':collector.ok===false?'no':'not reported'}.`:''} Account refs are observed at collection time, not historical ownership.</p>
      <p class="muted small">Model is the thread's current model at collection time; Freebuff stores no per-run model history. A changed thread model is therefore not attributable per run.</p>`;
    const shown=all.slice(-50).reverse();
    document.getElementById('fb-events').innerHTML=`<table class="data"><thead><tr><th>Time</th><th>Host</th><th>Model</th><th>Run</th><th>Input</th><th>Cached</th><th>Fresh</th><th>Output</th><th>Reasoning</th><th>Total</th><th>Receipt</th></tr></thead><tbody>`+
      (shown.length?shown.map(e=>`<tr><td class="small">${esc(e.timestamp)}</td><td>${esc(e.host||'')}</td><td>${esc(reportedLabel(e.model))}</td><td class="small mono" title="${esc(e.run_id||'')}">${esc(String(e.run_id||'').slice(0,8))}</td><td>${fmt(e.input_tokens)}</td><td>${fmt(e.cached_input_tokens)}</td><td>${fmt(e.fresh_input_tokens)}</td><td>${fmt(e.output_tokens)}</td><td>${fmt(e.reasoning_tokens)}</td><td>${fmt(e.total_tokens)}</td><td>${e.usage_incomplete?'<span class="pill amber">incomplete</span>':'<span class="pill green">exact</span>'}</td></tr>`).join(''):'<tr><td colspan="11" class="muted">No measured Freebuff runs match this filter.</td></tr>')+
      '</tbody></table>'+(eventsTotal>shown.length?`<p class="muted small">Showing the newest ${fmt(shown.length)} of ${fmt(eventsTotal)} measured runs. Card totals and the chart cover all ${fmt(eventsTotal)} runs matching this filter, not only these rows.</p>`:'');
  }
  async function applyFbFilter(){
    if(!available())return;
    const my=++fbSeq;
    try{
      const u=await api('/api/unified/usage?'+fbFilterQuery().q);
      if(my!==fbSeq||!available())return;
      fbData=u.freebuff&&typeof u.freebuff==='object'?u.freebuff:null;
      renderFreebuff();
    }catch(e){toast('Freebuff filter',e.message,'error');}
  }
  async function load(){const id=++seq,days=document.getElementById('usage-period').value;
    const [u,oc,a]=await Promise.all([api('/api/unified/usage?'+fbFilterQuery().q),api('/api/openchamber/telemetry').catch(e=>({available:false,reason:e.message})),api('/api/freebuff/allowance').catch(e=>({available:false,error:e.message}))]);
    if(!available()||id!==seq)return;
    if(u?.available===false)throw new Error(u.error||'Unified usage service unavailable');
    document.getElementById('usage-openchamber').innerHTML=renderOpenChamberCoverage(oc,Number(days)||30);
    document.getElementById('usage-summary').innerHTML=box('Input tokens',fmt(u.input_tokens_recorded),'Measured across '+fmt(u.input_token_events)+' invocation records')+
      box('Output tokens',fmt(u.output_tokens_recorded),'Measured across '+fmt(u.output_token_events)+' invocation records')+
      box('Sources with data',fmt((u.sources||[]).filter(s=>s.events>0).length)+' / '+fmt((u.sources||[]).length),'Unavailable sources are not zero consumption');
    document.getElementById('usage-age').textContent='Checked '+relative(u.collected_at);
    document.getElementById('usage-sources').innerHTML=`<div class="table-wrap"><table class="data"><thead><tr><th>Source</th><th>State</th><th>Events</th><th>Last observed</th></tr></thead><tbody>`+
      (u.sources||[]).map(s=>`<tr><td>${esc(s.label)}</td><td>${pill(s.status)}</td><td>${fmt(s.events)}</td><td>${esc(s.latest_at||'No recorded sample')}</td></tr>`).join('')+'</tbody></table></div>';
    const daily=u.daily||[];
    sparkChart(document.getElementById('usage-token-chart'),daily,[{key:'input_tokens',label:'Input',color:'#4aabff'},{key:'output_tokens',label:'Output',color:'#bd96ff'}],{empty:'No timestamped token measurements available. Connect collectors before trends can appear.'});
    document.getElementById('usage-events').innerHTML=`<table class="data"><thead><tr><th>Time</th><th>Source</th><th>Model</th><th>Input</th><th>Output</th></tr></thead><tbody>`+
      (u.recent||[]).filter(e=>numeric(e.input_tokens)!==null||numeric(e.output_tokens)!==null).slice(0,50).map(e=>`<tr><td class="small">${esc(e.timestamp)}</td><td>${esc(displayLabel(e.source))}</td><td>${esc(reportedLabel(e.model))}</td><td>${fmt(e.input_tokens)}</td><td>${fmt(e.output_tokens)}</td></tr>`).join('')+'</tbody></table><p class="muted small">Newest 50 records with reported input or output tokens. Records without tokens remain in source coverage. Missing values are not estimated.</p>';
    fbData=u.freebuff&&typeof u.freebuff==='object'?u.freebuff:null;
    if(fbData)renderFreebuff();else document.getElementById('fb-summary').innerHTML=`<p>${pill('unavailable')} Freebuff receipt section unavailable in this response.</p>`;
    renderAllowance(a);
  }
  document.getElementById('fb-host').addEventListener('change',applyFbFilter);
  document.getElementById('fb-model').addEventListener('change',applyFbFilter);
  const refresh=()=>load().catch(e=>{if(available())toast('Usage',e.message,'error')});
  document.getElementById('usage-reload').addEventListener('click',refresh);
  document.getElementById('usage-period').addEventListener('change',refresh);
  state.cleanup=()=>{disposed=true;seq++};
  await load();schedule(refresh,60000);
}

// -------------------------------------------------------------- test hook
// Regression-test surface for the pure helpers (node/bun). Importing this
// module only ever runs the bootstrap above; no view, fetch or timer starts.
export const __editorTestSurface = {rowsOf, contentOf, createDiscoveryGuard, applyHarnessRefresh, harnessInterval,
  displayLabel, pill, statusPill, categoryChip, metricBlock,
  diagnosticsTabOf, indexingTabOf, tabStrip, DIAGNOSTICS_TABS, INDEXING_TABS,
  debounceForRoute, sequencer,
  get refreshMs(){return harnessRefreshMs;}};


// Read-only Agent Chat monitor. The durable agentchat inboxes remain the source
// of truth; this view never acknowledges mail or sends a message for an agent.
async function viewAgentChat() {
  APP.innerHTML = pageHead('Agent Chat', 'Inter-agent messages from durable role and session inboxes. Monitoring does not mark messages read.') + `
    <div class="toolbar agentchat-controls">
      <input class="input" id="ac-filter" aria-label="Filter agent identity" placeholder="Filter agent or session" autocomplete="off" />
      <button class="btn small" type="button" id="ac-pause">Pause feed</button>
      <span class="muted small" id="ac-status">Connecting…</span>
    </div>
    <div id="ac-stream" class="agentchat-stream" role="feed" aria-label="Agent chat messages"></div>`;
  const stream = document.getElementById('ac-stream');
  const status = document.getElementById('ac-status');
  const filter = document.getElementById('ac-filter');
  const pauseButton = document.getElementById('ac-pause');
  let cursor = 0;
  let paused = false;
  let pending = false;
  const known = new Set();
  const records = [];
  const mark = (m) => `#${esc(m.id)} · ${esc(m.origin || 'agent')} · ${esc(m.created_at || '')}`;
  const label = (m) => [...(m.recipients || []).map(r => '@' + r),
                        ...(m.sessions || []).map(s => 'session:' + s)].join(', ');
  const render = () => {
    const term = filter.value.toLowerCase().trim();
    const visible = records.filter(m => !term ||
      [m.from,m.from_session,label(m),m.text].join(' ').toLowerCase().includes(term));
    stream.innerHTML = visible.length ? visible.map(m => `<article class="agentchat-message">
      <div class="agentchat-meta"><strong>${esc(m.from)}</strong>
        ${m.from_session ? `<span class="agentchat-session">${esc(m.from_session)}</span>` : ''}
        <span class="agentchat-arrow">→</span> <span>${esc(displayLabel(label(m)))}</span>
        <time class="agentchat-stamp">${mark(m)}</time></div>
      <div class="agentchat-body">${esc(m.text)}</div></article>`).join('')
      : '<div class="block muted">No Agent Chat messages match this view.</div>';
  };
  const load = async () => {
    if (pending || paused || !document.getElementById('ac-stream')) return;
    pending = true;
    try {
      const response = await api('/api/agentchat/feed?' + new URLSearchParams({ after: String(cursor), limit: '100' }));
      if (!document.getElementById('ac-stream')) return;
      if (!response.available) {
        status.textContent = response.reason || 'Agent Chat unavailable';
        return;
      }
      for (const m of response.messages || []) {
        if (known.has(m.id)) continue;
        known.add(m.id);
        records.unshift(m);
      }
      while (records.length > 180) known.delete(records.pop().id);
      cursor = Math.max(cursor, Number(response.last_id) || 0);
      status.textContent = `${records.length} recent messages · live updates every 2s`;
      render();
      // A burst larger than one page is drained on subsequent fetches.
      if (response.has_more) status.textContent += ' · catching up';
    } catch (error) {
      if (error.status !== -1) status.textContent = 'Feed error: ' + error.message;
    } finally { pending = false; }
  };
  filter.addEventListener('input', render);
  pauseButton.addEventListener('click', () => {
    paused = !paused;
    pauseButton.textContent = paused ? 'Resume feed' : 'Pause feed';
    if (!paused) load();
    else status.textContent = 'Paused';
  });
  await load();
  schedule(load, 2000);
}
