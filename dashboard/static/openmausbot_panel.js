// RepoQL's OpenMausBot portal: the OpenMausBot bot inventory, the RepoQL link,
// and the `omb-bot-registry` reconciler's last readback. Bot Operations was
// retired here (fleet#832); this is the only bot surface in the dashboard.
//
// OpenMausBot owns the bot conversations; the reconciler owns
// Tencent roles and optional legacy Pi / OpenChamber mirrors. This view never
// starts a second registration and never reports a state it has not read.
const IDENTITIES = [
  ['pi', 'Pi Chamber (optional)'],
  ['openchamber', 'OpenChamber (legacy)'],
  ['tencent', 'Tencent MemoryCore'],
];

const OVERALL = {
  ready: ['Registered', 'green'],
  blocked: ['Blocked', 'red'],
  pending: ['Pending registration', 'amber'],
  waiting: ['Waiting for rename', 'amber'],
};

const TONE = {ready: 'green', pending: 'amber', blocked: 'red', neutral: 'neutral'};
const pill = (tone, text) => `<span class="pill ${TONE[tone] || 'amber'}">${text}</span>`;

function officeRow(entry, esc) {
  const row = entry || {};
  const key = row.proposed_session_key ? ` <span class="mono">${esc(row.proposed_session_key)}</span>` : '';
  if (row.verified) return {ok: true, text: `seat present${key}`};
  if (row.state === 'seat_absent') return {ok: false, text: `not seated${key} — the Office active-session list does not contain it`};
  return {ok: false, text: `not active${key}${row.detail ? ' — ' + esc(row.detail) : ''}`};
}

function kanzoRow(entry, esc) {
  const row = entry || {};
  const actor = row.identity_key ? ` <span class="mono">${esc(row.identity_key)}</span>` : '';
  if (row.verified) return {ok: true, text: `holding ${esc(row.task || 'a live claim')}${actor}`};
  if (row.task) return {ok: false, text: `no live claim · last ${esc(row.task)} (${esc(row.task_status)})${actor}`
    + (row.detail ? ' · ' + esc(row.detail) : '')};
  if (row.state === 'no_card_found') return {ok: false, text: `actor has no Kanzo card${actor}`};
  return {ok: false, text: `not active${actor}${row.detail ? ' — ' + esc(row.detail) : ''}`};
}

export async function viewOpenMausBot({app, api, pageHead, esc, toast, current, mode = 'workspace'}) {
  // Phone-first: the workspace route is only the embedded OpenMausBot app.
  // Fleet status lives on its own page under Diagnostics.
  if (mode === 'fleet') {
    app.innerHTML = pageHead('Bot fleet status', 'Tencent MemoryCore, optional Pi registration, Claude Office and Kanzo evidence for each OpenMausBot bot; OpenChamber is a legacy optional integration.')
      + '<section class="block" id="omb-portal" aria-live="polite">Checking the OpenMausBot server…</section>';
    await renderFleet({app, api, esc, toast, current});
    return;
  }
  app.innerHTML = '<section id="omb-workspace" class="native-panel-shell"><div class="loading">Opening OpenMausBot…</div></section>';

  // The real OpenMausBot app, embedded through the dashboard's same-origin
  // proxy with the dashboard's own server-side session: no link, code or sign-in.
  (async () => {
    const holder = app.querySelector('#omb-workspace');
    try {
      await api('/api/embed/openmausbot/handshake', {timeoutMs: 10000});
    } catch (error) {
      if (!current()) return;
      holder.innerHTML = `<div class="block accent-amber"><div class="block-title">OpenMausBot is not connected to the dashboard</div>
        <p class="muted small">The embedded workspace needs the dashboard's OpenMausBot session (${esc(error.message || 'unavailable')}).
        Fleet status (Diagnostics) still works. To reconnect, re-open the Singularity Dashboard shortcut.</p></div>`;
      return;
    }
    if (!current()) return;
    const frame = document.createElement('iframe');
    frame.title = 'OpenMausBot';
    frame.className = 'native-panel-frame';
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('allow', 'clipboard-read; clipboard-write; microphone; fullscreen');
    frame.src = '/embed/openmausbot/';
    holder.replaceChildren(frame);
  })();

}

