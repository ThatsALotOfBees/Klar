import { api, session, Realtime } from './api.js';

// Tiny logging shim. When the desktop shell exposes window.klar.log (Electron
// preload bridge), every event also lands in a per-session log file under
// userData/Klar/logs/. In a regular browser tab there's no preload — we fall
// back to the JS console.
const klog = {
  info:  (cat, msg, extra) => { try { window.klar?.log?.info?.(cat, msg, extra); } catch {}; console.log(`[klar] ${cat}: ${msg}`, extra || ''); },
  warn:  (cat, msg, extra) => { try { window.klar?.log?.warn?.(cat, msg, extra); } catch {}; console.warn(`[klar] ${cat}: ${msg}`, extra || ''); },
  error: (cat, msg, extra) => { try { window.klar?.log?.error?.(cat, msg, extra); } catch {}; console.error(`[klar] ${cat}: ${msg}`, extra || ''); },
};

const root = document.getElementById('app');
const tplAuth = document.getElementById('tpl-auth');
const tplApp = document.getElementById('tpl-app');
const tplSidebarHome = document.getElementById('tpl-sidebar-home');
const tplSidebarServer = document.getElementById('tpl-sidebar-server');

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

// ---------- Persistent session ("remember me") ----------
//
// When the user opts in via the "Stay logged in" checkbox, we stash the
// session token plus the unlocked CryptoKey objects in IndexedDB. CryptoKeys
// are structured-clonable, so the private key never has to be re-derived
// from the password on reload — but the user still has to opt in, because
// keeping the unlocked private key on disk is a real trade-off.
//
// Without remember-me, both the token and the private key live in JS memory
// only and are gone on reload (matches our earlier in-memory-only stance,
// which also makes multi-tab independent sessions Just Work).

const SESSION_DB = 'klar';
const SESSION_STORE = 'session';
const SESSION_KEY = 'current';

function openSessionDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SESSION_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SESSION_STORE)) db.createObjectStore(SESSION_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function saveSavedSession(payload) {
  try {
    const db = await openSessionDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SESSION_STORE, 'readwrite');
      tx.objectStore(SESSION_STORE).put(payload, SESSION_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { console.error('saveSavedSession failed', e); }
}
async function loadSavedSession() {
  try {
    const db = await openSessionDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(SESSION_STORE, 'readonly');
      const r = tx.objectStore(SESSION_STORE).get(SESSION_KEY);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(r.error);
    });
  } catch (e) { console.error('loadSavedSession failed', e); return null; }
}
async function clearSavedSession() {
  try {
    const db = await openSessionDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SESSION_STORE, 'readwrite');
      tx.objectStore(SESSION_STORE).delete(SESSION_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { console.error('clearSavedSession failed', e); }
}

function svgIcon(id, size) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  if (size) { svg.setAttribute('width', size); svg.setAttribute('height', size); }
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttributeNS(XLINK_NS, 'xlink:href', `#${id}`);
  use.setAttribute('href', `#${id}`);
  svg.appendChild(use);
  return svg;
}

const state = {
  user: null,

  dms: [],
  messagesByDm: new Map(),
  dmHistoryFetched: new Set(),

  servers: [],
  serverDetails: new Map(),
  channelMessagesByChan: new Map(),
  channelHistoryFetched: new Set(),

  view: { kind: 'home' },
  activeDmId: null,
  activeChannelId: null,

  usersById: new Map(),
  realtime: null,
  userlistHidden: false,
};

// Tiny stable id for optimistic-send tracking. Crypto.randomUUID is in every
// browser back to ~2022. The id round-trips through the server (POST body ->
// echoed back in the response and the WS broadcast), so the client can match
// the confirmation against the dimmed local row and un-dim it in place.
function newClientId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function rememberUser(u) {
  if (!u || !u.id) return;
  state.usersById.set(u.id, {
    id: u.id,
    username: u.username,
    displayName: u.displayName || u.username,
    publicKey: u.publicKey,
  });
}
function userById(id) {
  return state.usersById.get(id) || { id, username: 'unknown', displayName: 'Unknown user' };
}

function avatarText(name) {
  if (!name) return '?';
  return name.trim().slice(0, 1).toUpperCase();
}
// Hash a seed -> a stable hex color the design's radial-gradient avatar can use.
function avatarHexColor(seed) {
  if (!seed) return '#9d6dff';
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  const palette = ['#9d6dff', '#7a52cc', '#6dd5c4', '#f0a868', '#e85d75', '#5a8aff', '#c084fc', '#d4a574'];
  return palette[((h % palette.length) + palette.length) % palette.length];
}
function shadeHex(hex, factor) {
  const c = hex.replace('#', '');
  const r = Math.min(255, Math.max(0, Math.round(parseInt(c.slice(0, 2), 16) * factor)));
  const g = Math.min(255, Math.max(0, Math.round(parseInt(c.slice(2, 4), 16) * factor)));
  const b = Math.min(255, Math.max(0, Math.round(parseInt(c.slice(4, 6), 16) * factor)));
  return `rgb(${r}, ${g}, ${b})`;
}
function paintAvatar(el, user) {
  if (!el || !user) return;
  el.textContent = avatarText(user.displayName || user.name);
  const c = avatarHexColor(user.id || user.username || user.displayName);
  el.style.background = `radial-gradient(circle at 30% 30%, ${shadeHex(c, 1.5)}, ${c} 60%, ${shadeHex(c, 0.55)})`;
}
function paintServerOrb(el, server) {
  if (!el) return;
  el.textContent = avatarText(server.name);
  const c = avatarHexColor(server.id || server.name);
  el.style.background = `radial-gradient(circle at 30% 25%, ${shadeHex(c, 1.4)}, ${c} 50%, ${shadeHex(c, 0.5)})`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (sameDay) return 'Today at ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday at ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function dayLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return 'TODAY';
  if (d.toDateString() === yesterday.toDateString()) return 'YESTERDAY';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase();
}

function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); }
function mountTemplate(tpl) {
  clear(root);
  root.appendChild(tpl.content.cloneNode(true));
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ===========================================================================
// "Server unreachable" screen
// ===========================================================================

function renderServerUnreachable(detail) {
  clear(root);
  const wrap = document.createElement('div');
  wrap.className = 'error-shell';
  wrap.innerHTML = `
    <div class="starfield"></div>
    <div class="nebula-glow nebula-a"></div>
    <div class="nebula-glow nebula-b"></div>
    <div class="error-card">
      <div class="broken-cable">
        <svg viewBox="0 0 120 64" aria-hidden="true"><use href="#klar-broken-cable"/></svg>
      </div>
      <h2>Couldn't connect to the server</h2>
      <p>Please try again later.</p>
      <div class="error-server" data-server></div>
      <div class="error-actions">
        <button data-action="retry" type="button">Retry</button>
      </div>
    </div>
  `;
  root.appendChild(wrap);
  const cfg = (window.KLAR_CONFIG || {});
  const serverEl = wrap.querySelector('[data-server]');
  if (cfg.serverUrl) serverEl.textContent = cfg.serverUrl;
  wrap.querySelector('[data-action="retry"]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = 'Retrying…';
    await boot();
  });
}

