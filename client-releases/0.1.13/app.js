import { api, session, Realtime, setManualServerUrl } from './api.js';

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
  settings: null,           // populated by loadSettings() at boot
  call: null,               // populated by CallManager when active
  globalMicMuted: false,    // me-bar mic icon toggles this
  globalDeafened: false,    // me-bar headphones icon toggles this
};

// ===========================================================================
// Settings: persisted to localStorage, applied on boot, edited in /settings
// ===========================================================================

const SETTINGS_KEY = 'klar.settings.v1';
const ACCENT_PALETTE = [
  '#9D6DFF', '#FF6DA8', '#FF9D6D', '#FFD46D',
  '#6DFFB1', '#6DDBFF', '#6D8BFF', '#C76DFF',
];
const DEFAULT_SETTINGS = {
  voice: {
    inputDeviceId: '',
    outputDeviceId: '',
    inputVol: 100,
    outputVol: 100,
    noiseSuppression: true,
    echoCancellation: true,
    autoGain: true,
  },
  video: {
    inputDeviceId: '',
    resolution: 720,
  },
  personalization: {
    accentColor: '#9D6DFF',
    fontSize: 15,
    compactMode: false,
    reduceMotion: false,
  },
  advanced: {
    serverOverride: '',
    debugMode: false,
    minimizeToTray: true,
  },
  notifications: {
    enabled: true,
    sound: true,
    soundVolume: 80,
    showWhenFocused: false, // suppress toast if window is already focused
  },
};

function deepMergeDefaults(target, defaults) {
  const out = { ...defaults };
  if (target && typeof target === 'object') {
    for (const k of Object.keys(defaults)) {
      if (defaults[k] && typeof defaults[k] === 'object' && !Array.isArray(defaults[k])) {
        out[k] = deepMergeDefaults(target[k], defaults[k]);
      } else if (target[k] !== undefined) {
        out[k] = target[k];
      }
    }
  }
  return out;
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return deepMergeDefaults(raw ? JSON.parse(raw) : null, DEFAULT_SETTINGS);
  } catch {
    return deepMergeDefaults(null, DEFAULT_SETTINGS);
  }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch (e) { klog.warn('settings.save', 'failed', { err: e.message }); }
}

// Apply personalization preferences to the live document. Voice/video device
// preferences only get used at call setup time, so they don't need an
// immediate apply here.
function applyPersonalization() {
  const p = state.settings.personalization;
  document.documentElement.style.setProperty('--pulsar', p.accentColor);
  document.documentElement.style.setProperty('--app-font-size', p.fontSize + 'px');
  document.body.classList.toggle('compact', p.compactMode);
  document.body.classList.toggle('force-reduce-motion', p.reduceMotion);
}

// ===========================================================================
// Voice call manager (1:1 DM only for now). WebRTC over the existing WS for
// signaling — no separate signaling channel. The server forwards call.*
// messages between the two parties without inspecting the SDP/ICE payloads.
// ===========================================================================

const ICE_CONFIG = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ],
};

class CallManager {
  constructor() {
    this.pc = null;
    this.localStream = null;
    this.remoteAudio = null;
    this.callId = null;
    this.peer = null;          // { id, username, displayName }
    this.dmId = null;
    this.isCaller = false;
    this.state = 'idle';       // idle | inviting | ringing | connecting | connected | ended
    this.startedAt = 0;
    this._pendingCandidates = [];
  }

  async startCall(peer, dmId) {
    if (this.state !== 'idle') { klog.warn('call.start', 'already in call', { state: this.state }); return; }
    this.peer = peer;
    this.dmId = dmId;
    this.callId = newClientId();
    this.isCaller = true;
    this.state = 'inviting';
    klog.info('call.start', 'starting call', { peer: peer.username, call: this.callId });

    if (!this._sendSignal('invite')) {
      this._teardown('cannot reach server');
      return;
    }
    showActiveCallBar(peer, 'Calling…');
    try {
      await this._buildPeer();
      const offer = await this.pc.createOffer({ offerToReceiveAudio: true });
      await this.pc.setLocalDescription(offer);
      this._sendSignal('signal', { kind: 'offer', sdp: offer });
    } catch (e) {
      klog.error('call.start', 'offer failed', { err: e.message });
      this._teardown('couldn\'t set up audio (' + e.message + ')');
    }
  }

  async accept() {
    if (this.state !== 'ringing') return;
    this.state = 'connecting';
    klog.info('call.accept', 'accepting', { call: this.callId, from: this.peer && this.peer.username });
    closeIncomingCallModal();
    showActiveCallBar(this.peer, 'Connecting…');
    this._sendSignal('accept');
    try { await this._buildPeer(); } catch (e) {
      klog.error('call.accept', 'peer setup failed', { err: e.message });
      this._teardown('couldn\'t set up audio (' + e.message + ')');
    }
  }

  decline() {
    if (this.state !== 'ringing') return;
    klog.info('call.decline', 'declining', { call: this.callId });
    this._sendSignal('decline');
    closeIncomingCallModal();
    this._teardown(null);
  }

  hangup() {
    if (this.state === 'idle') return;
    klog.info('call.hangup', 'local hangup', { call: this.callId });
    this._sendSignal('hangup');
    closeIncomingCallModal();
    this._teardown(null);
  }

  async onIncomingInvite(msg) {
    if (this.state !== 'idle') {
      // Auto-decline so the caller doesn't sit in "calling…" forever.
      this._sendSignalRaw('decline', msg.fromUserId, msg.callId, null);
      return;
    }
    const peer = userById(msg.fromUserId) || { id: msg.fromUserId, username: msg.fromUsername || '?', displayName: msg.fromUsername || 'Unknown' };
    this.peer = peer;
    this.dmId = msg.dmId;
    this.callId = msg.callId;
    this.isCaller = false;
    this.state = 'ringing';
    klog.info('call.incoming', 'invited', { call: this.callId, from: peer.username });
    showIncomingCallModal(peer, this);
  }

  async onAccept(msg) {
    if (this.state !== 'inviting' || msg.callId !== this.callId) return;
    klog.info('call.accept', 'remote accepted', { call: this.callId });
    this.state = 'connecting';
    setActiveCallState('Connecting…');
    // Offer was already created + sent in startCall — the answer will arrive
    // via onSignal once the callee finishes their PC setup.
  }

  async onDecline(msg) {
    if (msg.callId !== this.callId) return;
    klog.info('call.decline', 'remote declined', { call: this.callId });
    this._teardown('Call declined');
  }

