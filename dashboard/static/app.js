import {createKnowledgeGraph, relationshipDetails, sparkChart, numeric, brainOutline} from './observability.js?v=rq-20261113-cmp';
import {renderKnowledgeGuide} from './repoql_guidance.js';
import {openAvatarPicker, agentAvatar} from './agent_avatars.js';
import {viewOpenMausBot} from './openmausbot_panel.js';
import {viewOpenMausOps} from './openmausbot_ops.js?v=rq-20261109-windows-design';
import {mountNativeKanban} from './kanban_native.js?v=rq-20261109-windows-design';
import {initNavigationUI, navPathFor} from './navigation_ui.js?v=20261110c';
import {renderRepoqlCheatSheet, bindRepoqlCheatSheet} from './repoql_cheatsheet.js';
import {renderMemoryArchitecturePage, bindMemoryArchitecturePage, renderOrchestraWorkflowPage, bindOrchestraWorkflowPage} from './workflow_graphs.js';
import {renderAgentReferencePage, bindAgentReferencePage} from './agent_reference.js';
import {viewAgentsControl as viewAgentsControlPage, bindAgentsControl} from './agents_control_view.js';
// RepoQL Control — dark neon block management UI.
// Vanilla ES module: no build step, no framework, no extra dependency.

const SECRET_KEY = "repoql.dashboard.secret";
const APP = document.getElementById("app");
const TOASTS = document.getElementById("toasts");
const CONN = document.getElementById("conn");
const CONN_LABEL = document.getElementById("connLabel");
const HOST_LINE = document.getElementById("hostLine");
const THEME_SLOT = document.getElementById("theme-switcher-slot");
const THEME_KEY = window.matchMedia && window.matchMedia("(max-width:760px)").matches ? "repoql.dashboard.theme.phone" : "repoql.dashboard.theme";
const THEME_LAST_DARK_KEY = "repoql.dashboard.theme.dark";
const THEME_LAST_LIGHT_KEY = "repoql.dashboard.theme.light";

// A theme chooses the atmosphere, not the meaning of colours. Data roles remain
// distinguishable within every theme, including the two neon alternatives.
const THEME_CATALOG = [
  { id: "charcoal", label: "Charcoal", mode: "dark", note: "Grok-inspired near-black surfaces, soft charcoal cards and purposeful colours across every workspace.", swatches: ["#242426", "#65a9ef", "#a684e7", "#65c6a5", "#e7b874"] },
  { id: "neon", label: "Neon Grid", mode: "dark", note: "Graphite command deck with spectrum neon accents and distinct workspace colours.", swatches: ["#3ee7ff", "#b8ff4a", "#ff5fa8", "#5ca8ff", "#b47cff"] },
  { id: "neon-violet", label: "Neon Violet", mode: "dark", note: "Violet atmosphere with independent lime, coral, blue and teal workspace accents.", swatches: ["#76e9ff", "#c6ff63", "#ff79ba", "#72b6ff", "#cf96ff"] },
  { id: "neon-emerald", label: "Neon Emerald", mode: "dark", note: "Emerald atmosphere with bright blue, violet, pink and gold workspace accents.", swatches: ["#58e7e9", "#bfff63", "#ff74ae", "#72c0ff", "#b998ff"] },
  { id: "light-paper", label: "Paper Light", mode: "light", note: "Neutral white with restrained multi-colour categories.", swatches: ["#377bbd", "#8063b2", "#248c79", "#ad7635", "#ad6385"] },
  { id: "light-sky", label: "Sky Light", mode: "light", note: "Cool light surfaces and balanced category colour.", swatches: ["#2f79b5", "#7965b0", "#288c7c", "#a77938", "#ad6484"] },
  { id: "light-sand", label: "Sand Light", mode: "light", note: "Warm neutral surfaces and clear blue, purple and green roles.", swatches: ["#376ca5", "#8362ad", "#278573", "#ab7435", "#b06983"] },
  { id: "light-mint", label: "Mint Light", mode: "light", note: "Fresh pale surfaces with balanced violet, blue and gold accents.", swatches: ["#327ab2", "#7d62b0", "#258b77", "#a77a37", "#ae6985"] },
];

const themeCatalog = () => THEME_CATALOG.map((entry) => ({ ...entry, swatches: [...entry.swatches] }));
const themeById = (id) => THEME_CATALOG.find((entry) => entry.id === id);
const themeModeOf = (id) => themeById(id)?.mode || "dark";
const sanitizeThemeChoice = (value) => themeById(value)?.id || THEME_CATALOG[0].id;

function storedTheme() {
  try { return sanitizeThemeChoice(localStorage.getItem(THEME_KEY)); } catch { return THEME_CATALOG[0].id; }
}

function applyTheme(themeId, {persist = true} = {}) {
  const safe = sanitizeThemeChoice(themeId);
  const html = document.documentElement || document.querySelector?.('html');
  const info = themeById(safe);
  if (!html || !info) return safe;
  html.dataset.theme = safe;
  html.dataset.themeMode = info.mode;
  document.body?.setAttribute?.('data-theme-mode', info.mode);
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.setAttribute('content', info.mode === 'light' ? 'light dark' : 'dark light');
  const control = document.getElementById('theme-select');
  if (control && control.value !== safe) control.value = safe;
  document.querySelectorAll('[data-theme-preview]').forEach((node) => {
    node.classList.toggle('active', node.dataset.themePreview === safe);
    node.setAttribute('aria-pressed', String(node.dataset.themePreview === safe));
  });
  const modePill = document.getElementById('theme-mode-pill');
  if (modePill) modePill.textContent = info.mode === 'light' ? 'Light mode' : 'Dark mode';
  const modeToggle = document.getElementById('theme-mode-toggle');
  if (modeToggle) {
    modeToggle.textContent = info.mode === 'light' ? 'Switch to dark' : 'Switch to light';
    modeToggle.setAttribute('aria-label', modeToggle.textContent);
  }
  const description = document.getElementById('theme-description');
  if (description) description.textContent = info.note;
  const currentSwatches = document.getElementById('theme-current-swatches');
  if (currentSwatches) currentSwatches.innerHTML = info.swatches.map(c => `<i style="--swatch:${c}"></i>`).join('');
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, safe);
      localStorage.setItem(info.mode === 'light' ? THEME_LAST_LIGHT_KEY : THEME_LAST_DARK_KEY, safe);
    } catch {}
  }
  return safe;
}

function renderThemeSwitcher() {
  if (!THEME_SLOT) return;
  const groups = { dark: THEME_CATALOG.filter(t => t.mode === 'dark'), light: THEME_CATALOG.filter(t => t.mode === 'light') };
  const options = (items) => items.map(t => `<option value="${esc(t.id)}">${esc(t.label)}</option>`).join('');
  THEME_SLOT.innerHTML = `<section class="theme-panel compact" aria-label="Dashboard appearance">
    <label class="theme-select-wrap compact" for="theme-select">Theme
      <select id="theme-select" class="select compact"><optgroup label="Dark themes">${options(groups.dark)}</optgroup><optgroup label="Light">${options(groups.light)}</optgroup></select>
    </label>
  </section>`;
  document.getElementById('theme-select')?.addEventListener('change', e => applyTheme(e.target.value));
  applyTheme(storedTheme(), {persist:false});
}