// ===========================================================================
// Auth screen
// ===========================================================================

function renderAuth(initialError) {
  mountTemplate(tplAuth);
  const tabs = root.querySelectorAll('.tab');
  const forms = {
    login: root.querySelector('[data-form="login"]'),
    register: root.querySelector('[data-form="register"]'),
  };
  const errEl = root.querySelector('[data-error]');
  const showError = (msg) => {
    if (!msg) { errEl.hidden = true; errEl.textContent = ''; return; }
    errEl.hidden = false; errEl.textContent = msg;
  };
  if (initialError) showError(initialError);

  tabs.forEach((t) => t.addEventListener('click', () => {
    tabs.forEach((x) => x.classList.toggle('active', x === t));
    Object.entries(forms).forEach(([k, f]) => f.classList.toggle('hidden', k !== t.dataset.tab));
    showError(null);
  }));

  forms.login.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError(null);
    const fd = new FormData(forms.login);
    const username = (fd.get('klar_id') || '').toString().trim();
    const password = (fd.get('klar_secret') || '').toString();
    const remember = fd.get('remember') === 'on';
    const btn = forms.login.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Logging in...';
    try {
      const { token, user } = await api.login({ username, password });
      session.token = token;
      state.user = user;
      rememberUser(user);
      if (remember) await saveSavedSession({ token, user });
      else await clearSavedSession();
      klog.info('auth.login', 'logged in', { user: user.username, remember });
      await enterApp();
    } catch (err) {
      klog.warn('auth.login', 'failed', { err: err.message });
      showError(err.message || 'login failed');
      btn.disabled = false; btn.textContent = 'Log in';
    }
  });

  forms.register.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError(null);
    const fd = new FormData(forms.register);
    const username = (fd.get('klar_id') || '').toString().trim();
    const displayName = (fd.get('klar_display') || '').toString().trim() || username;
    const password = (fd.get('klar_secret') || '').toString();
    const remember = fd.get('remember') === 'on';
    const btn = forms.register.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Creating account...';
    try {
      const { token, user } = await api.register({ username, displayName, password });
      session.token = token;
      state.user = user;
      rememberUser(user);
      if (remember) await saveSavedSession({ token, user });
      else await clearSavedSession();
      klog.info('auth.register', 'new account', { user: user.username, remember });
      await enterApp();
    } catch (err) {
      klog.warn('auth.register', 'failed', { err: err.message });
      showError(err.message || 'registration failed');
      btn.disabled = false; btn.textContent = 'Create account';
    }
  });
}

// ===========================================================================
// App shell
// ===========================================================================

function enterApp() {
  mountTemplate(tplApp);

  root.querySelector('[data-action="select-home"]').addEventListener('click', () => switchView({ kind: 'home' }));
  root.querySelector('[data-action="create-server"]').addEventListener('click', openCreateServerModal);
  root.querySelector('[data-action="join-server"]').addEventListener('click', openJoinServerModal);

  state.realtime = new Realtime();
  state.realtime.addEventListener('message',             (e) => onRemoteDmMessage(e.detail.message));
  state.realtime.addEventListener('dm_created',          (e) => onRemoteDmCreated(e.detail.dm));
  state.realtime.addEventListener('dm_updated',          (e) => onRemoteDmUpdated(e.detail));
  state.realtime.addEventListener('channel_message',     (e) => onRemoteChannelMessage(e.detail.message));
  state.realtime.addEventListener('channel_created',     (e) => onRemoteChannelCreated(e.detail.channel));
  state.realtime.addEventListener('server_member_joined',(e) => onRemoteMemberJoined(e.detail));
  state.realtime.addEventListener('server_member_left',  (e) => onRemoteMemberLeft(e.detail));
  state.realtime.addEventListener('server_deleted',      (e) => onRemoteServerDeleted(e.detail));
  state.realtime.connect();

  // Render the home view IMMEDIATELY with whatever's cached (usually empty
  // on first launch). DMs and servers populate as they arrive — the
  // sidebar re-renders the moment loadDms/loadServers resolve.
  switchView({ kind: 'home' });
  setupComposer();

  loadDms().catch((e) => klog.error('enterApp.loadDms', 'failed', { err: e.message }));
  loadServers().catch((e) => klog.error('enterApp.loadServers', 'failed', { err: e.message }));

  // Re-discover the server URL every minute so friends auto-track tunnel
  // URL changes mid-session without a manual restart.
  if (state._discoverTimer) clearInterval(state._discoverTimer);
  state._discoverTimer = setInterval(() => {
    api.discoverServerUrl().catch(() => {});
  }, 60_000);
}

async function loadDms() {
  const { dms } = await api.listDms();
  state.dms = dms;
  for (const dm of dms) rememberUser(dm.other);
  // Re-render the sidebar if we're still on home view.
  if (state.view.kind === 'home') renderDmList();
}

async function loadServers() {
  const { servers } = await api.listServers();
  state.servers = servers;
  renderServerRail();
}

function renderServerRail() {
  const list = root.querySelector('[data-server-list]');
  if (!list) return;
  clear(list);
  for (const s of state.servers) {
    const slot = document.createElement('div');
    slot.className = 'rail-slot';
    if (state.view.kind === 'server' && state.view.serverId === s.id) slot.classList.add('active');
    slot.dataset.label = s.name;
    slot.innerHTML = `
      <span class="pill"></span>
      <span class="orbit-ring"></span>
      <button class="rail-btn"></button>
    `;
    const btn = slot.querySelector('.rail-btn');
    // Alternate planet/asteroid based on hash of server id, mirroring the design.
    const isAsteroid = (s.id.charCodeAt(0) ^ s.id.charCodeAt(1 % s.id.length)) % 2 === 0;
    btn.classList.add(isAsteroid ? 'asteroid' : 'planet');
    paintServerOrb(btn, s);
    btn.addEventListener('click', () => switchView({ kind: 'server', serverId: s.id }));
    list.appendChild(slot);
  }

  // Update home-slot active state
  const homeSlot = root.querySelector('[data-action="select-home"]');
  if (homeSlot) homeSlot.classList.toggle('active', state.view.kind === 'home');
}

// ===========================================================================
// View switching
// ===========================================================================

