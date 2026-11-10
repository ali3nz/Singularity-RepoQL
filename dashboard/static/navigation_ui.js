// Responsive application shell, route-aware navigation, and table accessibility.
// No network calls and no changes to dashboard authentication or data.

// Routes whose sidebar entry was consolidated. The retired routes keep working
// (their page still renders), but the sidebar marks the one surviving entry:
//   /knowledge/{wisdom,principle,principles,rule,rules,shape,shapes} -> Concepts
//   /knowledge/connections -> Connections & Links
//   /repositories, /repositories/view -> Indexing (Repositories is a tab there)
//   /cpu, /errors, /excluded -> Diagnostics (tabs of one page)
const NAV_ALIASES = {
  // Bot Operations retired (fleet#832): the view redirects, so a stale link must
  // mark the surviving OpenMausBot entry.
  "/bots": "/openmausbot",
  "/openmausbot/calendar": "/openmausbot",
  "/openmausbot/attention": "/openmausbot",
  "/openmausbot/history": "/openmausbot",
  "/cpu": "/diagnostics",
  "/errors": "/diagnostics",
  "/excluded": "/diagnostics",
  "/repositories": "/indexing",
  "/repositories/view": "/indexing",
  "/knowledge/connections": "/links",
  "/harness/run": "/harness/runs",
  "/reference/agents": "/agents-control",
  "/openmausbot/fleet": "/agents-control",
  "/harness/usage": "/unified/usage",
  "/knowledge/principle": "/knowledge/all",
  "/knowledge/principles": "/knowledge/all",
  "/knowledge/rule": "/knowledge/all",
  "/knowledge/rules": "/knowledge/all",
  "/knowledge/shape": "/knowledge/all",
  "/knowledge/shapes": "/knowledge/all",
  "/knowledge/wisdom": "/knowledge/all",
  "/principles": "/knowledge/all",
  "/rules": "/knowledge/all",
  "/shapes": "/knowledge/all",
  "/wisdom": "/knowledge/all",
  "/unified/tencent-advanced": "/unified/tencent",
};

const normalizePath = (path) => String(path || "/").split("?")[0].replace(/\/+$/, "") || "/";

// Pure route -> sidebar target mapping, shared with app.js markNav so the
// sidebar and the page tab strips can never disagree.
export function navTargetFor(path) {
  const clean = normalizePath(path);
  if (NAV_ALIASES[clean]) return NAV_ALIASES[clean];
  if (clean.startsWith("/knowledge/item")) return "/knowledge/all";
  if (clean.startsWith("/knowledge/")) {
    const category = clean.slice("/knowledge/".length);
    return category === "all" || category === "connectors" ? clean : "/knowledge/all";
  }
  if (clean.startsWith("/harness/")) return "/harness";
  if (clean.startsWith("/indexing")) return "/indexing";
  if (clean.startsWith("/diagnostics")) return "/diagnostics";
  if (clean.startsWith("/repositories")) return "/indexing";
  return clean;
}

// Exact sidebar entries always win; aliases and section prefixes only fill in
// for retired routes and detail pages. `available` is the sidebar's data-nav
// list, so the same function serves app.js markNav and the drawer below.
export function navPathFor(path, available = []) {
  const clean = normalizePath(path);
  return available.includes(clean) ? clean : navTargetFor(clean);
}