// repoql-host.service runs with CPUQuota=400% (4 cores). CPU samples are
// recorded as percent of one core; display them as a percentage of that quota.
const nativeInstall = Boolean(window.__SINGULARITY_VARIANT__?.variant);
const CPU_QUOTA_CORES = nativeInstall ? 1 : 4;
const CPU_QUOTA_LABEL = nativeInstall ? "one logical core" : "4-core quota";
const guiUsageName = () => window.__SINGULARITY_VARIANT__?.gui === 'openchamber-desktop'
  ? 'OpenChamber Desktop' : 'Claude Desktop Code';
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
  const controller = new AbortController();
  const owner = state.routeAbort?.signal;
  const onNavigation = () => controller.abort('route_changed');
  if (owner?.aborted) controller.abort('route_changed');
  else owner?.addEventListener('abort', onNavigation, {once:true});
  const timer = setTimeout(() => controller.abort('timeout'), options.timeoutMs ?? 120000);
  try {
    const response = await fetch(path, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
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
      if (controller.signal.reason === 'route_changed') throw new ApiError('navigation_cancelled', -1);
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
        <p>Open the Singularity Dashboard shortcut for an authenticated local session.</p>
      </div>
    </div>`;
  setConn("error", "locked");
}

// -------------------------------------------------------------- hash router

function parseRoute() {
  let raw = location.hash.replace(/^#/, "") || "/";
  if (/^k=/.test(raw)) raw = "/"; // legacy token fragment: not a route
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
  const mobileTitle=document.getElementById('mobile-page-title');
  if (mobileTitle) {
    const names={'/':'Command Center','/kanban':'Agent Jobs','/openmausbot':'Bot Schedules','/openmausbot/chat':'OpenMausBot',
      '/agentchat':'Agent Chat','/unified/graph':'Memory Graph','/office':'Office Viewer'};
    mobileTitle.textContent=names[target] || active?.textContent.trim() || 'RepoQL';
  }
  // Canonical sidebar destination is also the visual route identity. Detail
  // URLs keep their owner's colours without a parallel colour routing table.
  APP.dataset.pageRoute = target;
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

// These are narrow runtime probes, not an attestation of the memory capture
// pipeline or the coordinator's policy gates. Avoid silently treating a 200
// response as a healthy ingest or a successful run.
function architectureProbeState(kind, value, nowMs = Date.now()) {
  if (kind === 'harness') {
    if (!value || value.enabled !== true) return ['Unavailable', 'Telemetry is not reported as enabled.'];
    if (value.last_error) return ['Needs attention', 'The collector reports an ingest error.'];
    if (!value.last_ingest) return ['Unknown', 'No successful ingest timestamp was reported.'];
    const timestamp = Date.parse(value.last_ingest);
    if (!Number.isFinite(timestamp) || timestamp > nowMs + 60000) return ['Unknown', 'Ingest timestamp is invalid or in the future.'];
    if (nowMs - timestamp > 300000) return ['Needs attention', 'Telemetry has not reported an ingest within five minutes.'];
    return ['Responding', `Last reported ingest: ${value.last_ingest}`];
  }
  if (!value || value.available === false || value.ok !== true || value.rust !== true) {
    return ['Unavailable', 'The unified Rust service did not report a healthy response.'];
  }
  return ['Responding', 'Unified Rust service responded. This does not establish MemoryCore or graph coverage.'];
}
function architectureRuntimeChecks() {
  const guide = APP.querySelector('.arch-guide');
  if (!guide) return;
  for (const link of guide.querySelectorAll('a[href^="#/"]')) {
    if (!featureAllowed(link.getAttribute('href').slice(1))) link.remove();
  }
  const checks = [
    ...(!nativeInstall ? [['Harness telemetry', 'harness', '/api/harness/health']] : []),
    ['Unified Rust plane', 'unified', '/api/unified/health'],
  ];
  guide.insertAdjacentHTML('afterend', `<section class="arch-runtime block" aria-label="Current service observations">
    <div class="block-title">Current service observations</div>
    <p class="muted">${nativeInstall ? 'Check the local unified Rust service. Capture, recall and worker gates require their own validation.' : 'These read-only checks show whether telemetry and the unified Rust plane respond. They do not validate capture, recall, worker gates, or end-to-end correctness.'}</p>
    <div class="arch-runtime-results" id="arch-runtime-results" role="status" aria-live="polite">Not checked</div>
    <button class="btn" type="button" id="arch-runtime-refresh">Check services</button>
    ${nativeInstall ? '<a href="#/native/status">Windows Integration Status</a>' : '<a href="#/harness">Inspect Harness evidence</a>'}
  </section>`);
  const results = APP.querySelector('#arch-runtime-results');
  const button = APP.querySelector('#arch-runtime-refresh');
  const check = async () => {
    if (button.disabled) return;
    button.disabled = true;
    results.textContent = 'Checking services…';
    const epoch = state.routeEpoch;
    const probes = await Promise.allSettled(checks.map(([, , endpoint]) => api(endpoint, {timeoutMs:8000})));
    if (epoch !== state.routeEpoch || !results.isConnected) return;
    results.replaceChildren();
    probes.forEach((probe, i) => {
      const [label, kind] = checks[i];
      const [status, detail] = probe.status === 'fulfilled'
        ? architectureProbeState(kind, probe.value)
        : ['Unavailable', 'The service check could not complete.'];
      const row = document.createElement('p');
      row.innerHTML = `<strong>${label}: ${esc(status)}</strong> · ${esc(detail)}`;
      results.appendChild(row);
    });
    button.disabled = false;
  };
  button.addEventListener('click', check);
  // Load only on explicit request: opening an explanation page does not impose
  // an unexpected telemetry request or report invented runtime state.
}

async function route() {
  const epoch = ++state.routeEpoch;
  state.routeAbort?.abort('route_changed');
  state.routeAbort = new AbortController();
  try { state.cleanup?.(); } catch (error) { console.warn('View cleanup failed', error); }
  state.cleanup = null;
  clearTimers();
  const { path, params } = parseRoute();
  document.documentElement.dataset.route = path === '/openmausbot/chat' ? 'openmausbot' : '';
  // One visual identity per workspace. Presentation only: no change to
  // routing, MCP authority, task ownership or API calls.
  APP.dataset.workspace = path === '/kanban' ? 'work'
    : path.startsWith('/bots') || path.startsWith('/openmausbot') ? 'chat'
    : path === '/agentchat' ? 'chat'
    : path === '/unified/graph' || path.startsWith('/architecture/memory') || path.startsWith('/knowledge/') ? 'memory'
    : path === '/office' ? 'office'
    : path.startsWith('/unified/tencent') ? 'tencent'
    : path.startsWith('/harness') ? 'harness'
    : path.startsWith('/diagnostics') || path.startsWith('/unified/usage') ? 'attention'
    : 'repoql';
  // Presentation only. Nested pages receive the right accent without changing
  // the existing route handlers or the owning coordinator/data source.
  APP.dataset.pageIdentity = path.startsWith('/bots') ? 'bot'
    : path === '/kanban' ? 'work'
    : path === '/agentchat' ? 'lounge'
    : path === '/office' ? 'office'
    : path === '/architecture/orchestra' ? 'orchestra'
    : path === '/reference/agents' ? 'reference'
    : path.startsWith('/architecture/') || path === '/unified/graph' ? 'memory'
    : path.startsWith('/repoql/cheat-sheet') ? 'reference'
    : path.startsWith('/knowledge/all') || path.startsWith('/knowledge/item') ? 'concepts'
    : path.startsWith('/knowledge/connectors') ? 'connectors'
    : path === '/links' || path.startsWith('/knowledge/connections') ? 'links'
    : path.startsWith('/unified/tencent') ? 'tencent'
    : path === '/indexing' || path.startsWith('/repositories') ? 'indexing'
    : path === '/unified/usage' ? 'usage'
    : path.startsWith('/diagnostics') || ['/cpu','/errors','/excluded'].includes(path) ? 'diagnostics'
    : path.startsWith('/harness/settings') ? 'settings'
    : path.startsWith('/harness/agents') ? 'agents'
    : path.startsWith('/harness/runs') || path.startsWith('/harness/run') ? 'runs'
    : path.startsWith('/harness/events') ? 'events'
    : path.startsWith('/harness') ? 'harness'
    : 'repoql';
  if (!featureAllowed(path)) {
    APP.innerHTML = '<div class="empty">This component is not included in the selected Singularity installation option.</div>';
    return;
  }
  markNav(path.startsWith('/bots/') ? '/bots' : path.startsWith('/openmausbot/') && !['/openmausbot/fleet','/openmausbot/calendar','/openmausbot/attention','/openmausbot/history'].includes(path) ? '/openmausbot/chat' : path);
  if (state.routeEpoch > 1) window.scrollTo(0, 0);
  try {
    // Shared bot operations (Now / Calendar / Needs attention / Run history).
    // The embedded native workspace (chat and routine management) moved to /openmausbot/chat.
    if (["/openmausbot", "/openmausbot/calendar", "/openmausbot/attention", "/openmausbot/history"].includes(path)) {
      return await viewOpenMausOps({
        app: APP, api, pageHead, esc, current: () => epoch === state.routeEpoch,
        tab: path.split("/")[2] || "now", params,
        workspaceHref: '#/openmausbot/chat',
        setCleanup: (fn) => { state.cleanup = fn; },
      });
    }
    if (path === "/openmausbot/chat") return await viewOpenMausBot({
      app: APP, api, pageHead, esc, toast, current: () => epoch === state.routeEpoch,
    });
    if (path === "/openmausbot/fleet" && nativeInstall) return await viewNativeBotInventory();
    if (path === "/openmausbot/fleet") return await viewOpenMausBot({
      app: APP, api, pageHead, esc, toast, current: () => epoch === state.routeEpoch, mode: 'fleet',
    });
    if (path === "/bots" || path.startsWith("/bots/")) {
      // Bot Operations retired (fleet#832): the one surviving behaviour is the
      // redirect. replaceState keeps a single history entry, like the other
      // consolidated routes.
      const canonical = replaceRoute(href("/openmausbot"));
      return await viewOpenMausOps({
        app: APP, api, pageHead, esc, current: () => epoch === state.routeEpoch,
        params: canonical.params,
        workspaceHref: '#/openmausbot/chat',
        setCleanup: (fn) => { state.cleanup = fn; },
      });
    }
    if (path === "/unified/graph") return await viewUnifiedGraph();
    if (path === "/claude/agents" && nativeInstall) {
      const mod = await import('./claude_agents_control.js');
      return await mod.mountClaudeAgentsControl(APP, api);
    }
    if (path === "/unified/tencent") return await viewTencentNative();
    if (path === "/unified/tencent-advanced") return await viewTencentNative();
    if (path === "/repoql/control") return await viewRepoqlNative();
    if (path === "/architecture/memory") { APP.innerHTML = renderMemoryArchitecturePage(); architectureRuntimeChecks(); const binding = bindMemoryArchitecturePage(); state.cleanup = () => binding?.dispose(); return; }
    if (path === "/architecture/orchestra") { APP.innerHTML = renderOrchestraWorkflowPage(); architectureRuntimeChecks(); const binding = bindOrchestraWorkflowPage(); state.cleanup = () => binding?.dispose(); return; }
    if (path === "/reference/agents") { APP.innerHTML = groupTabs() + renderAgentReferencePage(); bindAgentReferencePage(); return; }
    if (path === "/repoql/cheat-sheet") { APP.innerHTML = renderRepoqlCheatSheet(); return bindRepoqlCheatSheet(); }
    if (path === "/knowledge/connectors") return await viewConnectors();
    if (path === "/knowledge/connections") return await viewLinks({...params, collection: params.collection || "see_also"}, true);

    if (path === "/unified/usage") return await viewUnifiedUsage();
    if (path === "/native/status" && nativeInstall) return await viewNativeInstallStatus();
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
    if (path === "/agents-control") return await viewAgentsControl();
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
    if (path === "/kanban") return nativeInstall ? await viewKanbanNative() : await viewKanban(params);
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

async function viewNativeBotInventory() {
  APP.innerHTML = pageHead('Bot fleet status', 'Windows-local OpenMausBot inventory.',
    '<a class="btn small" href="#/openmausbot">Operations</a>') +
    '<section class="block" id="windows-omb-status">Checking the local OpenMausBot service…</section>';
  const report = await api('/api/openmausbot/overview', {timeoutMs: 8000});
  const holder = document.getElementById('windows-omb-status');
  if (!holder) return;
  if (!report.available) {
    holder.innerHTML = `<h2>OpenMausBot is not connected</h2><p class="muted small">Local service: ${esc(report.reason || 'not configured')}. Install and pair the required Windows-local OpenMausBot instance before using its bot functions. No external host was contacted.</p>`;
    return;
  }
  const rows = (report.bots || []).map(bot => `<tr><td>${esc(bot.name)}</td><td class="mono">${esc(bot.id)}</td><td>${esc(bot.working ? 'Working' : 'Idle')}</td><td class="muted">Registration, Tencent, Duo and Kanzo not verified</td></tr>`).join('');
  holder.innerHTML = `<h2>${Number(report.total) || 0} local bot(s)</h2><p class="muted small">This is a read-only inventory, not a registration or execution receipt. No credentials are exposed to this page.</p>
  <div class="table-wrap"><table class="data"><thead><tr><th>Bot</th><th>Identity</th><th>Runtime</th><th>External integrations</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No bots in this workspace.</td></tr>'}</tbody></table></div>`;
}

// -------------------------------------------------------------- shared views

function pageHead(title, subtitle, actions = "") {
  return `<div class="page-head">
    <div><h1>${esc(title)}</h1><div class="sub">${esc(subtitle)}</div></div>
    <div class="actions">${actions}</div>
  </div>` + groupTabs();
}

// One sidebar entry per workspace; its sibling pages are tabs on every page of
// the group (Harness telemetry, Agents). Routes are unchanged, so old links work.
const HARNESS_TABS = [
  { id: "/harness", label: "Overview" },
  { id: "/harness/agents", label: "Live agents" },
  { id: "/harness/runs", label: "Runs" },
  { id: "/harness/performance", label: "Performance" },
  { id: "/harness/events", label: "Events" },
  { id: "/harness/settings", label: "Settings" },
];
const AGENT_TABS = [
  { id: "/agents-control", label: "Configuration" },
  { id: "/reference/agents", label: "Roles" },
  { id: "/openmausbot/fleet", label: "Bot fleet" },
];
function groupTabs() {
  const { path } = parseRoute();
  if (path === "/harness" || path.startsWith("/harness/")) {
    const active = path === "/harness/run" ? "/harness/runs" : HARNESS_TABS.some(t => t.id === path) ? path : "/harness";
    return tabStrip(HARNESS_TABS.map(t => ({ ...t, href: () => href(t.id, {}) })), active, "Harness sections");
  }
  if (AGENT_TABS.some(t => t.id === path)) {
    return tabStrip(AGENT_TABS.map(t => ({ ...t, href: () => href(t.id, {}) })), path, "Agent sections");
  }
  return "";
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
  { id: "runtime", label: "Runtime & Services", href: () => href("/diagnostics", { tab: "runtime" }) },
];
const DIAGNOSTICS_SUBTITLES = {
  cpu: "RepoQL host process CPU, measured from its own process and stored independently of any browser.",
  errors: "Indexing failures, analyzer parse errors and service-level warnings from the RepoQL host.",
  excluded: "Live mount-root .repoqlignore rules and dashboard-managed exclusion history.",
  runtime: "Service health, collectors, versions and Rust state authority. Technical details live here, not on the command centre.",
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

// A status indicator is unknown until the endpoint actually reports its value.
// In particular, null and undefined must never be displayed as a healthy zero.
function miniatureBrainGraph() {
  // Decorative, deterministic illustration only; no API request and no implied
  // live node counts, relationships or memory health.
  const outline = brainOutline(108).map(({x,y},i) => `${i?'L':'M'}${(x*.34+150).toFixed(1)} ${(y*.34+92).toFixed(1)}`).join(' ')+'Z';
  const points = Array.from({length:74},(_,i)=>{
    const theta = (i * 2.399963229728653)+0.25;
    const radius = Math.sqrt((i+.5)/74)*.85;
    const x = 150+Math.cos(theta)*radius*102;
    const y = 93+Math.sin(theta)*radius*62;
    return {x,y,type:i%7===0?'mem':i%3===0?'tx':'rq'};
  });
  const lines=points.map((point,i)=>{
    const to=points[(i*13+21)%points.length];
    return `<path d="M${point.x.toFixed(1)} ${point.y.toFixed(1)}L${to.x.toFixed(1)} ${to.y.toFixed(1)}"/>`;
  }).join('');
  const dots=points.map(point=>`<circle class="mini-${point.type}" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${point.type==='mem'?2.8:1.85}"/>`).join('');
  return `<svg class="command-brain-svg" viewBox="0 0 300 190" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path class="mini-brain-outline" d="${outline}"/>
    <g class="mini-brain-edges">${lines}</g>
    <g class="mini-brain-dots">${dots}</g>
    <path class="mini-brain-divider" d="M150 33v122" stroke-dasharray="2 9"/>
  </svg>`;
}

function dashboardSnapshot() {
  const destinations = [
    ['OpenMausBot','/openmausbot/chat','Open the OpenMausBot workspace to chat with and manage your bots.','chat','Bot operations'],
    ['Bot Schedules','/openmausbot','See every bot\'s schedule, recent runs and anything needing attention.','chat','Bot operations'],
    ['Agent Chat','/agentchat','Follow agent conversations and recent job updates.','chat','Agent activity'],
    ['Memory Graph','/unified/graph','Explore live knowledge links across RepoQL, Tencent and memories.','memory','Knowledge'],
    ['Office Viewer','/office','Open the live protected office scene.','office','Workspace'],
  ];
  const REPOQL_ICON = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2.6 20.2 7.3v9.4L12 21.4 3.8 16.7V7.3z" opacity=".55" stroke="currentColor" stroke-width="1.5"/><path d="M12 8.6V12m0 0-3.3 2.2M12 12l3.3 2.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="7.3" r="1.75" fill="currentColor"/><circle cx="7.6" cy="15" r="1.75" fill="currentColor"/><circle cx="16.4" cy="15" r="1.75" fill="currentColor"/><circle cx="12" cy="12" r="1.05" fill="currentColor"/></svg>`;
  const BRAIN_ICON = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 3.5a3 3 0 0 0-3 3 3 3 0 0 0-2.5 4.6A3.2 3.2 0 0 0 5 17a3 3 0 0 0 4 2.6V3.5z" stroke="currentColor" stroke-width="1.35"/><path d="M15 3.5a3 3 0 0 1 3 3 3 3 0 0 1 2.5 4.6A3.2 3.2 0 0 1 19 17a3 3 0 0 1-4 2.6V3.5z" stroke="currentColor" stroke-width="1.35"/><path d="M9 9H7.2M9 14H6.8M15 9h1.8M15 14h2.2" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg>`;
  const iconBadges = {
    '/kanban': `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3.5" y="4.5" width="5.5" height="15" rx="1.8" stroke="currentColor" stroke-width="1.6"/><rect x="10.2" y="8" width="5.5" height="11.5" rx="1.8" stroke="currentColor" stroke-width="1.6"/><rect x="16.9" y="6" width="3.6" height="13.5" rx="1.6" stroke="currentColor" stroke-width="1.6"/></svg>`,
    '/openmausbot/chat': `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="7" width="16" height="13" rx="4" stroke="currentColor" stroke-width="1.6"/><circle cx="9" cy="13.5" r="1.3" fill="currentColor"/><circle cx="15" cy="13.5" r="1.3" fill="currentColor"/><path d="M12 7V4" stroke="currentColor" stroke-width="1.5"/></svg>`,
    '/agentchat': `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 7.5A3.5 3.5 0 0 1 8.5 4h7A3.5 3.5 0 0 1 19 7.5v4A3.5 3.5 0 0 1 15.5 15H11l-4 3v-3.2A3.5 3.5 0 0 1 5 11.5v-4Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 8.7h6M9 11.3h3.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
    '/office': `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="3.5" width="15" height="17" rx="2"/><path d="M2.5 20.5h19"/><path d="M8.5 7.5h2M13.5 7.5h2M8.5 11.5h2M13.5 11.5h2"/><path d="M10.5 20.5v-2.5a1.5 1.5 0 0 1 3 0v2.5"/></svg>`,
    '/unified/graph': BRAIN_ICON,
    '/repoql/control': REPOQL_ICON,
    '/unified/tencent': BRAIN_ICON,
    '/repoql/cheat-sheet': `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 5h10M7 9h10M7 13h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><rect x="4" y="3.5" width="16" height="17" rx="2.4" stroke="currentColor" stroke-width="1.6"/></svg>`,
    '/unified/usage': `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 18.5V12M12 18.5V7M19 18.5v-4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="5" cy="10.2" r="1.4" fill="currentColor"/><circle cx="12" cy="5.2" r="1.4" fill="currentColor"/><circle cx="19" cy="12.2" r="1.4" fill="currentColor"/></svg>`,
    '/architecture/memory': `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 4 4.5 7.5 12 11l7.5-3.5L12 4Zm-7.5 8L12 15.5 19.5 12M4.5 16.5 12 20l7.5-3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    '/architecture/orchestra': `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3.8" y="5" width="5" height="5" rx="1.4" stroke="currentColor" stroke-width="1.5"/><rect x="15.2" y="5" width="5" height="5" rx="1.4" stroke="currentColor" stroke-width="1.5"/><rect x="9.5" y="14" width="5" height="5" rx="1.4" stroke="currentColor" stroke-width="1.5"/><path d="M8.8 7.5h6.4M12 10.2V14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  };
  // Decorative only: these mini illustrations suggest the kind of workspace
  // visually, but they never imply live counts or hidden state.
  const cardIllustrations = {
    '/kanban': `<svg viewBox="0 0 300 190" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="17" y="19" width="266" height="152" rx="19" fill="currentColor" fill-opacity=".045" stroke="currentColor" stroke-opacity=".28"/><path d="M38 45H262" stroke="currentColor" stroke-opacity=".18"/><circle cx="42" cy="32" r="3" fill="currentColor" fill-opacity=".65"/><circle cx="53" cy="32" r="3" fill="currentColor" fill-opacity=".28"/><circle cx="64" cy="32" r="3" fill="currentColor" fill-opacity=".28"/><g fill="currentColor" fill-opacity=".075" stroke="currentColor" stroke-opacity=".35"><rect x="31" y="55" width="72" height="103" rx="9"/><rect x="114" y="55" width="72" height="103" rx="9"/><rect x="197" y="55" width="72" height="103" rx="9"/></g><g fill="currentColor" fill-opacity=".22"><rect x="39" y="64" width="36" height="5" rx="2.5"/><rect x="122" y="64" width="39" height="5" rx="2.5"/><rect x="205" y="64" width="44" height="5" rx="2.5"/></g><g fill="currentColor" fill-opacity=".13" stroke="currentColor" stroke-opacity=".46"><rect x="39" y="79" width="56" height="25" rx="5"/><rect x="39" y="110" width="56" height="25" rx="5"/><rect x="122" y="79" width="56" height="25" rx="5"/><rect x="122" y="110" width="56" height="33" rx="5"/><rect x="205" y="79" width="56" height="36" rx="5"/></g><g stroke="currentColor" stroke-opacity=".45" stroke-width="2" stroke-linecap="round"><path d="M47 88H74M47 94H63M130 88H162M130 94H148M213 88H246M213 94H234"/></g><circle cx="241" cy="136" r="13" fill="currentColor" fill-opacity=".16" stroke="currentColor" stroke-opacity=".55"/><path d="m235 136 4 4 8-9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    '/openmausbot/chat': `<svg viewBox="0 0 300 190" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="86" y="52" width="128" height="92" rx="26" fill="currentColor" fill-opacity=".08" stroke="currentColor" stroke-opacity=".5" stroke-width="2"/><path d="M150 52V30" stroke="currentColor" stroke-opacity=".5" stroke-width="2" stroke-linecap="round"/><circle cx="150" cy="26" r="6" fill="currentColor" fill-opacity=".55"/><circle cx="123" cy="92" r="11" fill="currentColor" fill-opacity=".45"/><circle cx="177" cy="92" r="11" fill="currentColor" fill-opacity=".45"/><path d="M128 120h44" stroke="currentColor" stroke-opacity=".5" stroke-width="3" stroke-linecap="round"/><path d="M60 98H44M256 98h-16M70 132 52 144M230 132l18 12" stroke="currentColor" stroke-opacity=".3" stroke-width="2" stroke-linecap="round"/></svg>`,
    '/agentchat': `<svg viewBox="0 0 300 190" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="47" y="43" width="108" height="71" rx="26" fill="currentColor" fill-opacity=".18" stroke="currentColor" stroke-opacity=".68"/><path d="M86 114 69 132l2-19" stroke="currentColor" stroke-opacity=".68" stroke-linecap="round" stroke-linejoin="round"/><rect x="146" y="78" width="107" height="60" rx="24" fill="currentColor" fill-opacity=".08" stroke="currentColor" stroke-opacity=".42"/><path d="M198 138 214 151l-1-13" stroke="currentColor" stroke-opacity=".42" stroke-linecap="round" stroke-linejoin="round"/><path d="M71 66h57M71 82h41M166 99h50M166 114h30" stroke="currentColor" stroke-opacity=".8" stroke-width="4" stroke-linecap="round"/></svg>`,
    '/office': `<svg viewBox="0 0 300 190" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="44" y="31" width="212" height="118" rx="18" fill="currentColor" fill-opacity=".05" stroke="currentColor" stroke-opacity=".35"/><rect x="58" y="45" width="184" height="89" rx="12" fill="currentColor" fill-opacity=".08" stroke="currentColor" stroke-opacity=".22"/><path d="M111 162h79M132 149l-8 13M167 149l8 13" stroke="currentColor" stroke-opacity=".4" stroke-linecap="round"/><rect x="74" y="60" width="73" height="28" rx="8" fill="currentColor" fill-opacity=".13"/><rect x="155" y="60" width="70" height="53" rx="8" fill="currentColor" fill-opacity=".09"/><path d="M84 71h36M84 79h22M166 73h48M166 82h32M166 91h39" stroke="currentColor" stroke-opacity=".54" stroke-linecap="round"/></svg>`,
    '/unified/graph': miniatureBrainGraph(),
    '/repoql/control': `<svg viewBox="0 0 300 190" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M42 51 96 35 145 80 220 43 263 89 215 147 144 132 78 156 42 103Z" stroke="currentColor" stroke-opacity=".4" stroke-width="1.7"/><path d="M96 35 78 156M145 80 144 132M220 43 215 147M42 103 145 80 263 89M78 156 215 147M96 35 220 43" stroke="currentColor" stroke-opacity=".27"/><g fill="currentColor" fill-opacity=".16" stroke="currentColor" stroke-width="2"><rect x="29" y="38" width="26" height="26" rx="7"/><rect x="84" y="23" width="24" height="24" rx="7"/><rect x="133" y="68" width="24" height="24" rx="7"/><rect x="208" y="31" width="24" height="24" rx="7"/><rect x="251" y="77" width="24" height="24" rx="7"/><rect x="202" y="135" width="26" height="26" rx="7"/><rect x="132" y="120" width="24" height="24" rx="7"/><rect x="66" y="144" width="24" height="24" rx="7"/><rect x="30" y="91" width="24" height="24" rx="7"/></g><g fill="currentColor"><circle cx="42" cy="51" r="4"/><circle cx="96" cy="35" r="4"/><circle cx="145" cy="80" r="4"/><circle cx="220" cy="43" r="4"/><circle cx="263" cy="89" r="4"/><circle cx="215" cy="147" r="4"/><circle cx="144" cy="132" r="4"/><circle cx="78" cy="156" r="4"/><circle cx="42" cy="103" r="4"/></g></svg>`,
    '/unified/tencent': `<svg viewBox="0 0 300 190" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M111 41c-18 0-33 15-33 33 0 3 .3 5.9 1.1 8.7-12.8 6.9-21.6 20.4-21.6 35.9 0 22.5 18.3 40.8 40.8 40.8 15.2 0 28.5-8.3 35.5-20.5 5.2 3.1 11.3 4.9 17.8 4.9 19 0 34.8-15.1 35.6-34 .7.1 1.4.1 2.1.1 22.8 0 41.3-18.5 41.3-41.3S252.1 28 229.3 28c-7.4 0-14.4 1.9-20.5 5.4C202.5 20 189.2 11 173.8 11c-17.1 0-31.5 11.1-36.8 26.4A33 33 0 0 0 111 41Z" stroke="currentColor" stroke-opacity=".28" stroke-width="2"/><g stroke="currentColor" stroke-opacity=".48"><path d="M107 111 138 92M161 73l23-17M165 104l28 18M122 127h52M86 90l23 16"/></g><g fill="currentColor"><circle cx="84" cy="89" r="6"/><circle cx="107" cy="111" r="6"/><circle cx="138" cy="92" r="6"/><circle cx="161" cy="73" r="6"/><circle cx="184" cy="56" r="6"/><circle cx="165" cy="104" r="6"/><circle cx="193" cy="122" r="6"/><circle cx="122" cy="127" r="6"/><circle cx="174" cy="127" r="6"/></g></svg>`,
    '/repoql/cheat-sheet': `<svg viewBox="0 0 300 190" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="72" y="29" width="158" height="132" rx="16" fill="currentColor" fill-opacity=".055" stroke="currentColor" stroke-opacity=".33"/><path d="M94 61h113M94 83h85M94 105h99M94 127h53" stroke="currentColor" stroke-opacity=".76" stroke-width="6" stroke-linecap="round"/><path d="M88 37h126" stroke="currentColor" stroke-opacity=".2"/></svg>`,
    '/unified/usage': `<svg viewBox="0 0 300 190" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M54 148h191" stroke="currentColor" stroke-opacity=".22" stroke-width="2"/><g fill="currentColor" fill-opacity=".14" stroke="currentColor" stroke-opacity=".55"><rect x="72" y="102" width="28" height="46" rx="8"/><rect x="116" y="80" width="28" height="68" rx="8"/><rect x="160" y="53" width="28" height="95" rx="8"/><rect x="204" y="89" width="28" height="59" rx="8"/></g><path d="M86 93 130 71 174 44 218 79" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" stroke-opacity=".82"/><g fill="currentColor"><circle cx="86" cy="93" r="5"/><circle cx="130" cy="71" r="5"/><circle cx="174" cy="44" r="5"/><circle cx="218" cy="79" r="5"/></g></svg>`,
    '/architecture/memory': `<svg viewBox="0 0 300 190" fill="none" xmlns="http://www.w3.org/2000/svg"><g fill="currentColor" fill-opacity=".08" stroke="currentColor" stroke-opacity=".32"><path d="M150 35 86 63l64 28 64-28-64-28Z"/><path d="M86 95l64 28 64-28"/><path d="M86 127l64 28 64-28"/></g><path d="M106 71h88M106 103h88M106 135h88" stroke="currentColor" stroke-opacity=".45" stroke-linecap="round"/><circle cx="150" cy="63" r="5" fill="currentColor"/><circle cx="150" cy="95" r="5" fill="currentColor"/><circle cx="150" cy="127" r="5" fill="currentColor"/></svg>`,
    '/architecture/orchestra': `<svg viewBox="0 0 300 190" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="40" y="44" width="65" height="42" rx="12" fill="currentColor" fill-opacity=".08" stroke="currentColor" stroke-opacity=".35"/><rect x="118" y="74" width="65" height="42" rx="12" fill="currentColor" fill-opacity=".08" stroke="currentColor" stroke-opacity=".35"/><rect x="196" y="104" width="65" height="42" rx="12" fill="currentColor" fill-opacity=".08" stroke="currentColor" stroke-opacity=".35"/><path d="M105 65h13c8 0 14 6 14 14v0M183 95h13c8 0 14 6 14 14v0" stroke="currentColor" stroke-opacity=".75" stroke-width="3" stroke-linecap="round"/><circle cx="72" cy="65" r="6" fill="currentColor"/><circle cx="150" cy="95" r="6" fill="currentColor"/><circle cx="228" cy="125" r="6" fill="currentColor"/></svg>`,
  };
  const featureCards = new Set();
  const tileShots = {'/openmausbot/chat':'openmausbot','/openmausbot':'bots','/agentchat':'lounge','/unified/graph':'memory','/office':'office-room'};
  const referenceDocuments = [
    ['RepoQL Cheat Sheet','/repoql/cheat-sheet'],
    ['Memory Architecture','/architecture/memory'],
    ['Orchestration Architecture','/architecture/orchestra'],
  ];
  const systemKnowledge = [
    ['RepoQL Dashboard','/repoql/control'],
    ['Tencent Dashboard','/unified/tencent'],
    ['Concepts','/knowledge/all'],
    ['Connections','/links'],
    ['Connectors','/knowledge/connectors'],
    ['Indexing and Sources','/indexing'],
  ];
  const diagnosticsTools = [
    ...(!nativeInstall ? [['AI Usage','/unified/usage']] : []),
    ['Bot fleet status','/openmausbot/fleet'],
    ...(nativeInstall ? [['Agents Control','/claude/agents']] : []),
    ['Diagnostics','/diagnostics'],
    ...(!nativeInstall ? [
      ['Harness Control Center','/harness'],
      ['Live Agents','/harness/agents'],
      ['Execution History','/harness/runs'],
    ] : []),
  ];
  if (typeof nativeInstall !== 'undefined' && nativeInstall) diagnosticsTools.push(['Windows Integration Status','/native/status']);
  // Values are filled only after successful authenticated, read-only responses.
  // The page itself remains usable even if Kanzo or Agent Chat is unavailable.
  const overview = [
    ['To do','ready','work','#/kanban','Kanzo ready tasks'],
    ['In progress','doing','chat','#/kanban','Kanzo active stage'],
    ['Review','review','memory','#/kanban','Kanzo review stage'],
    ['Recently active agents','agents','repoql','#/agentchat','Agent Chat activity, last 5 min'],
  ];
  return `<section class="command-overview block" aria-labelledby="command-focus-heading" id="command-live-overview">
    <div class="command-heading"><h2 id="command-focus-heading">Operations overview</h2>
      <span class="command-overview-actions"><span id="command-live-status" role="status" aria-live="polite">Checking live status…</span><button id="command-live-refresh" type="button">Refresh status</button></span></div>
    <div class="command-health" id="command-health" role="list" aria-label="Service health"></div>
    <div class="command-overview-grid">${overview.map(([title,key,accent,link,description]) => `<a class="command-overview-card" data-accent="${esc(accent)}" href="${esc(link)}"><span class="command-overview-name">${esc(title)}</span><strong class="command-overview-value" id="command-live-${esc(key)}">…</strong><small>${esc(description)}</small></a>`).join('')}</div>
  </section>
  <section aria-labelledby="goto-heading">
    <div class="command-heading"><h2 id="goto-heading">Primary workspaces</h2></div>
    <div class="command-links command-links-priority command-links-visual">${destinations.map(([title,link,description,accent,kicker])=>`<a class="command-link command-workspace${featureCards.has(link)?' command-workspace-feature':''}" data-accent="${esc(accent)}" href="#${esc(link)}">
      <span class="command-card-icon" aria-hidden="true">${iconBadges[link] || REPOQL_ICON}</span>
      <span class="command-card-content"><span class="command-card-kicker">${esc(kicker)}</span><strong>${esc(title)}</strong><span class="command-card-description">${esc(description)}</span><span class="command-card-cta">Open workspace <span aria-hidden="true">↗</span></span></span>
      <span class="command-card-illustration" aria-hidden="true">${cardIllustrations[link] || ''}</span>
      ${tileShots[link] ? `<img class="command-card-shot" src="/assets/tiles/${tileShots[link]}.webp?v=ts9" alt="" loading="lazy" decoding="async">` : ''}
    </a>`).join('')}</div>
  </section>
  <details class="command-more block" data-accent="office" open>
    <summary><span>Reference documents</span></summary>
    <div class="command-more-grid">${referenceDocuments.map(([title,link])=>`<a class="command-mini-chip" href="#${esc(link)}">${esc(title)}</a>`).join('')}</div>
  </details>
  <details class="command-more block" data-accent="memory" open>
    <summary><span>System knowledge</span></summary>
    <div class="command-more-grid">${systemKnowledge.map(([title,link])=>`<a class="command-mini-chip" href="#${esc(link)}">${esc(title)}</a>`).join('')}</div>
  </details>
  <details class="command-more block" data-accent="attention" open>
    <summary><span>Diagnostics</span></summary>
    <div class="command-more-grid">${diagnosticsTools.map(([title,link])=>`<a class="command-mini-chip" href="#${esc(link)}">${esc(title)}</a>`).join('')}</div>
  </details>`;
}

async function viewDashboard() {
  // Render immediately; operational counts are an optional read-only enhancement.
  APP.innerHTML = pageHead('Command center', '') +
    `<div id="dash" class="stack">${dashboardSnapshot()}</div>`;
  HOST_LINE.textContent = 'RepoQL Dashboard';
  if (window.matchMedia?.('(max-width:760px)').matches) {
    // Keep primary workspaces and live status prominent on phone-sized screens.
    // Secondary links remain accessible via their native disclosure controls.
    APP.querySelectorAll('#dash .command-more').forEach(details => { details.open = false; });
  }
  const panel = document.getElementById('command-live-overview');
  const refresh = document.getElementById('command-live-refresh');
  const status = document.getElementById('command-live-status');
  const epoch = state.routeEpoch;
  let busy = false;
  const update = (key, value) => {
    const output = panel?.querySelector(`#command-live-${key}`);
    if (output) output.textContent = value;
  };
  const loadOverview = async () => {
    if (busy || !panel?.isConnected) return;
    busy = true;
    refresh.disabled = true;
    status.textContent = 'Checking live status…';
    const [kanzo, agents] = await Promise.allSettled([
      (async () => {
        await api('/api/embed/kanzo/handshake', {timeoutMs:6000});
        return api('/embed/kanzo/api/board?project=all', {timeoutMs:8000});
      })(),
      api('/api/agentchat/presence', {timeoutMs:6000}),
    ]);
    if (epoch !== state.routeEpoch || !panel.isConnected) return;
    const tasks = kanzo.status === 'fulfilled' && Array.isArray(kanzo.value?.tasks) ? kanzo.value.tasks : null;
    for (const [key, stage] of [['ready','todo'],['doing','doing'],['review','review']]) {
      update(key, tasks ? String(tasks.filter(task => task?.status === stage).length) : '–');
    }
    const roster = agents.status === 'fulfilled' && agents.value?.available === true && Array.isArray(agents.value?.agents)
      ? agents.value.agents : null;
    update('agents', roster ? String(roster.filter(agent => agent?.status === 'working').length) : '–');
    const stamp = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    status.textContent = tasks && roster ? `Updated ${stamp}` : `Some services unavailable · ${stamp}`;
    const health = document.getElementById('command-health');
    if (health) {
      const tasksN = tasks ? tasks.length : 0;
      const items = [
        ['Agent Jobs', tasks ? 'up' : 'down', tasks ? `${tasksN} tasks` : 'not responding', '#/kanban'],
        ['Agent Chat', roster ? 'up' : 'down', roster ? `${roster.length} agents known` : 'not responding', '#/agentchat'],
        ['Diagnostics', 'link', 'runtime and service details', '#/diagnostics'],
      ];
      health.innerHTML = items.map(([name, st, note, href]) => `<a class="health-chip ${st}" role="listitem" href="${href}"><i aria-hidden="true"></i><b>${name}</b><span>${note}</span></a>`).join('');
    }
    refresh.disabled = false;
    busy = false;
  };
  refresh.addEventListener('click', () => { void loadOverview(); });
  void loadOverview();
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
      <text x="${pad.left - 6}" y="${yAt(value) + 3}" text-anchor="end" fill="var(--muted)" font-size="9" font-family="monospace">${value.toFixed(0)}</text>`;
  }).join("");

  wrap.innerHTML = `
    <svg class="chart" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="RepoQL CPU usage — ${label}">
      <defs>
        <linearGradient id="cpuFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--cyan)" stop-opacity="0.35"/>
          <stop offset="100%" stop-color="var(--cyan)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${ticks}
      <path d="${area}" fill="url(#cpuFill)"/>
      <path d="${line}" fill="none" stroke="var(--cyan)" stroke-width="1.6" stroke-linejoin="round"/>
      <circle cx="${xAt(points.length - 1)}" cy="${yAt(points[points.length - 1].avg)}" r="2.6" fill="var(--green)"/>
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
    inspector.innerHTML = `<div class="conn-inspector-head"><div><span class="conn-kicker">Selected memory</span><strong>${esc(node.name)}</strong><span class="muted small">${esc(node.category || 'uncategorised')} · ${neighbors.length} stored connections</span></div><a class="btn small primary" href="${href('/knowledge/item',{uri})}">View memory</a></div>
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
  if (tab === "runtime") return mountRuntime(panel);
  return mountCpu(panel, params);
}

// Diagnostics is the only default location for technical runtime metadata.
// Every status is sourced from an authenticated existing read API; a failed
// probe is explicitly unavailable, never synthesized as healthy or zero.
async function mountRuntime(panel) {
  const owner = state.routeAbort?.signal;
  panel.innerHTML = `<div class="block"><div class="block-title">Runtime & services</div>
      <p class="muted small">Version, collector and authority details for troubleshooting. These probes do not attest to memory recall, completed agent work or Office rendering.</p>
      <button class="btn" type="button" id="runtime-check">Refresh status</button>
      <span class="muted small" id="runtime-checked" role="status" aria-live="polite"></span></div>
      <div id="runtime-results" aria-live="polite"><div class="loading">Checking service status…</div></div>`;
  const target = panel.querySelector('#runtime-results');
  const button = panel.querySelector('#runtime-check');
  const label = panel.querySelector('#runtime-checked');
  const probes = [
    ['Dashboard', '/api/health'],
    ['Host status', '/api/status'],
    ['Harness collector', '/api/harness/health'],
    ['Run state authority', '/api/harness/rust'],
    ['Office viewer', '/api/harness/office'],
  ];
  let sequence = 0;
  const render = async () => {
    const epoch = ++sequence;
    button.disabled = true;
    label.textContent = 'Checking…';
    const results = await Promise.allSettled(probes.map(([, url]) => api(url)));
    if (owner?.aborted || epoch !== sequence || !target.isConnected) return;
    target.innerHTML = `<div class="grid cols-3">${results.map((result, index) => {
      const [name, url] = probes[index];
      const ok = result.status === 'fulfilled';
      const data = ok ? result.value : null;
      const explicitFailure = data?.ok === false || data?.available === false || data?.enabled === false || data?.stale === true;
      const stateText = !ok ? 'Unavailable' : explicitFailure ? 'Check required' : 'Responding';
      const version = [data?.version, data?.runtime_version, data?.build_version, data?.build?.version]
        .find(value => typeof value === 'string' && value.trim());
      const metadata = [
        version ? `<dt>Version</dt><dd>${esc(version)}</dd>` : '',
        name === 'Harness collector' ? `<dt>Last ingest</dt><dd>${esc(relative(data?.last_ingest))}</dd>
          <dt>Ingest errors</dt><dd>${data?.ingest_errors == null ? 'Unavailable' : esc(fmt(data.ingest_errors))}</dd>` : '',
        name === 'Office viewer' ? `<dt>Viewer</dt><dd>${data?.available === true ? 'Available (health only)' : 'Unavailable'}</dd>` : '',
      ].join('');
      return `<section class="block"><div class="block-title">${esc(name)}
          <span class="tag ${!ok || explicitFailure ? 'amber' : 'green'}">${stateText}</span></div>
          <dl class="kv"><dt>Endpoint</dt><dd class="mono">${esc(url)}</dd>${metadata}</dl>
          ${!ok ? `<p class="muted small">${esc(result.reason?.message || 'Probe unavailable')}</p>` : ''}</section>`;
    }).join('')}</div>
      <details class="block runtime-details"><summary>Run authority and collector internals</summary>
        ${rustAuthorityBlock(results[3].status === 'fulfilled' ? results[3].value : {available:false,error:'Status unavailable'})}
        <p class="muted small"><a href="#/harness/events">View telemetry events</a> · <a href="#/harness/performance">Run performance</a> · <a href="#/architecture/orchestra">How orchestration works</a></p>
      </details>`;
    label.textContent = 'Last checked ' + new Date().toLocaleTimeString('en-GB');
    button.disabled = false;
  };
  button.addEventListener('click', () => { render().catch(() => { button.disabled = false; label.textContent = 'Check failed'; }); });
  await render();
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
            <dt>Measured by</dt><dd>${nativeInstall?(data.available?'Native Rust Win32 collector':'Native Rust collector (unavailable)'):'systemd timer, 30 s'}</dd>
          </dl>
          <div class="small muted" style="margin-top:12px">${nativeInstall?'Windows CPU samples are recorded only by the optional native Rust bridge collector. Missing or unverified samples remain gaps; Linux history is never reused.':'Samples are collected by repoql-cpu-collector.timer, not by this page.'}</div>
        </div>
        <div class="block">
          <div class="block-title">Method</div>
          <div class="small muted" style="line-height:1.7">
            ${nativeInstall
              ? 'Win32 GetSystemTimes/GetProcessTimes via the Rust bridge: process usage is percentage of one logical core, not systemd quota. History is displayed only from the separate Windows collector database. Missing values stay unknown.'
              : 'cpu_pct = Δ(utime+stime) ÷ CLK_TCK ÷ Δseconds × 100, read from Linux /proc. Display normalized against the 4-core systemd CPU quota (CPUQuota=400%). Missing values stay unknown.'}
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

// Read-only metadata lint for a single loaded source document. This does
// not verify the evidence or change RepoQL concepts. The list API does not
// expose frontmatter, so do NOT scan every row with extra item requests.
function conceptMetadataCheck(meta, category, sourceAvailable) {
  if (!sourceAvailable) return {state: 'unavailable', issues: ['Source document not readable; metadata was not evaluated.']};
  const kind = String(category || '').toLowerCase().trim();
  const has = key => {
    const value = meta?.[key];
    return typeof value === 'string' ? Boolean(value.trim()) : Array.isArray(value) && value.length > 0;
  };
  if (!['principle','wisdom','rule','shape','knowledge'].includes(kind))
    return {state: 'not_evaluated', issues: ['No metadata contract is defined for this category.']};
  const issues = [];
  const relevance = has('relevance'), verification = has('verification'), ttl = has('ttlDays');
  if (kind !== 'principle' && !relevance) issues.push('Missing required relevance.');
  if (kind === 'principle' && relevance) issues.push('Principle must not specify relevance.');
  if (kind === 'principle' || kind === 'wisdom') {
    if (verification) issues.push('Verification is not allowed for this category.');
    if (ttl) issues.push('ttlDays is not allowed for this category.');
  } else {
    if (kind === 'knowledge' && !verification) issues.push('Knowledge requires verification.');
    if (kind === 'knowledge' && !ttl) issues.push('Knowledge requires ttlDays.');
    if (kind !== 'knowledge' && verification !== ttl) issues.push('Verification and ttlDays must be provided together.');
    if (ttl) {
      const n = Number(meta.ttlDays);
      if (!Number.isInteger(n) || n < 1 || n > 3650) issues.push('ttlDays must be an integer from 1 through 3650.');
    }
  }
  return {state: issues.length ? 'review_needed' : 'metadata_present', issues};
}

async function viewKnowledgeItem(params) {
  const uri = params.uri || "";
  APP.innerHTML = pageHead("Knowledge record", uri, `<a class="btn ghost" href="${href("/knowledge/all")}">Back to concepts</a>`) +
    `<div id="knowledge-item"><div class="loading">Loading record…</div></div>`;
  const data = await api(`/api/knowledge/item?uri=${encodeURIComponent(uri)}`);
  const record = data.record;
  const meta = frontMatter(data.content?.text || "");
  const tags = Array.isArray(meta.tags) ? meta.tags : meta.tags ? [meta.tags] : [];
  const metadata = conceptMetadataCheck(meta, data.category || record.category, data.content?.available === true);
  const metadataNote = metadata.state === 'metadata_present'
    ? 'Required fields are present. Accuracy, relevance, verification and expiry are not proven by this check.'
    : metadata.state === 'review_needed' ? 'Source metadata needs review; no change has been made.'
    : metadata.issues[0];
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
      <div class="block-title">Concept metadata check <span class="tag">read only</span></div>
      <p class="muted small">${esc(metadataNote)}</p>
      ${metadata.state === 'review_needed' ? `<ul class="small">${metadata.issues.map(issue => `<li>${esc(issue)}</li>`).join('')}</ul>` : ''}
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
  let includeHelp = params.help === "1";
  let page = Number(params.page || 1);
  const graphHost = `<div id="graph" class="conn-graph-host"><div class="conn-loading"><div class="ug-loader"><i></i><i></i><i></i></div><span>Laying out stored relationships…</span></div></div>`;
  APP.innerHTML = pageHead(connections ? "RepoQL Connections" : "Links & relationships", "Stored RepoQL relationships, deduplicated: mirrored concept copies collapse to one table row, reciprocal pairs collapse in the graph, and RepoQL help pages are hidden by default. These are not inferred dependencies.") +
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
       <label class="small muted" style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="link-help" ${includeHelp ? "checked" : ""}> Include RepoQL help docs</label>
       <span class="small muted" id="link-total"></span>
     </div>
     <div id="link-table" class="table-wrap"><div class="loading">Loading relationships…</div></div>
     <div id="link-pager"></div>
     ${connections ? "" : `<div style="margin-top:14px">${graphHost}</div>`}`;

  const next = sequencer();
  const load = async () => {
    const isCurrent = next();
    const data = await api(`/api/links?collection=${collection}&q=${encodeURIComponent(query)}&status=${encodeURIComponent(status)}&include_help=${includeHelp ? "1" : "0"}&page=${page}&page_size=${connections ? 25 : 50}`);
    if (!isCurrent()) return;
    const counts = data.counts || {};
    const storedKey = collection === "see_also" ? "see_also_stored" : collection === "markdown" ? "markdown_stored" : collection === "refers_to" ? "refers_to_stored" : collection === "composition" ? "composition_stored" : null;
    const stored = storedKey ? counts[storedKey] : null;
    document.getElementById("link-total").textContent = stored && !query && !status && stored > data.total
      ? `${fmt(data.total)} distinct · ${fmt(stored)} stored`
      : `${fmt(data.total)} relationships`;
    const rows = data.rows.map((row) => {
      const source = row.source_name || row.source_uri;
      const target = row.target_name || row.target_uri || row.destination_uri;
      return `<tr>
        <td>${row.source_uri ? `<a class="mono small" href="${href("/knowledge/item", { uri: row.source_uri })}">${esc(source)}</a>` : esc(source)}
          <div class="small">${categoryChip(row.source_category)}</div></td>
        <td class="mono small">${esc(row.type || "—")}</td>
        <td>${row.target_uri ? `<a class="mono small" href="${href("/knowledge/item", { uri: row.target_uri })}">${esc(target)}</a>` : `<span class="mono small">${esc(target)}</span>`}
          ${row.target_category ? `<div class="small">${categoryChip(row.target_category)}</div>` : ""}</td>
        <td class="small">${esc(row.provenance || "—")}${row.copies > 1 ? ` <span class="pill">${fmt(row.copies)} copies</span>` : ""}</td>
        <td>${row.status ? pill(row.status) : row.resolved === false ? `<span class="pill amber">unresolved</span>` : `<span class="pill green">stored</span>`}${row.occurrences > 1 ? ` <span class="pill">×${fmt(row.occurrences)}</span>` : ""}</td>
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
  document.getElementById("link-help").addEventListener("change", (event) => {
    includeHelp = event.target.checked;
    page = 1;
    setParams({ help: includeHelp ? "1" : "", page: 1 });
    load().catch((error) => toast("Links", error.message, "error"));
  });

  await Promise.all([load(), loadGraph().catch(() => {})]);
  schedule(() => load().catch(() => {}), 45000);
}

// ---------------------------------------------------------------- connectors

async function viewConnectors() {
  APP.innerHTML = pageHead('RepoQL Connectors', 'Source ingestion connectors · Separate from stored concept and code relationships') + `
    <div class="connectors-intro block">
      <div><span class="conn-kicker">External source ingestion</span><h2>Connect outside knowledge to RepoQL</h2>
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

const selectedFeatures = window.__SINGULARITY_VARIANT__?.features || null;
function featureAllowed(path) {
  if (nativeInstall && (path === "/harness" || path.startsWith("/harness/"))) return false;
  if (path === "/claude/agents") return nativeInstall;
  // Fleet-only controls need APIs outside the Windows product.
  if (nativeInstall && (path === "/agents-control" || path === "/reference/agents")) return false;
  if (!selectedFeatures) return true;
  if (path === "/office" || path.startsWith("/office/")) return selectedFeatures.office === true;
  if (path === "/kanban") return selectedFeatures.kanban === true;
  if (path === "/agentchat") return selectedFeatures.agent_chat === true;
  return true;
}
for (const link of document.querySelectorAll('[data-nav]')) {
  if (!featureAllowed(link.dataset.nav) || (nativeInstall && link.dataset.nav === '/unified/usage') || (link.dataset.nav === '/native/status' && !nativeInstall)) {
    link.hidden = true;
    link.dataset.variantDisabled = '1';
  }
  if (link.dataset.nav === '/unified/usage' && nativeInstall) {
    const label=link.querySelector('.nav-text');
    if (label) label.textContent=guiUsageName() + ' Usage';
    else link.textContent=guiUsageName() + ' Usage';
  }
}
for (const link of document.querySelectorAll('[data-dock]')) {
  if (!featureAllowed(link.dataset.dock)) link.hidden = true;
}

initNavigationUI();
renderThemeSwitcher();
applyTheme(storedTheme(), {persist:false});
if (!window.__SINGULARITY_LOCAL_LOGIN__) captureSecret();
else {
  try { sessionStorage.removeItem(SECRET_KEY); } catch {}
  state.token = null;
  const signout = document.getElementById('account-signout');
  if (signout) {
    signout.hidden = false;
    signout.addEventListener('click', async () => {
      const response = await fetch('/api/account/logout', {
        method: 'POST', credentials: 'same-origin',
        headers: {'Content-Type':'application/json','X-Requested-With':'repoql-dashboard'},
        body: '{}', cache: 'no-store'
      }).catch(() => null);
      if (response?.ok) location.replace('/');
    });
  }
}
// window.__RQDASH_ACCESS__ is set by the server when a Cloudflare Access JWT
// vouched for this browser on the public hostname; no capability key is needed.
// Local login serves this page only after the server has granted a session cookie
// (loopback auto-session), so no fragment key is needed there.
if (!state.token && !window.__RQDASH_ACCESS__ && !window.__SINGULARITY_LOCAL_LOGIN__) {
  showSignpost("This tab holds no dashboard key.");
} else {
  window.addEventListener("hashchange", route);
  // Defer the first render until this module has finished evaluating: views can
  // use module constants declared further down (HARNESS_RANGES), and a direct
  // deep link such as #/harness/performance would otherwise hit their TDZ.
  queueMicrotask(route);
}

// ---------------------------------------------------------------- harness
// Issue 789: Harness Control Center. Everything here is rendered from the
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
// A failed background poll cannot leave yesterday's values silently labelled
// as current. Preserve the previous view for diagnosis, but label it stale.
function harnessRefreshFailed(body) {
  if (!body?.isConnected) return;
  let banner = body.querySelector('#harness-refresh-warning');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'harness-refresh-warning';
    banner.className = 'block accent-amber';
    banner.setAttribute('role', 'status');
    banner.setAttribute('aria-live', 'polite');
    body.prepend(banner);
  }
  banner.textContent = 'Telemetry refresh failed. Values below may be out of date; current activity is not verified.';
  const stamp = document.getElementById('harness-updated');
  if (stamp) stamp.textContent = 'Refresh unavailable · last successful snapshot shown';
}


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
    <div class="metric ${tone}"><span class="value${String(value).length > 7 ? " long" : ""}">${esc(value)}</span>${unit ? `<span class="unit">${esc(unit)}</span>` : ""}</div>
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
  APP.innerHTML = pageHead("Harness Control Center", "Live state of the AI Orchestra harness: runs, agents, models, reviews and bounded telemetry health.", '<a class="btn small" href="#/openmausbot">OpenMausBot</a>') +
    harnessRangeBar("/harness", params) + `<div id="harness-body"><div class="loading">Reading harness telemetry…</div></div>`;
  const body = document.getElementById("harness-body");
  const next = sequencer();
  async function load() {
    const mine = next();
    const [o, h] = await Promise.all([
      api(`/api/harness/overview?range=${encodeURIComponent(range)}`),
      api("/api/harness/health"),
    ]);
    if (!mine()) return;
    applyHarnessRefresh(h?.dashboard_refresh_seconds ?? o?.telemetry?.dashboard_refresh_seconds);
    const t = o.telemetry || h || {};
    const health = h || t;
    const budgetPct = health.budget_pct == null ? null : Number(health.budget_pct);
    const budgetKnown = Number.isFinite(budgetPct) && budgetPct >= 0;
    const errorsKnown = typeof health.ingest_errors === 'number';
    const currentFailures = Array.isArray(o.alerts) ? o.alerts.length : null;
    const tile = (title, value, url, description, accent) => `<a class="command-link" data-accent="${esc(accent)}" href="${href(url)}">
      <strong>${esc(title)}: ${esc(value)}</strong><span>${esc(description)}</span></a>`;
    body.innerHTML = `<section class="block"><div class="command-heading"><h2>What needs attention</h2>
      <a href="#/diagnostics?tab=runtime">Runtime diagnostics</a></div>
      <div class="command-links">
        ${tile('Active runs', fmt(o.active_runs), '/harness/runs', 'Open execution history', 'harness')}
        ${tile('Active agents', fmt(o.active_agents), '/harness/agents', 'See workers and sessions', 'agents')}
        ${tile('Significant events', currentFailures === null ? 'Unavailable' : fmt(currentFailures), '/harness/events', 'Inspect warnings and failures', 'attention')}
        ${tile('Run performance', o.success_rate == null ? 'Unavailable' : Math.round(o.success_rate * 100) + '% success', '/harness/performance', 'Completion, latency and retries', 'history')}
      </div>
      <p class="muted small">A zero is shown only when the source reports zero. Dashboard telemetry is not the orchestration run authority.</p>
    </section>
    ${currentFailures > 0 ? `<section class="block"><div class="block-title">Recent significant events</div>
      ${dataTable(['Time','Category','Event','Detail','Count'],(o.alerts || []).slice(0,5),(a)=>`<tr>
        <td class="mono">${esc(relative(a.ts))}</td><td>${esc(a.kind || a.category)}</td>
        <td>${pill(a.severity || a.status)}</td><td class="wrap">${esc(a.detail || '')}</td>
        <td class="mono">${a.occurrences > 1 ? fmt(a.occurrences) : ''}</td></tr>`)}</section>` : ''}
    <details class="block runtime-details"><summary>Collector details</summary>
      <p class="muted small">For troubleshooting only. The full authority journal and service versions are under <a href="#/diagnostics?tab=runtime">Runtime diagnostics</a>.</p>
      <dl class="kv">
        <dt>Collector last ingest</dt><dd>${esc(relative(health.last_ingest))}</dd>
        <dt>Storage</dt><dd>${bytes(health.storage_bytes)} / ${bytes(health.budget_bytes)} (${budgetKnown ? budgetPct + '%' : 'Unavailable'})</dd>
        <dt>Retention</dt><dd>${health.detail_days == null ? 'Unavailable' : esc(String(health.detail_days)) + ' d detail'} · ${health.aggregate_days == null ? 'Unavailable' : esc(String(health.aggregate_days)) + ' d aggregates'}</dd>
        <dt>Ingest errors</dt><dd class="${errorsKnown && health.ingest_errors ? 'err' : ''}">${errorsKnown ? fmt(health.ingest_errors) : 'Unavailable'}</dd>
        <dt>Last error</dt><dd>${esc(health.last_error || 'Not reported')}</dd>
      </dl>
    </details>`;
    const stamp = document.getElementById("harness-updated");
    if (stamp) stamp.textContent = `updated ${new Date().toLocaleTimeString("en-GB")}`;
  }
  await load();
  schedule(() => load().catch(() => harnessRefreshFailed(body)), harnessInterval());
}

// ------------------------------------------------------------- liveness
// /api/harness/agents classifies every run, seat and session as
// fresh | stale | unknown | ended | inactive. Only fresh means active: silence
// is not a heartbeat, an unknown row has no usable source update timestamp at
// all, and neither may be rendered as activity.
const LIVENESS_STATES = ["fresh", "stale", "unknown", "ended", "inactive"];
const LIVENESS_UNKNOWN_NOTE = "no source update timestamp recorded";

// Liveness of one row. `legacy` is what that payload meant before the backend
// exposed liveness, so an older backend keeps its previous rendering instead of
// being re-read as activity it never reported.
function livenessState(row, legacy = null) {
  const raw = row && typeof row.liveness === "string" ? row.liveness.trim().toLowerCase() : "";
  if (LIVENESS_STATES.includes(raw)) return raw;
  return LIVENESS_STATES.includes(legacy) ? legacy : null;
}

function livenessLabel(state) {
  switch (state) {
    case "fresh": return "live";
    case "stale": return "not active · stale";
    case "unknown": return "not active · timestamp unknown";
    case "ended": return "ended";
    case "inactive": return "inactive";
    default: return "unknown";
  }
}

// One honest sentence per non-fresh state; fresh rows say nothing extra.
function livenessNote(row, state) {
  if (state === "stale") {
    // runs carry age_seconds, desktop sessions carry age_ms; both are the
    // backend's own sample, so the note never estimates an age.
    const raw = row ? (row.age_seconds ?? (row.age_ms == null ? null : Number(row.age_ms) / 1000)) : null;
    const age = raw == null ? null : Number(raw);
    return Number.isFinite(age) && age > 0 ? `no source update for ${ms(age * 1000)}` : "no update for 15+ min";
  }
  if (state === "unknown") return LIVENESS_UNKNOWN_NOTE;
  if (state === "ended") return "terminal timestamp recorded";
  if (state === "inactive") return "status does not claim to be active";
  return "";
}

function livenessTone(state) {
  return state === "fresh" ? "green" : state === "stale" ? "amber" : "";
}

function sessionRow(x) {
  const state = livenessState(x, x.live ? "fresh" : "stale");
  // A row whose own report is inactive (idle, closed, ended) says more than the
  // class can: show that claim, never a running one the row did not make. Stale
  // and unknown rows keep their existing pill. The name is the source's own
  // agent name when it reports one.
  const reported = String(x.state || "").trim().toLowerCase();
  // Only a report that itself says the row is idle/closed/ended may replace the
  // label; an "open"/"active" claim never becomes the word shown for an
  // inactive row, or the pill would read "open" while liveness says inactive.
  const ACTIVE_CLAIMS = ["running", "live", "fresh", "active", "busy", "open", "started", "working"];
  const claimed = state === "inactive" && reported && !ACTIVE_CLAIMS.includes(reported) && reported !== "inactive";
  const label = state === "fresh" ? (x.state || "live") : claimed ? reported : livenessLabel(state);
  const note = (claimed && String(x.liveness_reason || "").trim()) || livenessNote(x, state);
  const title = String(x.agent_name || "").trim() || x.harness || "freebuff";
  return `<div class="harness-node">
    <span class="node-dot"></span>
    <div><strong>${esc(title)}</strong>
      <div class="muted small">${esc(x.model || "model not recorded")} · ${esc(x.agent_mode || "—")} · ${esc(x.execution_mode || "—")} · ${fmt(x.messages)} msgs</div>
      <div class="muted small mono">${esc(String(x.session_id).slice(0, 8))}${x.last_turn_outcome ? " · last turn " + esc(x.last_turn_outcome) : ""}</div>
      ${note ? `<div class="muted small">${esc(note)}</div>` : ""}</div>
    <span class="pill ${livenessTone(state)}">${esc(label)}</span>
    <span class="muted mono small">${esc(relative(x.last_activity))}</span>
  </div>`;
}

function sessionsBlock(sessions) {
  if (!sessions.length) return "";
  return `<div class="block accent-cyan" style="margin-bottom:14px">
    <div class="block-title">Freebuff Desktop <span class="tag">${sessions.length} session${sessions.length === 1 ? "" : "s"} · last 2 h</span></div>
    <div class="harness-tree">
      ${sessions.map(sessionRow).join("")}
    </div>
    <p class="muted small">Session metadata only — titles, prompts and message bodies are never read or stored.</p>
  </div>`;
}

// Seat activity comes from the backend's `active` flag: a seat is active only
// while its run is fresh and the seat itself has not finished. A payload from
// before that flag keeps the old status pill exactly as it was.
function seatPill(a) {
  const status = String((a && a.status) || "assigned");
  if (!a || typeof a.active !== "boolean") {
    const tone = status === "error" ? "red" : status === "waiting" ? "amber" : "green";
    return `<span class="pill ${tone}">${esc(status)}</span>`;
  }
  if (a.active) return `<span class="pill green">${esc(status)}</span>`;
  let state = livenessState(a, "inactive");
  // A fresh run whose seat already finished is an inactive seat, not an active one.
  if (state === "fresh") state = "inactive";
  const tone = state === "stale" ? "amber" : status === "error" ? "red" : "";
  const detail = state === "unknown" ? "not active · timestamp unknown" : livenessLabel(state);
  return `<span class="pill ${tone}">${esc(status)} · ${esc(detail)}</span>`;
}

function runBlock(r) {
  const started = Date.parse(r.started_at || "");
  const elapsed = Number.isNaN(started) ? null : Date.now() - started;
  const agents = r.agents || [];
  const state = livenessState(r, r.stale === true ? "stale" : "fresh");
  const accent = state === "fresh" ? "accent-cyan" : state === "stale" ? "accent-amber" : "";
  const tag = `${esc(r.mode || "mode?")} · ${esc(state === "fresh" ? "live" : livenessLabel(state))}`;
  const note = livenessNote(r, state);
  return `<div class="block ${accent}" style="margin-bottom:14px">
    <div class="block-title">${esc(r.run_id)} <span class="tag">${tag}</span></div>
    <div class="harness-title">${esc(r.title || runLabel(r))}</div>
    <div class="toolbar" style="margin-top:10px">
      ${state === "fresh" ? pill(r.state) : `<span class="pill">${esc(displayLabel(r.state, "state not reported"))}</span>`} ${pill("stage " + (r.stage || "—"))}
      <span class="muted mono">elapsed ${ms(elapsed)} · updated ${esc(relative(r.updated_at))}${note ? " · " + esc(note) : ""}</span>
    </div>
    <div class="harness-tree">
      <div class="harness-node coordinator"><span class="node-dot"></span>
        <div><strong>coordinator</strong><div class="muted small">orchestrates · ${esc(r.roster || "default roster")}</div></div>
        <span class="pill cyan">${esc(r.stage || "—")}</span></div>
      ${agents.map((a) => `<div class="harness-node">
        <span class="node-dot"></span>
        <div><strong>${esc(a.agent)}</strong><div class="muted small">${esc(a.model || "model not recorded")} · ${esc(a.provider || "provider?")}</div></div>
        ${seatPill(a)}
        <span class="muted mono small">${ms(a.duration_ms)}</span></div>`).join("") || `<div class="muted small" style="padding-left:18px">no seats recorded yet</div>`}
    </div>
  </div>`;
}

function runsBlock(runs) {
  return runs.map(runBlock).join("");
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
    body.innerHTML = sessionsBlock(sessions) + runsBlock(runs);
  }
  await load();
  schedule(() => load().catch(() => harnessRefreshFailed(body)), 15000);
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
  const subEl = APP.querySelector('.page-head .sub');
  if (subEl && c) subEl.textContent = `${fmt(c.samples)} runs in ${range}: median ${ms(c.p50)}, 95th percentile ${ms(c.p95)}. Missing samples are shown as missing.`;
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
      ${metricBlock("Retries", fmt(p.retries), "", "", `${ms(p.retry_attempt_ms)} retry-attempt time — ${p.retry_definition}`)}
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
  const query = { range: params.range || "24h", category: params.kind === "gate_decision" ? "operator" : params.kind === "nudge_recorded" ? "agent" : params.kind === "hook_registration" ? "operator" : (params.category || ""),
    severity: params.severity || "", kind: ["gate_decision", "nudge_recorded", "hook_registration"].includes(params.kind) ? params.kind : "", limit: 120 };
  const gateOnly = query.kind === "gate_decision";
  const nudgeOnly = query.kind === "nudge_recorded";
  const hookOnly = query.kind === "hook_registration";
  APP.innerHTML = pageHead(gateOnly ? "Gate Evidence" : nudgeOnly ? "Nudge Evidence" : hookOnly ? "Hook Registration" : "Important Events", gateOnly
    ? "Recorded decisions from the existing harness audit. No rows means no retained evidence, not a successful gate check."
    : nudgeOnly ? "Recorded nudges, not proof that an agent acted on them or saved model calls."
    : hookOnly ? "Plugin initialization decisions, not proof that every active session is currently hooked."
    : "Failures, repeated model errors, fallbacks, review rejections, interruptions and gate decisions. Identical events are collapsed with a count.") + `
    <div class="toolbar">
      <a class="btn small ${!gateOnly && !nudgeOnly && !hookOnly ? 'primary' : ''}" href="${href('/harness/events', {range: query.range})}">All events</a>
      <a class="btn small ${gateOnly ? 'primary' : ''}" href="${href('/harness/events', {range: query.range, kind: 'gate_decision'})}">Gate decisions</a>
      <a class="btn small ${nudgeOnly ? 'primary' : ''}" href="${href('/harness/events', {range: query.range, kind: 'nudge_recorded'})}">Nudges</a>
      <a class="btn small ${hookOnly ? 'primary' : ''}" href="${href('/harness/events', {range: query.range, kind: 'hook_registration'})}">Hook startup</a>
      <select class="select" id="h-cat" ${gateOnly || nudgeOnly || hookOnly ? 'disabled' : ''}>${["", "run", "agent", "model", "tool", "review", "operator"].map(v => `<option value="${v}" ${query.category === v ? "selected" : ""}>${v || "any category"}</option>`).join("")}</select>
      <select class="select" id="h-sev">${["", "info", "warn", "error", "critical"].map(v => `<option value="${v}" ${query.severity === v ? "selected" : ""}>${v || "any severity"}</option>`).join("")}</select>
      ${HARNESS_RANGES.map(([value, label]) => `<a class="btn small ${query.range === value ? "primary" : ""}" href="${href("/harness/events", { ...query, range: value })}">${label}</a>`).join("")}
      <button class="btn" id="h-apply">Apply</button>
    </div>
    <div id="harness-body"><div class="loading">Reading events…</div></div>`;
  document.getElementById("h-apply").addEventListener("click", () => {
    location.hash = href("/harness/events", { ...query, category: gateOnly || hookOnly ? "operator" : nudgeOnly ? "agent" : document.getElementById("h-cat").value,
      severity: document.getElementById("h-sev").value });
  });
  const body = document.getElementById("harness-body");
  const e = await api(`/api/harness/events?${new URLSearchParams(query).toString()}`);
  const source = e.events || [];
  if (gateOnly) {
    const gateName = ev => {
      const status = String(ev.status || '');
      const reason = String(ev.detail || '');
      if (status.startsWith('repoql_') || reason.startsWith('RepoQL pre-work')) return 'RepoQL';
      if (status.startsWith('review_')) return 'Reviewer';
      if (status.startsWith('kanzo_')) return 'Kanzo';
      if (status.startsWith('task_')) return 'Task ownership';
      if (status.startsWith('cred_') || status.startsWith('operator_override_')) return 'Credentials';
      return 'Other';
    };
    body.innerHTML = `<p class="muted small">Audit collection begins at the end of the source log on its first successful ingest. These are observed decisions, not an assertion that every hook registered or every action was intercepted.</p>` +
      dataTable(["Time", "Gate", "Decision", "Session", "Tool", "Reason", "Count"], source, (ev) => `<tr>
        <td class="mono">${esc(ev.ts)}</td><td>${esc(gateName(ev))}</td>
        <td>${pill(ev.status || 'unknown')}</td><td class="mono wrap">${esc(ev.session_id || 'unattributed')}</td>
        <td>${esc(ev.tool || '—')}</td><td class="wrap">${esc(ev.detail || 'not recorded')}</td>
        <td class="mono">${ev.occurrences > 1 ? fmt(ev.occurrences) : ''}</td></tr>`, "No retained gate decisions match these filters.");
  } else if (hookOnly) {
    body.innerHTML = `<p class="muted small">These are startup audit records only. A LOADED event alone does not prove the tool wrappers were registered; check GATED and current source health.</p>` +
      dataTable(["Time", "Plugin", "Decision", "Recorded detail"], source, (ev) => `<tr>
        <td class="mono">${esc(ev.ts)}</td><td>${esc(ev.tool || '—')}</td>
        <td>${pill(ev.status || 'unknown')}</td><td class="wrap">${esc(ev.detail || 'not recorded')}</td></tr>`, 'No hook startup evidence retained.');
  } else if (nudgeOnly) {
    body.innerHTML = `<p class="muted small">Source emits NUDGE audit decisions; delivery and subsequent action are not proven by these rows.</p>` +
      dataTable(["Time", "Session", "Tool", "Recorded nudge", "Count"], source, (ev) => `<tr>
        <td class="mono">${esc(ev.ts)}</td><td class="mono wrap">${esc(ev.session_id || 'unattributed')}</td>
        <td>${esc(ev.tool || '—')}</td><td class="wrap">${esc(ev.detail || 'not recorded')}</td>
        <td class="mono">${ev.occurrences > 1 ? fmt(ev.occurrences) : ''}</td></tr>`, 'No retained nudges match these filters.');
  } else {
    body.innerHTML = dataTable(["Time", "Category", "Event", "Severity", "Run", "Agent", "Detail", "Count"], source, (ev) => `<tr>
      <td class="mono">${esc(ev.ts)}</td><td>${esc(ev.category)}</td><td>${esc(ev.kind)}</td><td>${pill(ev.severity || "")}</td>
      <td class="mono">${ev.run_id ? `<a href="${href("/harness/run", { id: ev.run_id })}">${esc(ev.run_id)}</a>` : "—"}</td>
      <td>${esc(ev.agent || "—")}</td><td class="wrap">${esc(ev.detail || "")}</td><td class="mono">${ev.occurrences > 1 ? fmt(ev.occurrences) : ""}</td></tr>`, "No events match these filters.");
  }
}

// Dashboard access (fleet#893 A2): the local dashboard signs in automatically on
// this computer; password mode stays available as the explicit opt-in, and the
// Setup health page (one row per integration, one Fix action) is one click away.
async function renderDashboardAccess() {
  const modeEl = document.getElementById("auth-mode");
  const button = document.getElementById("auth-toggle");
  const out = document.getElementById("auth-saved");
  if (!modeEl || !button || !out) return;
  let info;
  try {
    info = await api("/api/account/status");
  } catch (e) {
    modeEl.textContent = "unavailable";
    out.textContent = e.message;
    return;
  }
  const auto = info.mode !== "password";
  modeEl.innerHTML = auto
    ? `${pill("ok")} <span class="muted small">no password on this computer</span>`
    : `${pill("warning")} <span class="muted small">${info.configured ? "owner account required" : "no owner account yet"}</span>`;
  button.textContent = auto ? "Require a password" : "Sign in automatically";
  button.dataset.mode = auto ? "password" : "auto-local";
  button.disabled = false;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const result = await api("/api/account/mode", { method: "POST", body: { mode: button.dataset.mode } });
      if (result.mode === "password") {
        // The mode switch revoked this session: continue on the account page.
        location.href = "/account.html";
        return;
      }
      out.textContent = "Automatic local sign-in restored.";
      toast("Dashboard access changed", "Automatic local sign-in");
      await renderDashboardAccess();
    } catch (e) {
      out.textContent = e.message;
      button.disabled = false;
    }
  });
}