async function switchView(view) {
  state.view = view;
  state.activeDmId = null;
  state.activeChannelId = null;

  root.querySelector('[data-chat-active]').classList.add('hidden');
  root.querySelector('[data-chat-empty]').classList.remove('hidden');
  clear(root.querySelector('[data-messages]'));
  clear(root.querySelector('[data-chat-header]'));
  setComposerStatus(null, false);

  // Hide members panel by default; server view re-shows it.
  root.querySelector('[data-app-shell]').classList.add('no-members');
  root.querySelector('[data-members]').classList.add('hidden');

  renderServerRail();

  if (view.kind === 'home') {
    renderHomeSidebar();
  } else if (view.kind === 'server') {
    await renderServerSidebar(view.serverId);
  }
}

// ===========================================================================
// Sidebar: home (DMs)
// ===========================================================================

function renderHomeSidebar() {
  const sidebar = root.querySelector('[data-sidebar]');
  clear(sidebar);
  sidebar.appendChild(tplSidebarHome.content.cloneNode(true));
  setupUserSearch();
  renderDmList();
  renderMeBar();

  const emptyTitle = root.querySelector('[data-chat-empty] h2');
  const emptyP = root.querySelector('[data-chat-empty] p');
  if (emptyTitle) emptyTitle.textContent = 'Direct messages';
  if (emptyP) emptyP.textContent = 'Search a username on the left to start a transmission.';
}

function renderDmList() {
  const ul = root.querySelector('[data-dm-list]');
  if (!ul) return;
  clear(ul);
  for (const dm of state.dms) {
    const li = document.createElement('li');
    li.className = 'dm-item' + (dm.id === state.activeDmId ? ' active' : '');
    li.innerHTML = `<div class="avatar"></div><div class="dm-name"></div>`;
    paintAvatar(li.querySelector('.avatar'), dm.other);
    li.querySelector('.dm-name').textContent = dm.other.displayName;
    li.addEventListener('click', () => openDm(dm.id));
    ul.appendChild(li);
  }
}

function setupUserSearch() {
  const input = root.querySelector('[data-user-search]');
  const results = root.querySelector('[data-search-results]');
  if (!input) return;
  let t = 0;
  input.addEventListener('input', async () => {
    const q = input.value.trim();
    const my = ++t;
    if (!q) { results.hidden = true; clear(results); return; }
    try {
      const { users } = await api.searchUsers(q);
      if (my !== t) return;
      clear(results);
      if (!users.length) {
        const empty = document.createElement('div');
        empty.className = 'search-result';
        empty.style.color = 'var(--starlight-faint)';
        empty.textContent = 'No pilots found';
        results.appendChild(empty);
      } else {
        for (const u of users) {
          rememberUser(u);
          const r = document.createElement('div');
          r.className = 'search-result';
          r.innerHTML = `<div class="avatar"></div><div><div>${escapeHtml(u.displayName)}</div><div class="muted">@${escapeHtml(u.username)}</div></div>`;
          paintAvatar(r.querySelector('.avatar'), u);
          r.addEventListener('click', async () => {
            input.value = ''; results.hidden = true;
            try {
              const { dm } = await api.createDm(u.id);
              if (!dm || !dm.id) {
                alert('Could not start the conversation. Server returned an empty response.');
                console.error('createDm returned no dm:', { dm });
                return;
              }
              rememberUser(u);
              const enriched = { ...dm, other: u, lastAt: dm.createdAt || dm.lastAt };
              const existing = state.dms.find((d) => d.id === dm.id);
              if (!existing) state.dms.unshift(enriched);
              renderDmList();
              openDm(dm.id);
            } catch (err) {
              console.error('createDm/openDm failed:', err);
              alert(err.message || 'Could not start the conversation.');
            }
          });
          results.appendChild(r);
        }
      }
      results.hidden = false;
    } catch (err) { console.error(err); }
  });
  input.addEventListener('blur', () => setTimeout(() => results.hidden = true, 150));
  input.addEventListener('focus', () => { if (results.firstChild) results.hidden = false; });
}

function renderMeBar() {
  const bar = root.querySelector('[data-me-bar]');
  if (!bar || !state.user) return;
  clear(bar);
  const wrap = document.createElement('div');
  wrap.className = 'avatar-wrap';
  wrap.innerHTML = `<div class="avatar"></div><span class="status-dot"></span>`;
  paintAvatar(wrap.querySelector('.avatar'), state.user);
  bar.appendChild(wrap);

  const info = document.createElement('div');
  info.className = 'me-info';
  info.innerHTML = `<div class="me-name"></div><div class="me-handle"></div>`;
  info.querySelector('.me-name').textContent = state.user.displayName;
  info.querySelector('.me-handle').textContent = state.user.username;
  bar.appendChild(info);

  const actions = document.createElement('div');
  actions.className = 'footer-actions';
  for (const [icon, title] of [['klar-mic', 'Mic'], ['klar-headphones', 'Headphones'], ['klar-settings', 'Settings'], ['klar-logout', 'Log out']]) {
    const b = document.createElement('button');
    b.className = 'footer-btn';
    b.title = title;
    b.appendChild(svgIcon(icon, 16));
    if (icon === 'klar-logout') b.addEventListener('click', logout);
    actions.appendChild(b);
  }
  bar.appendChild(actions);
}

// ===========================================================================
// Sidebar: server (channels) + Members panel
// ===========================================================================

async function renderServerSidebar(serverId) {
  const sidebar = root.querySelector('[data-sidebar]');
  clear(sidebar);
  sidebar.appendChild(tplSidebarServer.content.cloneNode(true));

  let detail = state.serverDetails.get(serverId);
  try {
    const fresh = await api.getServer(serverId);
    detail = fresh;
    state.serverDetails.set(serverId, fresh);
    for (const m of fresh.members) rememberUser(m);
  } catch (err) {
    console.error('getServer failed', err);
    if (!detail) { switchView({ kind: 'home' }); return; }
  }

  root.querySelector('[data-server-name]').textContent = detail.server.name;
  const meta = root.querySelector('[data-server-tag]');
  if (meta) meta.textContent = `${detail.members.length} member${detail.members.length === 1 ? '' : 's'} · OPEN FREQUENCY`;

  root.querySelector('[data-action="server-menu"]').addEventListener('click', () => openServerMenu(serverId));

  renderChannelList(serverId);
  renderMeBar();
  renderMembersPanel(serverId);

  // Honor the user's saved member-list preference (toggle in the channel
  // header). Defaults to visible on first open of the session.
  applyUserlistVisibility();

  const firstChannel = detail.channels[0];
  if (firstChannel) openChannel(firstChannel.id);
  else {
    const emptyTitle = root.querySelector('[data-chat-empty] h2');
    const emptyP = root.querySelector('[data-chat-empty] p');
    if (emptyTitle) emptyTitle.textContent = detail.server.name;
    if (emptyP) emptyP.textContent = detail.server.ownerId === state.user.id
      ? 'No channels yet. Open the menu (top-right) to spin one up.'
      : 'No channels yet — ask the captain to open one.';
  }
}

