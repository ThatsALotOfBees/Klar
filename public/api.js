// REST + WebSocket client.

// Session token lives in JS memory ONLY. It is intentionally NOT persisted to
// localStorage, sessionStorage, or cookies. Reasoning: localStorage is shared
// across all tabs of the same origin, so two tabs would clobber each other's
// tokens — the second tab's login would silently steal the first tab's auth,
// and every subsequent request from either tab would go out as the most-recent
// login. (Symptom: messages from both tabs show up under the same sender, with
// the second sender's row collapsing into a same-author continuation.) Keeping
// the token in module scope means each tab has its own independent session.
//
// We also can't usefully persist the token across reloads anyway: the
// unlocked private key is in-memory only, so a reload requires re-typing the
// password regardless. Dropping the token on reload matches that behavior.
let _token = null;

// Clean up any token left behind by older builds that used localStorage.
try { localStorage.removeItem('klar.token'); } catch {}

export const session = {
  get token() { return _token; },
  set token(v) { _token = v || null; },
};

// When the page is loaded inside the desktop shell from a local file://
// (packaged build), relative paths like "/api/me" don't resolve. The shell
// injects window.KLAR_CONFIG.serverUrl pointing at the user's remote backend,
// and we prefix every request with it. In dev / regular browser tabs the
// config is empty and relative paths work as before.
function serverBase() {
  const cfg = (typeof window !== 'undefined' && window.KLAR_CONFIG) || {};
  const url = (cfg.serverUrl || '').replace(/\/+$/, '');
  return url;
}
function apiUrl(path) {
  return serverBase() + path;
}
function wsUrl(path) {
  const base = serverBase();
  if (base) {
    return base.replace(/^http/, 'ws') + path;
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}`;
}

async function request(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (session.token) headers['Authorization'] = `Bearer ${session.token}`;
  const res = await fetch(apiUrl(path), { ...opts, headers });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error(data.error || `request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  register: (body) => request('/api/register', { method: 'POST', body: JSON.stringify(body) }),
  login: (body) => request('/api/login', { method: 'POST', body: JSON.stringify(body) }),
  logout: () => request('/api/logout', { method: 'POST' }),
  me: () => request('/api/me'),
  searchUsers: (q) => request(`/api/users/search?q=${encodeURIComponent(q)}`),

  // DMs
  listDms: () => request('/api/dms'),
  createDm: (userId) => request('/api/dms', { method: 'POST', body: JSON.stringify({ userId }) }),
  setE2ee: (dmId, e2eeEnabled) => request(`/api/dms/${dmId}`, { method: 'PATCH', body: JSON.stringify({ e2eeEnabled }) }),
  listMessages: (dmId, before) => request(`/api/dms/${dmId}/messages${before ? `?before=${before}` : ''}`),
  sendMessage: (dmId, body) => request(`/api/dms/${dmId}/messages`, { method: 'POST', body: JSON.stringify(body) }),

  // Servers
  listServers: () => request('/api/servers'),
  createServer: (name) => request('/api/servers', { method: 'POST', body: JSON.stringify({ name }) }),
  getServer: (id) => request(`/api/servers/${id}`),
  deleteServer: (id) => request(`/api/servers/${id}`, { method: 'DELETE' }),
  leaveServer: (id) => request(`/api/servers/${id}/leave`, { method: 'POST' }),

  // Channels
  createChannel: (serverId, name) => request(`/api/servers/${serverId}/channels`, { method: 'POST', body: JSON.stringify({ name }) }),
  listChannelMessages: (channelId, before) => request(`/api/channels/${channelId}/messages${before ? `?before=${before}` : ''}`),
  sendChannelMessage: (channelId, content) => request(`/api/channels/${channelId}/messages`, { method: 'POST', body: JSON.stringify({ content }) }),

  // Invites
  createInvite: (serverId) => request(`/api/servers/${serverId}/invites`, { method: 'POST' }),
  previewInvite: (code) => request(`/api/invites/${code}`),
  acceptInvite: (code) => request(`/api/invites/${code}/accept`, { method: 'POST' }),

  // Connectivity probe — used at boot to decide between rendering the auth
  // screen and rendering "couldn't connect to the server". Any HTTP response
  // (even 401) means the server is up; only fetch failures / timeouts mean
  // we can't reach it. AbortSignal.timeout caps the wait so we don't sit on
  // an unstyled blank screen if the host is down.
  probe: async () => {
    try {
      const res = await fetch(apiUrl('/api/me'), {
        method: 'GET',
        signal: AbortSignal.timeout(3500),
        cache: 'no-store',
      });
      return { reachable: true, status: res.status };
    } catch (e) {
      return { reachable: false, error: String(e && e.message || e) };
    }
  },
};

export class Realtime extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this._reconnectTimer = null;
    this._closing = false;
  }
  connect() {
    if (this.ws || !session.token) return;
    this._closing = false;
    const ws = new WebSocket(wsUrl('/ws'));
    this.ws = ws;
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token: session.token }));
    });
    ws.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this.dispatchEvent(new CustomEvent(msg.type, { detail: msg }));
    });
    ws.addEventListener('close', () => {
      this.ws = null;
      if (this._closing || !session.token) return;
      this._reconnectTimer = setTimeout(() => this.connect(), 2000);
    });
    ws.addEventListener('error', () => { try { ws.close(); } catch {} });
  }
  close() {
    this._closing = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    if (this.ws) { try { this.ws.close(); } catch {} ; this.ws = null; }
  }
}