async function renderFleet({app, api, esc, toast, current}) {
  const render = async () => {
    const info = await api('/api/openmausbot/overview');
    if (!current()) return;
    const holder = app.querySelector('#omb-portal');
    if (!holder) return;
    if (!info.available) {
      holder.innerHTML = `<h2>OpenMausBot inventory is not readable</h2><p>${esc(info.message || 'The server has not been verified.')}</p>
        <p>Existing bots and memory are untouched. Registration is paused until the inventory is readable again.</p>`;
      return;
    }
    const link = info.url
      ? `<a class="btn" id="omb-open" href="${esc(info.url)}" target="_blank" rel="noopener noreferrer">Open in a separate tab</a>`
        + `<span class="muted">${info.seamless
          ? 'Signs you in automatically: no code or token to type.'
          : (info.url_kind === 'lan' ? 'LAN address, plain HTTP (no public URL is configured).' : 'Signed-in address.')
            + ' Automatic sign-in is not connected yet (re-open the Singularity Dashboard shortcut).'}</span>`
      : '<span>No launch address is configured. Use the paired LAN address of the OpenMausBot server.</span>';
    const hint = `<p class="muted">${esc(info.create_hint || 'Create the bot inside OpenMausBot. It registers itself through omb-bot-registry.path; do not register it again here.')}</p>`;
    const bots = Array.isArray(info.bots) ? info.bots : [];
    const retiring = Array.isArray(info.retire_pending) ? info.retire_pending : [];
    const retireBlock = retiring.length
      ? `<article class="block" style="margin-top:12px"><h3>Deleted bots pending clean-up ${pill('pending', String(retiring.length))}</h3>
        <p class="muted">These bots no longer exist in OpenMausBot. Tencent capture eligibility and the registry record are retired after the grace period. Optional Pi session titles are only updated if Pi mirroring remains enabled; Tencent history is retained. A legacy OpenChamber definition is touched only if its old integration remains enabled.</p>
        <div class="table-wrap"><table class="data"><tbody>${retiring.map(row =>
          `<tr><td>${esc(row.name || 'Unnamed bot')} <span class="mono muted">${esc(row.bot_id)}</span></td><td>clean-up at ${esc(row.retires_at || 'unknown')}</td></tr>`).join('')}</tbody></table></div></article>`
      : '';
    const entries = bots.map(bot => {
      const safeId = esc(bot.id);
      const title = esc(bot.name);
      const about = esc(bot.description || 'Conversational identity only. Add a specific mission in OpenMausBot when needed.');
      const overall = bot.overall || 'pending';
      const [overallText, overallTone] = OVERALL[overall] || [overall, 'amber'];
      const states = bot.states || {};
      const rows = IDENTITIES.map(([key, text]) => {
        const entry = states[key] || {state: 'pending', label: 'not read back'};
        const tone = entry.state === 'ready' || entry.state === 'retired' ? 'ready' : entry.state === 'blocked' ? 'blocked' : 'pending';
        return `<tr><td>${text}</td><td>${pill(tone, esc(entry.state))} <span class="muted">${esc(entry.label)}</span></td></tr>`;
      }).join('');
      const activation = bot.activation || {};
      const office = officeRow(activation.claude_office, esc);
      const kanzo = kanzoRow(activation.kanzo, esc);
      const activationRows = [
        ['Claude Office seat', office],
        ['Kanzo actor claim', kanzo],
      ].map(([text, row]) => `<tr><td>${text}</td><td>${pill(row.ok ? 'ready' : 'neutral', row.ok ? 'verified' : 'not active')} <span class="muted">${row.text}</span></td></tr>`)
        .concat('<tr><td>Duo AI coordinator</td><td>' + pill('neutral', 'not active')
          + ' <span class="muted">no bot-scoped coordinator run</span></td></tr>').join('');
      // Read-only: native identities belong to the registry reconciler, and a
      // second registration started here would duplicate them.
      const linked = bot.repoql_id
        ? `<span>RepoQL identity record <span class="mono">${esc(bot.repoql_id)}</span></span>`
        : '<span class="muted">No RepoQL identity record. Registration for this bot is owned by the registry reconciler.</span>';
      const when = bot.bridge && bot.bridge.verified_at ? ` · reconciled ${esc(bot.bridge.verified_at)}` : '';
      const role = bot.bridge && bot.bridge.role ? ` · Tencent role <span class="mono">${esc(bot.bridge.role)}</span>` : '';
      return `<article class="block" style="margin-top:12px">
        <h3>${title} ${pill(overallTone, esc(overallText))}</h3>
        <p class="muted">${about}</p>
        <div class="table-wrap omb-status"><table class="data"><tbody>${rows}${activationRows}</tbody></table></div>
        <p class="muted" style="margin-top:10px">OpenMausBot id <span class="mono">${safeId}</span>${role}${when}</p>
        <p>${linked}</p>
        <p class="muted">Registration, an Office seat and a Kanzo claim are not proof of a running conversation or of captured chat memory.</p>
      </article>`;
    }).join('');
    holder.innerHTML = `<div class="row" style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">
      ${link}<button type="button" class="btn small" id="omb-refresh">Refresh status</button></div>
      ${hint}
      <p>${bots.length} bot${bots.length === 1 ? '' : 's'} reported by the OpenMausBot inventory.
      Registration requires Tencent MemoryCore. Pi Chamber and legacy OpenChamber mirroring are optional;
      registration is not proof of a running conversation or captured chat memory.</p>
      ${entries || '<p>No bots are present in this OpenMausBot workspace.</p>'}${retireBlock}`;
    // Seamless launch: open the tab inside the click (popup-safe), ask the dashboard for a
    // one-shot sign-in link, then navigate it. Any failure lands on the plain address.
    holder.querySelector('#omb-open')?.addEventListener('click', async event => {
      if (!info.seamless) return;
      event.preventDefault();
      const tab = window.open('about:blank', '_blank');
      if (tab) tab.opener = null;
      const go = target => { if (tab) tab.location.href = target; else window.location.href = target; };
      try {
        const result = await api('/api/openmausbot/launch', {method: 'POST', body: {}, timeoutMs: 20000});
        if (result && result.ok && result.url) { go(result.url); return; }
        go((result && result.fallback_url) || info.url);
        toast('OpenMausBot', 'Automatic sign-in unavailable (' + ((result && result.reason) || 'unknown') + '); opened the sign-in page instead.', 'error');
      } catch (error) {
        go(info.url);
        toast('OpenMausBot', 'Automatic sign-in failed: ' + error.message, 'error');
      }
    });
    holder.querySelector('#omb-refresh')?.addEventListener('click', () => {
      render().catch(error => toast('OpenMausBot status', error.message, 'error'));
    });
  };
  await render();
}