function renderChannelList(serverId) {
  const ul = root.querySelector('[data-channel-list]');
  if (!ul) return;
  clear(ul);
  const detail = state.serverDetails.get(serverId);
  if (!detail) return;

  // Single category for the MVP — server-side has no category concept yet.
  const cat = document.createElement('li');
  cat.className = 'channel-category';
  cat.textContent = 'OPEN COMMS';
  ul.appendChild(cat);

  for (const ch of detail.channels) {
    const li = document.createElement('li');
    li.className = 'channel-item' + (ch.id === state.activeChannelId ? ' active' : '');
    li.innerHTML = `<span class="channel-icon"></span><span class="channel-name"></span>`;
    li.querySelector('.channel-icon').appendChild(svgIcon('klar-hash', 18));
    li.querySelector('.channel-name').textContent = ch.name;
    li.addEventListener('click', () => openChannel(ch.id));
    ul.appendChild(li);
  }
}

function renderMembersPanel(serverId) {
  const panel = root.querySelector('[data-members]');
  if (!panel) return;
  clear(panel);
  const detail = state.serverDetails.get(serverId);
  if (!detail) return;

  const header = document.createElement('div');
  header.className = 'members-header';
  header.textContent = `MEMBERS — ${detail.members.length}`;
  panel.appendChild(header);

  const owners = detail.members.filter((m) => m.id === detail.server.ownerId);
  const others = detail.members.filter((m) => m.id !== detail.server.ownerId);

  const renderGroup = (label, list, ownerFlag) => {
    if (!list.length) return;
    const lbl = document.createElement('div');
    lbl.className = 'member-group-label';
    lbl.textContent = `${label} — ${list.length}`;
    panel.appendChild(lbl);
    for (const m of list) {
      const row = document.createElement('div');
      row.className = 'member-row' + (ownerFlag ? ' owner' : '');
      row.innerHTML = `
        <div class="member-avatar-wrap online">
          <div class="avatar"></div>
          <span class="status-dot"></span>
        </div>
        <div class="info">
          <div class="name"></div>
        </div>
      `;
      paintAvatar(row.querySelector('.avatar'), m);
      row.querySelector('.name').textContent = m.displayName;
      panel.appendChild(row);
    }
  };

  renderGroup('CAPTAIN', owners, true);
  renderGroup('CREW', others, false);
}

// Members panel toggle (channel header button). Reflects current state in
// `state.userlistHidden` so the preference persists across channel switches
// inside the same session.
function toggleUserlist() {
  state.userlistHidden = !state.userlistHidden;
  applyUserlistVisibility();
}
function applyUserlistVisibility() {
  const shell = root.querySelector('[data-app-shell]');
  const panel = root.querySelector('[data-members]');
  if (!shell || !panel) return;
  if (state.userlistHidden) {
    shell.classList.add('no-members');
    panel.classList.add('hidden');
  } else {
    shell.classList.remove('no-members');
    panel.classList.remove('hidden');
  }
  syncUserlistButton();
}
function syncUserlistButton() {
  const btn = root.querySelector('[data-action="toggle-userlist"]');
  if (!btn) return;
  const showing = !state.userlistHidden;
  btn.setAttribute('aria-pressed', String(showing));
  btn.title = showing ? 'Hide member list' : 'Show member list';
  btn.classList.toggle('active', showing);
}

// Profile modal — surfaces a peer's identity for DMs. Server-side `/api/me`
// only returns the current user, so for DM peers we fall back to whatever is
// in the cached user record (id, username, displayName).
function openProfileModal(user) {
  if (!user) return;
  openModal('tpl-modal-profile', (modal) => {
    paintAvatar(modal.querySelector('.avatar'), user);
    modal.querySelector('[data-profile-name]').textContent = user.displayName || user.username || 'Unknown pilot';
    modal.querySelector('[data-profile-handle]').textContent = '@' + (user.username || '?');
    const idEl = modal.querySelector('[data-profile-id]');
    if (idEl) idEl.textContent = user.id || '';
    const joinedEl = modal.querySelector('[data-profile-joined]');
    if (joinedEl) {
      if (user.createdAt) {
        joinedEl.textContent = new Date(user.createdAt).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
      } else {
        joinedEl.textContent = '—';
      }
    }
  });
}

// ===========================================================================
// DM: open + render
// ===========================================================================

function openDm(dmId) {
  state.activeDmId = dmId;
  state.activeChannelId = null;
  renderDmList();

  const dm = state.dms.find((d) => d.id === dmId);
  if (!dm) return;

  root.querySelector('[data-chat-empty]').classList.add('hidden');
  root.querySelector('[data-chat-active]').classList.remove('hidden');

  const header = root.querySelector('[data-chat-header]');
  clear(header);
  header.innerHTML = `
    <div class="chat-title">
      <div class="avatar"></div>
      <div>
        <div class="channel-name"></div>
        <div class="peer-handle"></div>
      </div>
    </div>
    <div class="chat-topic">Direct message</div>
    <div class="actions">
      <button class="icon-btn" data-action="dm-profile" title="View profile" aria-label="View profile">
        <svg width="18" height="18"><use href="#klar-user"/></svg>
      </button>
    </div>
  `;
  paintAvatar(header.querySelector('.avatar'), dm.other);
  header.querySelector('.channel-name').textContent = dm.other.displayName;
  header.querySelector('.peer-handle').textContent = dm.other.username;
  header.querySelector('[data-action="dm-profile"]').addEventListener('click', () => openProfileModal(dm.other));

  const status = root.querySelector('[data-composer-status]');
  if (status) { status.textContent = ''; status.classList.remove('encrypted'); }

  if (!state.messagesByDm.has(dmId)) state.messagesByDm.set(dmId, []);

  // Render whatever's cached *immediately* so the chat appears instantly.
  // Then kick off the history fetch in the background and re-render only if
  // the user is still on this DM by the time the network round-trip lands.
  renderDmMessages(dm);
  root.querySelector('[data-composer-input]').placeholder = `Message @${dm.other.username}`;
  root.querySelector('[data-composer-input]').focus();
  klog.info('dm.open', 'opened DM', { dm: dm.id, peer: dm.other.username });

  if (!state.dmHistoryFetched.has(dmId)) {
    state.dmHistoryFetched.add(dmId);
    api.listMessages(dmId).then(({ messages: rows }) => {
      const list = state.messagesByDm.get(dmId) || [];
      const seen = new Set(list.map((m) => m.id));
      let added = 0;
      for (const r of rows) if (!seen.has(r.id)) { list.push(r); added++; }
      if (added > 0) {
        list.sort((a, b) => a.createdAt - b.createdAt);
        state.messagesByDm.set(dmId, list);
        if (state.activeDmId === dmId) renderDmMessages(dm);
      }
    }).catch((err) => {
      // Allow a retry on next open.
      state.dmHistoryFetched.delete(dmId);
      klog.error('dm.history', 'load failed', { dm: dmId, err: err && err.message });
    });
  }
}