async function viewHarnessSettings(params) {
  APP.innerHTML = pageHead("Nannies and Settings", "Effective state of fleet nannies plus the dashboard's own bounded telemetry controls.") +
    `<div id="harness-body"><div class="loading">Reading settings…</div></div>`;
  const body = document.getElementById("harness-body");
  const [n, s] = await Promise.all([api("/api/harness/nannies"), api("/api/harness/settings")]);
  const settings = n.settings || {};
  const cg = n.catgpt || {};
  body.innerHTML = `
    <div class="block"><div class="block-title">Dashboard access</div>
      <p class="muted small">This dashboard opens already signed in on this computer. Requiring a password switches it to the private owner-account flow; the way back is the same button.</p>
      <div class="grid cols-2" style="margin-bottom:12px">
        <div class="field"><span class="label">Mode</span><span class="value" id="auth-mode">reading…</span></div>
        <div class="field"><span class="label">Integrations</span><span class="value"><a href="/setup">Open Setup health</a> <span class="muted small">one row per integration, one Fix action</span></span></div>
      </div>
      <button class="btn small" id="auth-toggle" disabled>Reading…</button>
      <div id="auth-saved" class="muted small" style="margin-top:8px"></div>
    </div>
    <div class="block" style="margin-top:14px"><div class="block-title">Telemetry controls</div>
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
    <div class="block" style="margin-top:14px"><div class="block-title">CatGPT continuation watcher</div>
      <p class="muted small">A detached host watcher that sends the continuation prompt into one ChatGPT thread after each completed turn. Changing the target while it is running requires Save &amp; restart.</p>
      <div class="grid cols-2" style="margin-bottom:12px">
        <div class="field"><span class="label">Status</span><span class="value">${cg.paused ? `<span class="pill amber">paused</span>` : pill(cg.running ? "running" : (cg.available ? "stopped" : "unavailable"))} ${cg.pid ? `<span class="mono small">pid ${esc(cg.pid)}</span>` : ""} <span class="muted small">${cg.paused ? "nudges disabled" : "nudges enabled"}</span></span></div>
        <div class="field"><span class="label">Last action</span><span class="value mono">${esc(cg.action || "—")}</span></div>
        <div class="field"><span class="label">Thread</span><span class="value">${esc(cg.thread_name || "—")}</span></div>
        <div class="field"><span class="label">Conversation ID</span><span class="value mono">${cg.thread_id ? (cg.thread_url ? `<a href="${esc(cg.thread_url)}" target="_blank" rel="noopener">${esc(cg.thread_id)}</a>` : esc(cg.thread_id)) : "resolved from the name at start"}</span></div>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:end">
        <label class="field" style="flex:1 1 260px"><span class="label">Thread name</span><input class="input" id="cg-thread-name" value="${esc(cg.thread_name || "")}" placeholder="Completed review package" ${cg.available ? "" : "disabled"}></label>
        <label class="field" style="flex:1 1 320px"><span class="label">Conversation ID (optional if the name is unique)</span><input class="input" id="cg-thread-id" value="${esc(cg.thread_id || "")}" placeholder="Paste conversation ID" ${cg.available ? "" : "disabled"}></label>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn small" data-cg-action="save" ${cg.available ? "" : "disabled"}>Save target</button>
          ${cg.paused
            ? `<button class="btn small primary" data-cg-action="resume" ${cg.available ? "" : "disabled"}>Resume nudges</button>`
            : `<button class="btn small danger" data-cg-action="pause" ${cg.available ? "" : "disabled"}>Pause nudges</button>`}
          ${!cg.paused ? `<button class="btn small primary" data-cg-action="${cg.running ? "restart" : "start"}" ${cg.available ? "" : "disabled"}>${cg.running ? "Save &amp; restart" : "Save &amp; start"}</button>` : ""}
          ${cg.running ? `<button class="btn small danger" data-cg-action="stop">Stop</button>` : ""}
        </div>
      </div>
      <p class="muted small">The name is resolved to an exact thread title when the conversation ID is blank. An ID, when present, wins. Save &amp; restart applies a new target without waiting for the next stop condition. Pausing writes <code>enabled=false</code>, stops the watcher, and makes a direct start refuse until resumed.</p>
      ${cg.pending ? `<p class="muted small" style="color:var(--amber)">Pending send (${esc(cg.pending.status || "unknown")} at ${esc(cg.pending.at || "—")}). The next start verifies the conversation before sending anything. <button class="btn small" data-cg-action="clear-pending" ${cg.running ? "disabled" : ""}>Clear pending</button></p>` : ""}
      ${cg.send_in_flight ? `<p class="muted small" style="color:var(--amber)">A send is in flight. Wait for the verification line before stopping or restarting; forcing a stop can leave an unverified prompt.</p>` : ""}
      <div id="cg-out" class="muted small" style="margin-top:8px"></div>
      <details style="margin-top:8px"><summary class="muted small">Last watcher log lines</summary><pre class="mono small" style="white-space:pre-wrap">${esc((cg.log_tail || []).join("\n") || "No log lines.")}</pre></details>
    </div>
    <div class="block" style="margin-top:14px"><div class="block-title">Systemd nannies</div>
      <p class="muted small">Enable or disable the timer at boot and runtime. Start/stop changes only this run. Mandatory review, lease, asset and compliance gates are not configurable here.</p>
      <div class="table-wrap"><table class="data"><thead><tr><th>Nanny</th><th>Purpose</th><th>Configured</th><th>Effective</th><th>Last trigger</th><th>Control</th></tr></thead><tbody>
        ${(n.nannies || []).map((x) => {
          const enabled = String(x.configured || "").startsWith("enabled");
          const active = x.effective === "active";
          const confirmStop = x.safety_critical ? "1" : "0";
          return `<tr><td><strong>${esc(x.name)}</strong><div class="muted small">${esc(x.unit)}</div></td>
          <td class="wrap">${esc(x.purpose)}</td><td>${pill(enabled ? "ok" : x.configured)}</td><td>${pill(active ? "running" : x.effective)}</td>
          <td class="mono small">${esc(x.last_trigger || "—")}</td><td class="nowrap">
            <button class="btn small" data-nanny-unit="${esc(x.unit)}" data-nanny-action="${enabled ? "disable" : "enable"}" data-nanny-confirm="${enabled ? confirmStop : "0"}">${enabled ? "Disable" : "Enable"}</button>
            <button class="btn small" data-nanny-unit="${esc(x.unit)}" data-nanny-action="${active ? "stop" : "start"}" data-nanny-confirm="${active ? confirmStop : "0"}">${active ? "Stop" : "Start"}</button>
          </td></tr>`;
        }).join("")}
      </tbody></table></div>
      <div class="block-title" style="margin-top:16px">Recent nanny changes</div>
      ${dataTable(["When", "Target", "Action", "Result", "Actor"], n.audit || [], (a) => `<tr><td class="mono">${esc(a.at || "")}</td><td class="mono">${esc(a.unit || "")}</td><td>${esc(a.action || "")}</td><td>${pill(a.ok ? "ok" : "failed")}</td><td>${esc(a.actor || "")}</td></tr>`, "No dashboard nanny changes yet.")}
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

  document.querySelectorAll("[data-nanny-unit]").forEach((b) => b.addEventListener("click", async () => {
    const unit = b.dataset.nannyUnit;
    const action = b.dataset.nannyAction;
    if (b.dataset.nannyConfirm === "1" && !confirm(`This is a safety guard. ${action === "disable" ? "Disable" : "Stop"} ${unit}?`)) return;
    b.disabled = true;
    try {
      const r = await api("/api/harness/nannies", { method: "POST", body: { unit, action, confirm: b.dataset.nannyConfirm === "1" } });
      toast(r.ok ? "Nanny updated" : "Nanny change failed", `${unit}: ${action} → ${r.after?.effective || r.error || "unknown"}`, r.ok ? "ok" : "error");
      await viewHarnessSettings(params);
    } catch (e) {
      toast("Nanny change refused", e.message, "error");
      b.disabled = false;
    }
  }));

  const cgAction = async (action) => {
    const name = document.getElementById("cg-thread-name")?.value.trim() || "";
    const id = document.getElementById("cg-thread-id")?.value.trim() || "";
    let force = false;
    if ((action === "stop" || action === "restart" || action === "pause") && cg.send_in_flight) {
      if (!confirm("A send is in flight. Stopping now can leave an unverified prompt. Continue?")) return;
      force = true;
    }
    if (action === "pause" && !confirm("Pause nudges for this thread? The watcher stops and a direct start will be refused until you resume.")) return;
    if (action === "clear-pending" && !confirm("Clear the pending send record? The next start will not re-verify it.")) return;
    const out = document.getElementById("cg-out");
    if (out) out.textContent = `${action} requested…`;
    try {
      const r = await api("/api/harness/nannies", { method: "POST", body: { unit: "catgpt-thread-watch", action, thread_name: name, thread_id: id, force } });
      toast(r.ok ? "Watcher updated" : "Watcher action failed", `${action} → ${r.status?.state || r.error || "unknown"}`, r.ok ? "ok" : "error");
      await viewHarnessSettings(params);
    } catch (e) {
      if (out) out.textContent = e.message;
      toast("Watcher action refused", e.message, "error");
    }
  };
  document.querySelectorAll("[data-cg-action]").forEach((b) => b.addEventListener("click", () => cgAction(b.dataset.cgAction)));
  await renderDashboardAccess();
}

// Keep Office on the authenticated dashboard origin. A separate Office hostname
// requires its own Cloudflare login even when the dashboard already works.
// Fixed, same-origin iframe destinations only. Never trust a health endpoint to
// turn an arbitrary URL into an authenticated navigation target.
function validNativeEmbed(kind, value) {
  if (kind === "kanzo") return value === "/embed/kanzo/";
  return kind === "office" && value === "/embed/office/?embed=1";
}

function nativeViewerFailure(body, title, reason, retry) {
  if (!body.isConnected) return;
  body.innerHTML = `<div class="block accent-amber" role="alert"><div class="block-title">${esc(title)} <span class="tag amber">unavailable</span></div>
    <p class="muted">${esc(reason)}</p><button id="native-viewer-retry" class="btn small">Try again</button></div>`;
  body.querySelector('#native-viewer-retry')?.addEventListener('click', retry);
}

function nativeViewerFrameState(body, frameSelector, statusSelector) {
  const frame = body.querySelector(frameSelector), status = body.querySelector(statusSelector);
  if (!frame || !status) return;
  // iframe load confirms only a navigation event. It cannot certify that the
  // inner app authenticated or rendered successfully.
  frame.addEventListener('load', () => {
    if (frame.isConnected) status.textContent = 'Viewer loaded · check the workspace above';
  });
  frame.addEventListener('error', () => {
    if (frame.isConnected) status.textContent = 'Viewer failed to load · use Try again';
  });
}

async function viewKanban(params = {}) {
  const phone=window.matchMedia?.('(max-width:760px)').matches===true;
  APP.innerHTML = pageHead('Agent Jobs', '') +
    `<section id="kanban-body" class="kn-shell"><div class="loading">Connecting to Kanzo…</div></section>`;
  const body = document.getElementById('kanban-body');
  try {
    // The same secured, loopback-only Kanzo proxy used by the former iframe.
    await api('/api/embed/kanzo/handshake');
  } catch {
    nativeViewerFailure(body, 'Kanzo',
      'The local Kanzo service could not authorize this session. Check the board service or dashboard login.', viewKanban);
    return;
  }
  if (!body.isConnected) return;
  const stop = mountNativeKanban(body, api, { initialTaskId: Number(params.task) });
  state.routeAbort?.signal?.addEventListener('abort', stop, {once:true});
}

async function viewOffice() {
  APP.innerHTML = `<section id="office-body" class="native-panel-shell"><div class="loading">Checking Office availability…</div></section>`;
  const body = document.getElementById('office-body');
  let st;
  try { st = await api('/api/harness/office'); }
  catch (error) {
    nativeViewerFailure(body, 'Claude Office', 'The Office health check failed. No viewer session has been opened.', viewOffice);
    return;
  }
  if (!body.isConnected) return;
  if (st?.available !== true) {
    nativeViewerFailure(body, 'Claude Office', st?.reason || 'Office is not reachable from the dashboard host.', viewOffice);
    return;
  }
  const frame_src = st.embed_url;
  if (!validNativeEmbed('office', frame_src)) {
    nativeViewerFailure(body, 'Claude Office',
      'The same-origin Office launch URL is missing or invalid. Check CLAUDE_OFFICE_EMBED_URL.', viewOffice);
    return;
  }
  try { await api('/api/embed/office/handshake'); }
  catch (error) {
    nativeViewerFailure(body, 'Claude Office', 'Office is reachable but the protected viewer session could not be established.', viewOffice);
    return;
  }
  if (!body.isConnected) return;
  const frame = `<iframe class="office-view-embed native-panel-frame" title="Claude Office live view" src="${esc(frame_src)}"
      allow="clipboard-write" referrerpolicy="no-referrer" loading="eager"></iframe>`;
  body.innerHTML = `${frame}
      <p class="muted small" id="office-viewer-status" role="status" aria-live="polite" style="display:none">Loading the Office viewer…</p>`;
  nativeViewerFrameState(body, '.office-view-embed', '#office-viewer-status');
}

// Unified Rust data plane UI, inherits authenticated api() and existing routing.

// Unified Systems: bounded browser graph, Tencent management, fleet usage.
// No external CDN or browser-side upstream credentials.
async function viewUnifiedGraph() {
  const NET_ICON='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="6" r="2.2"/><circle cx="18" cy="5" r="2.2"/><circle cx="12" cy="13" r="2.6"/><circle cx="5" cy="19" r="2.2"/><circle cx="19" cy="18" r="2.2"/><path d="M6.8 7.2 10.3 11.4M16.3 6.6 13.6 11M7 17.9l3-3M14.5 14.6l3 2.4"/></svg>';
  const BRAIN_ICON='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3.5a3 3 0 0 0-3 3 3 3 0 0 0-2.5 4.6A3.2 3.2 0 0 0 5 17a3 3 0 0 0 4 2.6V3.5z"/><path d="M15 3.5a3 3 0 0 1 3 3 3 3 0 0 1 2.5 4.6A3.2 3.2 0 0 1 19 17a3 3 0 0 1-4 2.6V3.5z"/><path d="M9 9H7.2M9 14H6.8M15 9h1.8M15 14h2.2"/></svg>';
  APP.innerHTML=`<section class="ug-hero ug-hero-minimal"><h1>Live memory graph</h1></section>
    <div class="ug-toolbar graph-controls ug-compact">
      <button type="button" class="ug-filters-toggle" id="ug-filters-toggle" aria-expanded="false" aria-controls="ug-toolbar-secondary">Filters and view options</button>
      <div class="ug-toolbar-group ug-toolbar-secondary" id="ug-toolbar-secondary">
        <div class="ug-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>
        <input id="ug-search" class="input wide" type="search" placeholder="Find a topic, entity or relationship" aria-label="Search graph"></div>
        <div class="ug-chips" role="group" aria-label="Sources">
          <label class="graph-toggle ug-chip rq"><input type="checkbox" id="ug-repoql" checked><i></i>RepoQL</label>
          <label class="graph-toggle ug-chip tx"><input type="checkbox" id="ug-tencent" checked><i></i>Tencent</label>
          <label class="graph-toggle ug-chip mem"><input type="checkbox" id="ug-memories" checked><i></i>Memories</label>
          <label class="graph-toggle ug-chip cross"><input type="checkbox" id="ug-cross" checked><i></i>Cross-system</label>
        </div>
        <div class="ug-chips" role="group" aria-label="3D options">
          <label class="graph-toggle ug-chip"><input type="checkbox" id="ug-3d-names"><i></i>Names</label>
        </div>
        <label class="ug-clarity-label" for="ug-detail-level">Detail
          <select id="ug-detail-level" class="select" aria-label="Graph detail level">
            <option value="overview">Overview · key topics</option>
            <option value="all" selected>Explore all loaded topics</option>
          </select>
        </label>
        <label class="ug-clarity-label" for="ug-connections">Links
          <select id="ug-connections" class="select" aria-label="Displayed connections">
            <option value="focus">On selection</option>
            <option value="all" selected>All visible links</option>
          </select>
        </label>
        <div class="ug-viz" id="ug-mode" role="radiogroup" aria-label="Visualisation">
          <button type="button" role="radio" class="ug-viz-btn" data-mode="network" aria-checked="false">${NET_ICON}<span>Network</span></button>
          <button type="button" role="radio" class="ug-viz-btn" data-mode="neural" aria-checked="true">${BRAIN_ICON}<span>Brain</span></button>
          <button type="button" role="radio" class="ug-viz-btn" data-mode="3d" aria-checked="false">${BRAIN_ICON}<span>3D</span></button>
          <i class="ug-viz-glider" aria-hidden="true"></i>
        </div>
        <div class="ug-tools">
          <label class="ug-limit"><span>Nodes</span><select class="select" id="ug-limit" aria-label="Max graph nodes"><option>250</option><option selected>500</option><option>1000</option><option>1500</option></select></label>
          <div class="ug-zoom" role="group" aria-label="Zoom">
            <button class="btn" id="ug-zoom-out" aria-label="Zoom out">−</button><button class="btn" id="ug-fit" aria-label="Fit network">Fit</button><button class="btn" id="ug-zoom-in" aria-label="Zoom in">+</button>
          </div>
          <a class="btn small" href="#/openmausbot">Bot learning</a>
          <button class="btn primary" id="ug-reload">↻ Refresh</button>
        </div>
      </div>
    </div>
    <div class="unified-graph-layout">
      <div class="graph-stage ug-stage-shell">
        <div class="graph-stage-heading ug-stage-heading"><div class="ug-stage-copy"><strong>Memory network</strong><span id="ug-stage-caption" class="visually-hidden"></span></div></div>
        <canvas id="ug-canvas" class="unified-graph-canvas" tabindex="0" role="img" aria-label="Interactive network. Select any node or link to inspect relationships. Drag to pan, pinch with two fingers or scroll to zoom."></canvas>
        <div id="ug-graph-stats" class="visually-hidden" role="status"></div>
        <div class="ug-legend" aria-hidden="true"><span class="rq"><i></i>RepoQL</span><span class="tx"><i></i>Tencent</span><span class="mem"><i></i>Memories</span><span class="cross"><i></i>Cross-system link</span></div>
        <div class="ug-loading" id="ug-loading" role="status"><div class="ug-loader"><i></i><i></i><i></i></div><strong>Mapping knowledge network…</strong><span>Reading RepoQL and Tencent MemoryCore. A cold load can take around 10 seconds.</span></div>

      </div>
      <aside class="graph-side"><section class="block graph-details ug-inspector-card" id="ug-detail" aria-label="Relationship inspector"><div class="ug-empty-insp"><div class="ug-empty-orb"></div><strong>Explore your memory</strong><span>Choose a topic to reveal its relationships.</span></div></section>
      <details class="block ug-source-disclosure"><summary class="block-title">Source diagnostics</summary><p class="muted small ug-source-update" id="ug-info">Loading…</p><div id="ug-sources" class="graph-source-list muted">Checking…</div></details>
      </aside>
    </div>
    <div class="block ug-topic-explorer"><div class="ug-topic-head"><div class="block-title">Explore visible topics <span class="tag" id="ug-visible-count"></span></div><p class="muted small" id="ug-projection-note">All sources are available. Mobile initially shows a smaller projection for smoother navigation; choose a larger node limit or Explore all loaded topics when needed.</p></div><div class="unified-node-list ug-topic-grid" id="ug-results"></div><button class="btn small" id="ug-show-topics" type="button" hidden>Show more topics</button></div>
    <div class="ug-sheet" id="ug-sheet" hidden>
      <button class="ug-sheet-scrim" id="ug-sheet-scrim" type="button" tabindex="-1" aria-label="Close details"></button>
      <section class="ug-sheet-panel" role="dialog" aria-labelledby="ug-sheet-title">
        <header class="ug-sheet-head"><strong id="ug-sheet-title">Relationships</strong><button class="ug-sheet-x" id="ug-sheet-x" type="button" aria-label="Close details">✕</button></header>
        <div class="ug-sheet-body" id="ug-sheet-body"></div>
      </section>
    </div>`;
  const el=id=>document.getElementById(id);
  let raw={nodes:[],edges:[],sources:[]}, graph=raw, annotations={}, active=null, disposed=false, refreshing=false,showAllTopics=false;
  const sourceChecks=()=>['repoql','tencent','memories'].filter(k=>el('ug-'+k)?.checked);
  const alive=()=>!disposed&&Boolean(el('ug-canvas'));
  const setText=(id,value)=>{const node=el(id); if(node) node.textContent=value;};
  function refreshStageMeta(filtered=null){
    const mode=({neural:'Brain mode','3d':'3D mode'})[el('ug-mode')?.dataset.active]||'Network mode';
    const detail=el('ug-detail-level')?.value==='all'?'all loaded topics':'overview';
    const links=el('ug-connections')?.value==='all'?'all visible links':'focus links';
    setText('ug-stage-caption', `${mode} · ${links} · ${detail} · ${el('ug-limit')?.value||'500'} node sample`);
    if(filtered){
      const sourceCount=sourceChecks().length;
      setText('ug-stage-source-pill', `${sourceCount} source${sourceCount===1?'':'s'} selected`);
    }
  }
  const edgeKey=e=>'edge:'+String(e.id||`${e.source}|${e.type||'link'}|${e.target}`);
  function annotated(data){return {...data,
    nodes:(data.nodes||[]).map(n=>({...n,display_label:annotations[n.id]?.display_label||n.label,annotation_notes:annotations[n.id]?.notes||''})),
    edges:(data.edges||[]).map(e=>({...e,annotation_notes:annotations[edgeKey(e)]?.notes||'',display_label:annotations[edgeKey(e)]?.display_label||e.type}))};}
  // Brain is the default (operator 2026-10-26); an explicit later choice persists under the v2 key.
  const phoneShell=window.matchMedia?.('(max-width:768px), (hover:none) and (pointer:coarse)');
  // Phones start on the plain network layout; the saved choice still wins.
  let initialMode='3d';try{const saved=localStorage.getItem('repoql.graph.mode.v3');if(saved==='network'||saved==='neural'||saved==='3d')initialMode=saved;}catch{}
  const setModeUI=(mode)=>{el('ug-mode').dataset.active=mode;document.documentElement.dataset.ugMode=mode==='3d'?'neural':mode;if(!document.getElementById('ug-3d-switch')){const st=document.createElement('style');st.id='ug-3d-switch';st.textContent='#ug-mode{grid-template-columns:1fr 1fr 1fr!important}#ug-mode .ug-viz-glider{width:calc(33.333% - 2.7px)!important}#ug-mode[data-active="neural"] .ug-viz-glider{transform:translateX(100%)!important}#ug-mode[data-active="3d"] .ug-viz-glider{transform:translateX(200%)!important}';document.head.appendChild(st);}el('ug-mode').querySelectorAll('[data-mode]').forEach(b=>{const on=b.dataset.mode===mode;b.setAttribute('aria-checked',String(on));b.tabIndex=on?0:-1;});};
  setModeUI(initialMode);
  // Phones and touch tablets render the same 2D canvas as desktop; only the
  // starting projection is smaller so a 390px stage stays readable.
  if(phoneShell?.matches){
    // Phones show every loaded topic and every link, as desktop does, from a 250-node sample.
    el('ug-limit').value='250';
    el('ug-detail-level').value='all';
    el('ug-connections').value='all';
  }
  if(!document.getElementById('ug-compact-css')){const st=document.createElement('style');st.id='ug-compact-css';
    st.textContent='html .ug-toolbar.ug-compact.graph-controls{display:block!important;padding:0!important;margin-bottom:8px!important;border:0!important;background:none!important;box-shadow:none!important}'
    +'html .ug-toolbar.ug-compact .ug-filters-toggle{display:flex!important;align-items:center;justify-content:space-between;width:100%;min-height:34px!important;margin:0!important;padding:0 12px;border:1px solid rgba(120,140,175,.28);border-radius:10px;background:rgba(14,22,36,.9);color:#cfe0f5;font:600 13px system-ui,sans-serif;cursor:pointer}'
    +'html .ug-toolbar.ug-compact .ug-filters-toggle::after{content:"\\25BE";opacity:.7;transition:transform .18s}'
    +'html .ug-toolbar.ug-compact .ug-filters-toggle[aria-expanded="true"]::after{transform:rotate(180deg)}'
    +'html .ug-toolbar.ug-compact .ug-toolbar-secondary:not(.open){display:none!important}'
    +'html .ug-toolbar.ug-compact .ug-toolbar-secondary.open{display:flex!important;flex-wrap:wrap;gap:6px 8px;align-items:center;justify-content:flex-start;margin-top:6px;padding:8px;border:1px solid rgba(120,140,175,.22);border-radius:10px;background:rgba(10,16,28,.92)}'
    +'.ug-compact .ug-search{flex:1 1 100%}.ug-compact .ug-search .input{min-height:34px!important;padding-top:4px;padding-bottom:4px}'
    +'html .ug-compact .ug-chips{display:contents!important}html .ug-compact .graph-toggle.ug-chip{flex:0 0 auto!important;width:auto!important;padding:3px 10px!important;min-height:28px!important;font-size:12px}'
    +'.ug-compact .select,.ug-compact .btn{min-height:32px!important;padding-top:3px!important;padding-bottom:3px!important;font-size:12px!important}'
    +'.ug-compact .ug-clarity-label,.ug-compact .ug-limit{font-size:11px;gap:4px}'
    +'.ug-compact .ug-tools{margin-left:0!important;gap:6px;flex-wrap:wrap}'
    +'.ug-compact .ug-viz{min-height:32px}.ug-compact .ug-viz-btn{min-height:28px!important;padding:2px 8px!important;font-size:12px}'
    +'html .ug-hero.ug-hero-minimal{padding-top:4px!important;padding-bottom:4px!important;margin-bottom:6px!important}.ug-hero-minimal h1{font-size:20px!important;margin:0!important}';
    document.head.appendChild(st);}
  {const nm=el('ug-3d-names');if(nm){try{nm.checked=localStorage.getItem('repoql.brain3d.names')==='1'}catch{}
    nm.addEventListener('change',()=>{try{localStorage.setItem('repoql.brain3d.names',nm.checked?'1':'0')}catch{}window.dispatchEvent(new CustomEvent('brain3d-option',{detail:{names:nm.checked}}))});}
}
  el('ug-filters-toggle')?.addEventListener('click',(e)=>{const t=e.currentTarget,o=t.getAttribute('aria-expanded')!=='true';t.setAttribute('aria-expanded',String(o));el('ug-toolbar-secondary')?.classList.toggle('open',o);});
  let viewer=null;
  // Phones slide the same inspector up as a sheet; desktop keeps the side panel.
  const sheet=el('ug-sheet'), sheetBody=el('ug-sheet-body'), sheetClose=el('ug-sheet-x'), sheetScrim=el('ug-sheet-scrim');
  const inspectorCard=el('ug-detail'), inspectorHome=inspectorCard?.parentElement, inspectorNext=inspectorCard?.nextElementSibling;
  function openSheet(){return; /* phones: show details below the graph, no overlay */ if(!sheet||!phoneShell?.matches)return;
    if(inspectorCard.parentElement!==sheetBody)sheetBody.appendChild(inspectorCard);
    sheet.hidden=false;document.body.classList.add('ug-sheet-open');sheetClose?.focus({preventScroll:true});}
  function closeSheet(){if(!sheet||sheet.hidden)return;
    if(inspectorCard.parentElement===sheetBody)inspectorHome.insertBefore(inspectorCard,inspectorNext);
    sheet.hidden=true;document.body.classList.remove('ug-sheet-open');}
  const sheetKeys=event=>{if(event.key==='Escape'&&!sheet?.hidden)closeSheet();};
  const sheetFit=event=>{if(!event.matches)closeSheet();};
  document.addEventListener('keydown',sheetKeys);phoneShell?.addEventListener?.('change',sheetFit);
  sheetScrim?.addEventListener('click',closeSheet);
  sheetClose?.addEventListener('click',()=>{closeSheet();el('ug-canvas')?.focus({preventScroll:true})});
  viewer=createKnowledgeGraph(el('ug-canvas'),{mode:initialMode,onSelect:(node,edges,edge)=>{
    active=node?{kind:'node',id:node.id}:edge?{kind:'edge',id:edgeKey(edge)}:null;
    renderInspector(node,edge);
    if(node||edge)openSheet();else closeSheet();
  }});
  if(initialMode==='3d')Promise.resolve().then(()=>viewer.settled?.()).then(()=>{const actual=viewer.getMode();if(actual!==initialMode){setModeUI(actual);refreshStageMeta()}});
  function renderInspector(node,edge){const area=el('ug-detail');if(!area)return;
    if(!node&&!edge){area.innerHTML='<div class="ug-empty-insp"><div class="ug-empty-orb"></div><strong>Explore your memory</strong><span>Choose a topic to reveal its actual links. The layout is illustrative; source records and relationships remain authoritative.</span></div>';return;}
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
      <p class="muted small wrap">${esc(node?.source_id||edge?.id||key)}</p>
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
    viewer.filter({sources:sourceChecks(),cross:el('ug-cross').checked,query:el('ug-search').value,
      detail:el('ug-detail-level').value,connections:el('ug-connections').value});
    const filtered=viewer.getVisible();
    // A changed filter or refreshed sample must not leave a stale inspector open.
    if(active?.kind==='node'&&!filtered.nodes.some(n=>n.id===active.id))viewer.focus(null);
    else if(active?.kind==='edge'&&!filtered.edges.some(e=>edgeKey(e)===active.id))viewer.focus(null);
    if(fit)viewer.fit();
    setText('ug-graph-stats', `${fmt(filtered.nodes.length)} loaded nodes · ${fmt(filtered.edges.length)} recorded links`);
    refreshStageMeta(filtered);
    el('ug-visible-count').textContent=filtered.omitted
      ?`${fmt(filtered.nodes.length)} of ${fmt(filtered.totalVisibleBeforeProjection)} topics shown`
      :`${fmt(filtered.nodes.length)} loaded topics shown`;
    el('ug-projection-note').textContent=filtered.omitted
      ?`Overview shows ${fmt(filtered.nodes.length)} high-connectivity source records, selected deterministically across sources. ${fmt(filtered.omitted)} loaded records are hidden from this view, not deleted. Search or choose Explore all loaded topics to inspect them.`
      :`Showing all matching records from the currently loaded sample. Node limit controls how many records the API fetches; a healthy source does not imply complete index coverage.`;
    const ranked=[...filtered.nodes].sort((a,b)=>Number(b.degree||0)-Number(a.degree||0));
    const searching=Boolean(el('ug-search').value.trim());
    const visibleCount=searching||showAllTopics?Math.min(90,ranked.length):Math.min(12,ranked.length);
    el('ug-results').innerHTML=ranked.slice(0,visibleCount).map(n=>`<button class="btn small graph-result" data-node="${esc(n.id)}"><span class="result-dot ${n.source_system==='tencent'?'tx':n.source_system==='memories'?'mem':'rq'}"></span>${esc(n.display_label||n.label)}</button>`).join('')||'<span class="muted small">No matching topics. Adjust search or filters.</span>';
    const more=el('ug-show-topics');more.hidden=searching||ranked.length<=12;
    more.textContent=showAllTopics?'Show fewer topics':`Show more topics (${fmt(ranked.length-12)} more)`;
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
      el('ug-sources').innerHTML=(data.sources||[]).map(s=>`<div class="graph-source-row"><span>${esc(s.name)}</span>${pill(s.available?'online':'unavailable')}</div>${!s.available?`<p class="muted small">${esc(s.error||'No response from source')}</p>`:''}`).join('')||'No source information';
      if(active){if(active.kind==='node')viewer.focus(active.id);else viewer.focusEdge(active.id.replace(/^edge:/,''));}
      loading(false);
    }catch(error){if(alive()){
      if(!raw.nodes?.length)loading(true,error.message||'Unified graph unavailable');
      else {
        // Cached source records remain visible, but are explicitly marked stale.
        setText('ug-graph-stats', 'Previously loaded graph · refresh failed');
        setText('ug-info', 'Refresh failed. Showing previously loaded source data.');
      }
    }throw error;}
    finally{refreshing=false;if(alive()){el('ug-reload').disabled=false;if(loadPending){loadPending=false;load().catch(e=>{if(alive())toast('Graph',e.message,'error')});}}}
  }
  for(const id of ['ug-repoql','ug-tencent','ug-cross','ug-detail-level','ug-connections'])el(id).addEventListener('change',()=>applyFilters(true));
  el('ug-show-topics').addEventListener('click',()=>{showAllTopics=!showAllTopics;applyFilters(false)});
  el('ug-search').addEventListener('input',()=>applyFilters(true));
  el('ug-limit').addEventListener('change',()=>load().catch(e=>{if(alive())toast('Graph',e.message,'error')}));
  // Memories are fetched only while their option is on (thousands of linkless files): a toggle refetches.
  el('ug-memories').addEventListener('change',()=>load().catch(e=>{if(alive())toast('Graph',e.message,'error')}));
  el('ug-reload').addEventListener('click',()=>load().catch(e=>{if(alive())toast('Graph',e.message,'error')}));
  el('ug-fit').addEventListener('click',()=>viewer.fit());
  el('ug-zoom-in').addEventListener('click',()=>viewer.zoomBy(1.3));
  el('ug-zoom-out').addEventListener('click',()=>viewer.zoomBy(1/1.3));
  const chooseMode=(mode)=>{setModeUI(mode);Promise.resolve(viewer.setMode(mode)).then(()=>{const actual=viewer.getMode();if(actual!==mode)setModeUI(actual);refreshStageMeta();try{localStorage.setItem('repoql.graph.mode.v3',actual)}catch{}})};
  el('ug-mode').addEventListener('click',e=>{const b=e.target.closest('button[data-mode]');if(b)chooseMode(b.dataset.mode)});
  el('ug-mode').addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();
    const order=['network','neural','3d'],at=order.indexOf(el('ug-mode').dataset.active),next=order[(at+(e.key==='ArrowRight'?1:2))%3];chooseMode(next);el('ug-mode').querySelector(`[data-mode="${next}"]`)?.focus();});
  state.cleanup=()=>{disposed=true;document.removeEventListener('keydown',sheetKeys);phoneShell?.removeEventListener?.('change',sheetFit);closeSheet();viewer.dispose()};
  await load().catch(e=>{if(alive())toast('Graph',e.message,'error')});schedule(()=>{if(!document.hidden && alive())load().catch(e=>{if(alive())toast('Graph refresh',e.message,'error')})},120000);
}

// Embed the original upstream applications instead of reproducing their controls.
// URLs come only from authenticated server configuration (never query parameters).
async function viewNativePanel(kind) {
  const tencent = kind === 'tencent';
  const name = tencent ? 'Tencent Dashboard' : kind === 'kanzo' ? 'Agent Jobs' : 'RepoQL Dashboard';
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
  if (kind === 'repoql' || kind === 'tencent' || kind === 'kanzo') {
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
}
async function viewTencentNative() { return viewNativePanel('tencent'); }
async function viewRepoqlNative() { return viewNativePanel('repoql'); }
async function viewKanbanNative() { return viewNativePanel('kanzo'); }

// Live OpenChamber invocation coverage is intentionally not added to Orchestra
// ledger totals: the same underlying model call may appear in both sources.
function renderOpenChamberCoverage(payload, selectedDays = 90) {
  if(payload?.available===false) return `<p class="muted">${esc(payload.reason||'No OpenChamber snapshot')}</p>`;
  if(!payload||payload.schema!=='openchamber-coverage/1') return '<p class="muted">OpenChamber summary unavailable</p>';
  const period=payload.windows?.[String(selectedDays)] || payload;
  const total=period.totals||{};
  const rows=Object.entries(period.by_provider||{}).sort((a,b)=>Number(b[1].tokens||0)-Number(a[1].tokens||0));
  // The OpenCode Go rows in this database are the same calls the fleet ledger
  // counts, so only the non-Go remainder is genuinely outside the fleet total.
  const counted=rows.filter(([name])=>name==='opencode-go').reduce((n,[,r])=>n+Number(r.tokens||0),0);
  const uncovered=Math.max(0,Number(total.tokens||0)-counted);
  const short=n=>n>=1e9?(n/1e9).toFixed(2)+'B':n>=1e6?(n/1e6).toFixed(2)+'M':n>=1e3?(n/1e3).toFixed(1)+'k':String(n);
  return `<p class="small">Every OpenChamber assistant call, direct sessions included. This is a coverage view over the OpenChamber session database, not a fleet source: it overlaps the fleet total above and is never added to it.</p>
    <p class="muted small">Of the ${short(Number(total.tokens||0))} tokens here, ${short(counted)} are OpenCode Go calls already counted in the fleet total (same session database); the remaining ${short(uncovered)} are OpenChamber providers that no fleet source measures, so they are outside the fleet total too.</p>
    <div class="grid cols-3">
      ${metricBlock('OpenChamber calls',fmt(total.calls),'',"cyan",`${fmt(total.missing_token_calls)} without exact primary receipts`)}
      ${metricBlock('Measured tokens',fmt(total.tokens),'',"purple",total.tokens == null ? `${fmt(total.measured_calls)} measured calls; token coverage unknown` : `${fmt(total.measured_calls)} measured calls; five OpenChamber components`)}
      ${metricBlock('Unmeasured calls',fmt(total.missing_token_calls),'',"",'No provider token receipt; excluded from measured tokens')}
    </div><p class="muted small">Snapshot ${esc(payload.captured_at)} · selected ${esc(selectedDays)} days · ${esc(payload.timezone)} · all-provider direct session view (90-day retained source).</p>
    ${dataTable(['Provider','Calls','With tokens','Total tokens','Unmeasured'],rows,([name,r])=>`<tr><td>${esc(displayLabel(name, 'Unattributed'))}</td><td>${fmt(r.calls)}</td><td>${fmt(r.measured_calls)}</td><td>${fmt(r.tokens)}</td><td>${fmt(r.missing_token_calls)}</td></tr>`,'No sources measured')}`;
}

async function viewNativeInstallStatus(){
  if (!nativeInstall) return;
  const profile=window.__SINGULARITY_VARIANT__;
  APP.innerHTML=pageHead('Native Windows integration status', 'Read-only checks are not end-to-end acceptance.')+
    '<div id="native-status-body" class="block">Checking configured services…</div>';
  const result=await api('/api/native/windows/readiness');
  const rows=Object.entries(result.services||{});
  document.getElementById('native-status-body').innerHTML=`<p class="muted small">Installation option ${esc(profile.variant)} · ${esc(guiUsageName())} · RepoQL ${esc(result.repoql_required_version||'unknown')}. Service reachability does not prove indexing, capture, restart recovery, subscription metering or GUI integration.</p>
    <div class="table-wrap"><table class="data"><thead><tr><th>Component</th><th>Evidence</th><th>Reason</th></tr></thead><tbody>${rows.map(([key,value])=>`<tr><td>${esc(key.replaceAll('_',' '))}</td><td>${pill(value.state)}</td><td>${esc(value.reason||'Specific local probe passed; functional acceptance pending')}</td></tr>`).join('')}</tbody></table></div>`;
}

async function viewUnifiedUsage() {
  const nativeGui=nativeInstall;
  APP.innerHTML=pageHead(nativeGui?guiUsageName()+' Usage':'Fleet AI Usage', nativeGui?'Only locally reported receipts attributable to this installed GUI. Subscription allowances and complete totals are not available.':'Measured tokens and source coverage. Financial estimates are not displayed.')+`
    <div class="unified-topline"><span class="live-beacon"><i></i> ${nativeGui?'NATIVE GUI RECEIPTS':'FLEET TELEMETRY'}</span><span class="muted small">Reported receipts only · no inferred tokens</span></div>
    <div class="toolbar"><select id="usage-period" class="select"><option value="1">1 day</option><option value="7">7 days</option><option value="30" selected>30 days</option><option value="90">90 days</option></select><button id="usage-reload" class="btn primary">Refresh</button><span id="usage-age" class="muted small"></span></div>
    <div id="usage-summary" class="grid cols-3"></div>
    <div class="block" id="usage-history-block" style="margin-top:14px"><div class="block-title">Daily input and output tokens</div><div id="usage-token-chart" class="ob-chart"></div></div>
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
  if(nativeGui){
    // Native Windows does not surface fleet/Freebuff or provider-wide usage as
    // desktop-subscription metrics. A recent page cannot produce a daily chart.
    document.getElementById('fb-details')?.remove();
    document.getElementById('fb-allowance')?.closest('details')?.remove();
    document.getElementById('usage-openchamber')?.closest('details')?.remove();
    document.getElementById('usage-history-block')?.remove();
    const note=document.createElement('p');note.className='muted small';
    note.textContent=guiUsageName()+' receipts: recent source-attributed samples only. Other GUI, Freebuff and unrelated provider traffic are excluded. '+(window.__SINGULARITY_VARIANT__?.gui==='openchamber-desktop'?'For authoritative provider plan quotas, open OpenChamber Settings → Usage; this dashboard does not claim to mirror those limits.':'Claude Code hook usage does not prove a subscription allowance or complete desktop-only token history.');
    document.getElementById('usage-summary')?.before(note);
  }
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
    sparkChart(document.getElementById('fb-chart'),dailyRows,[{key:'input_tokens',label:'Input (gross)',color:'#4aabff'},{key:'fresh_input_tokens',label:'Fresh input',color:'#8b8b90'},{key:'output_tokens',label:'Output',color:'#bd96ff'}],{empty:'No timestamped Freebuff receipts in this filter.'});
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
    const [u,oc,a]=await Promise.all([api('/api/unified/usage?'+fbFilterQuery().q),nativeGui?Promise.resolve(null):api('/api/openchamber/telemetry').catch(e=>({available:false,reason:e.message})),nativeGui?Promise.resolve(null):api('/api/freebuff/allowance').catch(e=>({available:false,error:e.message}))]);
    if(!available()||id!==seq)return;
    if(u?.available===false)throw new Error(u.error||'Unified usage service unavailable');
    if(!nativeGui) document.getElementById('usage-openchamber').innerHTML=renderOpenChamberCoverage(oc,Number(days)||30);
    document.getElementById('usage-summary').innerHTML=nativeGui
      ? box('Total input tokens','Unknown','Recent events are not a complete history')+
        box('Total output tokens','Unknown','Provider quotas and subscription limits are not exposed')+
        box('Attributed receipts',fmt((u.recent||[]).length),'Recent sample only · '+guiUsageName())
      : box('Input tokens',fmt(u.input_tokens_recorded),'Measured across '+fmt(u.input_token_events)+' invocation records')+
        box('Output tokens',fmt(u.output_tokens_recorded),'Measured across '+fmt(u.output_token_events)+' invocation records')+
        box('Sources with data',fmt((u.sources||[]).filter(s=>s.events>0).length)+' / '+fmt((u.sources||[]).length),'Unavailable sources are not zero consumption');
    document.getElementById('usage-age').textContent='Checked '+relative(u.collected_at);
    document.getElementById('usage-sources').innerHTML=`<div class="table-wrap"><table class="data"><thead><tr><th>Source</th><th>State</th><th>Events</th><th>Last observed</th></tr></thead><tbody>`+
      (u.sources||[]).map(s=>`<tr><td>${esc(s.label)}</td><td>${pill(s.status)}</td><td>${fmt(s.events)}</td><td>${esc(s.latest_at||'No recorded sample')}</td></tr>`).join('')+'</tbody></table></div>'+(nativeGui?`<p class="muted small">${esc(u.note||'Native GUI token receipts not yet verified.')}</p>`:'');
    const daily=u.daily||[];
    if(!nativeGui) sparkChart(document.getElementById('usage-token-chart'),daily,[{key:'input_tokens',label:'Input',color:'#4aabff'},{key:'output_tokens',label:'Output',color:'#bd96ff'}],{empty:'No timestamped token measurements available. Connect collectors before trends can appear.'});
    document.getElementById('usage-events').innerHTML=`<table class="data"><thead><tr><th>Time</th><th>Source</th><th>Model</th><th>Input</th><th>Output</th></tr></thead><tbody>`+
      (u.recent||[]).filter(e=>numeric(e.input_tokens)!==null||numeric(e.output_tokens)!==null).slice(0,50).map(e=>`<tr><td class="small">${esc(e.timestamp)}</td><td>${esc(displayLabel(e.source))}</td><td>${esc(reportedLabel(e.model))}</td><td>${fmt(e.input_tokens)}</td><td>${fmt(e.output_tokens)}</td></tr>`).join('')+'</tbody></table><p class="muted small">Newest 50 records with reported input or output tokens. Records without tokens remain in source coverage. Missing values are not estimated.</p>';
    fbData=u.freebuff&&typeof u.freebuff==='object'?u.freebuff:null;
    if(fbData)renderFreebuff();else if(document.getElementById('fb-summary')) document.getElementById('fb-summary').innerHTML=`<p>${pill('unavailable')} Freebuff receipt section unavailable in this response.</p>`;
    renderAllowance(a);
  }
  document.getElementById('fb-host')?.addEventListener('change',applyFbFilter);
  document.getElementById('fb-model')?.addEventListener('change',applyFbFilter);
  const refresh=()=>load().catch(e=>{if(available())toast('Usage',e.message,'error')});
  document.getElementById('usage-reload').addEventListener('click',refresh);
  document.getElementById('usage-period').addEventListener('change',refresh);
  state.cleanup=()=>{disposed=true;seq++};
  await load();schedule(refresh,60000);
}

