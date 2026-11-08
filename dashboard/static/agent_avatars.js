// Shared agent/bot avatar adapter: inline SVG faces, the deterministic fallback
// and one picker. Extracted from the retired Bot Operations UI (fleet#832) so the
// Agent Lounge keeps the same art; it holds no Bot Operations route or record.
const BOT_PALETTE = ['#59c9bd', '#a38bff', '#edaf6c', '#5e9df3', '#e287b7', '#86cc85', '#e8b4a0', '#8fb8d8'];
const BOT_AVATAR_ART = {
  robot: '<rect x="4.5" y="7.5" width="15" height="10.5" rx="3"/><circle cx="12" cy="4.4" r="1.5"/><rect x="8.4" y="10.8" width="2.4" height="3" rx="1.2" fill="#fff"/><rect x="13.2" y="10.8" width="2.4" height="3" rx="1.2" fill="#fff"/><rect x="9" y="15" width="6" height="1.4" rx=".7" fill="#fff"/>',
  bot: '<rect x="5" y="6" width="14" height="12" rx="4"/><circle cx="9.6" cy="11.4" r="1.5" fill="#fff"/><circle cx="14.4" cy="11.4" r="1.5" fill="#fff"/><path d="M9 15h6" stroke="#fff" stroke-width="1.4" stroke-linecap="round" fill="none"/>',
  cyborg: '<rect x="4.5" y="6" width="15" height="12" rx="3"/><path d="M4.5 10h15"/><circle cx="9.2" cy="14" r="1.5" fill="#fff"/><rect x="13" y="13" width="4" height="2" rx="1" fill="#fff"/><path d="M17 8.5h2.5" stroke="#fff" stroke-width="1.4"/>',
  alien: '<path d="M12 3.5c5 0 8 4.2 8 8.4 0 4.6-4 8.6-8 8.6s-8-4-8-8.6C4 7.7 7 3.5 12 3.5Z"/><path d="M8.4 10.2c1.2-1.6 3-1.6 4.2 0-1.4 1.5-2.8 1.5-4.2 0Z" fill="#fff"/><path d="M11.4 10.2c1.2-1.6 3-1.6 4.2 0-1.4 1.5-2.8 1.5-4.2 0Z" fill="#fff" opacity=".75"/><path d="M9.6 16c1.6 1 3.2 1 4.8 0" stroke="#fff" stroke-width="1.3" fill="none" stroke-linecap="round"/>',
  monster: '<path d="M12 3c4 0 6.6 2.4 7.4 5.6l1.2 1-.9 1.5c.2 4.4-2.6 8.2-7.7 8.2S4.1 15.5 4.3 11.1L3.4 9.6l1.2-1C5.4 5.4 8 3 12 3Z"/><circle cx="9.3" cy="11.2" r="1.6" fill="#fff"/><circle cx="14.7" cy="11.2" r="1.6" fill="#fff"/><path d="M8.6 16.4 9.6 14h4.8l1 2.4" fill="#fff" opacity=".85"/>',
  ghost: '<path d="M12 2.8c4.5 0 7.2 3.2 7.2 7.4v9.3l-2.4-1.7-2.4 1.7-2.4-1.7L9.6 19.5l-2.4-1.7-2.4 1.7V10.2c0-4.2 2.7-7.4 7.2-7.4Z"/><circle cx="9.4" cy="10.4" r="1.5" fill="#fff"/><circle cx="14.6" cy="10.4" r="1.5" fill="#fff"/>',
  cat: '<path d="M5 9 4 3.6l4.6 2.8h6.8L20 3.6 19 9c.8 1.4 1 2.8 1 4.2C20 17.6 16.4 21 12 21S4 17.6 4 13.2C4 11.8 4.2 10.4 5 9Z"/><circle cx="9.2" cy="12" r="1.4" fill="#fff"/><circle cx="14.8" cy="12" r="1.4" fill="#fff"/><path d="M10.8 16.2c.8.7 1.6.7 2.4 0" stroke="#fff" stroke-width="1.2" fill="none" stroke-linecap="round"/>',
  fox: '<path d="M12 21 3.5 8.2 5 3l4 3h6l4-3 1.5 5.2L12 21Z"/><path d="M8.4 11.4 12 20l3.6-8.6H8.4Z" fill="#fff" opacity=".9"/><circle cx="9.6" cy="10" r="1.2" fill="#fff"/><circle cx="14.4" cy="10" r="1.2" fill="#fff"/>',
  owl: '<path d="M12 3c4.4 0 8 3.4 8 7.8 0 5-3.6 10.2-8 10.2S4 15.8 4 10.8C4 6.4 7.6 3 12 3Z"/><path d="M7.4 6.4 9.8 9M16.6 6.4 14.2 9" stroke="#fff" stroke-width="1.5" fill="none"/><circle cx="9.4" cy="11.4" r="2.1" fill="#fff"/><circle cx="14.6" cy="11.4" r="2.1" fill="#fff"/><path d="M11 13.6h2L12 15Z" fill="#fff"/>',
  penguin: '<ellipse cx="12" cy="13" rx="7.4" ry="8.4"/><ellipse cx="12" cy="14.6" rx="4.6" ry="6.4" fill="#fff"/><circle cx="9.6" cy="9.6" r="1.3" fill="#fff"/><circle cx="14.4" cy="9.6" r="1.3" fill="#fff"/><path d="M11 12.4h2l-1 1.4Z" fill="#11151b"/>',
  frog: '<path d="M12 5c4.6 0 8 3 8 7.4 0 4.8-3.6 8-8 8s-8-3.2-8-8C4 8 7.4 5 12 5Z"/><circle cx="8.4" cy="7" r="2.4"/><circle cx="15.6" cy="7" r="2.4"/><circle cx="8.4" cy="7" r="1" fill="#fff"/><circle cx="15.6" cy="7" r="1" fill="#fff"/><path d="M8.6 15.2c2.3 1.6 4.5 1.6 6.8 0" stroke="#fff" stroke-width="1.4" fill="none" stroke-linecap="round"/>',
  panda: '<circle cx="12" cy="12.6" r="8.4"/><circle cx="5.6" cy="6" r="2.6"/><circle cx="18.4" cy="6" r="2.6"/><ellipse cx="9" cy="11.4" rx="2" ry="2.6" fill="#fff"/><ellipse cx="15" cy="11.4" rx="2" ry="2.6" fill="#fff"/><circle cx="9" cy="11.6" r="1" fill="#11151b"/><circle cx="15" cy="11.6" r="1" fill="#11151b"/><path d="M10.4 16.4h3.2" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/>',
  bee: '<ellipse cx="12" cy="13.6" rx="6.4" ry="7"/><path d="M6.2 11h11.6M6.6 15.6h10.8" stroke="#fff" stroke-width="1.6"/><ellipse cx="7.6" cy="7.6" rx="3" ry="2.2" transform="rotate(-22 7.6 7.6)"/><ellipse cx="16.4" cy="7.6" rx="3" ry="2.2" transform="rotate(22 16.4 7.6)"/>',
  octopus: '<path d="M12 3.4c4.2 0 6.8 3 6.8 7 0 2-.4 4.2-1.6 6.2l-1.8-2-1.6 2.6-1.4-2.2-1.4 2.2-1.6-2.6-1.8 2c-1.2-2-1.6-4.2-1.6-6.2 0-4 2.6-7 6.8-7Z"/><circle cx="9.4" cy="10.4" r="1.5" fill="#fff"/><circle cx="14.6" cy="10.4" r="1.5" fill="#fff"/>',
  shark: '<path d="M2.6 15.6c4.4-3.4 9.4-5.2 15-5.4l3.8-1.2-2.2 4.2 2.2 2.6-3.4-.6c-1.6 3.4-4.6 5.2-8.4 4.6-3.6-.6-5.8-2-7-4.2Z"/><path d="M6 13.2 8.6 6l3.4 4.4" /><circle cx="10.2" cy="14" r="1" fill="#fff"/>',
  dino: '<path d="M4.4 20c-.6-6 2.4-11.4 8-13.2l1.2-3 1.6 2.4 3.4-.6-1.2 3c2.6 1.6 4 4.4 4 7.4v4H4.4Z"/><circle cx="14.6" cy="10.2" r="1" fill="#fff"/><path d="M6.4 16.4h3M6.4 19h4" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/>',
  sloth: '<circle cx="12" cy="12" r="8.4"/><path d="M4.2 9.6C3 8 3.6 5.6 6 5.2c1.6 1 1.6 3.4.6 4.8M19.8 9.6c1.2-1.6.6-4-1.8-4.4-1.6 1-1.6 3.4-.6 4.8"/><circle cx="9.2" cy="12" r="1.6" fill="#fff"/><circle cx="14.8" cy="12" r="1.6" fill="#fff"/><path d="M9.8 16.4c1.4 1.2 3 1.2 4.4 0" stroke="#fff" stroke-width="1.3" fill="none" stroke-linecap="round"/>',
  yeti: '<path d="M6 21c-1.2-3-1.6-6-1-9 .8-4 3.4-6.6 7-6.6S19 7 19.8 11c.6 3.2.2 6.2-1 9H6Z"/><circle cx="9.2" cy="11" r="1.5" fill="#fff"/><circle cx="14.8" cy="11" r="1.5" fill="#fff"/><path d="M9.8 15.4c1.4 1 3 1 4.4 0" stroke="#fff" stroke-width="1.4" fill="none" stroke-linecap="round"/>',
  astronaut: '<circle cx="12" cy="12" r="8.4"/><rect x="7.4" y="8.6" width="9.2" height="7" rx="3.4" fill="#fff"/><circle cx="10.2" cy="12" r="1.2"/><circle cx="13.8" cy="12" r="1.2"/>',
  wizard: '<path d="M12 2.6 19 19H5L12 2.6Z"/><path d="M8.4 12.4h7.2" stroke="#fff" stroke-width="1.4"/><circle cx="10.4" cy="20.4" r="1.6"/><circle cx="14.2" cy="21" r="1.2"/>',
  pirate: '<path d="M12 3.4c4.4 0 7.6 3.2 7.6 7.4 0 3-1.4 5.4-3.6 6.8v2.4H8v-2.4c-2.2-1.4-3.6-3.8-3.6-6.8C4.4 6.6 7.6 3.4 12 3.4Z"/><rect x="7.4" y="9.2" width="9.2" height="2.2" rx="1.1" fill="#fff"/><circle cx="9.2" cy="10.3" r=".9" fill="#11151b"/><circle cx="14.8" cy="10.3" r=".9" fill="#11151b"/><path d="M9.6 15.2c1.6.8 3.2.8 4.8 0" stroke="#fff" stroke-width="1.2" fill="none" stroke-linecap="round"/>',
  ninja: '<circle cx="12" cy="12.4" r="8.6"/><rect x="3.2" y="10.4" width="17.6" height="3.4" rx="1.7" fill="#fff"/><circle cx="9" cy="12.1" r=".9" fill="#11151b"/><circle cx="15" cy="12.1" r=".9" fill="#11151b"/>',
  dragon: '<path d="M5 19c-.4-4.4 1.4-7.8 4.6-9.6L8.2 6l3.6 1 1.6-3 1.6 3.4 3.8-.6-1.6 3.2c2.6 1.8 3.8 4.6 3.4 9H5Z"/><circle cx="14" cy="12" r="1.1" fill="#fff"/><path d="M8.6 16.4h2.6M13 16.4h2.6" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/>',
  rocket: '<path d="M12 2.8c3 2.4 4.6 5.8 4.6 9.6L12 21l-4.6-8.6C7.4 8.6 9 5.2 12 2.8Z"/><circle cx="12" cy="10" r="1.8" fill="#fff"/><path d="M7.4 12.6 4.4 16l3.4-.4M16.6 12.6 19.6 16l-3.4-.4" />',
  cactus: '<rect x="9.6" y="4" width="4.8" height="17" rx="2.4"/><path d="M9.6 11H7a2.2 2.2 0 0 1-2.2-2.2V7.4M14.4 13.4H17A2.2 2.2 0 0 0 19.2 11.2V9"/><circle cx="12" cy="7.6" r=".9" fill="#fff"/>',
  bulb: '<path d="M12 3a6.4 6.4 0 0 0-3.6 11.6V17h7.2v-2.4A6.4 6.4 0 0 0 12 3Z"/><rect x="9.6" y="18.4" width="4.8" height="1.8" rx=".9"/><path d="M10.6 13.4 12 9l1.4 4.4" stroke="#fff" stroke-width="1.3" fill="none" stroke-linejoin="round"/>',
  gear: '<path d="M12 3.4 13.4 6l3-.6.6 3 2.6 1.4-1.6 2.6 1.6 2.6-2.6 1.4-.6 3-3-.6L12 20.6 10.6 18l-3 .6-.6-3L4.4 14.2 6 11.6 4.4 9 7 7.6l.6-3 3 .6L12 3.4Z"/><circle cx="12" cy="12" r="3.2" fill="#fff"/>',
  spark: '<path d="M12 2.6 14 9l6.4 2-6.4 2-2 6.4-2-6.4L3.6 11 10 9 12 2.6Z"/><circle cx="18.6" cy="18.4" r="2"/><circle cx="5.4" cy="18.8" r="1.4"/>',
  moon: '<path d="M15.6 3.4a9 9 0 1 0 5 12.6 7.2 7.2 0 0 1-5-12.6Z"/><circle cx="18" cy="6" r="1.2"/><circle cx="20.4" cy="9.6" r=".9"/>'
};
const BOT_AVATAR_NAMES = {
  robot: 'Robot',
  bot: 'Bot',
  cyborg: 'Cyborg',
  alien: 'Alien',
  monster: 'Monster',
  ghost: 'Ghost',
  cat: 'Cat',
  fox: 'Fox',
  owl: 'Owl',
  penguin: 'Penguin',
  frog: 'Frog',
  panda: 'Panda',
  bee: 'Bee',
  octopus: 'Octopus',
  shark: 'Shark',
  dino: 'Dino',
  sloth: 'Sloth',
  yeti: 'Yeti',
  astronaut: 'Astronaut',
  wizard: 'Wizard',
  pirate: 'Pirate',
  ninja: 'Ninja',
  dragon: 'Dragon',
  rocket: 'Rocket',
  cactus: 'Cactus',
  bulb: 'Bulb',
  gear: 'Gear',
  spark: 'Spark',
  moon: 'Moon'
};
export const BOT_AVATAR_IDS = [...Object.keys(BOT_AVATAR_ART), 'initials'];
function avatarFace(id) {
  const art = BOT_AVATAR_ART[id];
  if (!art) return '';
  return `<svg viewBox="0 0 24 24" fill="#11151b" aria-hidden="true" focusable="false">${art}</svg>`;
}
// One adapter for both surfaces: a bot record (contract shape) or a plain
// {id|role, name, avatar, avatar_default} subject from the Agent Lounge.
function avatarSubject(value) {
  if (!value) return {id: '', name: 'Agent', avatar: '', avatar_default: 'initials'};
  if (value.contract) return {id: value.id, name: value.contract.name, avatar: value.avatar, avatar_default: value.avatar_default};
  return {id: String(value.id || value.role || ''), name: String(value.name || value.alias || value.role || 'Agent'),
          avatar: value.avatar || '', avatar_default: value.avatar_default || 'initials'};
}
function avatarColor(value) {
  const key = String(avatarSubject(value).id || 'bot');
  let sum = 0;
  for (const ch of key) sum = (sum * 31 + ch.charCodeAt(0)) >>> 0;
  return BOT_PALETTE[sum % BOT_PALETTE.length];
}
function avatarInitials(value) {
  const name = avatarSubject(value).name.trim() || 'Agent';
  return name.split(/\s+/u).slice(0, 2).map(word => word[0] || '').join('').toUpperCase() || 'A';
}
// A stored choice wins; otherwise the deterministic server default; '' means unset.
function avatarIdOf(value) {
  const subject = avatarSubject(value);
  const stored = String(subject.avatar || '').trim();
  if (stored) return stored;
  return String(subject.avatar_default || '').trim() || 'initials';
}
function avatarInner(value, esc) {
  const id = avatarIdOf(value);
  return id === 'initials' ? esc(avatarInitials(value)) : (avatarFace(id) || esc(avatarInitials(value)));
}
// Agent Lounge rows and messages use the same art; only a pickable row is a button.
export function agentAvatar(subject, esc, options = {}) {
  const s = avatarSubject(subject);
  const cls = options.className || 'lounge-person-avatar';
  const style = `--bot-avatar:${avatarColor(s)}`;
  const inner = avatarInner(s, esc);
  if (!options.pickable) return `<span class="${cls}" style="${style}" aria-hidden="true">${inner}</span>`;
  return `<button type="button" class="${cls} ${cls}-pick" style="${style}" data-agent-avatar="${esc(s.id)}" ` +
    `aria-label="Change avatar for ${esc(s.name)}" title="Change avatar">${inner}` +
    `<span class="botops-avatar-edit-badge" aria-hidden="true">✎</span></button>`;
}
// The picker is one dialog, dismissed by Escape or a backdrop click, with arrow-key
// movement over the options. It posts one allowlisted id to the surface's endpoint.
export function openAvatarPicker({bot, subject, api, esc, endpoint, onSaved, title = 'Choose an avatar', note}) {
  const s = avatarSubject(subject || bot);
  // The Bot Operations route that used to own this default is retired (fleet#832);
  // a picker must name the endpoint it is allowed to write to.
  if (!endpoint) throw new Error('openAvatarPicker needs an endpoint');
  const post = endpoint;
  document.getElementById('botops-avatar-overlay')?.remove();
  const selectedId = avatarIdOf(s);
  const defaults = String(s.avatar || '').trim() ? String(s.avatar_default || '') : selectedId;
  const overlay = document.createElement('div');
  overlay.id = 'botops-avatar-overlay';
  overlay.className = 'botops-avatar-overlay';
  overlay.innerHTML = `<div class="botops-avatar-sheet" role="dialog" aria-modal="true" aria-labelledby="botops-avatar-title">
    <div class="botops-avatar-head"><h2 id="botops-avatar-title">${esc(title)}</h2>
      <button type="button" class="botops-avatar-close" data-avatar-close aria-label="Close avatar picker">✕</button></div>
    <p class="botops-avatar-note" id="botops-avatar-note">${esc(note || 'Saved for this bot and shown in its list and header.')}</p>
    <div class="botops-avatar-grid" role="listbox" aria-label="Avatars" aria-describedby="botops-avatar-note">
      ${BOT_AVATAR_IDS.map(id => {
        const label = id === 'initials' ? 'Initials' : (BOT_AVATAR_NAMES[id] || id);
        const face = id === 'initials' ? `<span class="botops-avatar-initials">${esc(avatarInitials(s))}</span>` : avatarFace(id);
        return `<button type="button" role="option" data-avatar-id="${id}" aria-selected="${id === selectedId}"
          aria-label="${esc(label)}${id === defaults ? ' (default)' : ''}" title="${esc(label)}"
          class="botops-avatar-option"><span class="botops-avatar-chip" style="--bot-avatar:${avatarColor(s)}">${face}</span></button>`;
      }).join('')}
    </div>
    <p class="botops-avatar-status" role="status" aria-live="polite"></p>
  </div>`;
  document.body.append(overlay);
  const grid = overlay.querySelector('.botops-avatar-grid');
  const status = overlay.querySelector('.botops-avatar-status');
  const options = [...grid.querySelectorAll('[data-avatar-id]')];
  const trigger = document.activeElement;
  let busy = false;
  const close = () => { overlay.remove(); trigger?.focus?.({preventScroll: true}); };
  (grid.querySelector('[aria-selected="true"]') || options[0])?.focus({preventScroll: true});
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  overlay.querySelector('[data-avatar-close]').addEventListener('click', close);
  overlay.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); close(); } });
  grid.addEventListener('keydown', event => {
    const index = options.indexOf(document.activeElement);
    const columns = 6;
    let next = null;
    if (event.key === 'ArrowRight') next = index + 1;
    else if (event.key === 'ArrowLeft') next = index - 1;
    else if (event.key === 'ArrowDown') next = index + columns;
    else if (event.key === 'ArrowUp') next = index - columns;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    if (next !== null) {
      event.preventDefault();
      options[Math.max(0, Math.min(next, options.length - 1))]?.focus({preventScroll: true});
    } else if (event.key === 'Tab') {
      const first = overlay.querySelector('[data-avatar-close]');
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); options[options.length - 1].focus(); }
      else if (!event.shiftKey && index === options.length - 1) { event.preventDefault(); first.focus(); }
    }
  });
  grid.addEventListener('click', async event => {
    const button = event.target.closest('[data-avatar-id]');
    if (!button || busy) return;
    const id = button.dataset.avatarId;
    busy = true;
    status.textContent = 'Saving…';
    try {
      const reply = await api(post, {method: 'POST', body: {avatar: id}, timeoutMs: 15000});
      s.avatar = reply?.bot?.avatar ?? reply?.agent?.avatar ?? id;
      for (const option of options) option.setAttribute('aria-selected', String(option.dataset.avatarId === id));
      const inner = avatarInner(s, esc);
      if (onSaved) onSaved(id, inner);
      else {
        document.querySelectorAll('[data-avatar-edit]').forEach(node => {
          node.innerHTML = inner + '<span class="botops-avatar-edit-badge" aria-hidden="true">✎</span>';
        });
      }
      status.textContent = 'Saved';
      setTimeout(() => { if (overlay.isConnected) close(); }, 380);
    } catch (error) {
      status.textContent = error?.status === 429 ? 'Too many changes — try again in a minute.'
        : error?.message === 'unknown avatar' ? 'That avatar is not available.' : 'Could not save — try again.';
    } finally {
      busy = false;
    }
  });
}