function setComposerStatus(text, encrypted) {
  const status = root.querySelector('[data-composer-status]');
  if (!status) return;
  status.textContent = text || '';
  status.classList.toggle('encrypted', !!encrypted);
}

function renderDmMessages(dm) {
  const list = root.querySelector('[data-messages]');
  clear(list);
  list.appendChild(buildChannelIntro({ kind: 'dm', name: dm.other.displayName, username: dm.other.username }));
  const messages = state.messagesByDm.get(dm.id) || [];
  let prevDay = null;
  for (const m of messages) {
    const day = dayLabel(m.createdAt);
    if (day !== prevDay) { list.appendChild(buildDayDivider(day, m.createdAt)); prevDay = day; }
    const showHeader = shouldShowHeader(list.lastElementChild, m.senderId, m.createdAt);
    const row = buildDmMessageRow(dm, m, showHeader);
    list.appendChild(row);
  }
  list.scrollTop = list.scrollHeight;
}

function buildChannelIntro({ kind, name, username }) {
  const intro = document.createElement('div');
  intro.className = 'channel-intro';
  const badge = document.createElement('div');
  badge.className = 'badge';
  badge.appendChild(svgIcon(kind === 'dm' ? 'klar-asteroid' : 'klar-hash', 36));
  intro.appendChild(badge);
  const h = document.createElement('h3');
  if (kind === 'dm') {
    h.innerHTML = `Direct line to <em></em>`;
    h.querySelector('em').textContent = '@' + username;
  } else {
    h.innerHTML = `Welcome to <em></em>`;
    h.querySelector('em').textContent = '#' + name;
  }
  intro.appendChild(h);
  const p = document.createElement('p');
  p.textContent = kind === 'dm'
    ? 'This channel is just between the two of you.'
    : 'Open frequency for this channel. Keep it civil, keep it weird.';
  intro.appendChild(p);
  return intro;
}

function buildDayDivider(day, ts) {
  const d = new Date(ts);
  const datePart = d.toLocaleDateString([], { month: 'short', day: 'numeric' }).toUpperCase();
  const div = document.createElement('div');
  div.className = 'day-divider';
  div.dataset.day = day;
  div.innerHTML = `<span></span>`;
  div.querySelector('span').textContent = `${day} · ${datePart}`;
  return div;
}

function buildDmMessageRow(dm, m, showHeader) {
  const row = baseMessageRow(m, showHeader);
  if (m.pending) row.classList.add('pending');
  if (m.failed) row.classList.add('failed');
  if (m.clientId) row.dataset.clientId = m.clientId;
  const author = userById(m.senderId);
  paintAvatar(row.querySelector('.avatar'), author);
  row.querySelector('.name').textContent = author.displayName;
  row.querySelector('.name').style.color = avatarHexColor(author.id);
  row.querySelector('.time').textContent = m.pending ? 'sending…' : fmtTime(m.createdAt);
  const textEl = row.querySelector('.text');
  if (m.encrypted) {
    // Legacy E2EE messages from before 0.1.8. We threw the keys away when
    // E2EE was removed, so the ciphertext is no longer recoverable.
    textEl.classList.add('failed');
    textEl.textContent = '[legacy encrypted message]';
  } else {
    textEl.textContent = m.content || '';
  }
  return row;
}

function baseMessageRow(m, showHeader) {
  const row = document.createElement('div');
  row.className = 'msg' + (showHeader ? '' : ' same');
  row.dataset.senderId = m.senderId;
  row.dataset.createdAt = String(m.createdAt);
  row.dataset.messageId = m.id;
  row.innerHTML = `
    <div class="avatar"></div>
    <div class="msg-body">
      <div class="meta"><span class="name"></span><span class="time"></span></div>
      <div class="text"></div>
    </div>
  `;
  return row;
}

function shouldShowHeader(prevRow, senderId, createdAt) {
  if (!prevRow || !prevRow.classList || !prevRow.classList.contains('msg')) return true;
  if (prevRow.dataset.senderId !== senderId) return true;
  const prevTs = Number(prevRow.dataset.createdAt) || 0;
  return (createdAt - prevTs) >= 5 * 60 * 1000;
}

// ===========================================================================
// Channel: open + render
// ===========================================================================

function openChannel(channelId) {
  state.activeChannelId = channelId;
  state.activeDmId = null;
  if (state.view.kind !== 'server') return;
  const detail = state.serverDetails.get(state.view.serverId);
  if (!detail) return;
  const ch = detail.channels.find((c) => c.id === channelId);
  if (!ch) return;
  renderChannelList(state.view.serverId);

  root.querySelector('[data-chat-empty]').classList.add('hidden');
  root.querySelector('[data-chat-active]').classList.remove('hidden');

  const header = root.querySelector('[data-chat-header]');
  clear(header);
  header.innerHTML = `
    <div class="chat-title">
      <span class="channel-hash"></span>
      <span class="channel-name"></span>
    </div>
    <div class="chat-topic">Open comms — keep it civil, keep it weird</div>
    <div class="actions">
      <button class="icon-btn" data-action="toggle-userlist" title="Show member list" aria-label="Toggle member list" aria-pressed="true">
        <svg width="18" height="18"><use href="#klar-users"/></svg>
      </button>
    </div>
  `;
  header.querySelector('.channel-hash').appendChild(svgIcon('klar-hash', 20));
  header.querySelector('.channel-name').textContent = ch.name;
  header.querySelector('[data-action="toggle-userlist"]').addEventListener('click', toggleUserlist);
  syncUserlistButton();

  setComposerStatus('Open frequency — channel messages are stored as plaintext.', false);

  if (!state.channelMessagesByChan.has(channelId)) state.channelMessagesByChan.set(channelId, []);

  // Render whatever's cached *immediately*. Fetch history in the background.
  renderChannelMessages(ch);
  root.querySelector('[data-composer-input]').placeholder = `Message #${ch.name}`;
  root.querySelector('[data-composer-input]').focus();

  if (!state.channelHistoryFetched.has(channelId)) {
    state.channelHistoryFetched.add(channelId);
    api.listChannelMessages(channelId).then(({ messages: rows }) => {
      const list = state.channelMessagesByChan.get(channelId) || [];
      const seen = new Set(list.map((m) => m.id));
      let added = 0;
      for (const r of rows) if (!seen.has(r.id)) { list.push(r); added++; }
      if (added > 0) {
        list.sort((a, b) => a.createdAt - b.createdAt);
        state.channelMessagesByChan.set(channelId, list);
        if (state.activeChannelId === channelId) renderChannelMessages(ch);
      }
    }).catch((err) => {
      state.channelHistoryFetched.delete(channelId);
      klog.error('channel.history', 'load failed', { channel: channelId, err: err && err.message });
    });
  }
}