// Agents Control lives in agents_control_view.js; dependencies are handed over lazily.
function viewAgentsControl() {
  bindAgentsControl({APP, api, bytes, esc, modal, pageHead, pill, state, toast});
  return viewAgentsControlPage();
}

// -------------------------------------------------------------- test hook
// Regression-test surface for the pure helpers (node/bun). Importing this
// module only ever runs the bootstrap above; no view, fetch or timer starts.
export const __editorTestSurface = {conceptMetadataCheck, validNativeEmbed, rowsOf, contentOf, createDiscoveryGuard, applyHarnessRefresh, harnessInterval,
  displayLabel, pill, statusPill, categoryChip, metricBlock, dashboardSnapshot, miniatureBrainGraph, fmt, renderOpenChamberCoverage,
  LIVENESS_STATES, livenessState, livenessLabel, livenessNote, sessionRow, sessionsBlock, seatPill, runBlock, runsBlock,
  diagnosticsTabOf, indexingTabOf, tabStrip, DIAGNOSTICS_TABS, INDEXING_TABS, architectureProbeState, architectureRuntimeChecks,
  featureAllowed,
  debounceForRoute, sequencer, themeCatalog, themeModeOf, sanitizeThemeChoice, applyTheme,
  agentChatParticipants, agentChatThreads, agentChatTimeline, agentChatTime,
  get refreshMs(){return harnessRefreshMs;},
  get nativeUsageGui(){return nativeInstall ? guiUsageName() : null;},
  get cpuScale(){return {cores:CPU_QUOTA_CORES,label:CPU_QUOTA_LABEL};}};