  async onSignal(msg) {
    if (msg.callId !== this.callId) return;
    const payload = msg.payload || {};
    if (!this.pc) {
      // Callee receives the offer before we've built our PC (because we wait
      // for accept on their side). Build it lazily.
      try { await this._buildPeer(); } catch (e) { klog.error('call.signal', 'peer setup failed', { err: e.message }); return; }
    }
    try {
      if (payload.kind === 'offer') {
        await this.pc.setRemoteDescription(payload.sdp);
        for (const c of this._pendingCandidates) { try { await this.pc.addIceCandidate(c); } catch {} }
        this._pendingCandidates = [];
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this._sendSignal('signal', { kind: 'answer', sdp: answer });
      } else if (payload.kind === 'answer') {
        await this.pc.setRemoteDescription(payload.sdp);
        for (const c of this._pendingCandidates) { try { await this.pc.addIceCandidate(c); } catch {} }
        this._pendingCandidates = [];
      } else if (payload.kind === 'candidate' && payload.candidate) {
        if (this.pc.remoteDescription && this.pc.remoteDescription.type) {
          try { await this.pc.addIceCandidate(payload.candidate); } catch {}
        } else {
          this._pendingCandidates.push(payload.candidate);
        }
      }
    } catch (e) {
      klog.error('call.signal', 'apply failed', { kind: payload.kind, err: e.message });
    }
  }

  onHangup(msg) {
    if (msg.callId !== this.callId) return;
    klog.info('call.hangup', 'remote hung up', { call: this.callId });
    this._teardown('Call ended');
  }

  toggleMute() {
    if (!this.localStream) return;
    const tracks = this.localStream.getAudioTracks();
    if (!tracks.length) return;
    const muted = tracks[0].enabled;  // currently enabled => about to mute
    for (const t of tracks) t.enabled = !muted;
    syncActiveCallControls();
    return !muted; // true when now muted
  }

  isMicMuted() {
    if (!this.localStream) return false;
    const tracks = this.localStream.getAudioTracks();
    return tracks.length > 0 && !tracks[0].enabled;
  }

  async _buildPeer() {
    const v = state.settings.voice;
    const constraints = {
      audio: {
        deviceId: v.inputDeviceId ? { exact: v.inputDeviceId } : undefined,
        noiseSuppression: !!v.noiseSuppression,
        echoCancellation: !!v.echoCancellation,
        autoGainControl: !!v.autoGain,
      },
      video: false,
    };
    this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
    if (state.globalMicMuted) {
      for (const t of this.localStream.getAudioTracks()) t.enabled = false;
    }

    this.pc = new RTCPeerConnection(ICE_CONFIG);
    for (const track of this.localStream.getAudioTracks()) this.pc.addTrack(track, this.localStream);

    this.pc.ontrack = (e) => {
      if (!this.remoteAudio) {
        this.remoteAudio = document.createElement('audio');
        this.remoteAudio.autoplay = true;
        this.remoteAudio.style.display = 'none';
        document.body.appendChild(this.remoteAudio);
      }
      this.remoteAudio.srcObject = e.streams[0];
      this.remoteAudio.muted = state.globalDeafened;
      // Output device selection where supported (Chromium has setSinkId).
      const out = state.settings.voice.outputDeviceId;
      if (out && this.remoteAudio.setSinkId) {
        this.remoteAudio.setSinkId(out).catch(() => {});
      }
      // Output volume (0–200 → 0.0–2.0; HTMLMediaElement.volume is capped
      // at 1.0 by the spec but most engines tolerate up to ~3 in practice).
      this.remoteAudio.volume = Math.min(1, state.settings.voice.outputVol / 100);
    };

    this.pc.onicecandidate = (e) => {
      if (e.candidate) this._sendSignal('signal', { kind: 'candidate', candidate: e.candidate });
    };

    this.pc.onconnectionstatechange = () => {
      if (!this.pc) return;
      const s = this.pc.connectionState;
      klog.info('call.pcstate', s, { call: this.callId });
      if (s === 'connected') {
        this.state = 'connected';
        this.startedAt = Date.now();
        setActiveCallState('Connected');
      } else if (s === 'failed' || s === 'closed' || s === 'disconnected') {
        if (this.state !== 'ended') this._teardown('Connection lost');
      }
    };
  }

  _sendSignal(subType, payload) {
    return this._sendSignalRaw(subType, this.peer && this.peer.id, this.callId, payload);
  }
  _sendSignalRaw(subType, toUserId, callId, payload) {
    if (!toUserId || !state.realtime) return false;
    return state.realtime.send({
      type: 'call.' + subType,
      toUserId,
      callId,
      dmId: this.dmId || null,
      payload: payload || null,
    });
  }

  _teardown(reasonText) {
    this.state = 'ended';
    if (this.localStream) {
      for (const t of this.localStream.getTracks()) try { t.stop(); } catch {}
      this.localStream = null;
    }
    if (this.pc) { try { this.pc.close(); } catch {} this.pc = null; }
    if (this.remoteAudio) { try { this.remoteAudio.remove(); } catch {} this.remoteAudio = null; }
    closeIncomingCallModal();
    hideActiveCallBar(reasonText);
    this.callId = null;
    this.peer = null;
    this.dmId = null;
    this.isCaller = false;
    this.startedAt = 0;
    this._pendingCandidates = [];
    setTimeout(() => { if (this.state === 'ended') this.state = 'idle'; }, 50);
  }
}

const callMgr = new CallManager();

// --- Active-call bar (floating bottom-right when in a call) ----------------

function showActiveCallBar(peer, stateText) {
  const bar = document.querySelector('[data-active-call]');
  if (!bar) return;
  bar.classList.remove('hidden');
  const av = bar.querySelector('.avatar');
  if (av) paintAvatar(av, peer);
  bar.querySelector('[data-call-peer-name]').textContent = peer.displayName || peer.username || '—';
  bar.querySelector('[data-call-state]').textContent = stateText || 'Connecting…';
  syncActiveCallControls();

  bar.querySelectorAll('[data-call-ctrl]').forEach((b) => {
    if (b.dataset.wired) return;
    b.dataset.wired = '1';
    b.addEventListener('click', () => {
      if (b.dataset.callCtrl === 'mute') callMgr.toggleMute();
      else if (b.dataset.callCtrl === 'hangup') callMgr.hangup();
    });
  });
}
function setActiveCallState(text) {
  const bar = document.querySelector('[data-active-call]');
  if (!bar) return;
  const el = bar.querySelector('[data-call-state]');
  if (el) el.textContent = text;
}
function syncActiveCallControls() {
  const bar = document.querySelector('[data-active-call]');
  if (!bar) return;
  const muteBtn = bar.querySelector('[data-call-ctrl="mute"]');
  if (muteBtn) {
    const muted = callMgr.isMicMuted();
    muteBtn.classList.toggle('active', muted);
    muteBtn.title = muted ? 'Unmute' : 'Mute';
    muteBtn.innerHTML = '';
    muteBtn.appendChild(svgIcon(muted ? 'klar-mic-off' : 'klar-mic', 16));
  }
}
function hideActiveCallBar(reasonText) {
  const bar = document.querySelector('[data-active-call]');
  if (!bar) return;
  if (reasonText) {
    setActiveCallState(reasonText);
    setTimeout(() => bar.classList.add('hidden'), 1500);
  } else {
    bar.classList.add('hidden');
  }
}