async function renderChannelMessages(channel) {
  const list = root.querySelector('[data-messages]');
  clear(list);
  list.appendChild(buildChannelIntro({ kind: 'channel', name: channel.name }));
  const messages = state.channelMessagesByChan.get(channel.id) || [];
  let prevDay = null;
  for (const m of messages) {
    const day = dayLabel(m.createdAt);
    if (day !== prevDay) { list.appendChild(buildDayDivider(day, m.createdAt)); prevDay = day; }
    const showHeader = shouldShowHeader(list.lastElementChild, m.senderId, m.createdAt);
    const row = buildChannelMessageRow(m, showHeader);
    list.appendChild(row);
  }
  list.scrollTop = list.scrollHeight;
}

function buildChannelMessageRow(m, showHeader) {
  const row = baseMessageRow(m, showHeader);
  if (m.pending) row.classList.add('pending');
  if (m.failed) row.classList.add('failed');
  if (m.clientId) row.dataset.clientId = m.clientId;
  const author = userById(m.senderId);
  paintAvatar(row.querySelector('.avatar'), author);
  row.querySelector('.name').textContent = author.displayName;
  row.querySelector('.name').style.color = avatarHexColor(author.id);
  row.querySelector('.time').textContent = m.pending ? 'sending…' : fmtTime(m.createdAt);
  row.querySelector('.text').textContent = m.content || '';
  return row;
}

// ===========================================================================
// Composer
// ===========================================================================

function setupComposer() {
  const form = root.querySelector('[data-composer]');
  if (!form) return;
  const input = root.querySelector('[data-composer-input]');
  const sendBtn = form.querySelector('button[type="submit"]');

  const updateDisabled = () => { sendBtn.disabled = !input.value.trim(); };
  input.addEventListener('input', updateDisabled);
  updateDisabled();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value;
    if (!text.trim()) return;
    if (state.activeDmId) await sendDmMessage(text);
    else if (state.activeChannelId) await sendChannelMessage(text);
    else return;
    input.value = '';
    updateDisabled();
  });
}

// Optimistic send: render the message dimmed (.pending) immediately, then
// reconcile when the server confirms. The clientId rides along on POST and
// the server echoes it on the WS broadcast back so we can match the
// confirmation against the local row regardless of which arrives first.

async function sendDmMessage(text) {
  const dm = state.dms.find((d) => d.id === state.activeDmId);
  if (!dm) return;
  const clientId = newClientId();
  const optimistic = {
    id: 'tmp_' + clientId,
    clientId,
    dmId: dm.id,
    senderId: state.user.id,
    content: text,
    encrypted: false,
    nonce: null,
    createdAt: Date.now(),
    pending: true,
  };
  // Render immediately
  let list = state.messagesByDm.get(dm.id);
  if (!list) { list = []; state.messagesByDm.set(dm.id, list); }
  list.push(optimistic);
  appendDmMessage(dm, optimistic);
  klog.info('msg.dm.send', 'sending', { dm: dm.id, clientId, bytes: text.length });

  try {
    await api.sendMessage(dm.id, text, clientId);
    // Confirmation will arrive via WS (which also includes clientId) and
    // un-dim the row in onRemoteDmMessage. We don't need to do anything
    // with the POST response here.
  } catch (err) {
    klog.error('msg.dm.send', 'failed', { dm: dm.id, clientId, err: err.message });
    markMessageFailed(clientId, err.message);
  }
}

async function sendChannelMessage(text) {
  const channelId = state.activeChannelId;
  if (!channelId) return;
  const clientId = newClientId();
  const optimistic = {
    id: 'tmp_' + clientId,
    clientId,
    channelId,
    senderId: state.user.id,
    content: text,
    createdAt: Date.now(),
    pending: true,
  };
  let list = state.channelMessagesByChan.get(channelId);
  if (!list) { list = []; state.channelMessagesByChan.set(channelId, list); }
  list.push(optimistic);
  appendChannelMessage(optimistic);
  klog.info('msg.channel.send', 'sending', { channel: channelId, clientId, bytes: text.length });

  try {
    await api.sendChannelMessage(channelId, text, clientId);
  } catch (err) {
    klog.error('msg.channel.send', 'failed', { channel: channelId, clientId, err: err.message });
    markMessageFailed(clientId, err.message);
  }
}

function markMessageFailed(clientId, errMsg) {
  // Walk the on-screen messages and tag the matching row as failed.
  const list = root.querySelector('[data-messages]');
  if (!list) return;
  const row = list.querySelector(`[data-client-id="${clientId}"]`);
  if (row) {
    row.classList.remove('pending');
    row.classList.add('failed');
    const timeEl = row.querySelector('.time');
    if (timeEl) timeEl.textContent = 'send failed';
    if (errMsg) row.title = errMsg;
  }
}

// ===========================================================================
// Realtime
// ===========================================================================

function onRemoteDmMessage(message) {
  let list = state.messagesByDm.get(message.dmId);
  if (!list) { list = []; state.messagesByDm.set(message.dmId, list); }

  // Already-confirmed dedupe by server id.
  if (list.find((m) => m.id === message.id && !m.pending)) return;

  // If this confirms a pending optimistic message we sent, replace in place.
  let pending = null;
  if (message.clientId) pending = list.find((m) => m.pending && m.clientId === message.clientId);
  if (pending) {
    pending.id = message.id;
    pending.createdAt = message.createdAt;
    pending.pending = false;
    confirmPendingDom(pending.clientId, message);
    klog.info('msg.dm.confirmed', 'sent ok', { dm: message.dmId, clientId: pending.clientId, id: message.id });
  } else {
    // Genuine new message (from peer, or from another client of ours).
    list.push(message);
    if (state.activeDmId === message.dmId) {
      const dm = state.dms.find((d) => d.id === message.dmId);
      if (dm) appendDmMessage(dm, message);
    }
    klog.info('msg.dm.recv', 'received', { dm: message.dmId, from: message.senderId });
  }

  const idx = state.dms.findIndex((d) => d.id === message.dmId);
  if (idx >= 0) {
    state.dms[idx].lastAt = message.createdAt;
    const [d] = state.dms.splice(idx, 1);
    state.dms.unshift(d);
    if (state.view.kind === 'home') renderDmList();
  }
}

function confirmPendingDom(clientId, message) {
  const list = root.querySelector('[data-messages]');
  if (!list) return;
  const row = list.querySelector(`[data-client-id="${clientId}"]`);
  if (!row) return;
  row.classList.remove('pending');
  row.dataset.messageId = message.id;
  const timeEl = row.querySelector('.time');
  if (timeEl) timeEl.textContent = fmtTime(message.createdAt);
}