// Agent Chat encodes identity in the role token. The Lounge labels a person
// with the name their identity owns - an OpenMausBot bot carries the same name
// Claude Office draws - while the token stays the addressable form.
function agentDisplayName(role, names) {
  const key = String(role || '');
  const name = names && typeof names === 'object' ? names[key] : '';
  return typeof name === 'string' && name.trim() ? name.trim() : key;
}

// Conversation grouping is presentation only. No local-user identity or mailbox
// ownership is inferred from the durable delivery envelopes.
function agentChatParticipants(message) {
  const names = [message?.from, ...(message?.recipients || []),
    ...(message?.sessions || []).map(s => `session:${s}`)]
    .filter(value => typeof value === 'string' && value.trim())
    .map(value => value.trim());
  return [...new Set(names)].sort();
}

function agentChatThreads(messages, displayName = (role) => role) {
  const threads = new Map();
  for (const message of messages) {
    const members = agentChatParticipants(message);
    if (!members.length) continue;
    const key = JSON.stringify(members);
    let thread = threads.get(key);
    if (!thread) {
      thread = { key, title: members.map(member => member.startsWith('session:') ? `Session ${member.slice(-6)}` : displayName(member)).join(' · '), members, messages: [], latest: message };
      threads.set(key, thread);
    }
    thread.messages.push(message);
    if (Number(message.id) > Number(thread.latest.id)) thread.latest = message;
  }
  return [...threads.values()].sort((a, b) => Number(b.latest.id) - Number(a.latest.id));
}