// --- Incoming-call modal (uses the same openModal helper as everything else) -

let _incomingCallClose = null;
function showIncomingCallModal(peer, mgr) {
  closeIncomingCallModal();
  const tpl = document.getElementById('tpl-modal-incoming-call');
  if (!tpl) return;
  document.body.appendChild(tpl.content.cloneNode(true));
  const backdrop = document.body.querySelector('.call-backdrop[data-modal]:last-of-type');
  if (!backdrop) return;
  paintAvatar(backdrop.querySelector('.avatar'), peer);
  backdrop.querySelector('h2').textContent = `${peer.displayName || peer.username} is calling`;
  backdrop.querySelector('[data-caller-handle]').textContent = '@' + (peer.username || '?');
  _incomingCallClose = () => { try { backdrop.remove(); } catch {} _incomingCallClose = null; };
  backdrop.querySelector('[data-action="accept"]').addEventListener('click', () => mgr.accept());
  backdrop.querySelector('[data-action="decline"]').addEventListener('click', () => mgr.decline());
  // Don't dismiss by clicking outside — call decisions should be explicit.
}
function closeIncomingCallModal() {
  if (_incomingCallClose) _incomingCallClose();
}

// ===========================================================================
// New-message notifications: in-app toast + audio cue. The toast is rendered
// in a fixed-position stack at the top-right; clicking it opens the DM.
// Sound is bundled at public/sounds/notify.mp3 (referenced relative to the
// renderer document so it works in both browser and Electron modes).
// ===========================================================================

let _notifyAudio = null;
let _notifyToastContainer = null;
let _windowFocused = (typeof document !== 'undefined') ? !document.hidden : true;
if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => { _windowFocused = true; });
  window.addEventListener('blur',  () => { _windowFocused = false; });
  document.addEventListener('visibilitychange', () => { _windowFocused = !document.hidden; });
}

function ensureNotifyAudio() {
  if (_notifyAudio) return _notifyAudio;
  _notifyAudio = new Audio('sounds/notify.mp3');
  _notifyAudio.preload = 'auto';
  return _notifyAudio;
}
function playNotifySound() {
  const n = state.settings && state.settings.notifications;
  if (!n || !n.sound) return;
  const a = ensureNotifyAudio();
  a.volume = Math.max(0, Math.min(1, (n.soundVolume || 80) / 100));
  // Clone-and-play so rapid messages don't trample each other.
  try {
    const c = a.cloneNode();
    c.volume = a.volume;
    c.play().catch(() => {});
  } catch {
    a.currentTime = 0; a.play().catch(() => {});
  }
}

function ensureToastContainer() {
  if (_notifyToastContainer && document.body.contains(_notifyToastContainer)) return _notifyToastContainer;
  _notifyToastContainer = document.createElement('div');
  _notifyToastContainer.className = 'notify-toast-stack';
  document.body.appendChild(_notifyToastContainer);
  return _notifyToastContainer;
}

// Show a toast for an incoming DM message. Caller decides whether the
// notification should fire at all (e.g. don't notify for own echoes).
function showDmNotification(dm, message) {
  const n = state.settings && state.settings.notifications;
  if (!n || !n.enabled) return;
  // Suppress toast if the window is focused AND the user is already looking
  // at this exact DM — they obviously see the new message.
  if (_windowFocused && state.activeDmId === message.dmId && !n.showWhenFocused) return;

  playNotifySound();

  const peer = dm.other || userById(message.senderId) || { username: '?' , displayName: 'Someone' };
  const container = ensureToastContainer();
  const toast = document.createElement('button');
  toast.className = 'notify-toast';
  toast.type = 'button';

  const av = document.createElement('div');
  av.className = 'avatar';
  paintAvatar(av, peer);
  toast.appendChild(av);

  const body = document.createElement('div');
  body.className = 'notify-body';
  const name = document.createElement('div'); name.className = 'notify-name';
  name.textContent = peer.displayName || peer.username || 'Direct message';
  const preview = document.createElement('div'); preview.className = 'notify-preview';
  let snippet = (message.content || '').trim();
  if (!snippet && message.attachments && message.attachments.length) {
    snippet = '[attachment: ' + (message.attachments[0].name || 'file') + ']';
  }
  if (snippet.length > 120) snippet = snippet.slice(0, 117) + '…';
  preview.textContent = snippet || '(empty)';
  body.appendChild(name); body.appendChild(preview);
  toast.appendChild(body);

  const close = document.createElement('span');
  close.className = 'notify-close';
  close.innerHTML = '&times;';
  close.addEventListener('click', (e) => { e.stopPropagation(); toast.remove(); });
  toast.appendChild(close);

  toast.addEventListener('click', () => {
    try { window.focus(); } catch {}
    if (window.klar && window.klar.shell && window.klar.shell.show) {
      try { window.klar.shell.show(); } catch {}
    }
    switchView({ kind: 'home' });
    setTimeout(() => openDm(message.dmId), 30);
    toast.remove();
  });

  container.appendChild(toast);
  // Stagger entry animation
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 220);
  }, 6000);

  // Tell the OS shell so the taskbar/dock can flash if available.
  if (window.klar && window.klar.shell && window.klar.shell.flash) {
    try { window.klar.shell.flash(); } catch {}
  }
}

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
  state.realtime.addEventListener('call.invite',         (e) => callMgr.onIncomingInvite(e.detail));
  state.realtime.addEventListener('call.accept',         (e) => callMgr.onAccept(e.detail));
  state.realtime.addEventListener('call.decline',        (e) => callMgr.onDecline(e.detail));
  state.realtime.addEventListener('call.signal',         (e) => callMgr.onSignal(e.detail));
  state.realtime.addEventListener('call.hangup',         (e) => callMgr.onHangup(e.detail));
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
  const items = [
    { icon: state.globalMicMuted ? 'klar-mic-off' : 'klar-mic', title: state.globalMicMuted ? 'Unmute mic' : 'Mute mic', action: 'mic' },
    { icon: state.globalDeafened ? 'klar-phone-off' : 'klar-headphones', title: state.globalDeafened ? 'Undeafen' : 'Deafen', action: 'deafen' },
    { icon: 'klar-settings', title: 'Settings',  action: 'settings' },
    { icon: 'klar-logout',   title: 'Log out',   action: 'logout' },
  ];
  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'footer-btn';
    b.title = it.title;
    b.appendChild(svgIcon(it.icon, 16));
    if (it.action === 'mic')      b.addEventListener('click', toggleGlobalMic);
    if (it.action === 'deafen')   b.addEventListener('click', toggleGlobalDeafen);
    if (it.action === 'settings') b.addEventListener('click', openSettingsModal);
    if (it.action === 'logout')   b.addEventListener('click', logout);
    if ((it.action === 'mic' && state.globalMicMuted) || (it.action === 'deafen' && state.globalDeafened)) {
      b.classList.add('muted-active');
    }
    actions.appendChild(b);
  }
  bar.appendChild(actions);
}