function appendDmMessage(dm, m) {
  const list = root.querySelector('[data-messages]');
  if (!list) return;
  if (m.id && list.querySelector(`[data-message-id="${m.id}"]`)) return;
  // Insert/append handling — for the typical case, find the last message row
  // and append after it; track day-divider boundaries when appending at end.
  const lastMsgRow = [...list.querySelectorAll('.msg')].pop() || null;
  const prevDay = lastMsgRow ? dayLabel(Number(lastMsgRow.dataset.createdAt)) : null;
  const newDay = dayLabel(m.createdAt);
  if (prevDay !== newDay) list.appendChild(buildDayDivider(newDay, m.createdAt));

  const showHeader = shouldShowHeader(list.lastElementChild, m.senderId, m.createdAt);
  const row = buildDmMessageRow(dm, m, showHeader);
  list.appendChild(row);
  list.scrollTop = list.scrollHeight;
}

function onRemoteDmCreated(dm) {
  if (state.dms.find((d) => d.id === dm.id)) return;
  state.dms.unshift(dm);
  if (dm.other) rememberUser(dm.other);
  if (state.view.kind === 'home') renderDmList();
}

function onRemoteDmUpdated() {
  // E2EE toggle was the only thing that ever fired this. Kept the WS event
  // type registration for backwards compat with older servers; nothing to do.
}

function onRemoteChannelMessage(message) {
  let list = state.channelMessagesByChan.get(message.channelId);
  if (!list) { list = []; state.channelMessagesByChan.set(message.channelId, list); }

  if (list.find((m) => m.id === message.id && !m.pending)) return;

  let pending = null;
  if (message.clientId) pending = list.find((m) => m.pending && m.clientId === message.clientId);
  if (pending) {
    pending.id = message.id;
    pending.createdAt = message.createdAt;
    pending.pending = false;
    confirmPendingDom(pending.clientId, message);
    klog.info('msg.channel.confirmed', 'sent ok', { channel: message.channelId, clientId: pending.clientId, id: message.id });
    return;
  }

  list.push(message);
  if (state.activeChannelId === message.channelId) appendChannelMessage(message);
  klog.info('msg.channel.recv', 'received', { channel: message.channelId, from: message.senderId });
}

function appendChannelMessage(m) {
  const list = root.querySelector('[data-messages]');
  if (!list) return;
  if (m.id && list.querySelector(`[data-message-id="${m.id}"]`)) return;
  const lastMsgRow = [...list.querySelectorAll('.msg')].pop() || null;
  const prevDay = lastMsgRow ? dayLabel(Number(lastMsgRow.dataset.createdAt)) : null;
  const newDay = dayLabel(m.createdAt);
  if (prevDay !== newDay) list.appendChild(buildDayDivider(newDay, m.createdAt));

  const showHeader = shouldShowHeader(list.lastElementChild, m.senderId, m.createdAt);
  const row = buildChannelMessageRow(m, showHeader);
  list.appendChild(row);
  list.scrollTop = list.scrollHeight;
}

function onRemoteChannelCreated(channel) {
  const detail = state.serverDetails.get(channel.serverId);
  if (!detail) return;
  if (detail.channels.find((c) => c.id === channel.id)) return;
  detail.channels.push(channel);
  if (state.view.kind === 'server' && state.view.serverId === channel.serverId) {
    renderChannelList(channel.serverId);
  }
}

function onRemoteMemberJoined(payload) {
  const detail = state.serverDetails.get(payload.serverId);
  if (!detail) return;
  if (payload.user) {
    rememberUser(payload.user);
    if (!detail.members.find((m) => m.id === payload.user.id)) detail.members.push(payload.user);
  }
  if (state.view.kind === 'server' && state.view.serverId === payload.serverId) {
    renderMembersPanel(payload.serverId);
  }
}

function onRemoteMemberLeft(payload) {
  const detail = state.serverDetails.get(payload.serverId);
  if (!detail) return;
  detail.members = detail.members.filter((m) => m.id !== payload.userId);
  if (state.view.kind === 'server' && state.view.serverId === payload.serverId) {
    renderMembersPanel(payload.serverId);
  }
}

function onRemoteServerDeleted(payload) {
  state.servers = state.servers.filter((s) => s.id !== payload.serverId);
  state.serverDetails.delete(payload.serverId);
  renderServerRail();
  if (state.view.kind === 'server' && state.view.serverId === payload.serverId) {
    switchView({ kind: 'home' });
  }
}

// ===========================================================================
// Modals
// ===========================================================================

function openModal(tplId, init) {
  const tpl = document.getElementById(tplId);
  const node = tpl.content.cloneNode(true);
  document.body.appendChild(node);
  const backdrop = document.body.querySelector('[data-modal]:last-of-type');
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelectorAll('[data-action="cancel"]').forEach((b) => b.addEventListener('click', close));
  if (init) init(backdrop, close);
  return { backdrop, close };
}
function showModalError(modal, msg) {
  const err = modal.querySelector('[data-error]');
  if (!err) return;
  if (!msg) { err.hidden = true; err.textContent = ''; return; }
  err.hidden = false; err.textContent = msg;
}

function openCreateServerModal() {
  openModal('tpl-modal-create-server', (modal, close) => {
    const form = modal.querySelector('[data-form="create-server"]');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      showModalError(modal, null);
      const name = new FormData(form).get('name').toString().trim();
      try {
        const { server } = await api.createServer(name);
        state.servers.push(server);
        renderServerRail();
        close();
        await switchView({ kind: 'server', serverId: server.id });
      } catch (err) {
        showModalError(modal, err.message || 'failed to create server');
      }
    });
  });
}

function openJoinServerModal() {
  openModal('tpl-modal-join-server', (modal, close) => {
    const form = modal.querySelector('[data-form="join-server"]');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      showModalError(modal, null);
      const code = new FormData(form).get('code').toString().trim();
      try {
        const { server } = await api.acceptInvite(code);
        if (!state.servers.find((s) => s.id === server.id)) state.servers.push(server);
        renderServerRail();
        close();
        await switchView({ kind: 'server', serverId: server.id });
      } catch (err) {
        showModalError(modal, err.message || 'failed to join');
      }
    });
  });
}

function openCreateChannelModal(serverId) {
  openModal('tpl-modal-create-channel', (modal, close) => {
    const form = modal.querySelector('[data-form="create-channel"]');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      showModalError(modal, null);
      const name = new FormData(form).get('name').toString().trim().toLowerCase();
      try {
        const { channel } = await api.createChannel(serverId, name);
        const detail = state.serverDetails.get(serverId);
        if (detail) {
          if (!detail.channels.find((c) => c.id === channel.id)) detail.channels.push(channel);
          renderChannelList(serverId);
        }
        close();
        openChannel(channel.id);
      } catch (err) {
        showModalError(modal, err.message || 'failed to create channel');
      }
    });
  });
}