// Source envelopes are displayed in a single chronological stream without
// inferring identities, task ownership, or private delivery acknowledgements.
function agentChatTimeline(messages, term = '') {
  const query = String(term || '').trim().toLowerCase();
  return messages.filter(m => !query || [m.from, m.text, m.from_session,
    m.origin, ...(m.recipients || []), ...(m.sessions || [])]
    .some(value => String(value || '').toLowerCase().includes(query)))
    .sort((a, b) => Number(a.id) - Number(b.id));
}

function agentChatTime(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : '';
}

// Self-reported Lounge message format. Role identity and task ownership stay
// authoritative only in Agent Chat / Kanzo. Never interpret this as a claim.
function parseLoungeAnnouncement(m) {
  const message = String(m?.text || '');
  const match = /^LOUNGE (JOIN|UPDATE|EXIT) \| alias=([a-zA-Z][a-zA-Z0-9_-]{1,23})(?: \| task=(none|[a-z0-9_-]{1,60}#[1-9][0-9]{0,9}))?(?: \| work=([^\r\n]{1,180}))?\s*$/.exec(message);
  if (!match || typeof m?.from !== 'string') return null;
  return {role:m.from, kind:match[1], alias:match[2], task:match[3] || null,
    work:(match[4] || '').trim(), id:Number(m.id), at:Date.parse(m.created_at || '') || 0};
}
function loungeAnnouncements(records) {
  const latest = new Map();
  for (const m of records) {
    const note=parseLoungeAnnouncement(m);
    if (!note) continue;
    const prior=latest.get(note.role);
    if (!prior || note.id > prior.id) latest.set(note.role,note);
  }
  return latest;
}

// Kanzo's /api/changes is a change token, NOT a historical event log. Use the
// existing authenticated read-only Kanzo proxy for current tasks. Only describe
// a stage transition when two actual board snapshots prove it occurred.
function kanzoTaskActivity(board, before = null, now = Date.now()) {
  if (!Array.isArray(board?.tasks)) return [];
  const older = before && Array.isArray(before.tasks)
    ? new Map(before.tasks.map(t => [Number(t.id), t])) : null;
  return board.tasks.flatMap(task => {
    const id = Number(task?.id);
    if (!Number.isSafeInteger(id) || id < 1 || !/^[a-z0-9_-]{1,60}$/.test(String(task.project || '')))
      return [];
    const timestamp = Date.parse(task.updated_at || '');
    const old = older?.get(id);
    const observed = Boolean(old && old.status !== task.status);
    const changed = Boolean(old && (old.updated_at !== task.updated_at || observed || old.title !== task.title));
    if (older && !changed) return [];
    // Initial view is a projection of recent records, never invented history.
    if (!older && (!Number.isFinite(timestamp) || timestamp > now + 60000 || now-timestamp > 7*86400000)) return [];
    return [{kind:'kanzo', key:`kanzo:${task.project}#${id}:${task.updated_at}:${task.status}`,
      task:`${task.project}#${id}`, id, project:task.project, title:String(task.title || '').slice(0,400),
      status:String(task.status || '').slice(0,25), from:observed ? String(old.status || '').slice(0,25) : null,
      at:observed ? now : (Number.isFinite(timestamp) ? timestamp : now), observed}];
  }).sort((a,b)=>b.at-a.at).slice(0,16);
}
function loungeDateVisible(timestamp, range, now=Date.now()) {
  if (range === 'all') return true;
  if (!Number.isFinite(timestamp)) return true; // unknown timestamps must not disappear
  if (range === '7d') return timestamp >= now - 7*86400000;
  if (range === 'today') {
    const nzDay = value => new Intl.DateTimeFormat('en-CA', {timeZone:'Pacific/Auckland', year:'numeric', month:'2-digit', day:'2-digit'}).format(new Date(value));
    return nzDay(timestamp) === nzDay(now);
  }
  return true;
}

// Messenger-style, read-only viewer. The durable agentchat inboxes remain the
// source of truth. This view never acknowledges mail or sends for an agent.
async function viewAgentChat() {
  APP.innerHTML = pageHead('Agent Chat', '', '<a class="btn small" href="#/openmausbot">OpenMausBot</a>') + `
    <section class="messenger-shell messenger-mode-threads" id="ac-shell" aria-label="Agent Chat">
      <header class="messenger-toolbar" aria-label="Agent Chat controls">
        <div class="messenger-modes" role="group" aria-label="Lounge view">
          <button type="button" id="ac-view-chats" aria-pressed="true">Conversations</button>
          <button type="button" id="ac-view-feed" aria-pressed="false">Activity</button>
        </div>
        <details class="lounge-filters" id="ac-filters">
          <summary>Filters</summary>
          <div class="lounge-filter-fields">
            <label class="messenger-search messenger-global-search"><span class="visually-hidden">Search agent messages and Kanzo activity</span>
              <input id="ac-filter" type="search" placeholder="Search agent messages" autocomplete="off"></label>
            <label class="lounge-date-picker"><span class="visually-hidden">Message date range</span>
              <select id="ac-range" aria-label="Lounge date range"><option value="all">All dates</option><option value="today">Today</option><option value="7d">Last 7 days</option></select></label>
          </div>
        </details>
        <span id="ac-status" class="lounge-live-status" role="status" aria-live="polite">Connecting…</span>
      </header>
      <details class="lounge-presence" id="ac-presence">
        <summary><span><span class="lounge-pulse" aria-hidden="true"></span> Agents on duty</span>
          <span class="lounge-presence-end"><span id="ac-presence-summary">Checking presence…</span></span></summary>
        <div id="ac-presence-list" class="lounge-roster" role="list" aria-label="Current agent activity"></div>
        <p class="lounge-presence-note">Online status uses recent Agent Chat activity. Aliases and task descriptions are agent announcements, not proof of a Kanzo claim.</p>
      </details>
      <aside class="messenger-listpane" aria-label="Conversation list">
        <div class="messenger-listhead"><h2>Conversations</h2></div>
        <label class="messenger-search messenger-chat-search"><span class="visually-hidden">Search conversations</span>
          <input id="ac-chat-search" type="search" placeholder="Search conversations" autocomplete="off"></label>
        <div id="ac-conversations" class="messenger-conversations" aria-label="Conversations"></div>
      </aside>
      <section class="messenger-thread" aria-label="Agent messages">
        <header class="messenger-threadhead">
          <button id="ac-back" type="button" class="messenger-back" aria-label="Back to conversations">‹</button>
          <span id="ac-thread-avatar" class="messenger-avatar" aria-hidden="true">AL</span>
          <div class="messenger-thread-title"><h2 id="ac-thread-name">Live Feed</h2>
            <span id="ac-thread-description"></span></div>
          <button id="ac-clear-agent" type="button" class="messenger-thread-action" hidden>Clear focus</button>
          <span class="messenger-live-marker" aria-hidden="true"></span>
        </header>
        <div id="ac-stream" class="messenger-messages" role="log" aria-label="Agent Chat messages" aria-live="off"></div>
        <button type="button" id="ac-latest" class="messenger-latest" hidden>↓ New messages</button>
      </section>
    </section>`;
  const shell = document.getElementById('ac-shell');
  const presenceDetails = document.getElementById('ac-presence');
  const presenceSummary = document.getElementById('ac-presence-summary');
  const presenceList = document.getElementById('ac-presence-list');
  presenceDetails.open = true;   // the name strip is always visible; only the cards collapse
  presenceDetails.querySelector('summary')?.addEventListener('click', e => e.preventDefault());

  const conversations = document.getElementById('ac-conversations');
  const stream = document.getElementById('ac-stream');
  const status = document.getElementById('ac-status');
  const filter = document.getElementById('ac-filter');
  const chatSearch = document.getElementById('ac-chat-search');
  const dateRange = document.getElementById('ac-range');
  const latestButton = document.getElementById('ac-latest');
  const threadName = document.getElementById('ac-thread-name');
  const threadDescription = document.getElementById('ac-thread-description');
  const threadAvatar = document.getElementById('ac-thread-avatar');
  const clearAgentButton = document.getElementById('ac-clear-agent');
  let mode = 'threads';
  let cursor = 0;
  let pending = false;
  let selected = null;
  let mobileOpen = false;
  const known = new Set();
  const records = [];
  let kanzoBoard = null;
  let kanzoChange = '';
  let kanzoActivity = [];
  let kanzoAvailable = false;
  let kanzoPollAt = 0;
  let kanzoPending = false;
  let kanzoHandshakeDone = false;
  const expandedMessages = new Set();
  let presence = null;
  let agentAvatars = {};
  // role -> display name (OpenMausBot bots resolve to their bot name). Loaded
  // with the avatar roster; a role with no name renders as the role itself.
  let agentNames = {};
  let lastPresencePoll = 0;
  let lastRosterKey = '';
  let selectedAgent = '';
  const dutyOpen = new Set();   // agents whose card is expanded; everyone else shows as a name chip
  const renderPresence = () => {
    if (!presenceList.isConnected) return;
    const agents = Array.isArray(presence?.agents) ? presence.agents : [];
    const current = agents.filter(a => a && ['working','idle'].includes(a.status));
    const working = current.filter(a => a.status === 'working').length;
    presenceSummary.textContent = presence?.available ? `${working} working · ${current.length-working} recently seen` : 'Presence unavailable';
    const announcement = loungeAnnouncements(records);
    const rows = current.sort((a,b) => (a.status === 'working' ? -1 : 1) - (b.status === 'working' ? -1 : 1) || a.role.localeCompare(b.role));
    const signature = JSON.stringify([selectedAgent, [...dutyOpen], ...rows.map(a => [a.role,a.status,announcement.get(a.role)?.id])]);
    if (signature === lastRosterKey) return;
    lastRosterKey = signature;
    if (!rows.length) {
      presenceList.innerHTML = '<p class="lounge-roster-empty">No agents currently reporting activity.</p>';
      return;
    }
    presenceList.innerHTML = rows.map(a => {
      const note = announcement.get(a.role);
      const recent = note && note.kind !== 'EXIT' && note.at > 0 && Date.now()-note.at < 12*3600*1000;
      const task = recent && note.task && note.task !== 'none' ? note.task : null;
      const parts=task?.match(/^([a-z0-9_-]{1,60})#([1-9][0-9]{0,9})$/);
      const taskLink=parts ? `<a class="lounge-task-link" href="#/kanban?task=${encodeURIComponent(parts[2])}" title="Open reported task in Kanzo board">${esc(task)}</a>` : '';
      const label = recent ? note.alias : agentDisplayName(a.role, agentNames);
      if (!dutyOpen.has(a.role)) {
        return `<button type="button" class="lounge-duty-chip${selectedAgent===a.role?' selected':''}" role="listitem" data-duty-toggle="${esc(a.role)}" aria-expanded="false" title="Show details">
          <span class="lounge-online-dot ${a.status}" aria-label="${a.status}"></span><span class="lounge-duty-name">${esc(label)}</span></button>`;
      }
      return `<div class="lounge-person${selectedAgent===a.role?' selected':''}" role="listitem" data-agent-role="${esc(a.role)}">
        ${agentAvatar({role: a.role, name: label,
          avatar: agentAvatars[a.role]?.avatar, avatar_default: agentAvatars[a.role]?.avatar_default},
          esc, {pickable: true})}
        <div class="lounge-person-body"><button type="button" class="lounge-agent-select" data-duty-toggle="${esc(a.role)}" aria-expanded="true" title="Collapse"><strong>${esc(label)}</strong></button>
          <span><button type="button" class="lounge-copy-role" data-copy-role="${esc(a.role)}" title="Copy Agent Chat address">@${esc(a.role)}</button> · ${a.status==='working'?'Working':'Recently seen'}</span>
          ${recent&&note.work?`<small title="Self-reported task">${esc(note.work)}</small>`:''}
          ${taskLink}${mode==='feed'?`<button type="button" class="lounge-focus-btn" data-select-agent="${esc(a.role)}" aria-pressed="${String(selectedAgent===a.role)}">${selectedAgent===a.role?'Show all':'Filter feed'}</button>`:''}</div><span class="lounge-online-dot ${a.status}" aria-label="${a.status}"></span></div>`;
    }).join('');
  };
  presenceList.addEventListener('click', async event => {
    const avatarButton = event.target.closest?.('button[data-agent-avatar]');
    if (avatarButton) {
      const role = avatarButton.dataset.agentAvatar || '';
      if (!/^[a-z0-9_-]{1,40}$/.test(role)) return;
      const current = agentAvatars[role] || {};
      openAvatarPicker({subject: {role, name: current.alias || role,
          avatar: current.avatar, avatar_default: current.avatar_default}, api, esc,
        title: 'Choose an avatar',
        note: 'Saved for this agent and shown wherever the Lounge lists them.',
        endpoint: '/api/agentchat/agents/' + encodeURIComponent(role) + '/avatar',
        onSaved: () => { void loadAgentAvatars(); }});
      return;
    }
    const button=event.target.closest?.('button[data-copy-role]');
    if(button){
      const role=button.dataset.copyRole;
      if(!/^[a-z0-9_-]{1,40}$/.test(role)) return;
      try {
        await navigator.clipboard.writeText('@'+role);
        const prior=button.textContent;button.textContent='Copied';
        setTimeout(()=>{if(button.isConnected)button.textContent=prior;},1500);
      } catch { button.title='Copy is not available in this browser'; }
      return;
    }
    const toggle = event.target.closest?.('button[data-duty-toggle]');
    if (toggle) {
      const r = toggle.dataset.dutyToggle || '';
      if (dutyOpen.has(r)) dutyOpen.delete(r); else dutyOpen.add(r);
      renderPresence();
      [...presenceList.querySelectorAll('button[data-duty-toggle]')].find(b => b.dataset.dutyToggle === r)?.focus({preventScroll:true});
      return;
    }
    const selectButton=event.target.closest?.('button[data-select-agent]');
    if (!selectButton || mode !== 'feed') return;
    const role=selectButton.dataset.selectAgent || '';
    selectedAgent = selectedAgent === role ? '' : role;
    renderPresence();
    render({force:true});
    [...presenceList.querySelectorAll('button[data-select-agent]')].find(b => b.dataset.selectAgent === role)?.focus({preventScroll:true});
  });
  const loadAgentAvatars = async () => {
    const known = JSON.stringify(agentNames);
    try {
      const reply = await api('/api/agentchat/avatars');
      const map = reply?.agents;
      agentAvatars = map && typeof map === 'object' ? map : {};
      agentNames = reply?.names && typeof reply.names === 'object' ? reply.names : {};
    } catch { agentAvatars = {}; agentNames = {}; }
    lastRosterKey = '';
    renderPresence();
    // Senders, conversation titles and previews are labelled with these names,
    // so repaint once the map arrives instead of waiting for the next message.
    if (renderedFeed && JSON.stringify(agentNames) !== known) render({force:true});
  };
  const loadPresence = async () => {
    if (!presenceList.isConnected) return;
    try {
      const response = await api('/api/agentchat/presence');
      if (!presenceList.isConnected) return;
      presence = response;
    } catch { presence = {available:false,agents:[]}; }
    lastRosterKey = '';
    renderPresence();
  };
  let displayedThread = null;
  let displayedMessages = '';
  let renderedFeed = false;
  let unreadCount = 0;
  const updateUnread = () => {
    latestButton.hidden = unreadCount === 0;
    latestButton.textContent = unreadCount ? `↓ ${unreadCount} new message${unreadCount===1?'':'s'} · Jump to latest` : '↓ New messages';
  };
  // Two words give their initials ("Model Scout" -> MS); one word gives its
  // first two letters ("scout" -> SC).
  const initials = (name) => {
    const words = String(name || 'AL').trim().split(/[\s·_\-]+/).filter(Boolean);
    if (!words.length) return 'AL';
    return (words.length > 1 ? words.slice(0, 2).map(word => word[0]).join('') : words[0].slice(0, 2)).toUpperCase();
  };
  const tone = (name) => [...String(name || '')].reduce((n, c) => n + c.charCodeAt(0), 0) % 5;
  const targetLabel = m => [...(m.recipients || []), ...(m.sessions || []).map(s => `session:${s}`)].join(', ');
  const renderKanzo = event => {
    const statusText = event.observed ? `Moved ${event.from || 'previous stage'} → ${event.status}` : `Current stage: ${event.status}`;
    return `<article class="messenger-kanzo" data-stage="${esc(event.status || 'unknown')}" aria-label="Kanzo task activity">
      <span class="messenger-kanzo-icon" aria-hidden="true">▤</span><div>
        <span class="messenger-kanzo-label">KANZO · ${event.observed ? 'Observed change' : 'Recent task update'}</span>
        <strong>${esc(event.title)}</strong>
        <span>${esc(statusText)}</span>
        <div><a class="lounge-task-link" href="#/kanban?task=${event.id}" aria-label="Open Kanzo task ${esc(event.task)}">${esc(event.task)}</a>
        <time title="${esc(new Date(event.at).toISOString())}">${esc(agentChatTime(new Date(event.at).toISOString()))}</time></div>
      </div></article>`;
  };
  const renderMessage = (m, alternate = false, continued = false) => {
    const to = targetLabel(m);
    const sender = m.from || 'Unknown sender';
    const senderName = agentDisplayName(sender, agentNames);
    const announcement = parseLoungeAnnouncement(m);
    if (announcement) {
      const activity = announcement.kind === 'JOIN' ? 'joined the Lounge' : announcement.kind === 'EXIT' ? 'finished their task' : 'updated their work';
      const task = announcement.task?.match(/^([a-z0-9_-]{1,60})#([1-9][0-9]{0,9})$/);
      const destination = task ? `<a href="#/kanban?task=${encodeURIComponent(task[2])}" class="lounge-task-link">${esc(announcement.task)}</a>` : '';
      return `<article class="messenger-announcement" aria-label="Agent work announcement">
        ${agentAvatar({role: sender, name: announcement.alias, avatar: agentAvatars[sender]?.avatar,
          avatar_default: agentAvatars[sender]?.avatar_default}, esc,
          {className: 'messenger-announcement-icon'})}
        <div><strong>${esc(announcement.alias)}</strong> <span>${activity}</span> <small>· @${esc(sender)}</small>
          ${announcement.work ? `<p>${esc(announcement.work)}</p>` : ''}${destination ? `<div>${destination}</div>` : ''}
          <time>${esc(agentChatTime(m.created_at) || `#${m.id}`)}</time></div>
        </article>`;
    }
    const long = String(m.text || '').length > 320 || String(m.text || '').split('\n').length > 8;
    const open = mode === 'feed' || expandedMessages.has(Number(m.id));
    return `<article class="messenger-message messenger-agent-tone-${tone(sender)} ${alternate ? 'messenger-message-alt' : ''}${continued ? ' messenger-message-continued' : ''}">
        ${agentAvatar({role: sender, name: senderName, avatar: agentAvatars[sender]?.avatar,
          avatar_default: agentAvatars[sender]?.avatar_default}, esc,
          {className: 'messenger-avatar messenger-avatar-small'})}
        <div class="messenger-message-content"><div class="messenger-sender">${esc(senderName)}</div>
          <div class="messenger-bubble ${long && !open ? 'messenger-bubble-collapsed' : ''}">${esc(m.text || '')}</div>
          ${long && mode !== 'feed' ? `<button type="button" class="messenger-expand" data-expand-message="${Number(m.id)}" aria-expanded="${open}">${open ? 'less' : '…more'}</button>` : ''}
          <div class="messenger-message-meta">${esc(agentChatTime(m.created_at) || `#${m.id}`)}${to ? ` · To ${esc(to)}` : ''}</div>
        </div></article>`;
  };
  // A single seven-day initial snapshot plus verified changes observed while
  // Lounge is open. This does not attribute task changes to an agent.
  const loadKanzo = async () => {
    if (kanzoPending || !stream.isConnected) return;
    kanzoPending = true;
    try {
      if (!kanzoHandshakeDone) {
        await api('/api/embed/kanzo/handshake', {timeoutMs:7000});
        kanzoHandshakeDone = true;
      }
      const changes = await api('/embed/kanzo/api/changes', {timeoutMs:7000});
      if (!stream.isConnected || typeof changes?.changes !== 'string') return;
      if (kanzoBoard && kanzoChange === changes.changes) {kanzoAvailable = true;return;}
      const next = await api('/embed/kanzo/api/board?project=all', {timeoutMs:10000});
      if (!stream.isConnected || !Array.isArray(next?.tasks)) return;
      const additions = kanzoTaskActivity(next, kanzoBoard);
      const events = new Map(kanzoActivity.map(item => [item.task, item]));
      for (const item of additions) events.set(item.task,item);
      kanzoActivity = [...events.values()].sort((a,b)=>b.at-a.at).slice(0,30);
      kanzoBoard = next;
      kanzoChange = changes.changes;
      kanzoAvailable = true;
      if (mode === 'feed') render({newMessages:additions.length>0});
    } catch { kanzoAvailable = false;kanzoHandshakeDone = false; }
    finally {
      kanzoPending = false;
      if (stream.isConnected && mode === 'feed' && !selectedAgent) threadDescription.textContent = kanzoAvailable ? 'Kanzo linked' : 'Kanzo unavailable';
    }
  };
  const isNearBottom = () => stream.scrollHeight - stream.scrollTop - stream.clientHeight < 100;
  const render = ({ force = false, newMessages = false, newCount = 0 } = {}) => {
    const feedMode = mode === 'feed';
    shell.classList.toggle('messenger-mode-feed', feedMode);
    shell.classList.toggle('messenger-mode-threads', !feedMode);
    filter.placeholder = feedMode ? 'Search agent messages' : 'Search conversations';
    const threads = agentChatThreads(records);
    if (!threads.some(t => t.key === selected)) selected = threads[0]?.key || null;
    // Search scopes are independent. Looking for a conversation must not
    // silently filter the separate Activity feed when switching views.
    const term = (feedMode ? filter : chatSearch).value.toLowerCase().trim();
    if (!feedMode) {
      const visible = threads.filter(t => !term || t.title.toLowerCase().includes(term)
        || t.members.some(member => member.toLowerCase().includes(term)) || t.messages.some(m =>
        [m.text, m.from_session, m.origin, ...(m.recipients || []), ...(m.sessions || [])].join(' ').toLowerCase().includes(term)));
      if (!visible.some(t => t.key === selected)) selected = visible[0]?.key || null;
      const listScroll = conversations.scrollTop;
      const focusedThread = document.activeElement?.closest?.('button[data-thread]')?.dataset.thread;
      const listKey = `${term}:${visible.map(t => `${t.key}:${t.latest.id}`).join('|')}:${selected}`;
      if (force || conversations.dataset.renderKey !== listKey) {
        conversations.innerHTML = visible.length ? visible.map(t => `
          <button class="messenger-conversation ${t.key === selected ? 'selected' : ''}" type="button"
            data-thread="${esc(t.key)}" aria-pressed="${t.key === selected}">
            <span class="messenger-avatar" aria-hidden="true">${esc(initials(t.title))}</span>
            <span class="messenger-conversation-info"><strong>${esc(t.title)}</strong>
              <span class="messenger-preview">${esc(agentDisplayName(t.latest.from, agentNames))}: ${esc(t.latest.text || 'Message')}</span></span>
            <span class="messenger-conversation-time">${esc(agentChatTime(t.latest.created_at))}</span>
          </button>`).join('') : `<div class="messenger-empty-list"><p>${term ? 'No conversations match your search.' : 'No conversations yet.'}</p>${term ? '<button class="btn small" type="button" data-clear-conversation-search>Clear search</button>' : ''}</div>`;
        conversations.dataset.renderKey = listKey;
        conversations.scrollTop = listScroll;
        if (focusedThread && !mobileOpen) {
          const focused = [...conversations.querySelectorAll('button[data-thread]')].find(button => button.dataset.thread === focusedThread);
          focused?.focus({preventScroll:true});
        }
      }
    }
    const thread = threads.find(t => t.key === selected);
    shell.classList.toggle('messenger-open', !feedMode && mobileOpen && !!thread);
    const activeAnnouncement = selectedAgent ? loungeAnnouncements(records).get(selectedAgent) : null;
    threadName.textContent = feedMode ? (selectedAgent ? (activeAnnouncement?.alias || agentDisplayName(selectedAgent, agentNames)) : 'Live Feed') : (thread?.title || 'Select a chat');
    threadDescription.textContent = feedMode ? (selectedAgent ? `Focused on @${selectedAgent}` : (kanzoAvailable ? 'Kanzo linked' : 'Kanzo unavailable')) : '';
    threadAvatar.textContent = feedMode ? initials(selectedAgent ? (activeAnnouncement?.alias || agentDisplayName(selectedAgent, agentNames)) : 'AL') : initials(thread?.title);
    clearAgentButton.hidden = !(feedMode && selectedAgent);
    clearAgentButton.textContent = selectedAgent ? `Clear focus · @${selectedAgent}` : 'Clear focus';
    const previousScroll = stream.scrollTop;
    const nearBottom = isNearBottom();
    const range = dateRange.value;
    const agentMatches = m => !selectedAgent || agentChatParticipants(m).includes(selectedAgent) || String(m?.from || '') === selectedAgent;
    const chatMessages = (feedMode ? agentChatTimeline(records, term).filter(agentMatches)
      : thread ? [...thread.messages].sort((a,b) => Number(a.id) - Number(b.id)) : [])
      .filter(m => loungeDateVisible(Date.parse(m.created_at || ''), range));
    const events = feedMode && !selectedAgent ? kanzoActivity.filter(item =>
      loungeDateVisible(item.at, range) && (!term || [item.title,item.task,item.status].some(s => s.toLowerCase().includes(term)))) : [];
    const messages = [...chatMessages, ...events].sort((a,b) => {
      const time = x => x.kind==='kanzo' ? x.at : (Date.parse(x.created_at || '') || 0);
      return time(a)-time(b) || Number(a.id||0)-Number(b.id||0);
    });
    const viewKey = feedMode ? `feed:${term}:${range}:${selectedAgent}` : `thread:${selected}:${range}`;
    const signature = messages.map(m => m.kind === 'kanzo' ? m.key : `chat:${m.id}`).join('|') + ':expanded:' + [...expandedMessages].sort().join(',');
    if (!force && renderedFeed && viewKey === displayedThread && signature === displayedMessages) return;
    renderedFeed = true;
    const changedView = viewKey !== displayedThread;
    if (changedView || nearBottom) unreadCount = 0;
    else if (newCount > 0 && feedMode) unreadCount += newCount;
    displayedThread = viewKey;
    displayedMessages = signature;
    if (messages.length) {
      let lastDate = '';
      let previous = null;
      stream.innerHTML = messages.map(m => {
        const date = m.kind === 'kanzo' ? m.at : Date.parse(m.created_at || '');
        const label = Number.isFinite(date) ? new Date(date).toLocaleDateString([], {weekday:'short',month:'short',day:'numeric'}) : '';
        const divider = label && label !== lastDate ? `<div class="messenger-date-divider" role="separator">${esc(label)}</div>` : '';
        if (label) lastDate = label;
        const announcement = m.kind !== 'kanzo' && parseLoungeAnnouncement(m);
        const continued = !divider && !announcement && previous && previous.kind !== 'kanzo'
          && previous.from === m.from && targetLabel(previous) === targetLabel(m)
          && Number.isFinite(date) && Number.isFinite(Date.parse(previous.created_at || ''))
          && date >= Date.parse(previous.created_at) && date - Date.parse(previous.created_at) <= 5 * 60 * 1000;
        previous = (m.kind === 'kanzo' || announcement) ? null : m;
        const alternate = !feedMode && thread && m.from !== thread.members[0];
        return divider + (m.kind === 'kanzo' ? renderKanzo(m) : renderMessage(m, alternate, !!continued));
      }).join('');
    } else stream.innerHTML = `<p class="messenger-empty-thread">${feedMode
      ? (term ? 'No messages match your search.' : 'No recent messages yet.')
      : (term ? 'No conversations match your search.' : 'Select a conversation to see its messages.')}</p>`;
    // the toggle only earns its place when the collapsed bubble is really cut off
    stream.querySelectorAll('.messenger-bubble-collapsed').forEach(b => {
      if (b.scrollHeight <= b.clientHeight + 1) {
        b.classList.remove('messenger-bubble-collapsed');
        b.parentElement?.querySelector('.messenger-expand')?.remove();
      }
    });
    if (changedView || nearBottom) stream.scrollTop = stream.scrollHeight;
    else stream.scrollTop = previousScroll;
    updateUnread();
  };
  const chatsButton = document.getElementById('ac-view-chats');
  const feedButton = document.getElementById('ac-view-feed');
  const changeMode = next => {
    if (next === mode) return;
    mode = next;
    mobileOpen = false;
    selectedAgent = '';
    chatsButton.setAttribute('aria-pressed', String(mode === 'threads'));
    feedButton.setAttribute('aria-pressed', String(mode === 'feed'));
    render({force:true});
    if (mode === 'feed') void loadKanzo();
  };
  chatsButton.addEventListener('click', () => changeMode('threads'));
  feedButton.addEventListener('click', () => changeMode('feed'));
  conversations.addEventListener('click', event => {
    if (event.target.closest('button[data-clear-conversation-search]')) {
      chatSearch.value = '';
      render({force:true});
      chatSearch.focus();
      return;
    }
    const button = event.target.closest('button[data-thread]');
    if (!button) return;
    selected = button.dataset.thread;
    mobileOpen = true;
    render({force:true});
    stream.scrollTop = stream.scrollHeight;
    if (window.matchMedia?.('(max-width:760px)').matches) document.getElementById('ac-back').focus({preventScroll:true});
  });
  document.getElementById('ac-back').addEventListener('click', () => {
    mobileOpen = false;
    shell.classList.remove('messenger-open');
    chatSearch.focus();
  });
  latestButton.addEventListener('click', () => { stream.scrollTop = stream.scrollHeight;unreadCount = 0;updateUnread(); });
  stream.addEventListener('scroll', () => { if (isNearBottom()) { unreadCount = 0; updateUnread(); } }, {passive:true});
  const load = async () => {
    if (pending || !document.getElementById('ac-stream')) return;
    pending = true;
    try {
      const response = await api('/api/agentchat/feed?' + new URLSearchParams({ after: String(cursor), limit: '100' }));
      if (!document.getElementById('ac-stream')) return;
      if (!response.available) { status.textContent = response.reason || 'Agent Chat unavailable'; return; }
      let newMessages = false;
      let newlyVisible = 0;
      const term = filter.value.toLowerCase().trim();
      for (const m of response.messages || []) {
        if (known.has(m.id)) continue;
        newMessages = true;
        if (renderedFeed && mode === 'feed' && loungeDateVisible(Date.parse(m.created_at || ''), dateRange.value)
          && (!selectedAgent || agentChatParticipants(m).includes(selectedAgent))
          && (!term || [m.from,m.text,m.from_session,m.origin,...(m.recipients||[]),...(m.sessions||[])]
            .some(value => String(value || '').toLowerCase().includes(term)))) newlyVisible++;
        known.add(m.id);
        records.unshift(m);
      }
      while (records.length > 180) known.delete(records.pop().id);
      cursor = Math.max(cursor, Number(response.last_id) || 0);
      status.textContent = response.has_more ? 'Loading updates…' : 'Live updates';
      if (newMessages || !renderedFeed) render({newMessages,newCount:newlyVisible});
      if (newMessages) renderPresence();
      if (Date.now()-lastPresencePoll > 55000) {
        lastPresencePoll=Date.now();
        void loadAgentAvatars();
        void loadPresence();
      }
    } catch (error) { if (error.status !== -1) status.textContent = 'Feed error: ' + error.message; }
    finally {
      pending = false;
      if (mode === 'feed' && Date.now()-kanzoPollAt > 25000) {
        kanzoPollAt=Date.now();
        void loadKanzo();
      }
    }
  };
  stream.addEventListener('click', event => {
    const button = event.target.closest?.('button[data-expand-message]');
    if (!button) return;
    const id=Number(button.dataset.expandMessage);
    if (!Number.isSafeInteger(id)) return;
    if (expandedMessages.has(id)) expandedMessages.delete(id); else expandedMessages.add(id);
    const previousTop = button.getBoundingClientRect().top;
    render({force:true});
    const replacement = stream.querySelector(`button[data-expand-message="${id}"]`);
    if (replacement) {
      stream.scrollTop += replacement.getBoundingClientRect().top - previousTop;
      replacement.focus({preventScroll:true});
    }
  });
  chatSearch.addEventListener('input', () => render({force:true}));
  chatSearch.addEventListener('keydown', event => {
    if (event.key === 'Escape' && chatSearch.value) {
      chatSearch.value = '';
      render({force:true});
      event.preventDefault();
    } else if (event.key === 'Enter') {
      const first = conversations.querySelector('button[data-thread]');
      if (first) { first.click(); event.preventDefault(); }
    }
  });
  filter.addEventListener('input', () => render({force:true}));
  dateRange.addEventListener('change', () => render({force:true}));
  clearAgentButton.addEventListener('click', () => {
    selectedAgent = '';
    renderPresence();
    render({force:true});
  });
  await load();
  if (!renderedFeed) render({force:true});
  schedule(load, 2000);
}