export function initNavigationUI() {
  if (typeof window.matchMedia !== 'function') return () => {};
  const sidebar = document.getElementById('site-nav');
  const toggle = document.getElementById('nav-toggle');
  const close = document.getElementById('nav-close');
  const scrim = document.getElementById('nav-scrim');
  const search = document.getElementById('nav-search');
  const feedback = document.getElementById('nav-search-status');
  const pageTitle = document.getElementById('mobile-page-title');
  const main = document.getElementById('app');
  if (!sidebar || !toggle || !close || !scrim || !main) return () => {};

  const mobile = window.matchMedia('(max-width: 940px)');
  const links = [...sidebar.querySelectorAll('[data-nav]')];
  const groups = [...sidebar.querySelectorAll('.nav-section')];
  let opened = false;
  const currentPath = () => (location.hash.replace(/^#/, '').split('?')[0] || '/');
  const navPaths = links.map(link => link.dataset.nav);
  const sectionFor = (path) => {
    const target = navPathFor(path, navPaths);
    return links.find(link => link.dataset.nav === target && !link.hidden) || null;
  };

  function setOpened(shouldOpen, restoreFocus = false) {
    opened = mobile.matches && Boolean(shouldOpen);
    document.body.classList.toggle('nav-open', opened);
    toggle.setAttribute('aria-expanded', String(opened));
    sidebar.inert = mobile.matches && !opened;
    sidebar.setAttribute('aria-hidden', mobile.matches && !opened ? 'true' : 'false');
    scrim.hidden = !opened;
    if (opened) {
      if (search) {
        search.value = '';
        filterLinks('');
        search.focus();
      } else {
        close.focus();
      }
    } else if (restoreFocus && mobile.matches) {
      toggle.focus();
    }
  }

  function filterLinks(raw) {
    const term = raw.trim().toLocaleLowerCase();
    let matches = 0;
    for (const group of groups) {
      const groupName = (group.querySelector('h2')?.textContent || '').toLocaleLowerCase();
      let showGroup = false;
      group.querySelectorAll('[data-nav]').forEach(link => {
        const permitted = link.dataset.variantDisabled !== '1' && !(window.__SINGULARITY_VARIANT__?.features && (link.dataset.nav === '/office' && !window.__SINGULARITY_VARIANT__.features.office));
        const show = permitted && (!term || groupName.includes(term) || link.textContent.toLocaleLowerCase().includes(term));
        link.hidden = !show;
        if (show) { matches++; showGroup = true; }
      });
      group.hidden = !showGroup;
    }
    if (term && matches) sidebar.querySelector('#nav-more')?.setAttribute('open', '');
    if (feedback) feedback.textContent = term ? `${matches} navigation item${matches === 1 ? '' : 's'} found` : '';
  }

  function updateCurrent() {
    const path = currentPath();
    const target = sectionFor(path);
    if (pageTitle) pageTitle.textContent = target?.textContent.trim() || 'RepoQL Dashboard';
    if (target?.closest('#nav-more')) sidebar.querySelector('#nav-more')?.setAttribute('open', '');
    links.forEach(link => {
      if (link === target) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    if (opened) setOpened(false);
    if (search && search.value) { search.value = ''; filterLinks(''); }
  }

  toggle.addEventListener('click', () => setOpened(!opened, opened));
  close.addEventListener('click', () => setOpened(false, true));
  scrim.addEventListener('click', () => setOpened(false, true));
  search?.addEventListener('input', () => filterLinks(search.value));
  search?.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      const visible = links.find(link => !link.hidden && !link.closest('[hidden]'));
      if (visible) { event.preventDefault(); visible.click(); }
    }
  });
  sidebar.addEventListener('click', event => {
    if (event.target.closest('[data-nav]') && opened) {
      setOpened(false);
      window.requestAnimationFrame(() => main.focus({preventScroll:true}));
    }
  });
  window.addEventListener('hashchange', updateCurrent);
  const onModeChange = () => setOpened(false);
  if (mobile.addEventListener) mobile.addEventListener('change', onModeChange);
  else mobile.addListener(onModeChange);

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && opened) { event.preventDefault(); setOpened(false, true); return; }
    if (opened && event.key === 'Tab') {
      const visible = [...sidebar.querySelectorAll('button,input,a[href]')]
        .filter(el => !el.hidden && !el.closest('[hidden]') && el.getClientRects().length);
      if (!visible.length) return;
      const first = visible[0], last = visible[visible.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    const el = event.target;
    if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey &&
        !['INPUT','TEXTAREA','SELECT'].includes(el?.tagName) && !el?.isContentEditable) {
      event.preventDefault();
      if (mobile.matches && !opened) setOpened(true);
      else if (search) search.focus();
    }
  });

  // Tables previously inserted directly into view templates could overflow the
  // viewport. Enhance only live DOM nodes, preserving their listeners.
  let enhancementScheduled = false;
  function enhanceTables() {
    enhancementScheduled = false;
    for (const table of main.querySelectorAll('table.data')) {
      if (!table.closest('.table-wrap')) {
        const wrap = document.createElement('div');
        wrap.className = 'table-wrap responsive-table-wrap';
        table.parentNode.insertBefore(wrap, table);
        wrap.appendChild(table);
      }
    }
    for (const wrap of main.querySelectorAll('.table-wrap')) {
      if (wrap.dataset.uxReady === '1') continue;
      wrap.dataset.uxReady = '1';
      wrap.tabIndex = 0;
      wrap.setAttribute('role', 'region');
      wrap.setAttribute('aria-label', 'Data table, scroll horizontally for more columns');
      if (wrap.classList.contains('ac-stack')) {
        const heads = [...wrap.querySelectorAll('thead th')].map(th => th.textContent.trim());
        wrap.querySelectorAll('tbody tr').forEach(tr => [...tr.children].forEach((td, i) => { if (heads[i] && !td.hasAttribute('colspan')) td.dataset.label = heads[i]; }));
      } else if (wrap.querySelector('table.data')) {
        const help = document.createElement('p');
        help.className = 'table-swipe-hint';
        help.textContent = 'Swipe sideways to see more columns';
        help.setAttribute('aria-hidden', 'true');
        wrap.parentNode.insertBefore(help, wrap);
      }
    }
  }
  function scheduleEnhance() {
    if (enhancementScheduled) return;
    enhancementScheduled = true;
    window.requestAnimationFrame(enhanceTables);
  }
  const observer = new MutationObserver(scheduleEnhance);
  observer.observe(main, {childList: true, subtree: true});
  scheduleEnhance();
  updateCurrent();
  setOpened(false);
  return () => observer.disconnect();
}