function openInviteModal(serverId) {
  openModal('tpl-modal-invite', async (modal, close) => {
    const codeEl = modal.querySelector('[data-invite-code]');
    const statusEl = modal.querySelector('[data-invite-status]');
    codeEl.textContent = '...';
    try {
      const { code } = await api.createInvite(serverId);
      codeEl.textContent = code;
    } catch (err) {
      codeEl.textContent = '!';
      statusEl.textContent = err.message || 'failed to create invite';
      return;
    }
    modal.querySelector('[data-action="copy-invite"]').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(codeEl.textContent);
        statusEl.textContent = 'Copied to clipboard.';
      } catch {
        statusEl.textContent = 'Could not copy. Select and copy manually.';
      }
    });
  });
}

function openServerMenu(serverId) {
  const detail = state.serverDetails.get(serverId);
  if (!detail) return;
  const isOwner = detail.server.ownerId === state.user.id;
  openModal('tpl-modal-server-menu', (modal, close) => {
    modal.querySelector('[data-server-name]').textContent = detail.server.name;
    modal.querySelector('[data-action="create-channel"]').hidden = !isOwner;
    modal.querySelector('[data-action="leave"]').hidden = isOwner;
    modal.querySelector('[data-action="delete"]').hidden = !isOwner;
    modal.querySelector('[data-action="create-channel"]').addEventListener('click', () => { close(); openCreateChannelModal(serverId); });
    modal.querySelector('[data-action="invite"]').addEventListener('click', () => { close(); openInviteModal(serverId); });
    modal.querySelector('[data-action="leave"]').addEventListener('click', async () => {
      if (!confirm(`Leave ${detail.server.name}?`)) return;
      try {
        await api.leaveServer(serverId);
        state.servers = state.servers.filter((s) => s.id !== serverId);
        state.serverDetails.delete(serverId);
        renderServerRail();
        close();
        switchView({ kind: 'home' });
      } catch (err) { alert(err.message || 'failed to leave'); }
    });
    modal.querySelector('[data-action="delete"]').addEventListener('click', async () => {
      if (!confirm(`Decommission ${detail.server.name}? This cannot be undone.`)) return;
      try {
        await api.deleteServer(serverId);
        state.servers = state.servers.filter((s) => s.id !== serverId);
        state.serverDetails.delete(serverId);
        renderServerRail();
        close();
        switchView({ kind: 'home' });
      } catch (err) { alert(err.message || 'failed to decommission'); }
    });
  });
}

// ===========================================================================
// Logout / boot
// ===========================================================================

async function logout() {
  try { await api.logout(); } catch {}
  await clearSavedSession();
  if (state.realtime) state.realtime.close();
  session.token = null;
  state.user = null;
  state.dms = []; state.activeDmId = null; state.activeChannelId = null;
  state.servers = []; state.serverDetails.clear();
  state.messagesByDm.clear(); state.dmHistoryFetched.clear();
  state.channelMessagesByChan.clear(); state.channelHistoryFetched.clear();
  state.usersById.clear();
  renderAuth();
}

// ===========================================================================
// Auto-update toast (Electron only — fires when main has staged a new build)
// ===========================================================================

function setupUpdateToast() {
  if (!(window.klar && window.klar.updates && typeof window.klar.updates.onAvailable === 'function')) return;
  window.klar.updates.onAvailable((info) => {
    const existing = document.querySelector('[data-update-toast]');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'update-toast';
    toast.dataset.updateToast = '';
    toast.innerHTML = `
      <div class="ut-title">A new version of Klar is ready</div>
      <div class="ut-meta"></div>
      <div class="ut-actions">
        <button class="ut-later" type="button">Later</button>
        <button class="ut-apply" type="button">Reload now</button>
      </div>
    `;
    toast.querySelector('.ut-meta').textContent = `${info.from || '?'}  →  ${info.to || '?'}`;
    toast.querySelector('.ut-later').addEventListener('click', () => toast.remove());
    toast.querySelector('.ut-apply').addEventListener('click', async () => {
      toast.querySelector('.ut-apply').textContent = 'Applying…';
      toast.querySelector('.ut-apply').disabled = true;
      try { await window.klar.updates.apply(); }
      catch (err) { console.error('apply failed', err); toast.remove(); }
    });
    document.body.appendChild(toast);
  });
}

// ===========================================================================
// Desktop title bar (Electron only — hidden in regular browsers)
// ===========================================================================

function setupTitlebar() {
  const bar = document.querySelector('[data-titlebar]');
  if (!bar) return;
  // No bridge from Electron preload → we're in a regular browser. Stay hidden.
  if (!(window.klar && window.klar.shell && window.klar.shell.isAvailable)) return;

  bar.classList.remove('hidden');
  document.body.classList.add('has-titlebar');

  const text = bar.querySelector('[data-titlebar-text]');
  if (text) text.textContent = 'Klar — Deep Space Comms';

  bar.querySelector('[data-tl="close"]').addEventListener('click', () => window.klar.shell.close());
  bar.querySelector('[data-tl="minimize"]').addEventListener('click', () => window.klar.shell.minimize());
  bar.querySelector('[data-tl="fullscreen"]').addEventListener('click', () => window.klar.shell.toggleMaximize());
}

function boot() {
  setupTitlebar();
  setupUpdateToast();

  // Render auth IMMEDIATELY so the user sees something on screen the moment
  // the renderer paints. Network checks (URL discovery + reachability probe
  // + saved-session restore) happen in the background and may swap the
  // screen later. This trades a brief flash on slow networks for instant
  // perceived startup on the common path.
  renderAuth();

  // Background work — none of this blocks the first paint.
  (async () => {
    try { await api.discoverServerUrl(); } catch {}

    const probe = await api.probe();
    if (!probe.reachable) {
      // Don't yank the user out of mid-typing into the broken-cable screen.
      const id = document.querySelector('input[name="klar_id"]');
      const secret = document.querySelector('input[name="klar_secret"]');
      const focused = document.activeElement;
      const engaged =
        (id && id.value) ||
        (secret && secret.value) ||
        (focused === id) ||
        (focused === secret);
      if (!engaged) renderServerUnreachable(probe);
      return;
    }

    // Server is up — try the saved "Stay logged in" session if any.
    const saved = await loadSavedSession();
    if (!saved || !saved.token) return;
    session.token = saved.token;
    try {
      const { user } = await api.me();
      state.user = user;
      rememberUser(user);
      await saveSavedSession({ token: saved.token, user });
      klog.info('auth.restore', 'session restored', { user: user.username });
      await enterApp();
    } catch {
      session.token = null;
      await clearSavedSession();
    }
  })().catch((e) => console.error('boot background work failed:', e));
}
boot();