function toggleGlobalMic() {
  state.globalMicMuted = !state.globalMicMuted;
  if (callMgr.localStream) {
    for (const t of callMgr.localStream.getAudioTracks()) t.enabled = !state.globalMicMuted;
  }
  syncActiveCallControls();
  renderMeBar();
}
function toggleGlobalDeafen() {
  state.globalDeafened = !state.globalDeafened;
  if (callMgr.remoteAudio) callMgr.remoteAudio.muted = state.globalDeafened;
  // Deafening also forces mic mute (matches Discord behavior).
  if (state.globalDeafened && !state.globalMicMuted) {
    state.globalMicMuted = true;
    if (callMgr.localStream) for (const t of callMgr.localStream.getAudioTracks()) t.enabled = false;
  }
  renderMeBar();
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
      <button class="icon-btn" data-action="dm-call" title="Voice call" aria-label="Start voice call">
        <svg width="18" height="18"><use href="#klar-phone"/></svg>
      </button>
      <button class="icon-btn" data-action="dm-profile" title="View profile" aria-label="View profile">
        <svg width="18" height="18"><use href="#klar-user"/></svg>
      </button>
    </div>
  `;
  paintAvatar(header.querySelector('.avatar'), dm.other);
  header.querySelector('.channel-name').textContent = dm.other.displayName;
  header.querySelector('.peer-handle').textContent = dm.other.username;
  header.querySelector('[data-action="dm-profile"]').addEventListener('click', () => openProfileModal(dm.other));
  header.querySelector('[data-action="dm-call"]').addEventListener('click', () => callMgr.startCall(dm.other, dm.id));

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

// ---------------------------------------------------------------------------
// Embed detection & rendering
// ---------------------------------------------------------------------------
//
// Rule (per user spec): if a URL in the message produces an embed (image /
// video / audio), the URL itself disappears from the rendered text and only
// the embed shows. Catbox links (files.catbox.moe / litter.catbox.moe) work
// transparently because we classify by file extension, not host.
//
// Mixed content keeps its text — only the URL substring is stripped:
//   "lol look at this https://files.catbox.moe/abc.png cute right?"
//   → text "lol look at this   cute right?" + an image embed below.

const URL_RE = /\bhttps?:\/\/[^\s<>"]+/gi;
const IMG_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|svg)(?:\?|#|$)/i;
const VID_EXT = /\.(mp4|webm|mov|m4v|ogv)(?:\?|#|$)/i;
const AUD_EXT = /\.(mp3|wav|ogg|m4a|opus|flac)(?:\?|#|$)/i;

function classifyUrl(u) {
  const noFrag = u.split('#')[0];
  if (IMG_EXT.test(noFrag)) return 'image';
  if (VID_EXT.test(noFrag)) return 'video';
  if (AUD_EXT.test(noFrag)) return 'audio';
  return null;
}

// Returns { fragments, embeds } where:
//   fragments = array of either string (plain text) or { link: '<url>' }
//   embeds    = array of { url, type } for media URLs found in content
function parseMessageContent(content) {
  const text = String(content || '');
  const embeds = [];
  const matches = [...text.matchAll(URL_RE)];
  let cursor = 0;
  const fragments = [];
  for (const m of matches) {
    const u = m[0];
    fragments.push(text.slice(cursor, m.index));
    const type = classifyUrl(u);
    if (type) {
      embeds.push({ url: u, type });
      // intentionally drop the URL — embed renders below the text
    } else {
      fragments.push({ link: u });
    }
    cursor = m.index + u.length;
  }
  fragments.push(text.slice(cursor));
  return { fragments, embeds };
}

function renderTextFragments(textEl, fragments) {
  for (const f of fragments) {
    if (typeof f === 'string') {
      if (f) textEl.appendChild(document.createTextNode(f));
    } else if (f && f.link) {
      const a = document.createElement('a');
      a.href = f.link;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.className = 'msg-link';
      a.textContent = f.link;
      textEl.appendChild(a);
    }
  }
}

// Build a single embed DOM node for an image/video/audio URL. Falls back to
// a download link if the URL turned out to be untyped (shouldn't happen,
// but defensive).
function buildEmbed(url, type, attachmentMeta) {
  const wrap = document.createElement('div');
  wrap.className = 'embed embed-' + (type || 'file');
  if (type === 'image') {
    const img = document.createElement('img');
    img.src = url;
    img.alt = attachmentMeta && attachmentMeta.name ? attachmentMeta.name : '';
    img.loading = 'lazy';
    img.addEventListener('click', () => window.open(url, '_blank'));
    wrap.appendChild(img);
  } else if (type === 'video') {
    const v = document.createElement('video');
    v.src = url;
    v.controls = true;
    v.preload = 'metadata';
    v.playsInline = true;
    wrap.appendChild(v);
  } else if (type === 'audio') {
    const a = document.createElement('audio');
    a.src = url;
    a.controls = true;
    a.preload = 'metadata';
    wrap.appendChild(a);
  } else {
    // Generic file chip
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.className = 'attachment-chip';
    const sizeKb = attachmentMeta && attachmentMeta.size ? Math.round(attachmentMeta.size / 1024) + ' KB' : '';
    a.textContent = (attachmentMeta && attachmentMeta.name ? attachmentMeta.name : url) + (sizeKb ? ' · ' + sizeKb : '');
    wrap.appendChild(a);
  }
  return wrap;
}

// Render the body of a message into the row's `.msg-body`. Adds a
// `.embeds` container after `.text` for media. Used by both DM + channel
// row builders so the rules stay consistent.
function renderMessageBody(row, m) {
  const textEl = row.querySelector('.text');
  textEl.innerHTML = '';
  if (m.encrypted) {
    textEl.classList.add('failed');
    textEl.textContent = '[legacy encrypted message]';
    return;
  }

  const { fragments, embeds } = parseMessageContent(m.content);
  // Trim leading/trailing whitespace fragments after URL stripping so we
  // don't leave a dangling empty line above an embed.
  // (Pure structural trim — keeps internal whitespace untouched.)
  while (fragments.length && typeof fragments[0] === 'string' && !fragments[0].trim()) fragments.shift();
  while (fragments.length && typeof fragments[fragments.length - 1] === 'string' && !fragments[fragments.length - 1].trim()) fragments.pop();
  renderTextFragments(textEl, fragments);
  if (!textEl.childNodes.length) textEl.classList.add('empty'); else textEl.classList.remove('empty');

  // Attachments come from m.attachments (uploaded via /api/uploads). Each
  // attachment URL is also classified by extension so an uploaded PNG renders
  // inline as an image, an MP4 as a video, etc.
  const allEmbeds = [...embeds];
  if (Array.isArray(m.attachments)) {
    for (const a of m.attachments) {
      const t = classifyUrl(a.url) || (a.mime && a.mime.startsWith('image/') ? 'image' : a.mime && a.mime.startsWith('video/') ? 'video' : a.mime && a.mime.startsWith('audio/') ? 'audio' : null);
      allEmbeds.push({ url: a.url, type: t, meta: a });
    }
  }
  if (!allEmbeds.length) return;

  const embedsWrap = document.createElement('div');
  embedsWrap.className = 'embeds';
  for (const e of allEmbeds) {
    embedsWrap.appendChild(buildEmbed(e.url, e.type, e.meta));
  }
  row.querySelector('.msg-body').appendChild(embedsWrap);
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
  renderMessageBody(row, m);
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
  renderMessageBody(row, m);
  return row;
}

// ===========================================================================
// Composer
// ===========================================================================

// Pending-attachment buffer: files the user has chosen / dragged / pasted
// but not yet sent. Cleared when the message is submitted or the user
// removes them via the chip × button.
const composerState = {
  pending: [],   // [{ id, file, status: 'queued'|'uploading'|'done'|'failed', progress, uploaded?: { url, name, mime, size } }]
};

function setupComposer() {
  const form = root.querySelector('[data-composer]');
  if (!form) return;
  const input = root.querySelector('[data-composer-input]');
  const sendBtn = form.querySelector('button[type="submit"]');

  // Inject paperclip + hidden file input + attachment-tray once. Re-runs of
  // setupComposer (on switchView) just reuse the existing nodes.
  if (!form.querySelector('[data-attach-btn]')) {
    const attachBtn = document.createElement('button');
    attachBtn.type = 'button';
    attachBtn.className = 'composer-attach';
    attachBtn.dataset.attachBtn = '1';
    attachBtn.title = 'Upload a file';
    attachBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21 11l-9 9a5 5 0 11-7-7l9-9a3.5 3.5 0 115 5l-9 9a2 2 0 01-3-3l8.5-8.5"
            fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
    form.insertBefore(attachBtn, input);

    const fi = document.createElement('input');
    fi.type = 'file';
    fi.multiple = true;
    fi.style.display = 'none';
    fi.dataset.composerFile = '1';
    form.appendChild(fi);
    attachBtn.addEventListener('click', () => fi.click());
    fi.addEventListener('change', (e) => { onComposerFiles(Array.from(e.target.files || [])); fi.value = ''; });
  }
  let tray = form.parentElement.querySelector('[data-attach-tray]');
  if (!tray) {
    tray = document.createElement('div');
    tray.className = 'attachment-tray hidden';
    tray.dataset.attachTray = '1';
    form.parentElement.insertBefore(tray, form);
  }

  const updateDisabled = () => {
    const hasText = input.value.trim().length > 0;
    const hasReady = composerState.pending.some((p) => p.status === 'done');
    const anyUploading = composerState.pending.some((p) => p.status === 'uploading' || p.status === 'queued');
    sendBtn.disabled = (!hasText && !hasReady) || anyUploading;
  };
  input.addEventListener('input', updateDisabled);
  updateDisabled();
  composerState._updateDisabled = updateDisabled;
  composerState._renderTray = () => renderAttachmentTray(tray);

  // Drag & drop onto the messages area or the composer
  const chat = root.querySelector('[data-chat-active]') || form.parentElement;
  if (chat && !chat.dataset.dragWired) {
    chat.dataset.dragWired = '1';
    chat.addEventListener('dragover', (e) => { e.preventDefault(); chat.classList.add('drop-target'); });
    chat.addEventListener('dragleave', () => chat.classList.remove('drop-target'));
    chat.addEventListener('drop', (e) => {
      e.preventDefault(); chat.classList.remove('drop-target');
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      if (files.length) onComposerFiles(files);
    });
  }

  // Paste image / file from clipboard
  if (!input.dataset.pasteWired) {
    input.dataset.pasteWired = '1';
    input.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      const files = [];
      for (const it of items) {
        if (it.kind === 'file') {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) { e.preventDefault(); onComposerFiles(files); }
    });
  }

  if (!form.dataset.submitWired) {
    form.dataset.submitWired = '1';
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value;
      const ready = composerState.pending.filter((p) => p.status === 'done').map((p) => p.uploaded);
      if (!text.trim() && !ready.length) return;
      if (state.activeDmId) await sendDmMessage(text, ready);
      else if (state.activeChannelId) await sendChannelMessage(text, ready);
      else return;
      input.value = '';
      composerState.pending = [];
      composerState._renderTray();
      updateDisabled();
    });
  }
}

function onComposerFiles(files) {
  for (const f of files) {
    const entry = { id: newClientId(), file: f, status: 'queued', progress: 0, uploaded: null, error: null };
    composerState.pending.push(entry);
    composerState._renderTray();
    composerState._updateDisabled();
    uploadComposerEntry(entry).catch((err) => klog.error('upload', 'failed', { name: f.name, err: err.message }));
  }
}

async function uploadComposerEntry(entry) {
  entry.status = 'uploading';
  composerState._updateDisabled();
  composerState._renderTray();
  try {
    const result = await api.uploadFile(entry.file, (p) => {
      entry.progress = p;
      composerState._renderTray();
    });
    entry.uploaded = result;
    entry.status = 'done';
    entry.progress = 1;
    klog.info('upload.done', 'ok', { name: entry.file.name, size: entry.file.size });
  } catch (e) {
    entry.status = 'failed';
    entry.error = e.message || 'upload failed';
    klog.error('upload.fail', e.message, { name: entry.file.name });
  }
  composerState._renderTray();
  composerState._updateDisabled();
}

function renderAttachmentTray(tray) {
  tray.innerHTML = '';
  if (!composerState.pending.length) { tray.classList.add('hidden'); return; }
  tray.classList.remove('hidden');
  for (const e of composerState.pending) {
    const chip = document.createElement('div');
    chip.className = 'attach-chip ' + e.status;
    const isImg = e.file.type && e.file.type.startsWith('image/');
    if (isImg) {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(e.file);
      img.onload = () => URL.revokeObjectURL(img.src);
      chip.appendChild(img);
    } else {
      const ic = document.createElement('div');
      ic.className = 'file-thumb';
      ic.textContent = (e.file.name.split('.').pop() || '').slice(0, 4).toUpperCase() || 'FILE';
      chip.appendChild(ic);
    }
    const info = document.createElement('div');
    info.className = 'attach-info';
    const name = document.createElement('div'); name.className = 'attach-name'; name.textContent = e.file.name;
    const meta = document.createElement('div'); meta.className = 'attach-meta';
    if (e.status === 'uploading') meta.textContent = 'Uploading… ' + Math.round((e.progress || 0) * 100) + '%';
    else if (e.status === 'queued') meta.textContent = 'Queued';
    else if (e.status === 'failed') meta.textContent = 'Failed: ' + (e.error || 'error');
    else meta.textContent = Math.round(e.file.size / 1024) + ' KB';
    info.appendChild(name); info.appendChild(meta);
    chip.appendChild(info);

    if (e.status === 'uploading') {
      const bar = document.createElement('div');
      bar.className = 'attach-bar';
      const fill = document.createElement('span');
      fill.style.width = Math.round((e.progress || 0) * 100) + '%';
      bar.appendChild(fill);
      chip.appendChild(bar);
    }

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'attach-remove';
    rm.title = 'Remove';
    rm.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6l-12 12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
    rm.addEventListener('click', () => {
      composerState.pending = composerState.pending.filter((x) => x.id !== e.id);
      composerState._renderTray();
      composerState._updateDisabled();
    });
    chip.appendChild(rm);

    tray.appendChild(chip);
  }
}

// Optimistic send: render the message dimmed (.pending) immediately, then
// reconcile when the server confirms. The clientId rides along on POST and
// the server echoes it on the WS broadcast back so we can match the
// confirmation against the local row regardless of which arrives first.

async function sendDmMessage(text, attachments) {
  const dm = state.dms.find((d) => d.id === state.activeDmId);
  if (!dm) return;
  const att = Array.isArray(attachments) ? attachments : [];
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
    attachments: att,
  };
  // Render immediately
  let list = state.messagesByDm.get(dm.id);
  if (!list) { list = []; state.messagesByDm.set(dm.id, list); }
  list.push(optimistic);
  appendDmMessage(dm, optimistic);
  klog.info('msg.dm.send', 'sending', { dm: dm.id, clientId, bytes: text.length, attachments: att.length });

  try {
    await api.sendMessage(dm.id, text, clientId, att);
  } catch (err) {
    klog.error('msg.dm.send', 'failed', { dm: dm.id, clientId, err: err.message });
    markMessageFailed(clientId, err.message);
  }
}

async function sendChannelMessage(text, attachments) {
  const channelId = state.activeChannelId;
  if (!channelId) return;
  const att = Array.isArray(attachments) ? attachments : [];
  const clientId = newClientId();
  const optimistic = {
    id: 'tmp_' + clientId,
    clientId,
    channelId,
    senderId: state.user.id,
    content: text,
    createdAt: Date.now(),
    pending: true,
    attachments: att,
  };
  let list = state.channelMessagesByChan.get(channelId);
  if (!list) { list = []; state.channelMessagesByChan.set(channelId, list); }
  list.push(optimistic);
  appendChannelMessage(optimistic);
  klog.info('msg.channel.send', 'sending', { channel: channelId, clientId, bytes: text.length, attachments: att.length });

  try {
    await api.sendChannelMessage(channelId, text, clientId, att);
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
    // Notify only when the message is from someone else (not an echo of our
    // own send from another tab / device).
    if (state.user && message.senderId !== state.user.id) {
      const dm = state.dms.find((d) => d.id === message.dmId);
      if (dm) showDmNotification(dm, message);
    }
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

// Settings modal — four tabs (voice / video / personalization / advanced).
// Settings are persisted to localStorage on every change so the user never
// has to hit a "Save" button (except for fields that hit the server, like
// display name). Device enumeration only succeeds after permission is
// granted at least once; we trigger getUserMedia({audio:true}) silently when
// the modal opens to populate the device labels.
function openSettingsModal() {
  openModal('tpl-modal-settings', async (modal) => {
    const settings = state.settings;

    // Tab switching
    const navBtns = modal.querySelectorAll('.settings-nav-btn');
    const panes = modal.querySelectorAll('.settings-pane');
    navBtns.forEach((b) => b.addEventListener('click', () => {
      navBtns.forEach((x) => x.classList.toggle('active', x === b));
      panes.forEach((p) => p.classList.toggle('active', p.dataset.pane === b.dataset.tab));
    }));

    // ---- Voice tab ----
    const voiceInput  = modal.querySelector('[data-voice-input]');
    const voiceOutput = modal.querySelector('[data-voice-output]');
    const inputVol    = modal.querySelector('[data-input-vol]');
    const inputVolV   = modal.querySelector('[data-input-vol-value]');
    const outputVol   = modal.querySelector('[data-output-vol]');
    const outputVolV  = modal.querySelector('[data-output-vol-value]');
    const noiseSup    = modal.querySelector('[data-noise-suppression]');
    const echoCancel  = modal.querySelector('[data-echo-cancellation]');
    const autoGain    = modal.querySelector('[data-auto-gain]');

    inputVol.value  = settings.voice.inputVol;  inputVolV.textContent  = settings.voice.inputVol  + '%';
    outputVol.value = settings.voice.outputVol; outputVolV.textContent = settings.voice.outputVol + '%';
    noiseSup.checked   = settings.voice.noiseSuppression;
    echoCancel.checked = settings.voice.echoCancellation;
    autoGain.checked   = settings.voice.autoGain;

    inputVol.addEventListener('input', () => { settings.voice.inputVol  = +inputVol.value;  inputVolV.textContent  = inputVol.value  + '%'; saveSettings(); });
    outputVol.addEventListener('input', () => {
      settings.voice.outputVol = +outputVol.value; outputVolV.textContent = outputVol.value + '%'; saveSettings();
      if (callMgr.remoteAudio) callMgr.remoteAudio.volume = Math.min(1, settings.voice.outputVol / 100);
    });
    noiseSup.addEventListener('change',   () => { settings.voice.noiseSuppression = noiseSup.checked;   saveSettings(); });
    echoCancel.addEventListener('change', () => { settings.voice.echoCancellation = echoCancel.checked; saveSettings(); });
    autoGain.addEventListener('change',   () => { settings.voice.autoGain         = autoGain.checked;   saveSettings(); });

    voiceInput.addEventListener('change',  () => { settings.voice.inputDeviceId  = voiceInput.value;  saveSettings(); });
    voiceOutput.addEventListener('change', () => {
      settings.voice.outputDeviceId = voiceOutput.value; saveSettings();
      if (callMgr.remoteAudio && callMgr.remoteAudio.setSinkId) {
        callMgr.remoteAudio.setSinkId(voiceOutput.value).catch(() => {});
      }
    });

    // Hide setSinkId note if browser does support it
    if (typeof HTMLMediaElement !== 'undefined' && HTMLMediaElement.prototype.setSinkId) {
      const note = modal.querySelector('[data-output-note]');
      if (note) note.hidden = true;
    }

    // Populate device list (requires permission for labels to appear)
    await populateDeviceLists(modal);

    // Mic test
    let testCtx = null, testStream = null, testRaf = 0;
    const testBtn   = modal.querySelector('[data-mic-test-btn]');
    const meter     = modal.querySelector('[data-mic-meter]');
    const meterFill = meter.querySelector('span');
    testBtn.addEventListener('click', async () => {
      if (testStream) {
        for (const t of testStream.getTracks()) try { t.stop(); } catch {}
        if (testCtx) try { testCtx.close(); } catch {}
        testStream = null; testCtx = null; cancelAnimationFrame(testRaf); meterFill.style.width = '0%';
        testBtn.textContent = 'Start test'; return;
      }
      try {
        testStream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: settings.voice.inputDeviceId ? { exact: settings.voice.inputDeviceId } : undefined },
          video: false,
        });
        testCtx = new (window.AudioContext || window.webkitAudioContext)();
        const src = testCtx.createMediaStreamSource(testStream);
        const an = testCtx.createAnalyser(); an.fftSize = 512;
        src.connect(an);
        const buf = new Uint8Array(an.frequencyBinCount);
        const tick = () => {
          an.getByteFrequencyData(buf);
          let sum = 0; for (const v of buf) sum += v;
          const avg = sum / buf.length;
          const pct = Math.min(100, Math.round((avg / 100) * settings.voice.inputVol));
          meterFill.style.width = pct + '%';
          testRaf = requestAnimationFrame(tick);
        };
        tick();
        testBtn.textContent = 'Stop test';
      } catch (e) {
        meterFill.style.width = '0%';
        klog.warn('settings.mictest', 'failed', { err: e.message });
        testBtn.textContent = 'Start test';
      }
    });

    // ---- Video tab ----
    const vidIn   = modal.querySelector('[data-video-input]');
    const vidRes  = modal.querySelector('[data-video-resolution]');
    const vidPre  = modal.querySelector('[data-video-preview]');
    const vidStart = modal.querySelector('[data-video-test-btn]');
    const vidStop  = modal.querySelector('[data-video-stop-btn]');
    let vidStream = null;
    vidRes.value = String(settings.video.resolution);
    vidIn.addEventListener('change',  () => { settings.video.inputDeviceId = vidIn.value; saveSettings(); });
    vidRes.addEventListener('change', () => { settings.video.resolution     = +vidRes.value; saveSettings(); });
    vidStart.addEventListener('click', async () => {
      try {
        const cs = { video: {
          deviceId: settings.video.inputDeviceId ? { exact: settings.video.inputDeviceId } : undefined,
          height: { ideal: settings.video.resolution },
        }, audio: false };
        vidStream = await navigator.mediaDevices.getUserMedia(cs);
        vidPre.srcObject = vidStream;
        vidStart.hidden = true; vidStop.hidden = false;
      } catch (e) { klog.warn('settings.video', 'failed', { err: e.message }); }
    });
    vidStop.addEventListener('click', () => {
      if (vidStream) { for (const t of vidStream.getTracks()) try { t.stop(); } catch {} ; vidStream = null; }
      vidPre.srcObject = null;
      vidStart.hidden = false; vidStop.hidden = true;
    });

    // ---- Notifications tab ----
    const nEnabled = modal.querySelector('[data-notif-enabled]');
    const nSound   = modal.querySelector('[data-notif-sound]');
    const nFoc     = modal.querySelector('[data-notif-focused]');
    const nVol     = modal.querySelector('[data-notif-volume]');
    const nVolV    = modal.querySelector('[data-notif-volume-value]');
    const nTest    = modal.querySelector('[data-notif-test]');
    const nTray    = modal.querySelector('[data-tray-enabled]');
    const nf = settings.notifications;
    nEnabled.checked = nf.enabled;
    nSound.checked   = nf.sound;
    nFoc.checked     = nf.showWhenFocused;
    nVol.value       = nf.soundVolume;
    nVolV.textContent = nf.soundVolume + '%';
    nTray.checked    = settings.advanced.minimizeToTray;
    nEnabled.addEventListener('change', () => { nf.enabled         = nEnabled.checked; saveSettings(); });
    nSound.addEventListener('change',   () => { nf.sound           = nSound.checked;   saveSettings(); });
    nFoc.addEventListener('change',     () => { nf.showWhenFocused = nFoc.checked;     saveSettings(); });
    nVol.addEventListener('input',      () => { nf.soundVolume     = +nVol.value; nVolV.textContent = nVol.value + '%'; saveSettings(); });
    nTest.addEventListener('click', () => playNotifySound());
    nTray.addEventListener('change', () => {
      settings.advanced.minimizeToTray = nTray.checked;
      saveSettings();
      if (window.klar && window.klar.shell && window.klar.shell.setMinimizeToTray) {
        try { window.klar.shell.setMinimizeToTray(nTray.checked); } catch {}
      }
    });

    // ---- Personalization tab ----
    const dispName = modal.querySelector('[data-display-name]');
    const username = modal.querySelector('[data-username]');
    const dispSave = modal.querySelector('[data-save-display-name]');
    const dispStat = modal.querySelector('[data-display-name-status]');
    dispName.value = state.user ? state.user.displayName : '';
    username.value = state.user ? state.user.username : '';
    dispSave.addEventListener('click', async () => {
      const v = dispName.value.trim();
      if (!v) return;
      dispSave.disabled = true; dispStat.textContent = 'Saving…';
      try {
        const { user } = await api.updateMe({ displayName: v });
        state.user = user; rememberUser(user);
        renderMeBar();
        dispStat.textContent = 'Saved';
        setTimeout(() => { dispStat.textContent = ''; }, 1500);
      } catch (e) { dispStat.textContent = 'Failed: ' + (e.message || 'error'); }
      finally { dispSave.disabled = false; }
    });

    const accentGrid = modal.querySelector('[data-accent-grid]');
    for (const c of ACCENT_PALETTE) {
      const sw = document.createElement('button');
      sw.className = 'accent-swatch' + (c.toLowerCase() === settings.personalization.accentColor.toLowerCase() ? ' active' : '');
      sw.style.background = c;
      sw.title = c;
      sw.addEventListener('click', () => {
        settings.personalization.accentColor = c; saveSettings(); applyPersonalization();
        accentGrid.querySelectorAll('.accent-swatch').forEach((s) => s.classList.toggle('active', s === sw));
      });
      accentGrid.appendChild(sw);
    }

    const fontSize  = modal.querySelector('[data-font-size]');
    const fontVal   = modal.querySelector('[data-font-value]');
    fontSize.value  = settings.personalization.fontSize;
    fontVal.textContent = settings.personalization.fontSize + 'px';
    fontSize.addEventListener('input', () => {
      settings.personalization.fontSize = +fontSize.value;
      fontVal.textContent = fontSize.value + 'px';
      saveSettings(); applyPersonalization();
    });

    const compact = modal.querySelector('[data-compact-mode]');
    const reduceMotion = modal.querySelector('[data-reduce-motion]');
    compact.checked = settings.personalization.compactMode;
    reduceMotion.checked = settings.personalization.reduceMotion;
    compact.addEventListener('change',     () => { settings.personalization.compactMode  = compact.checked;     saveSettings(); applyPersonalization(); });
    reduceMotion.addEventListener('change',() => { settings.personalization.reduceMotion = reduceMotion.checked; saveSettings(); applyPersonalization(); });

    // ---- Advanced tab ----
    const curUrl = modal.querySelector('[data-current-server-url]');
    const cfg = (typeof window !== 'undefined' && window.KLAR_CONFIG) || {};
    curUrl.textContent = settings.advanced.serverOverride || cfg.serverUrl || location.origin;

    const override = modal.querySelector('[data-server-override]');
    override.value = settings.advanced.serverOverride || '';
    modal.querySelector('[data-save-override]').addEventListener('click', () => {
      settings.advanced.serverOverride = override.value.trim();
      saveSettings();
      curUrl.textContent = settings.advanced.serverOverride || cfg.serverUrl || location.origin;
      alert('Override saved. Reload the app to apply.');
    });
    modal.querySelector('[data-clear-override]').addEventListener('click', () => {
      settings.advanced.serverOverride = ''; override.value = '';
      saveSettings();
      curUrl.textContent = cfg.serverUrl || location.origin;
    });

    modal.querySelector('[data-client-version]').textContent = (cfg.clientVersion || cfg.version || '0.0.0');

    const logDir = modal.querySelector('[data-log-dir]');
    const logBtn = modal.querySelector('[data-open-log-dir]');
    if (window.klar && window.klar.log && window.klar.log.path) {
      try {
        const p = await window.klar.log.path();
        if (p) {
          logDir.textContent = p;
          logBtn.hidden = false;
          logBtn.addEventListener('click', () => { try { window.klar.log.openDir(); } catch {} });
        }
      } catch {}
    }

    const dbg = modal.querySelector('[data-debug-mode]');
    dbg.checked = settings.advanced.debugMode;
    dbg.addEventListener('change', () => { settings.advanced.debugMode = dbg.checked; saveSettings(); });

    modal.querySelector('[data-factory-reset]').addEventListener('click', async () => {
      if (!confirm('Wipe local settings + log out? Server-side data is untouched.')) return;
      try { localStorage.clear(); } catch {}
      try { await clearSavedSession(); } catch {}
      location.reload();
    });
  });
}

async function populateDeviceLists(modal) {
  const voiceIn  = modal.querySelector('[data-voice-input]');
  const voiceOut = modal.querySelector('[data-voice-output]');
  const videoIn  = modal.querySelector('[data-video-input]');
  // Trigger permission prompt so device labels populate. If denied, the
  // selects show "Unknown microphone (id)" which is at least selectable.
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const t of tmp.getTracks()) try { t.stop(); } catch {}
  } catch {}
  let devices = [];
  try { devices = await navigator.mediaDevices.enumerateDevices(); } catch {}
  const fill = (sel, kind, current) => {
    sel.innerHTML = '';
    const def = document.createElement('option');
    def.value = ''; def.textContent = '(system default)';
    sel.appendChild(def);
    for (const d of devices.filter((x) => x.kind === kind)) {
      const o = document.createElement('option');
      o.value = d.deviceId; o.textContent = d.label || `${kind} (${d.deviceId.slice(0,6)})`;
      sel.appendChild(o);
    }
    sel.value = current || '';
  };
  fill(voiceIn,  'audioinput',  state.settings.voice.inputDeviceId);
  fill(voiceOut, 'audiooutput', state.settings.voice.outputDeviceId);
  fill(videoIn,  'videoinput',  state.settings.video.inputDeviceId);
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
  // Load + apply persisted settings BEFORE first paint so the user never sees
  // a flash of the default theme/font when their preferences are non-default.
  state.settings = loadSettings();
  applyPersonalization();
  setManualServerUrl(state.settings.advanced.serverOverride);
  if (window.klar && window.klar.shell && window.klar.shell.setMinimizeToTray) {
    try { window.klar.shell.setMinimizeToTray(state.settings.advanced.minimizeToTray); } catch {}
  }

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
