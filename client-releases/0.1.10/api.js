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

// Runtime serverUrl override. Filled by api.discoverServerUrl() when the
// client discovers a fresher URL on GitHub than the one bundled into the
// EXE. Higher precedence than window.KLAR_CONFIG.serverUrl, so installed
// clients pick up new tunnel URLs even when the host's subdomain changed
// after the EXE was built.
let _runtimeServerUrl = null;

// When the page is loaded inside the desktop shell from a local file://
// (packaged build), relative paths like "/api/me" don't resolve. The shell
// injects window.KLAR_CONFIG.serverUrl pointing at the user's remote backend,
// and we prefix every request with it. In dev / regular browser tabs the
// config is empty and relative paths work as before.
function serverBase() {
  if (_runtimeServerUrl) return _runtimeServerUrl;
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
  const headers = {
    'Content-Type': 'application/json',
    // localtunnel (used by the dev-shell `tunnel` command for cross-network
    // testing) injects a "click to continue" HTML reminder page on first
    // hit per IP. JSON.parse on that HTML breaks every API call. Any truthy
    // value of this header skips the reminder. Other tunnels and direct
    // connections ignore the header.
    'bypass-tunnel-reminder': 'klar-app',
    ...(opts.headers || {}),
  };
  if (session.token) headers['Authorization'] = `Bearer ${session.token}`;

  let res;
  try {
    res = await fetch(apiUrl(path), { ...opts, headers });
  } catch (e) {
    // Network-level failure (DNS, refused, CORS, abort, etc).
    const err = new Error(`network error: ${e && e.message || e}`);
    err.network = true;
    throw err;
  }

  const text = await res.text();
  let data;
  if (!text) {
    data = {};
  } else {
    try {
      data = JSON.parse(text);
    } catch (parseErr) {
      // Surface what the server actually sent — usually the only way to
      // diagnose tunnel-injected HTML reminder pages or proxy weirdness.
      const ct = res.headers.get('content-type') || '?';
      const preview = text.slice(0, 200).replace(/\s+/g, ' ').trim();
      console.error('[klar.api] non-JSON response:', { status: res.status, contentType: ct, bodyPreview: preview });
      const err = new Error(`server returned non-JSON (${res.status}, ${ct}, ${text.length}B): ${preview}`);
      err.status = res.status;
      err.bodyPreview = preview;
      err.parseError = true;
      throw err;
    }
  }
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
  listMessages: (dmId, before) => request(`/api/dms/${dmId}/messages${before ? `?before=${before}` : ''}`),
  sendMessage: (dmId, content, clientId) =>
    request(`/api/dms/${dmId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content, clientId }),
    }),

  // Servers
  listServers: () => request('/api/servers'),
  createServer: (name) => request('/api/servers', { method: 'POST', body: JSON.stringify({ name }) }),
  getServer: (id) => request(`/api/servers/${id}`),
  deleteServer: (id) => request(`/api/servers/${id}`, { method: 'DELETE' }),
  leaveServer: (id) => request(`/api/servers/${id}/leave`, { method: 'POST' }),

  // Channels
  createChannel: (serverId, name) => request(`/api/servers/${serverId}/channels`, { method: 'POST', body: JSON.stringify({ name }) }),
  listChannelMessages: (channelId, before) => request(`/api/channels/${channelId}/messages${before ? `?before=${before}` : ''}`),
  sendChannelMessage: (channelId, content, clientId) =>
    request(`/api/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content, clientId }),
    }),

  // Invites
  createInvite: (serverId) => request(`/api/servers/${serverId}/invites`, { method: 'POST' }),
  previewInvite: (code) => request(`/api/invites/${code}`),
  acceptInvite: (code) => request(`/api/invites/${code}/accept`, { method: 'POST' }),

  // Connectivity probe — used at boot to decide between rendering the auth
  // screen and rendering "couldn't connect to the server". Any HTTP response
  // (even 401) means the server is up; only fetch failures / timeouts mean
  // we can't reach it. AbortSignal.timeout caps the wait so we don't sit on
  // an unstyled blank screen if the host is down.
  // Resolve the *current* server URL.
  //
  // Resolution order:
  //   1. localhost:3000 (or whatever localhost port the bundled config
  //      points at) — if a Klar server answers there, prefer it. Saves the
  //      whole public-internet round-trip when the host runs the EXE on
  //      the same machine as the server. Friends fail-fast with
  //      connection-refused and skip past this candidate.
  //   2. jsDelivr-served server.json — fast global CDN, propagates within
  //      ~10s of a push, much fresher than raw.githubusercontent.com.
  //   3. raw.githubusercontent.com server.json — fallback in case jsDelivr
  //      is rate-limited or the file isn't on the CDN yet. Up to ~5min
  //      stale due to GitHub's CDN cache.
  //
  // Best-effort throughout; returns the resolved URL or null. Whatever
  // succeeds wins and gets cached in `_runtimeServerUrl` for subsequent
  // API calls and the WebSocket connection.
  discoverServerUrl: async () => {
    const cfg = (typeof window !== 'undefined' && window.KLAR_CONFIG) || {};

    // -- Candidate 1: localhost --
    const localCandidates = ['http://localhost:3000', 'http://127.0.0.1:3000'];
    if (cfg.serverUrl && /^https?:\/\/(localhost|127\.0\.0\.1):\d+/.test(cfg.serverUrl)) {
      const c = cfg.serverUrl.replace(/\/+$/, '');
      if (!localCandidates.includes(c)) localCandidates.unshift(c);
    }
    for (const c of localCandidates) {
      try {
        const res = await fetch(c + '/api/me', {
          signal: AbortSignal.timeout(600),
          cache: 'no-store',
          headers: { 'bypass-tunnel-reminder': 'klar-app' },
        });
        // /api/me with no auth returns 401 + {"error":"not authenticated"}.
        // Anything else means it's not a Klar server — keep walking.
        if (res.status === 401) {
          const body = await res.text();
          if (body && body.includes('"error"')) {
            _runtimeServerUrl = c;
            return c;
          }
        }
      } catch {}
    }

    // -- Candidates 2 & 3: GitHub-published server.json --
    if (!cfg.updateRepo) return null;
    const branch = cfg.updateBranch || 'main';
    const urls = [
      `https://cdn.jsdelivr.net/gh/${cfg.updateRepo}@${branch}/client-releases/server.json`,
      `https://raw.githubusercontent.com/${cfg.updateRepo}/${branch}/client-releases/server.json?t=${Date.now()}`,
    ];
    for (const url of urls) {
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(4000),
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache' },
        });
        if (!res.ok) continue;
        const text = await res.text();
        // Tolerate a UTF-8 BOM if any older publisher left one.
        const j = JSON.parse(text.replace(/^﻿/, ''));
        if (j && typeof j.serverUrl === 'string' && j.serverUrl) {
          _runtimeServerUrl = j.serverUrl.replace(/\/+$/, '');
          return _runtimeServerUrl;
        }
      } catch {}
    }
    return null;
  },

  probe: async () => {
    try {
      const res = await fetch(apiUrl('/api/me'), {
        method: 'GET',
        headers: { 'bypass-tunnel-reminder': 'klar-app' },
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
