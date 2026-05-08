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

  // Group chats (multi-party DMs). Same shape as `dms` but with a
  // `members` array. Messages live in messagesByGroup.
  groupChats: [],
  messagesByGroup: new Map(),
  groupHistoryFetched: new Set(),
  activeGroupChatId: null,

  // Voice channel presence: channelId -> Set<userId>. Updated by
  // voice_channel_member-joined / -left WS events.
  voiceChannelMembers: new Map(),
  // The MeshSession instance the user is currently in (voice channel
  // or group call). Single-room-at-a-time for now.
  mesh: null,
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
    noiseGate: 0,        // 0 = off; 1-100 maps to threshold
    rnnoise: true,       // RNNoise suppressor — drops keyboards/taps, keeps voice
  },
  video: {
    inputDeviceId: '',
    resolution: 720,
  },
  screenShare: {
    height: 720,
    fps: 30,
  },
  hotkeys: {
    // Strings are in the form "Ctrl+Shift+KeyM" — modifiers + KeyboardEvent.code
    mute:   'Ctrl+Shift+KeyM',
    deafen: 'Ctrl+Shift+KeyD',
    hangup: 'Ctrl+Shift+KeyL',
    screen: 'Ctrl+Shift+KeyS',
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

// ICE servers — STUN candidates from multiple providers (so we still get
// public reflexive candidates when one provider is blocked from a given
// network) plus free TURN relays for cases where neither peer can punch
// through their NAT.
//
// metered.ca rebranded `openrelay.metered.ca` to `global.relay.metered.ca`
// at some point. The old hostname still resolves but is heavily throttled
// these days. We list the new endpoints first plus a couple of fallbacks.
//
// If a call still hangs in "connecting" after the SDP exchange, almost
// always one of:
//   1. Both peers behind symmetric NAT and TURN over UDP/80 is throttled
//   2. The TURN credentials have changed/expired
//   3. The peer's network blocks UDP entirely (TURN/TCP/443 should rescue
//      that — but we observed TCP/443 to openrelay timing out from this
//      LAN, so we add multiple TURN providers as backup).
const ICE_CONFIG = {
  iceServers: [
    { urls: [
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:stun2.l.google.com:19302',
      'stun:stun.cloudflare.com:3478',
      'stun:stun.relay.metered.ca:80',
    ]},
    {
      urls: [
        'turn:global.relay.metered.ca:80',
        'turn:global.relay.metered.ca:80?transport=tcp',
        'turn:global.relay.metered.ca:443',
        'turns:global.relay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    // Legacy openrelay endpoints — still up, useful when global.relay is
    // throttled.
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
  iceTransportPolicy: 'all',
  iceCandidatePoolSize: 4,
};

// ---------- Mic processing pipeline (RNNoise + gate + gain + analyser) ----------
//
// One shared graph that owns the entire mic-to-peer audio chain so every
// stage (noise suppression, input volume, noise gate, speaking-detection
// analyser, MediaStreamDestination feeding the RTCPeerConnection) lives in
// the same AudioContext. That matters because:
//
//   1. WebRTC's built-in noiseSuppression handles steady-state noise (fans,
//      hum) but lets impulsive sounds (keyboard clicks, taps, mouse
//      buttons) right through. RNNoise is trained on 48 kHz speech vs.
//      non-speech frames and drops those impulsives. We vendor the worklet
//      + wasm under public/vendor/rnnoise/ — no runtime network fetch,
//      no bundler.
//
//   2. The speaking indicator must read post-suppression audio. Otherwise
//      keystrokes light up the indicator even though the peer can't hear
//      them. Tying the analyser into the same graph guarantees that.
//
//   3. The input-volume slider, the noise-gate slider, and the speaking
//      indicator all need to read the same setting state in real time.
//      Single graph + a single 50 ms loop reads settings.voice live, no
//      "settings only apply on next call" footgun.
//
// On any failure the pipeline still routes raw mic → gain → gate → output
// so calls never break — only suppression goes away.

const RNNOISE_PROCESSOR_NAME = '@sapphi-red/web-noise-suppressor/rnnoise';
const RNNOISE_WORKLET_URL = new URL('./vendor/rnnoise/workletProcessor.js', import.meta.url);
const RNNOISE_WASM_URL = new URL('./vendor/rnnoise/rnnoise.wasm', import.meta.url);
const RNNOISE_WASM_SIMD_URL = new URL('./vendor/rnnoise/rnnoise_simd.wasm', import.meta.url);

let _rnnoiseSharedCtx = null;
let _rnnoiseWasmBytes = null;
let _rnnoiseWorkletReady = null;

async function _wasmSimdSupported() {
  try {
    return await WebAssembly.validate(new Uint8Array([
      0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,
      10,10,1,8,0,65,0,253,15,253,98,11,
    ]));
  } catch { return false; }
}

async function _ensureRnnoiseAssets(ctx) {
  if (!_rnnoiseWasmBytes) {
    const url = (await _wasmSimdSupported()) ? RNNOISE_WASM_SIMD_URL : RNNOISE_WASM_URL;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`RNNoise wasm fetch failed (${res.status})`);
    _rnnoiseWasmBytes = await res.arrayBuffer();
  }
  if (!_rnnoiseWorkletReady) {
    _rnnoiseWorkletReady = ctx.audioWorklet.addModule(RNNOISE_WORKLET_URL);
  }
  await _rnnoiseWorkletReady;
}

function _getMicCtx() {
  if (!_rnnoiseSharedCtx || _rnnoiseSharedCtx.state === 'closed') {
    _rnnoiseSharedCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000,
    });
  }
  return _rnnoiseSharedCtx;
}

// Track every active pipeline so settings sliders can update them live.
const _activeMicPipelines = new Set();

class MicPipeline {
  constructor(rawStream) {
    this.rawStream = rawStream;
    this.ctx = null;
    this.src = null;
    this.suppressor = null;
    this.inputGain = null;
    this.gateGain = null;
    this.analyser = null;
    this.destination = null;
    this._loop = null;
    this._buf = null;
    this._destroyed = false;
    this.usingRnnoise = false;
  }

  async build() {
    const wantRnnoise = !!state.settings.voice.rnnoise;
    this.ctx = _getMicCtx();
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch {}
    }
    if (wantRnnoise) {
      try {
        await _ensureRnnoiseAssets(this.ctx);
        this.usingRnnoise = true;
      } catch (e) {
        klog.warn('mic.rnnoise', 'asset load failed, suppressor off', { err: e.message });
      }
    }

    this.src = this.ctx.createMediaStreamSource(this.rawStream);
    this.inputGain = this.ctx.createGain();
    this.gateGain = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this._buf = new Uint8Array(this.analyser.frequencyBinCount);
    this.destination = this.ctx.createMediaStreamDestination();

    let upstream = this.src;
    if (this.usingRnnoise) {
      try {
        // wasmBinary is structured-cloned to the worklet; pass a copy.
        this.suppressor = new AudioWorkletNode(this.ctx, RNNOISE_PROCESSOR_NAME, {
          processorOptions: { maxChannels: 1, wasmBinary: _rnnoiseWasmBytes.slice(0) },
        });
        this.src.connect(this.suppressor);
        upstream = this.suppressor;
        klog.info('mic.rnnoise', 'suppressor instantiated');
      } catch (e) {
        klog.warn('mic.rnnoise', 'worklet instantiate failed', { err: e.message });
        this.usingRnnoise = false;
      }
    }

    upstream.connect(this.inputGain);
    this.inputGain.connect(this.gateGain);
    this.gateGain.connect(this.analyser);
    this.analyser.connect(this.destination);

    // Initial gain values — read live state.
    this.inputGain.gain.value = (state.settings.voice.inputVol ?? 100) / 100;
    this.gateGain.gain.value = 1;

    // Settings tick: input volume + noise gate read live so sliders take
    // effect mid-call without a teardown/rebuild. setTargetAtTime gives a
    // short ramp so the gate doesn't click open/closed.
    this._loop = setInterval(() => {
      if (this._destroyed) return;
      const inputVol = (state.settings.voice.inputVol ?? 100) / 100;
      this.inputGain.gain.setTargetAtTime(inputVol, this.ctx.currentTime, 0.01);

      const threshold = state.settings.voice.noiseGate || 0;
      if (threshold <= 0) {
        this.gateGain.gain.setTargetAtTime(1, this.ctx.currentTime, 0.005);
      } else {
        this.analyser.getByteFrequencyData(this._buf);
        let sum = 0; for (const v of this._buf) sum += v;
        const avg = sum / this._buf.length;
        const target = avg < threshold ? 0 : 1;
        this.gateGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.025);
      }
    }, 50);

    _activeMicPipelines.add(this);
    return this;
  }

  get stream() { return this.destination?.stream; }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    _activeMicPipelines.delete(this);
    if (this._loop) { clearInterval(this._loop); this._loop = null; }
    try { this.suppressor?.port.postMessage('destroy'); } catch {}
    try { this.suppressor?.disconnect(); } catch {}
    try { this.src?.disconnect(); } catch {}
    try { this.inputGain?.disconnect(); } catch {}
    try { this.gateGain?.disconnect(); } catch {}
    try { this.analyser?.disconnect(); } catch {}
  }
}

// Apply the current voice.outputVol to every <audio> element rendering a
// remote peer (active call + every mesh peer). Called when the slider
// moves so changes take effect without a renegotiation.
function applyOutputVolumeToActiveAudios() {
  const vol = Math.min(1, (state.settings.voice.outputVol ?? 100) / 100);
  try {
    if (callMgr && callMgr.remoteAudio) callMgr.remoteAudio.volume = vol;
  } catch {}
  try {
    if (state.mesh && state.mesh.peers) {
      for (const [, entry] of state.mesh.peers) {
        if (entry.remoteAudio) entry.remoteAudio.volume = vol;
      }
    }
  } catch {}
}

// Restored from 0.1.16 (the last release where calls reliably reached
// "Connected"). The textbook offer/answer flow:
//
//   Caller: send invite → wait for accept → build peer + create offer → send
//   Callee: invite arrives → ringing modal → accept → build peer + send accept
//   Caller: receive accept → build peer + create offer → send
//   Callee: receive offer → setRemoteDescription → createAnswer → send
//   Caller: receive answer → setRemoteDescription → connection establishes
//
// No perfect-negotiation gymnastics during the initial handshake. Renegotiation
// for screen-share track add/remove is handled by manually calling
// _renegotiate() (createOffer + setLocalDescription + send), which the same
// onSignal(offer) branch consumes — no onnegotiationneeded handler at all,
// which avoids glare entirely.
class CallManager {
  constructor() {
    this.pc = null;
    this.localStream = null;
    this.remoteAudio = null;
    this.callId = null;
    this.peer = null;
    this.dmId = null;
    this.isCaller = false;
    this.state = 'idle';        // idle | inviting | ringing | connecting | connected | ended
    this.startedAt = 0;
    this._pendingCandidates = [];
    this._dialingAudio = null;
    // Screen-share state (off-by-default, layered on top of the audio call).
    this.screenStream = null;
    this.screenSender = null;
    // Peer state mirror — populated by call.state messages.
    this.peerMicMuted = false;
    this.peerDeafened = false;
    this.peerSharing  = false;
    // Speaking detection state.
    this._speakCtx = null;
    this._speakLoop = 0;
    this._selfAnalyser = null;
    this._peerAnalyser = null;
  }

  // ---- Outgoing/incoming ring tone ----
  _startDialing() {
    if (this._dialingAudio) return;
    try {
      const a = new Audio('sounds/dialing.mp3');
      a.loop = true; a.volume = 0.6;
      // Track the play() promise so _stopDialing can wait for it to
      // resolve before pausing — otherwise pause() can race a still-
      // unresolved play() and the audio resumes itself when the play
      // promise lands (a real Chromium quirk).
      this._dialingAudio = a;
      this._dialingPlay = a.play();
      if (this._dialingPlay && typeof this._dialingPlay.catch === 'function') {
        this._dialingPlay.catch(() => {});
      }
    } catch {}
  }
  _stopDialing() {
    const a = this._dialingAudio;
    this._dialingAudio = null;
    if (!a) return;
    const kill = () => {
      try { a.pause(); } catch {}
      try { a.loop = false; } catch {}
      try { a.currentTime = 0; } catch {}
      // Detach the source so the resource is fully released — without
      // this, Chromium has been observed to keep looping a still-
      // referenced media element even after pause + null.
      try { a.removeAttribute('src'); a.load(); } catch {}
    };
    // Wait for any in-flight play() before pausing, then kill again
    // afterwards to cover both ordering possibilities.
    kill();
    if (this._dialingPlay && typeof this._dialingPlay.then === 'function') {
      this._dialingPlay.then(kill, kill);
    }
    this._dialingPlay = null;
  }

  // ---- Lifecycle ----
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
    this._startDialing();
    // Don't create the WebRTC offer yet — wait until callee's accept lands.
  }

  async accept() {
    if (this.state !== 'ringing') return;
    this.state = 'connecting';
    this._stopDialing();
    klog.info('call.accept', 'accepting', { call: this.callId, from: this.peer && this.peer.username });
    closeIncomingCallModal();
    showActiveCallBar(this.peer, 'Connecting…');
    try {
      // Build peer FIRST, then send accept — that way when the caller
      // receives accept and ships their offer, our pc is ready to consume it.
      await this._buildPeer();
      this._sendSignal('accept');
    } catch (e) {
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

  // ---- Incoming signals from the WS relay ----
  async onIncomingInvite(msg) {
    if (this.state !== 'idle') {
      // Auto-decline so the caller doesn't sit forever in "Calling…".
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
    playNotifySound();
    this._startDialing();
    if (window.klar && window.klar.shell && window.klar.shell.flash) {
      try { window.klar.shell.flash(); } catch {}
    }
  }

  async onAccept(msg) {
    if (this.state !== 'inviting' || msg.callId !== this.callId) return;
    klog.info('call.accept', 'remote accepted', { call: this.callId });
    this.state = 'connecting';
    this._stopDialing();
    setActiveCallState('Connecting…');
    try {
      await this._buildPeer();
      const offer = await this.pc.createOffer({ offerToReceiveAudio: true });
      await this.pc.setLocalDescription(offer);
      klog.info('call.offer', 'sent', { call: this.callId });
      this._sendSignal('signal', { kind: 'offer', sdp: offer });
    } catch (e) {
      klog.error('call.onAccept', 'offer build failed', { err: e.message });
      this._teardown('couldn\'t set up audio (' + e.message + ')');
    }
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
      klog.warn('call.signal', 'no pc yet, dropping', { kind: payload.kind, call: this.callId, state: this.state });
      return;
    }
    try {
      if (payload.kind === 'offer') {
        await this.pc.setRemoteDescription(payload.sdp);
        for (const c of this._pendingCandidates) { try { await this.pc.addIceCandidate(c); } catch {} }
        this._pendingCandidates = [];
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        klog.info('call.answer', 'sent', { call: this.callId });
        this._sendSignal('signal', { kind: 'answer', sdp: answer });
      } else if (payload.kind === 'answer') {
        await this.pc.setRemoteDescription(payload.sdp);
        for (const c of this._pendingCandidates) { try { await this.pc.addIceCandidate(c); } catch {} }
        this._pendingCandidates = [];
        klog.info('call.answer', 'received', { call: this.callId });
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

  // ---- Peer state broadcast (mute / deafen / sharing badges) ----
  broadcastState() {
    this._sendSignal('state', {
      micMuted: !!state.globalMicMuted,
      deafened: !!state.globalDeafened,
      sharing:  !!this.screenSender,
    });
  }
  onState(msg) {
    if (msg.callId !== this.callId) return;
    const p = msg.payload || {};
    this.peerMicMuted = !!p.micMuted;
    this.peerDeafened = !!p.deafened;
    this.peerSharing  = !!p.sharing;
    syncCallTiles();
  }

  // Mute/deafen are owned by state.globalMicMuted / state.globalDeafened.
  isMicMuted() { return !!state.globalMicMuted; }

  // ---- Speaking detection ----
  _startSpeakingDetection() {
    if (this._speakLoop) return;
    const tick = () => {
      // Self analyser comes from the mic pipeline (post-suppression) so
      // keystrokes don't trigger the indicator. Falls back to spinning up
      // a separate analyser only if the pipeline isn't there.
      if (!this._selfAnalyser) {
        if (this._micPipeline?.analyser) {
          this._selfAnalyser = this._micPipeline.analyser;
        } else if (this.localStream) {
          try {
            if (!this._speakCtx) this._speakCtx = new (window.AudioContext || window.webkitAudioContext)();
            const src = this._speakCtx.createMediaStreamSource(this.localStream);
            this._selfAnalyser = this._speakCtx.createAnalyser();
            this._selfAnalyser.fftSize = 512;
            src.connect(this._selfAnalyser);
          } catch {}
        }
      }
      if (this.remoteAudio && this.remoteAudio.srcObject && !this._peerAnalyser) {
        try {
          if (!this._speakCtx) this._speakCtx = new (window.AudioContext || window.webkitAudioContext)();
          const src = this._speakCtx.createMediaStreamSource(this.remoteAudio.srcObject);
          this._peerAnalyser = this._speakCtx.createAnalyser();
          this._peerAnalyser.fftSize = 512;
          src.connect(this._peerAnalyser);
        } catch {}
      }
      const speaking = (an) => {
        if (!an) return false;
        const buf = new Uint8Array(an.frequencyBinCount);
        an.getByteFrequencyData(buf);
        let sum = 0; for (const v of buf) sum += v;
        return (sum / buf.length) > 18;
      };
      const bar = _callBanner();
      if (bar) {
        const selfTile = bar.querySelector('[data-ptile-self]');
        const peerTile = bar.querySelector('[data-ptile-peer]');
        if (selfTile) selfTile.classList.toggle('speaking', !state.globalMicMuted && speaking(this._selfAnalyser));
        if (peerTile) peerTile.classList.toggle('speaking', !this.peerMicMuted && speaking(this._peerAnalyser));
      }
      this._speakLoop = requestAnimationFrame(tick);
    };
    this._speakLoop = requestAnimationFrame(tick);
  }
  _stopSpeakingDetection() {
    if (this._speakLoop) cancelAnimationFrame(this._speakLoop);
    this._speakLoop = 0;
    if (this._speakCtx) { try { this._speakCtx.close(); } catch {} this._speakCtx = null; }
    this._selfAnalyser = null;
    this._peerAnalyser = null;
  }

  // ---- Screen sharing (layered on top of the audio call) ----
  //
  // When user clicks share, we addTrack a video track to the existing pc
  // and manually renegotiate (createOffer + send). This goes through the
  // same onSignal(offer) branch on the other side, which produces an
  // answer. No glare possible because only ONE side at a time runs this
  // path (the user who clicked share).
  async startScreenShare(opts = {}) {
    if (!this.pc || this.state !== 'connected') {
      klog.warn('call.screen.start', 'not in active call');
      return false;
    }
    if (this.screenSender) {
      klog.warn('call.screen.start', 'already sharing');
      return false;
    }
    const height = Number(opts.height) || 720;
    const fps = Number(opts.fps) || 30;
    const targetW = Math.round(height * (16 / 9));

    let stream;
    if (opts.sourceId) {
      // Electron path — chromeMediaSource constraints
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: opts.sourceId,
              maxWidth: targetW, maxHeight: height, maxFrameRate: fps,
            },
          },
        });
      } catch (e) {
        klog.error('call.screen.start', 'getUserMedia(desktop) failed', { err: e.message });
        alert('Couldn\'t start screen share: ' + (e.message || e));
        return false;
      }
    } else {
      // Browser path — getDisplayMedia
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width:     { ideal: targetW, max: targetW },
            height:    { ideal: height,  max: height },
            frameRate: { ideal: fps,     max: fps },
          },
          audio: false,
        });
      } catch (e) {
        klog.info('call.screen.start', 'getDisplayMedia cancelled / failed', { err: e.message });
        return false;
      }
    }

    const track = stream.getVideoTracks()[0];
    if (!track) return false;
    this.screenStream = stream;
    this.screenSender = this.pc.addTrack(track, stream);

    // Per-resolution bitrate cap so high-res sharing stays bandwidth-friendly.
    const bitrateMap = { 360: 600_000, 480: 900_000, 720: 1_800_000, 1080: 3_500_000, 1440: 6_000_000 };
    try {
      const params = this.screenSender.getParameters();
      params.encodings = params.encodings && params.encodings.length ? params.encodings : [{}];
      params.encodings[0].maxBitrate = bitrateMap[height] || 2_000_000;
      params.encodings[0].maxFramerate = fps;
      await this.screenSender.setParameters(params);
    } catch {}

    track.onended = () => this.stopScreenShare();
    klog.info('call.screen.start', 'sharing', { call: this.callId, height, fps });
    showLocalScreenShareIndicator();
    syncScreenShareButton();
    if (this.state === 'connected') this.broadcastState();

    // Manual renegotiation — no onnegotiationneeded handler, so we do it
    // ourselves. Same path as the initial handshake (createOffer + send),
    // and the peer's onSignal(offer) branch consumes it.
    await this._renegotiate();
    return true;
  }

  async stopScreenShare() {
    if (!this.screenSender) return;
    try { this.pc.removeTrack(this.screenSender); } catch {}
    this.screenSender = null;
    if (this.screenStream) {
      for (const t of this.screenStream.getTracks()) try { t.stop(); } catch {}
      this.screenStream = null;
    }
    hideLocalScreenShareIndicator();
    syncScreenShareButton();
    if (this.state === 'connected') this.broadcastState();
    klog.info('call.screen.stop', 'stopped', { call: this.callId });
    // Renegotiate so the peer drops the dead track.
    try { await this._renegotiate(); } catch (e) { klog.warn('call.screen.stop', 'renegotiate failed', { err: e.message }); }
  }

  async _renegotiate() {
    if (!this.pc) return;
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      klog.info('call.renegotiate', 'sent', { call: this.callId });
      this._sendSignal('signal', { kind: 'offer', sdp: offer });
    } catch (e) {
      klog.error('call.renegotiate', 'failed', { err: e.message });
    }
  }

  // ---- Peer construction ----
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
    this._micRaw = await navigator.mediaDevices.getUserMedia(constraints);
    // One pipeline owns the whole mic chain (RNNoise → input gain → noise
    // gate → analyser → MediaStreamDestination) so settings sliders apply
    // live and the speaking-detection analyser sees post-suppression
    // audio (i.e. keystrokes don't light up the talking indicator).
    this._micPipeline = new MicPipeline(this._micRaw);
    try {
      await this._micPipeline.build();
      this.localStream = this._micPipeline.stream;
    } catch (e) {
      klog.warn('call.mic', 'pipeline failed, using raw mic', { err: e.message });
      try { this._micPipeline?.destroy(); } catch {}
      this._micPipeline = null;
      this.localStream = this._micRaw;
    }
    if (state.globalMicMuted) {
      for (const t of this.localStream.getAudioTracks()) t.enabled = false;
    }

    this.pc = new RTCPeerConnection(ICE_CONFIG);
    for (const track of this.localStream.getAudioTracks()) this.pc.addTrack(track, this.localStream);

    this.pc.ontrack = (e) => {
      const track = e.track;
      if (track.kind === 'audio') {
        if (!this.remoteAudio) {
          this.remoteAudio = document.createElement('audio');
          this.remoteAudio.autoplay = true;
          this.remoteAudio.style.display = 'none';
          document.body.appendChild(this.remoteAudio);
        }
        this.remoteAudio.srcObject = e.streams[0];
        this.remoteAudio.muted = state.globalDeafened;
        const out = state.settings.voice.outputDeviceId;
        if (out && this.remoteAudio.setSinkId) this.remoteAudio.setSinkId(out).catch(() => {});
        this.remoteAudio.volume = Math.min(1, state.settings.voice.outputVol / 100);
      } else if (track.kind === 'video') {
        showRemoteScreenShare(e.streams[0], this.peer);
        track.onended = () => {
          klog.info('call.screen.remote', 'remote stopped sharing', { call: this.callId });
          hideRemoteScreenShare();
        };
      }
    };

    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        this._sendSignal('signal', { kind: 'candidate', candidate: e.candidate });
        const t = e.candidate.type || 'unknown';
        if (t === 'relay' || t === 'srflx') {
          klog.info('call.ice.cand', t, { call: this.callId });
        }
      }
    };
    this.pc.oniceconnectionstatechange = () => {
      if (!this.pc) return;
      klog.info('call.ice.state', this.pc.iceConnectionState, { call: this.callId });
    };
    this.pc.onicegatheringstatechange = () => {
      if (!this.pc) return;
      klog.info('call.ice.gather', this.pc.iceGatheringState, { call: this.callId });
    };
    this.pc.onconnectionstatechange = () => {
      if (!this.pc) return;
      const s = this.pc.connectionState;
      klog.info('call.pcstate', s, { call: this.callId });
      if (s === 'connected') {
        this.state = 'connected';
        if (!this.startedAt) this.startedAt = Date.now();
        setActiveCallState('Connected');
        syncScreenShareButton();
        this.broadcastState();
        this._startSpeakingDetection();
        // Belt-and-suspenders: kill the ring tone here too. accept() and
        // onAccept() already do this, but if either path missed somehow
        // (race, exception in the middle of accept), this is the last
        // place where we know for sure the call is live.
        this._stopDialing();
        if (this._iceTimeout) { clearTimeout(this._iceTimeout); this._iceTimeout = null; }
      } else if (s === 'failed' || s === 'closed' || s === 'disconnected') {
        if (this.state !== 'ended') this._teardown('Connection lost');
      }
    };

    // ICE-failure timeout — surface a real error after 25s instead of
    // sitting forever on "Connecting…".
    if (this._iceTimeout) clearTimeout(this._iceTimeout);
    this._iceTimeout = setTimeout(() => {
      if (!this.pc || this.state === 'connected' || this.state === 'ended') return;
      const stats = { conn: this.pc.connectionState, ice: this.pc.iceConnectionState, sig: this.pc.signalingState };
      klog.error('call.timeout', 'ICE failed to connect within 25s', stats);
      this._teardown('Connection failed (NAT/firewall — try again or both connect to the same network)');
    }, 25_000);
  }

  // ---- WS signaling helpers ----
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
    // Play a short descending tone whenever a connected call ends (any
    // reason). For never-connected calls (e.g. cancelled before pickup)
    // the dialing sound's stop is feedback enough; skip the tone.
    if (this.state === 'connected') playDisconnectSound();
    this.state = 'ended';
    this._stopDialing();
    this._stopSpeakingDetection();
    if (this._iceTimeout) { clearTimeout(this._iceTimeout); this._iceTimeout = null; }
    if (this._micPipeline) { try { this._micPipeline.destroy(); } catch {} this._micPipeline = null; }
    if (this._micRaw && this._micRaw !== this.localStream) {
      for (const t of this._micRaw.getTracks()) try { t.stop(); } catch {}
    }
    this._micRaw = null;
    if (this.screenStream) {
      for (const t of this.screenStream.getTracks()) try { t.stop(); } catch {}
      this.screenStream = null;
    }
    this.screenSender = null;
    hideLocalScreenShareIndicator();
    hideRemoteScreenShare();
    this.peerMicMuted = false;
    this.peerDeafened = false;
    this.peerSharing  = false;
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

// ===========================================================================
// MeshSession — multi-party voice (voice channels + group DM calls)
// ===========================================================================
//
// Architecture: each pair of participants in the room maintains its own
// RTCPeerConnection (full mesh). Server tracks room membership in memory
// (`rooms` Map keyed by roomId) and relays member-joined/-left events.
// The renderer creates a pc to each existing peer when joining, and
// receives offers from new peers as they arrive.
//
// This is a deliberately simple SFU-less design: scales fine to ~6
// people on a residential connection. Beyond that we'd want a media
// server (mediasoup, livekit) — out of scope for now.

class MeshSession extends EventTarget {
  constructor() {
    super();
    this.roomId = null;
    this.kind = null;        // 'voice-channel' | 'group-call'
    this.scope = null;       // channelId for voice-channel, chatId for group-call
    this.peers = new Map();  // peerUserId -> { pc, remoteAudio, candidates: [] }
    this.localStream = null;
    this.state = 'idle';     // idle | joining | connected | leaving
  }

  async join(roomId, kind, scope) {
    if (this.state !== 'idle') {
      klog.warn('mesh.join', 'already in a room', { state: this.state });
      return false;
    }
    this.roomId = roomId;
    this.kind = kind;
    this.scope = scope;
    this.state = 'joining';
    klog.info('mesh.join', 'joining', { room: roomId, kind });

    const v = state.settings.voice;
    try {
      this._rawStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: v.inputDeviceId ? { exact: v.inputDeviceId } : undefined,
          noiseSuppression: !!v.noiseSuppression,
          echoCancellation: !!v.echoCancellation,
          autoGainControl:  !!v.autoGain,
        },
        video: false,
      });
    } catch (e) {
      klog.error('mesh.join', 'getUserMedia failed', { err: e.message });
      this.state = 'idle';
      alert('Could not access microphone: ' + (e.message || e));
      return false;
    }
    this._micPipeline = new MicPipeline(this._rawStream);
    try {
      await this._micPipeline.build();
      this.localStream = this._micPipeline.stream;
    } catch (e) {
      klog.warn('mesh.mic', 'pipeline failed, using raw mic', { err: e.message });
      try { this._micPipeline?.destroy(); } catch {}
      this._micPipeline = null;
      this.localStream = this._rawStream;
    }
    if (state.globalMicMuted) for (const t of this.localStream.getAudioTracks()) t.enabled = false;

    if (!state.realtime || !state.realtime.send({ type: 'room.join', roomId })) {
      this._teardown();
      alert('Lost connection to server, can\'t join voice room.');
      return false;
    }
    state.mesh = this;
    return true;
  }

  // Server told us who's already here. Build pcs to each, sending offers.
  async onJoined(msg) {
    if (msg.roomId !== this.roomId) return;
    klog.info('mesh.joined', `${msg.members.length} existing peers`, { room: this.roomId });
    this.state = 'connected';
    for (const peerId of msg.members) {
      try { await this._createPeer(peerId, /* createOffer */ true); }
      catch (e) { klog.error('mesh.peer', 'create failed', { peer: peerId, err: e.message }); }
    }
    this.dispatchEvent(new CustomEvent('changed'));
  }

  // A new peer joined AFTER us. They will create the offer (impolite
  // role); we just wait for it via onSignal('offer').
  onMemberJoined(msg) {
    if (msg.roomId !== this.roomId) return;
    klog.info('mesh.peer-joined', 'incoming peer', { peer: msg.userId });
    this.dispatchEvent(new CustomEvent('changed'));
  }

  onMemberLeft(msg) {
    if (msg.roomId !== this.roomId) return;
    const entry = this.peers.get(msg.userId);
    if (entry) {
      try { entry.pc.close(); } catch {}
      try { if (entry.remoteAudio) entry.remoteAudio.remove(); } catch {}
      this.peers.delete(msg.userId);
    }
    klog.info('mesh.peer-left', 'peer dropped', { peer: msg.userId, remaining: this.peers.size });
    this.dispatchEvent(new CustomEvent('changed'));
  }

  // call.signal arrived from a specific peer. Apply via the per-peer pc.
  async onSignal(msg) {
    const peerId = msg.fromUserId;
    if (!peerId) return;
    const payload = msg.payload || {};
    let entry = this.peers.get(peerId);
    if (!entry) {
      // First signal from this peer (likely an offer from a late joiner
      // that we hadn't yet made a pc for). Build the receive-side pc.
      if (payload.kind !== 'offer' && payload.kind !== 'candidate') return;
      try { await this._createPeer(peerId, /* createOffer */ false); }
      catch (e) { klog.error('mesh.signal', 'lazy create failed', { err: e.message }); return; }
      entry = this.peers.get(peerId);
      if (!entry) return;
    }
    const pc = entry.pc;
    try {
      if (payload.kind === 'offer') {
        await pc.setRemoteDescription(payload.sdp);
        for (const c of entry.candidates) { try { await pc.addIceCandidate(c); } catch {} }
        entry.candidates = [];
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this._sendSignal(peerId, { kind: 'answer', sdp: answer });
      } else if (payload.kind === 'answer') {
        await pc.setRemoteDescription(payload.sdp);
        for (const c of entry.candidates) { try { await pc.addIceCandidate(c); } catch {} }
        entry.candidates = [];
      } else if (payload.kind === 'candidate' && payload.candidate) {
        if (pc.remoteDescription && pc.remoteDescription.type) {
          try { await pc.addIceCandidate(payload.candidate); } catch {}
        } else {
          entry.candidates.push(payload.candidate);
        }
      }
    } catch (e) {
      klog.error('mesh.signal', 'apply failed', { peer: peerId, kind: payload.kind, err: e.message });
    }
  }

  async leave() {
    if (this.state === 'idle') return;
    klog.info('mesh.leave', 'leaving', { room: this.roomId });
    const wasScope = this.scope;
    if (state.realtime) state.realtime.send({ type: 'room.leave', roomId: this.roomId });
    this._teardown();
    hideActiveCallBar(null);
    // Refresh the channel sidebar so the "joined" indicator drops.
    if (state.view.kind === 'server') renderChannelList(state.view.serverId);
  }

  async _createPeer(peerId, createOffer) {
    const pc = new RTCPeerConnection(ICE_CONFIG);
    for (const t of this.localStream.getAudioTracks()) pc.addTrack(t, this.localStream);
    const entry = { pc, remoteAudio: null, candidates: [] };
    this.peers.set(peerId, entry);

    pc.ontrack = (e) => {
      if (!entry.remoteAudio) {
        entry.remoteAudio = document.createElement('audio');
        entry.remoteAudio.autoplay = true;
        entry.remoteAudio.style.display = 'none';
        document.body.appendChild(entry.remoteAudio);
      }
      entry.remoteAudio.srcObject = e.streams[0];
      entry.remoteAudio.muted = state.globalDeafened;
      const out = state.settings.voice.outputDeviceId;
      if (out && entry.remoteAudio.setSinkId) entry.remoteAudio.setSinkId(out).catch(() => {});
      entry.remoteAudio.volume = Math.min(1, state.settings.voice.outputVol / 100);
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) this._sendSignal(peerId, { kind: 'candidate', candidate: e.candidate });
    };
    pc.onconnectionstatechange = () => {
      klog.info('mesh.pcstate', pc.connectionState, { peer: peerId });
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        // Don't tear down the whole session — just this one peer.
        this.peers.delete(peerId);
        try { entry.remoteAudio && entry.remoteAudio.remove(); } catch {}
        this.dispatchEvent(new CustomEvent('changed'));
      }
    };
    if (createOffer) {
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      this._sendSignal(peerId, { kind: 'offer', sdp: offer });
    }
  }

  _sendSignal(peerId, payload) {
    if (!state.realtime) return;
    state.realtime.send({
      type: 'call.signal',
      toUserId: peerId,
      callId: this.roomId,
      payload,
    });
  }

  _teardown() {
    // Disconnect tone if we were actually in a room.
    if (this.state === 'joining' || this.state === 'connected' || this.peers.size > 0) {
      playDisconnectSound();
    }
    for (const [, entry] of this.peers) {
      try { entry.pc.close(); } catch {}
      try { if (entry.remoteAudio) entry.remoteAudio.remove(); } catch {}
    }
    this.peers.clear();
    if (this._micPipeline) { try { this._micPipeline.destroy(); } catch {} this._micPipeline = null; }
    if (this._rawStream) {
      for (const t of this._rawStream.getTracks()) try { t.stop(); } catch {}
      this._rawStream = null;
    }
    if (this.localStream) {
      for (const t of this.localStream.getTracks()) try { t.stop(); } catch {}
      this.localStream = null;
    }
    this.roomId = null;
    this.kind = null;
    this.scope = null;
    this.state = 'idle';
    if (state.mesh === this) state.mesh = null;
    this.dispatchEvent(new CustomEvent('changed'));
  }

  // Apply mute/deafen toggles to our peers.
  applyMute() {
    if (this.localStream) for (const t of this.localStream.getAudioTracks()) t.enabled = !state.globalMicMuted;
  }
  applyDeafen() {
    for (const [, entry] of this.peers) {
      if (entry.remoteAudio) entry.remoteAudio.muted = state.globalDeafened;
    }
  }
}

const meshSession = new MeshSession();

// --- Active-call banner (Discord-style, top of the DM messages area) -------
//
// Single banner element lives inside [data-chat-active] in tpl-app. We keep
// a per-banner timer ref + tick interval ref so successive show/hide cycles
// can cancel pending hides — this fixes the "call window doesn't close"
// bug where a delayed reason-text-then-hide setTimeout from a previous call
// would land after the next call had started, hiding the new banner.

let _callHideTimer = null;
let _callTickTimer = null;

function _callBanner() {
  return document.querySelector('[data-call-banner]');
}

function showActiveCallBar(peer, stateText) {
  const bar = _callBanner();
  if (!bar) return;
  // Cancel any pending hide from a previous call's teardown.
  if (_callHideTimer) { clearTimeout(_callHideTimer); _callHideTimer = null; }
  bar.classList.remove('hidden');
  // Paint the peer tile (data-ptile-peer) + the self tile (data-ptile-self).
  const peerTile = bar.querySelector('[data-ptile-peer]');
  const selfTile = bar.querySelector('[data-ptile-self]');
  if (peerTile) {
    paintAvatar(peerTile.querySelector('.avatar'), peer);
    if (!peerTile.dataset.ctxWired) {
      peerTile.dataset.ctxWired = '1';
      peerTile.addEventListener('contextmenu', (e) => {
        if (!callMgr.peer) return;
        e.preventDefault();
        openCallPeerContextMenu(e.clientX, e.clientY, callMgr.peer);
      });
    }
  }
  if (selfTile && state.user) paintAvatar(selfTile.querySelector('.avatar'), state.user);
  const peerNameEl = bar.querySelector('[data-call-peer-name]');
  if (peerNameEl) peerNameEl.textContent = peer.displayName || peer.username || '—';
  const stateEl = bar.querySelector('[data-call-state]');
  if (stateEl) stateEl.textContent = stateText || 'Connecting…';
  syncActiveCallControls();
  syncCallTiles();

  // Wire the peer-jump button + control buttons exactly once each.
  const jump = bar.querySelector('[data-call-banner-jump]');
  if (jump && !jump.dataset.wired) {
    jump.dataset.wired = '1';
    jump.title = 'Jump to ' + (peer.displayName || peer.username || 'this DM');
    jump.addEventListener('click', () => {
      if (callMgr.dmId) {
        switchView({ kind: 'home' });
        setTimeout(() => openDm(callMgr.dmId), 30);
      }
    });
  }
  bar.querySelectorAll('[data-call-ctrl]').forEach((b) => {
    if (b.dataset.wired) return;
    b.dataset.wired = '1';
    b.addEventListener('click', () => {
      // Banner buttons share state with the me-bar buttons — both use the
      // single source of truth (state.globalMicMuted / state.globalDeafened)
      // so the icons can never disagree, and undeafen never leaves the mic
      // stuck-muted.
      if (b.dataset.callCtrl === 'mute')        toggleGlobalMic();
      else if (b.dataset.callCtrl === 'deafen') toggleGlobalDeafen();
      else if (b.dataset.callCtrl === 'screen') {
        if (callMgr.screenSender) callMgr.stopScreenShare();
        else openScreenShareModal();
      }
      else if (b.dataset.callCtrl === 'hangup') {
        // If we're in a 1:1 call, hang it up. If we're in a mesh room
        // (voice channel / group call), leave that instead. Both sets
        // are mutually exclusive in practice.
        if (callMgr.state && callMgr.state !== 'idle') callMgr.hangup();
        else if (state.mesh) {
          meshSession.leave();
          hideActiveCallBar('Left voice channel');
          if (state.view.kind === 'server') renderChannelList(state.view.serverId);
        }
      }
    });
  });

  // Live timer when connected. Restarted whenever the state changes to
  // "Connected" via setActiveCallState.
  if (_callTickTimer) { clearInterval(_callTickTimer); _callTickTimer = null; }
}

function setActiveCallState(text) {
  const bar = _callBanner();
  if (!bar) return;
  const el = bar.querySelector('[data-call-state]');
  if (el) el.textContent = text;
  // When we transition into Connected, start the live duration counter.
  if (text === 'Connected') {
    if (_callTickTimer) clearInterval(_callTickTimer);
    _callTickTimer = setInterval(() => {
      if (!callMgr.startedAt || callMgr.state !== 'connected') return;
      const sec = Math.floor((Date.now() - callMgr.startedAt) / 1000);
      const mm = String(Math.floor(sec / 60)).padStart(2, '0');
      const ss = String(sec % 60).padStart(2, '0');
      const el2 = _callBanner() && _callBanner().querySelector('[data-call-state]');
      if (el2) el2.textContent = `In call · ${mm}:${ss}`;
    }, 1000);
  }
}

function syncCallTiles() {
  const bar = _callBanner();
  if (!bar) return;
  // Self badge: red mic-off if muted; if also deafened, append a small
  // headphones-off glyph as a sibling marker. Showing both communicates the
  // exact state without a custom badge per combo.
  const selfMute = bar.querySelector('[data-self-mute]');
  if (selfMute) {
    const muted = !!state.globalMicMuted;
    const deaf  = !!state.globalDeafened;
    selfMute.hidden = !(muted || deaf);
    selfMute.innerHTML = '';
    if (muted) selfMute.appendChild(svgIcon('klar-mic-off', 12));
    if (deaf)  selfMute.appendChild(svgIcon('klar-phone-off', 12));
  }
  // Peer badge — populated from call.state broadcasts.
  const peerMute = bar.querySelector('[data-peer-mute]');
  if (peerMute) {
    const muted = !!callMgr.peerMicMuted;
    const deaf  = !!callMgr.peerDeafened;
    peerMute.hidden = !(muted || deaf);
    peerMute.innerHTML = '';
    if (muted) peerMute.appendChild(svgIcon('klar-mic-off', 12));
    if (deaf)  peerMute.appendChild(svgIcon('klar-phone-off', 12));
  }
}

function syncActiveCallControls() {
  const bar = _callBanner();
  if (!bar) return;
  const muteBtn   = bar.querySelector('[data-call-ctrl="mute"]');
  const deafenBtn = bar.querySelector('[data-call-ctrl="deafen"]');
  if (muteBtn) {
    const muted = !!state.globalMicMuted;
    muteBtn.classList.toggle('active', muted);
    muteBtn.title = muted ? 'Unmute' : 'Mute';
    muteBtn.innerHTML = '';
    muteBtn.appendChild(svgIcon(muted ? 'klar-mic-off' : 'klar-mic', 16));
  }
  if (deafenBtn) {
    const deaf = !!state.globalDeafened;
    deafenBtn.classList.toggle('active', deaf);
    deafenBtn.title = deaf ? 'Undeafen' : 'Deafen';
    deafenBtn.innerHTML = '';
    deafenBtn.appendChild(svgIcon(deaf ? 'klar-phone-off' : 'klar-headphones', 16));
  }
}

// --- Screen share UI ------------------------------------------------------
//
// Three pieces:
//   1. A button in the call banner that opens a small popover (resolution
//      + fps) and starts/stops sharing.
//   2. A "you're sharing" indicator pill in the banner while local share
//      is active.
//   3. A floating viewer (bottom-right of the chat area) that renders the
//      remote peer's screen when they share.

function syncScreenShareButton() {
  const bar = _callBanner();
  if (!bar) return;
  const btn = bar.querySelector('[data-call-ctrl="screen"]');
  if (!btn) return;
  const sharing = !!callMgr.screenSender;
  btn.classList.toggle('active', sharing);
  btn.title = sharing ? 'Stop sharing screen' : 'Share screen';
  btn.disabled = callMgr.state !== 'connected';
}

// Show or hide the local-screen tile inside the call view. The video
// element is always in the DOM (it just stays hidden); this lets us
// attach the stream once and toggle visibility cheaply.
function showLocalScreenShareIndicator() {
  const bar = _callBanner();
  if (!bar) return;
  const tilesWrap = bar.querySelector('[data-screen-tiles]');
  const localTile = bar.querySelector('[data-local-screen-tile]');
  const localVid  = bar.querySelector('[data-local-screen]');
  if (!tilesWrap || !localTile || !localVid) return;
  if (callMgr.screenStream) localVid.srcObject = callMgr.screenStream;
  tilesWrap.hidden = false;
  localTile.classList.remove('hidden');
  wireScreenTileFullscreen(localTile, localVid);
  syncStageMode();
}
function hideLocalScreenShareIndicator() {
  const bar = _callBanner();
  if (!bar) return;
  const localTile = bar.querySelector('[data-local-screen-tile]');
  const localVid  = bar.querySelector('[data-local-screen]');
  if (!localTile || !localVid) return;
  try { localVid.srcObject = null; } catch {}
  localTile.classList.add('hidden');
  syncStageMode();
}

function showRemoteScreenShare(stream, peer) {
  const bar = _callBanner();
  if (!bar) return;
  const tilesWrap = bar.querySelector('[data-screen-tiles]');
  const tile = bar.querySelector('[data-remote-screen-tile]');
  const vid  = bar.querySelector('[data-remote-screen]');
  const lbl  = bar.querySelector('[data-remote-screen-label]');
  if (!tilesWrap || !tile || !vid) return;
  vid.srcObject = stream;
  if (lbl) lbl.textContent = (peer && (peer.displayName || peer.username)) || 'Peer screen';
  tilesWrap.hidden = false;
  tile.classList.remove('hidden');
  wireScreenTileFullscreen(tile, vid);
  syncStageMode();
}

// Right-click on a peer's tile in the active-call banner. Currently
// surfaces a per-call volume slider that scales the remote audio element
// directly — settings.voice.outputVol still controls the master, this
// just lets the user quiet a single loud peer mid-call.
function openCallPeerContextMenu(x, y, peer) {
  const audio = callMgr && callMgr.remoteAudio;
  const masterVol = (state.settings.voice.outputVol ?? 100) / 100;
  // The audio element's .volume is 0..1. We render a 0..200% slider so the
  // user can boost above the master setting (capped at 1.0 internally —
  // beyond that would need a Web Audio gain node we don't have here).
  const startPct = audio ? Math.round(audio.volume / Math.max(0.01, masterVol) * 100) : 100;
  openContextMenu(x, y, [
    { label: peer.displayName || peer.username || 'Peer', disabled: true },
    { divider: true },
    {
      slider: {
        label: 'User volume',
        min: 0, max: 200, value: Math.min(200, Math.max(0, startPct)),
        format: (v) => v + '%',
        onInput: (v) => {
          if (!callMgr || !callMgr.remoteAudio) return;
          const target = Math.min(1, masterVol * (v / 100));
          callMgr.remoteAudio.volume = target;
        },
      },
    },
    { divider: true },
    {
      label: 'View profile',
      icon: 'klar-user',
      onClick: () => openProfileModal(peer),
    },
  ]);
}

// Fullscreen affordance for a screen-share tile: hover-revealed corner
// button + double-click + 'F' keyboard shortcut while the tile is the
// active hover target. Idempotent — second invocation on the same tile
// skips re-wiring.
function wireScreenTileFullscreen(tile, vid) {
  if (tile.dataset.fsWired === '1') return;
  tile.dataset.fsWired = '1';
  const btn = tile.querySelector('[data-screen-fs]');
  const enterIcon = btn?.querySelector('[data-fs-enter]');
  const exitIcon  = btn?.querySelector('[data-fs-exit]');
  const toggle = (e) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else vid.requestFullscreen().catch((err) => klog.warn('screen.fs', 'requestFullscreen failed', { err: err.message }));
  };
  if (btn) btn.addEventListener('click', toggle);
  vid.addEventListener('dblclick', toggle);
  document.addEventListener('fullscreenchange', () => {
    const inFs = document.fullscreenElement === vid;
    if (enterIcon) enterIcon.hidden = inFs;
    if (exitIcon)  exitIcon.hidden  = !inFs;
  });
}
function hideRemoteScreenShare() {
  const bar = _callBanner();
  if (!bar) return;
  const tile = bar.querySelector('[data-remote-screen-tile]');
  const vid  = bar.querySelector('[data-remote-screen]');
  if (!tile || !vid) return;
  try { vid.srcObject = null; } catch {}
  tile.classList.add('hidden');
  syncStageMode();
}

// Decide which mode the stage shows: participant tiles (default) or
// screen tiles (when either side is sharing). When screen tiles are
// visible, hide the participant tiles to give the videos full real estate.
function syncStageMode() {
  const bar = _callBanner();
  if (!bar) return;
  const tilesWrap = bar.querySelector('[data-screen-tiles]');
  const ptiles    = bar.querySelector('[data-call-tiles]');
  const localOn   = bar.querySelector('[data-local-screen-tile]') && !bar.querySelector('[data-local-screen-tile]').classList.contains('hidden');
  const remoteOn  = bar.querySelector('[data-remote-screen-tile]') && !bar.querySelector('[data-remote-screen-tile]').classList.contains('hidden');
  const anyScreen = localOn || remoteOn;
  if (tilesWrap) tilesWrap.hidden = !anyScreen;
  if (ptiles)    ptiles.style.display = anyScreen ? 'none' : '';
}

// Custom screen-share picker. Two-pane modal:
//   left  = thumbnails of every screen + window the OS exposes
//   right = resolution + fps + selected source preview, with "Start sharing"
// In Electron we get the source list via window.klar.screen.sources();
// in a regular browser tab we skip the picker entirely and let the browser
// show its own (via getDisplayMedia).
async function openScreenShareModal() {
  const isElectronShell = !!(window.klar && window.klar.shell && window.klar.shell.isAvailable);
  const hasScreenIPC   = !!(window.klar && window.klar.screen && typeof window.klar.screen.sources === 'function');

  // Browser path or Electron-without-the-screen-IPC. The latter happens
  // when the user is on an MSI built before the screen-sources IPC was
  // added (the renderer auto-updates from GitHub but main.cjs/preload.cjs
  // are baked into the EXE). Try getDisplayMedia anyway and surface a
  // clear error so the user knows to reinstall.
  if (!hasScreenIPC) {
    const ss = state.settings.screenShare;
    try {
      const ok = await callMgr.startScreenShare({ height: ss.height, fps: ss.fps });
      if (!ok && isElectronShell) {
        alert(
          'Screen share failed.\n\n' +
          'Your installed Klar is from before the screen-share IPC was added. ' +
          'Reinstall the latest MSI from dist/ to get the system picker.'
        );
      }
    } catch (e) {
      alert('Screen share failed: ' + (e.message || e) +
            (isElectronShell ? '\n\nReinstall the latest MSI to fix this.' : ''));
    }
    return;
  }

  // Build the modal DOM directly (no template — lots of dynamic content).
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.dataset.modal = '1';
  backdrop.innerHTML = `
    <div class="modal screen-picker-modal">
      <div class="screen-picker-head">
        <h2>Share your screen</h2>
        <button class="settings-close" data-action="cancel" title="Close" aria-label="Close">
          <svg width="14" height="14"><use href="#klar-x"/></svg>
        </button>
      </div>
      <div class="screen-picker-body">
        <div class="sp-tabs">
          <button class="sp-tab active" data-tab="screen">Entire screen</button>
          <button class="sp-tab"        data-tab="window">Window</button>
        </div>
        <div class="sp-grid" data-sp-grid>
          <div class="muted small">Loading sources…</div>
        </div>
      </div>
      <div class="screen-picker-foot">
        <div class="sp-section sp-inline">
          <div class="sp-label">Resolution</div>
          <div class="sp-row" data-sp-resolutions></div>
        </div>
        <div class="sp-section sp-inline">
          <div class="sp-label">FPS</div>
          <div class="sp-row" data-sp-fps></div>
        </div>
        <div class="sp-spacer"></div>
        <button class="ghost" data-action="cancel">Cancel</button>
        <button data-sp-start disabled>Share</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelectorAll('[data-action="cancel"]').forEach((b) => b.addEventListener('click', close));

  const ss = state.settings.screenShare;
  const grid = backdrop.querySelector('[data-sp-grid]');
  const startBtn = backdrop.querySelector('[data-sp-start]');
  let chosenSource = null;

  // Resolution + fps pickers (same pill style as before).
  const resRow = backdrop.querySelector('[data-sp-resolutions]');
  for (const h of [360, 480, 720, 1080, 1440]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sp-pill' + (h === ss.height ? ' active' : '');
    b.textContent = h + 'p';
    b.addEventListener('click', () => {
      ss.height = h; saveSettings();
      resRow.querySelectorAll('.sp-pill').forEach((x) => x.classList.toggle('active', x === b));
    });
    resRow.appendChild(b);
  }
  const fpsRow = backdrop.querySelector('[data-sp-fps]');
  for (const f of [15, 30, 60]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sp-pill' + (f === ss.fps ? ' active' : '');
    b.textContent = f;
    b.addEventListener('click', () => {
      ss.fps = f; saveSettings();
      fpsRow.querySelectorAll('.sp-pill').forEach((x) => x.classList.toggle('active', x === b));
    });
    fpsRow.appendChild(b);
  }

  // Tab switching (filter sources by kind).
  const tabs = backdrop.querySelectorAll('.sp-tab');
  let currentTab = 'screen';
  let allSources = [];
  const renderGrid = () => {
    grid.innerHTML = '';
    const filtered = allSources.filter((s) => s.kind === currentTab);
    if (!filtered.length) {
      grid.innerHTML = '<div class="muted small">No ' + currentTab + 's found.</div>';
      return;
    }
    for (const s of filtered) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'sp-card' + (chosenSource && chosenSource.id === s.id ? ' active' : '');
      card.innerHTML = `<img alt="" /><div class="sp-card-name"></div>`;
      card.querySelector('img').src = s.thumbnail;
      card.querySelector('.sp-card-name').textContent = s.name;
      card.addEventListener('click', () => {
        chosenSource = s;
        startBtn.disabled = false;
        grid.querySelectorAll('.sp-card').forEach((c) => c.classList.toggle('active', c === card));
      });
      grid.appendChild(card);
    }
  };
  tabs.forEach((t) => t.addEventListener('click', () => {
    tabs.forEach((x) => x.classList.toggle('active', x === t));
    currentTab = t.dataset.tab;
    chosenSource = null;
    startBtn.disabled = true;
    renderGrid();
  }));

  // Fetch sources.
  try {
    allSources = await window.klar.screen.sources();
    renderGrid();
  } catch (e) {
    grid.innerHTML = '<div class="muted small">Failed to list sources: ' + (e.message || 'error') + '</div>';
  }

  startBtn.addEventListener('click', async () => {
    if (!chosenSource) return;
    startBtn.disabled = true;
    const ok = await callMgr.startScreenShare({
      height: ss.height,
      fps: ss.fps,
      sourceId: chosenSource.id,
    });
    if (ok) close();
    else startBtn.disabled = false;
  });
}

function hideActiveCallBar(reasonText) {
  const bar = _callBanner();
  if (!bar) return;
  // Always cancel any prior pending hide/tick — successive teardowns must
  // not double-schedule.
  if (_callHideTimer) { clearTimeout(_callHideTimer); _callHideTimer = null; }
  if (_callTickTimer) { clearInterval(_callTickTimer); _callTickTimer = null; }
  if (reasonText) {
    setActiveCallState(reasonText);
    _callHideTimer = setTimeout(() => {
      bar.classList.add('hidden');
      _callHideTimer = null;
    }, 1500);
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
// Hotkeys: small global keydown listener that translates a key combo string
// (e.g. "Ctrl+Shift+KeyM") to a call action. Bindings live in settings and
// are editable via the Voice tab.
// ===========================================================================

function comboFromEvent(e) {
  const parts = [];
  if (e.ctrlKey)  parts.push('Ctrl');
  if (e.altKey)   parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey)  parts.push('Meta');
  if (!e.code) return null;
  // Bare modifier key alone isn't a useful binding.
  if (/^(Control|Shift|Alt|Meta)/.test(e.code)) return null;
  parts.push(e.code);
  return parts.join('+');
}
function comboToLabel(combo) {
  if (!combo) return '(unbound)';
  return combo
    .replace(/Ctrl/g,  navigator.platform.includes('Mac') ? '⌃' : 'Ctrl')
    .replace(/Shift/g, '⇧')
    .replace(/Alt/g,   navigator.platform.includes('Mac') ? '⌥' : 'Alt')
    .replace(/Meta/g,  navigator.platform.includes('Mac') ? '⌘' : 'Win')
    .replace(/Key/g, '')
    .replace(/Digit/g, '')
    .replace(/\+/g, ' + ');
}

function setupHotkeys() {
  document.addEventListener('keydown', (e) => {
    const combo = comboFromEvent(e);
    if (!combo) return;
    const hk = state.settings && state.settings.hotkeys;
    if (!hk) return;
    let action = null;
    for (const k of Object.keys(hk)) {
      if (hk[k] === combo) { action = k; break; }
    }
    if (!action) return;
    // Only mute/deafen are useful outside an active call (you can prep
    // before answering); hangup + screen are no-ops without a call.
    if (action === 'mute')   { e.preventDefault(); toggleGlobalMic(); }
    else if (action === 'deafen') { e.preventDefault(); toggleGlobalDeafen(); }
    else if (action === 'hangup') { if (callMgr.state !== 'idle') { e.preventDefault(); callMgr.hangup(); } }
    else if (action === 'screen') {
      if (callMgr.state === 'connected') {
        e.preventDefault();
        if (callMgr.screenSender) callMgr.stopScreenShare();
        else openScreenShareModal();
      }
    }
  });
}

// ===========================================================================
// New-message notifications: native OS notification (Windows toast in
// Electron / browser notification on the web) + audio cue. Clicking the
// notification focuses the window and opens the DM.
//
// Sound is bundled at public/sounds/notify.mp3. We play it ourselves with an
// Audio element + pass `silent:true` to the OS notification so we don't get
// the OS default ding on top.
// ===========================================================================

let _notifyAudio = null;
let _notifyPermissionAsked = false;
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
  try {
    const c = a.cloneNode();
    c.volume = a.volume;
    c.play().catch(() => {});
  } catch {
    a.currentTime = 0; a.play().catch(() => {});
  }
}

// Synthesised "call ended" tone — two descending notes, ~280 ms total.
// Generated with Web Audio so we don't need to ship another mp3 and so
// the same code runs with no audio asset. Volume tracks the notification
// sound slider.
function playDisconnectSound() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const vol = Math.max(0, Math.min(1, ((state.settings?.notifications?.soundVolume) || 80) / 100)) * 0.4;
    const now = ctx.currentTime;
    const beep = (freq, start, dur) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, now + start);
      g.gain.exponentialRampToValueAtTime(vol, now + start + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
      osc.connect(g); g.connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + dur + 0.05);
    };
    beep(587.33, 0,     0.16); // D5
    beep(440.00, 0.14,  0.22); // A4
    setTimeout(() => { try { ctx.close(); } catch {} }, 600);
  } catch {}
}

// Lazy permission request — only the first time a notification would fire.
// In Electron the permission is granted by default; in a browser tab the
// user gets the OS prompt. We never block on the answer; the worst case
// is a missed first notification.
function ensureNotifyPermission() {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'granted' || Notification.permission === 'denied') return;
  if (_notifyPermissionAsked) return;
  _notifyPermissionAsked = true;
  try { Notification.requestPermission().catch(() => {}); } catch {}
}

function showDmNotification(dm, message) {
  const n = state.settings && state.settings.notifications;
  if (!n || !n.enabled) return;
  // Don't notify if the user is already looking at this DM (and hasn't
  // explicitly opted in to "notify when focused").
  if (_windowFocused && state.activeDmId === message.dmId && !n.showWhenFocused) return;

  ensureNotifyPermission();
  playNotifySound();

  const peer = dm.other || userById(message.senderId) || { username: '?' , displayName: 'Someone' };
  const title = peer.displayName || peer.username || 'Direct message';
  let body = (message.content || '').trim();
  if (!body && message.attachments && message.attachments.length) {
    body = '[attachment: ' + (message.attachments[0].name || 'file') + ']';
  }
  if (body.length > 200) body = body.slice(0, 197) + '…';
  if (!body) body = '(new message)';

  const open = () => {
    try { window.focus(); } catch {}
    if (window.klar && window.klar.shell && window.klar.shell.show) {
      try { window.klar.shell.show(); } catch {}
    }
    switchView({ kind: 'home' });
    setTimeout(() => openDm(message.dmId), 30);
  };

  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      const note = new Notification(title, {
        body,
        silent: true,           // we play notify.mp3 ourselves, don't double-ding
        tag: 'klar-dm-' + message.dmId, // collapse rapid notifications per DM
        renotify: true,
      });
      note.onclick = () => { open(); try { note.close(); } catch {} };
    } catch {
      // Some browsers throw if Notification was constructed too early.
    }
  }

  // Flash the taskbar so background callers in Electron get attention even
  // if the OS toast was missed (e.g. focus assist on).
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
  state.realtime.addEventListener('channel_updated',     (e) => onRemoteChannelUpdated(e.detail.channel));
  state.realtime.addEventListener('channel_deleted',     (e) => onRemoteChannelDeleted(e.detail));
  state.realtime.addEventListener('message_deleted',         (e) => onRemoteMessageDeleted(e.detail));
  state.realtime.addEventListener('channel_message_deleted', (e) => onRemoteChannelMessageDeleted(e.detail));
  state.realtime.addEventListener('block_updated',       (e) => onRemoteBlockUpdated(e.detail));
  state.realtime.addEventListener('server_member_joined',(e) => onRemoteMemberJoined(e.detail));
  state.realtime.addEventListener('server_member_left',  (e) => onRemoteMemberLeft(e.detail));
  state.realtime.addEventListener('server_deleted',      (e) => onRemoteServerDeleted(e.detail));
  state.realtime.addEventListener('call.invite',         (e) => callMgr.onIncomingInvite(e.detail));
  state.realtime.addEventListener('call.accept',         (e) => callMgr.onAccept(e.detail));
  state.realtime.addEventListener('call.decline',        (e) => callMgr.onDecline(e.detail));
  state.realtime.addEventListener('call.signal',         (e) => {
    // Disambiguate: if we're in a mesh room and the callId matches the
    // mesh roomId, route to mesh. Else route to the 1:1 CallManager.
    const detail = e.detail;
    if (state.mesh && state.mesh.roomId && detail.callId === state.mesh.roomId) {
      meshSession.onSignal(detail);
    } else {
      callMgr.onSignal(detail);
    }
  });
  state.realtime.addEventListener('call.hangup',         (e) => callMgr.onHangup(e.detail));
  state.realtime.addEventListener('call.state',          (e) => callMgr.onState(e.detail));

  // Mesh room events (group calls + voice channels)
  state.realtime.addEventListener('room.joined',         (e) => meshSession.onJoined(e.detail));
  state.realtime.addEventListener('room.member-joined',  (e) => meshSession.onMemberJoined(e.detail));
  state.realtime.addEventListener('room.member-left',    (e) => meshSession.onMemberLeft(e.detail));

  // Voice channel presence (server-wide broadcast — not just room peers).
  state.realtime.addEventListener('voice_channel_member-joined', (e) => onVoiceChannelMemberJoined(e.detail));
  state.realtime.addEventListener('voice_channel_member-left',   (e) => onVoiceChannelMemberLeft(e.detail));

  // Group chat WS events
  state.realtime.addEventListener('group_chat_created', (e) => onRemoteGroupChatCreated(e.detail.chat));
  state.realtime.addEventListener('group_chat_updated', (e) => onRemoteGroupChatUpdated(e.detail.chat));
  state.realtime.addEventListener('group_chat_left',    (e) => onRemoteGroupChatLeft(e.detail));
  state.realtime.addEventListener('group_chat_message', (e) => onRemoteGroupChatMessage(e.detail.message));
  state.realtime.addEventListener('group_chat_message_deleted', (e) => onRemoteGroupChatMessageDeleted(e.detail));

  state.realtime.connect();

  // Render the home view IMMEDIATELY with whatever's cached (usually empty
  // on first launch). DMs and servers populate as they arrive — the
  // sidebar re-renders the moment loadDms/loadServers resolve.
  switchView({ kind: 'home' });
  setupComposer();

  loadDms().catch((e) => klog.error('enterApp.loadDms', 'failed', { err: e.message }));
  loadGroupChats().catch((e) => klog.error('enterApp.loadGroupChats', 'failed', { err: e.message }));
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

async function loadGroupChats() {
  try {
    const { groupChats } = await api.listGroupChats();
    state.groupChats = groupChats || [];
    for (const g of state.groupChats) {
      for (const m of (g.members || [])) rememberUser(m);
    }
    if (state.view.kind === 'home') renderDmList();
  } catch (e) {
    klog.warn('groups.load', 'failed', { err: e.message });
  }
}

// Group-chat WS handlers ----------------------------------------------------

function onRemoteGroupChatCreated(chat) {
  if (!chat || !chat.id) return;
  if (state.groupChats.find((g) => g.id === chat.id)) return;
  state.groupChats.unshift(chat);
  for (const m of chat.members || []) rememberUser(m);
  if (state.view.kind === 'home') renderDmList();
}

function onRemoteGroupChatUpdated(chat) {
  if (!chat || !chat.id) return;
  const idx = state.groupChats.findIndex((g) => g.id === chat.id);
  if (idx >= 0) state.groupChats[idx] = chat;
  else state.groupChats.unshift(chat);
  for (const m of chat.members || []) rememberUser(m);
  if (state.view.kind === 'home') renderDmList();
  // If we're currently in this chat, refresh the header (member list might have changed).
  if (state.activeGroupChatId === chat.id) {
    refreshGroupChatHeader(chat);
  }
}

function onRemoteGroupChatLeft(payload) {
  state.groupChats = state.groupChats.filter((g) => g.id !== payload.chatId);
  state.messagesByGroup.delete(payload.chatId);
  state.groupHistoryFetched.delete(payload.chatId);
  if (state.view.kind === 'home') renderDmList();
  if (state.activeGroupChatId === payload.chatId) {
    state.activeGroupChatId = null;
    root.querySelector('[data-chat-active]').classList.add('hidden');
    root.querySelector('[data-chat-empty]').classList.remove('hidden');
  }
}

function onRemoteGroupChatMessage(message) {
  let list = state.messagesByGroup.get(message.groupChatId);
  if (!list) { list = []; state.messagesByGroup.set(message.groupChatId, list); }
  // Already-confirmed dedupe.
  if (list.find((m) => m.id === message.id && !m.pending)) return;
  // Optimistic-send reconciliation.
  let pending = null;
  if (message.clientId) pending = list.find((m) => m.pending && m.clientId === message.clientId);
  if (pending) {
    pending.id = message.id;
    pending.createdAt = message.createdAt;
    pending.pending = false;
    confirmPendingDom(pending.clientId, message);
  } else {
    list.push(message);
    if (state.activeGroupChatId === message.groupChatId) {
      const chat = state.groupChats.find((g) => g.id === message.groupChatId);
      if (chat) appendGroupMessage(chat, message);
    }
    // Notification path (reuse the DM notification shape).
    if (state.user && message.senderId !== state.user.id) {
      const chat = state.groupChats.find((g) => g.id === message.groupChatId);
      if (chat) showGroupChatNotification(chat, message);
    }
  }
  // Move chat to top of sidebar list.
  const idx = state.groupChats.findIndex((g) => g.id === message.groupChatId);
  if (idx >= 0) {
    state.groupChats[idx].lastAt = message.createdAt;
    const [g] = state.groupChats.splice(idx, 1);
    state.groupChats.unshift(g);
    if (state.view.kind === 'home') renderDmList();
  }
}

function onRemoteGroupChatMessageDeleted(payload) {
  const list = state.messagesByGroup.get(payload.chatId);
  if (list) {
    const idx = list.findIndex((m) => m.id === payload.messageId);
    if (idx >= 0) list.splice(idx, 1);
  }
  if (state.activeGroupChatId === payload.chatId) {
    const row = root.querySelector(`[data-messages] [data-message-id="${payload.messageId}"]`);
    if (row) row.remove();
  }
}

// Voice-channel presence ----------------------------------------------------

function onVoiceChannelMemberJoined(payload) {
  const set = state.voiceChannelMembers.get(payload.channelId) || new Set();
  set.add(payload.userId);
  state.voiceChannelMembers.set(payload.channelId, set);
  if (state.view.kind === 'server') renderChannelList(state.view.serverId);
}
function onVoiceChannelMemberLeft(payload) {
  const set = state.voiceChannelMembers.get(payload.channelId);
  if (set) {
    set.delete(payload.userId);
    if (set.size === 0) state.voiceChannelMembers.delete(payload.channelId);
  }
  if (state.view.kind === 'server') renderChannelList(state.view.serverId);
}

// Show an OS notification for a group-chat message — same path as DMs.
function showGroupChatNotification(chat, message) {
  const n = state.settings && state.settings.notifications;
  if (!n || !n.enabled) return;
  if (_windowFocused && state.activeGroupChatId === chat.id && !n.showWhenFocused) return;
  ensureNotifyPermission();
  playNotifySound();
  const sender = userById(message.senderId) || { username: '?', displayName: 'Someone' };
  const title = (chat.name || groupChatDefaultName(chat)) + ' · ' + (sender.displayName || sender.username);
  let body = (message.content || '').trim();
  if (!body && message.attachments && message.attachments.length) {
    body = '[attachment: ' + (message.attachments[0].name || 'file') + ']';
  }
  if (body.length > 200) body = body.slice(0, 197) + '…';
  if (!body) body = '(new message)';
  const open = () => {
    try { window.focus(); } catch {}
    if (window.klar && window.klar.shell && window.klar.shell.show) try { window.klar.shell.show(); } catch {}
    switchView({ kind: 'home' });
    setTimeout(() => openGroupChat(chat.id), 30);
  };
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      const note = new Notification(title, {
        body, silent: true, tag: 'klar-gchat-' + chat.id, renotify: true,
      });
      note.onclick = () => { open(); try { note.close(); } catch {} };
    } catch {}
  }
  if (window.klar && window.klar.shell && window.klar.shell.flash) try { window.klar.shell.flash(); } catch {}
}

// Default name for a group chat that hasn't been explicitly named — list
// the first 3 member display names. Excludes the current user.
function groupChatDefaultName(chat) {
  if (chat.name) return chat.name;
  const others = (chat.members || []).filter((m) => m.id !== (state.user && state.user.id));
  const names = others.slice(0, 3).map((m) => m.displayName || m.username);
  if (others.length > 3) names.push('+' + (others.length - 3));
  return names.join(', ') || 'Group chat';
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
  state.activeGroupChatId = null;
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
  const newGroupBtn = root.querySelector('[data-action="new-group-chat"]');
  if (newGroupBtn) newGroupBtn.addEventListener('click', openCreateGroupChatModal);

  const emptyTitle = root.querySelector('[data-chat-empty] h2');
  const emptyP = root.querySelector('[data-chat-empty] p');
  if (emptyTitle) emptyTitle.textContent = 'Direct messages';
  if (emptyP) emptyP.textContent = 'Search a username on the left to start a transmission.';
}

function renderDmList() {
  const ul = root.querySelector('[data-dm-list]');
  if (!ul) return;
  clear(ul);

  // Group chats first (most-recent-by-message at the top), then 1:1 DMs.
  // Both lists are already pre-sorted by lastAt server-side / on insert.
  for (const g of state.groupChats) {
    const li = document.createElement('li');
    li.className = 'dm-item gchat' + (g.id === state.activeGroupChatId ? ' active' : '');
    li.innerHTML = `<div class="avatar group"></div><div class="dm-name"></div>`;
    paintGroupAvatar(li.querySelector('.avatar'), g);
    li.querySelector('.dm-name').textContent = groupChatDefaultName(g);
    li.addEventListener('click', () => openGroupChat(g.id));
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openGroupChatContextMenu(e.clientX, e.clientY, g);
    });
    ul.appendChild(li);
  }

  for (const dm of state.dms) {
    const li = document.createElement('li');
    li.className = 'dm-item' + (dm.id === state.activeDmId ? ' active' : '');
    li.innerHTML = `<div class="avatar"></div><div class="dm-name"></div>`;
    paintAvatar(li.querySelector('.avatar'), dm.other);
    li.querySelector('.dm-name').textContent = dm.other.displayName;
    li.addEventListener('click', () => openDm(dm.id));
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openDmContextMenu(e.clientX, e.clientY, dm);
    });
    ul.appendChild(li);
  }
}

// Compose-style avatar for a group chat — overlapping member avatars.
function paintGroupAvatar(el, chat) {
  el.innerHTML = '';
  el.classList.add('group');
  const others = (chat.members || []).filter((m) => m.id !== (state.user && state.user.id)).slice(0, 2);
  for (const m of others) {
    const sub = document.createElement('div');
    sub.className = 'group-sub';
    paintAvatar(sub, m);
    el.appendChild(sub);
  }
}

function openGroupChatContextMenu(x, y, chat) {
  const isOwner = state.user && chat.ownerId === state.user.id;
  openContextMenu(x, y, [
    { label: 'Open chat',         icon: 'klar-asteroid', onClick: () => openGroupChat(chat.id) },
    { label: 'Add members',       icon: 'klar-users',    onClick: () => openAddGroupMembersModal(chat) },
    { divider: true },
    { label: isOwner ? 'Delete group' : 'Leave group', icon: 'klar-x', danger: true,
      onClick: () => leaveGroupChat(chat) },
  ]);
}

async function leaveGroupChat(chat) {
  const verb = (chat.ownerId === state.user.id) ? 'Delete' : 'Leave';
  if (!confirm(`${verb} this group chat?`)) return;
  try { await api.removeGroupMember(chat.id, state.user.id); }
  catch (e) { alert('Failed: ' + (e.message || 'error')); }
}

function openDmContextMenu(x, y, dm) {
  openContextMenu(x, y, [
    { label: 'Open chat',     icon: 'klar-asteroid', onClick: () => openDm(dm.id) },
    { label: 'Voice call',    icon: 'klar-phone',    onClick: () => callMgr.startCall(dm.other, dm.id) },
    { label: 'View profile',  icon: 'klar-user',     onClick: () => openProfileModal(dm.other) },
    { divider: true },
    { label: 'Block ' + (dm.other.displayName || dm.other.username), icon: 'klar-x', danger: true, onClick: () => confirmAndBlock(dm.other) },
  ]);
}

async function confirmAndBlock(user) {
  if (!confirm(`Block @${user.username}? They will not be able to message you and the DM disappears from your sidebar. You can unblock from Settings → Notifications later.`)) return;
  try {
    await api.blockUser(user.id);
    // Server broadcasts block_updated; UI refreshes via the WS handler.
    klog.info('user.block', 'blocked', { target: user.username });
  } catch (e) {
    alert('Block failed: ' + (e.message || 'error'));
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

// Mute = our mic OFF. Deafen = peer audio we hear OFF.
// They are independent — clicking deafen does NOT also mute the mic
// (the previous "force mute when deafened" behaviour created a stuck
// half-state on undeafen, where the user's mic stayed muted but they
// couldn't tell). One toggle = one effect.
function toggleGlobalMic() {
  state.globalMicMuted = !state.globalMicMuted;
  applyMicMuteState();
  syncActiveCallControls();
  syncCallTiles();
  renderMeBar();
  if (callMgr.state === 'connected') callMgr.broadcastState();
}
function toggleGlobalDeafen() {
  state.globalDeafened = !state.globalDeafened;
  applyDeafenState();
  syncActiveCallControls();
  syncCallTiles();
  renderMeBar();
  if (callMgr.state === 'connected') callMgr.broadcastState();
}
function applyMicMuteState() {
  if (callMgr.localStream) {
    for (const t of callMgr.localStream.getAudioTracks()) t.enabled = !state.globalMicMuted;
  }
  meshSession.applyMute();
}
function applyDeafenState() {
  if (callMgr.remoteAudio) callMgr.remoteAudio.muted = state.globalDeafened;
  meshSession.applyDeafen();
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

  const meOwns = detail.server.ownerId === state.user.id;

  for (const ch of detail.channels) {
    const isVoice = ch.kind === 'voice';
    const inThisVoice = isVoice && state.mesh && state.mesh.scope === ch.id;
    const li = document.createElement('li');
    li.className = 'channel-item'
      + (ch.id === state.activeChannelId && !isVoice ? ' active' : '')
      + (ch.kind === 'announcement' ? ' announcement' : '')
      + (isVoice ? ' voice' : '')
      + (inThisVoice ? ' joined' : '');
    li.innerHTML = `<span class="channel-icon"></span><span class="channel-name"></span>`;
    const iconId = isVoice ? 'klar-headphones' : ch.kind === 'announcement' ? 'klar-mic' : 'klar-hash';
    li.querySelector('.channel-icon').appendChild(svgIcon(iconId, 18));
    li.querySelector('.channel-name').textContent = ch.name;
    li.addEventListener('click', () => {
      if (isVoice) joinVoiceChannel(ch);
      else openChannel(ch.id);
    });
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openChannelContextMenu(e.clientX, e.clientY, ch, meOwns, serverId);
    });
    ul.appendChild(li);

    // For voice channels, render the current member list as nested rows
    // beneath the channel itself.
    if (isVoice) {
      const present = state.voiceChannelMembers.get(ch.id);
      const members = present ? Array.from(present) : (Array.isArray(ch.voiceMembers) ? ch.voiceMembers : []);
      if (members.length) {
        const sub = document.createElement('li');
        sub.className = 'voice-members';
        for (const uid of members) {
          const u = userById(uid) || { id: uid, displayName: '?', username: '?' };
          const row = document.createElement('div');
          row.className = 'voice-member';
          row.innerHTML = `<div class="avatar"></div><div class="name"></div>`;
          paintAvatar(row.querySelector('.avatar'), u);
          row.querySelector('.name').textContent = u.displayName || u.username;
          sub.appendChild(row);
        }
        ul.appendChild(sub);
      }
    }
  }
}

async function joinVoiceChannel(ch) {
  // If we're already in THIS voice channel, leave instead.
  if (state.mesh && state.mesh.scope === ch.id) {
    await meshSession.leave();
    renderChannelList(ch.serverId);
    return;
  }
  // If we're in a different mesh (another voice channel), leave it first.
  if (state.mesh) await meshSession.leave();
  const ok = await meshSession.join(ch.id, 'voice-channel', ch.id);
  if (ok) {
    showActiveCallBar({ id: ch.id, displayName: '#' + ch.name, username: ch.name }, 'In voice');
    renderChannelList(ch.serverId);
  }
}

function openChannelContextMenu(x, y, channel, meOwns, serverId) {
  const items = [
    { label: 'Open',          icon: 'klar-asteroid', onClick: () => openChannel(channel.id) },
    { divider: true },
  ];
  if (meOwns) {
    items.push(
      { label: 'Edit name',           icon: 'klar-settings', onClick: () => openRenameChannelPrompt(channel) },
      { label: channel.kind === 'announcement' ? 'Convert to text channel' : 'Convert to announcement', icon: 'klar-mic', onClick: () => toggleChannelKind(channel) },
      { label: 'Generate invite link', icon: 'klar-compass', onClick: () => generateInviteFor(serverId) },
      { divider: true },
      { label: 'Delete channel',     icon: 'klar-x', danger: true, onClick: () => confirmAndDeleteChannel(channel) },
    );
  } else {
    items.push({ label: 'Generate invite link', icon: 'klar-compass', onClick: () => generateInviteFor(serverId) });
  }
  openContextMenu(x, y, items);
}

async function openRenameChannelPrompt(channel) {
  const next = prompt('New channel name (lowercase letters, digits, dash, underscore):', channel.name);
  if (next == null) return;
  const trimmed = next.trim().toLowerCase();
  if (!trimmed || trimmed === channel.name) return;
  try { await api.updateChannel(channel.id, { name: trimmed }); }
  catch (e) { alert('Rename failed: ' + (e.message || 'error')); }
}

async function toggleChannelKind(channel) {
  const newKind = channel.kind === 'announcement' ? 'text' : 'announcement';
  try { await api.updateChannel(channel.id, { kind: newKind }); }
  catch (e) { alert('Failed: ' + (e.message || 'error')); }
}

async function confirmAndDeleteChannel(channel) {
  if (!confirm(`Delete channel #${channel.name}? This cannot be undone.`)) return;
  try { await api.deleteChannel(channel.id); }
  catch (e) { alert('Delete failed: ' + (e.message || 'error')); }
}

function generateInviteFor(serverId) {
  // Reuse the existing invite modal — it creates the code itself + offers
  // a copy button + status feedback.
  openInviteModal(serverId);
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
  state.activeGroupChatId = null;
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
  // Pin to bottom. Setting scrollTop synchronously here can read a stale
  // scrollHeight if the chat container was just unhidden by openDm() —
  // browser hasn't reflowed yet, so we'd land at the top with history.
  // Two animation frames: first lets style/layout settle, second confirms
  // after fonts/avatar images may have shifted size.
  list.scrollTop = list.scrollHeight;
  requestAnimationFrame(() => {
    list.scrollTop = list.scrollHeight;
    requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  });
}

// ===========================================================================
// Group chat: open + render
// ===========================================================================

function openGroupChat(chatId) {
  state.activeDmId = null;
  state.activeChannelId = null;
  state.activeGroupChatId = chatId;
  renderDmList();

  const chat = state.groupChats.find((g) => g.id === chatId);
  if (!chat) return;

  root.querySelector('[data-chat-empty]').classList.add('hidden');
  root.querySelector('[data-chat-active]').classList.remove('hidden');

  refreshGroupChatHeader(chat);

  const status = root.querySelector('[data-composer-status]');
  if (status) { status.textContent = ''; status.classList.remove('encrypted'); }

  if (!state.messagesByGroup.has(chatId)) state.messagesByGroup.set(chatId, []);

  renderGroupChatMessages(chat);
  root.querySelector('[data-composer-input]').placeholder = `Message ${groupChatDefaultName(chat)}`;
  root.querySelector('[data-composer-input]').focus();
  klog.info('gchat.open', 'opened', { chat: chatId });

  if (!state.groupHistoryFetched.has(chatId)) {
    state.groupHistoryFetched.add(chatId);
    api.listGroupMessages(chatId).then(({ messages: rows }) => {
      const list = state.messagesByGroup.get(chatId) || [];
      const seen = new Set(list.map((m) => m.id));
      let added = 0;
      for (const r of rows) if (!seen.has(r.id)) { list.push(r); added++; }
      if (added > 0) {
        list.sort((a, b) => a.createdAt - b.createdAt);
        state.messagesByGroup.set(chatId, list);
        if (state.activeGroupChatId === chatId) renderGroupChatMessages(chat);
      }
    }).catch((err) => {
      state.groupHistoryFetched.delete(chatId);
      klog.error('gchat.history', 'load failed', { chat: chatId, err: err && err.message });
    });
  }
}

function refreshGroupChatHeader(chat) {
  const header = root.querySelector('[data-chat-header]');
  if (!header) return;
  clear(header);
  header.innerHTML = `
    <div class="chat-title">
      <div class="avatar group"></div>
      <div>
        <div class="channel-name"></div>
        <div class="peer-handle muted small"></div>
      </div>
    </div>
    <div class="chat-topic">Group chat — ${chat.members.length} member${chat.members.length === 1 ? '' : 's'}</div>
    <div class="actions">
      <button class="icon-btn" data-action="gchat-rename" title="Rename group" aria-label="Rename group">
        <svg width="18" height="18"><use href="#klar-settings"/></svg>
      </button>
      <button class="icon-btn" data-action="gchat-add"    title="Add members" aria-label="Add members">
        <svg width="18" height="18"><use href="#klar-users"/></svg>
      </button>
    </div>
  `;
  paintGroupAvatar(header.querySelector('.avatar'), chat);
  header.querySelector('.channel-name').textContent = groupChatDefaultName(chat);
  const handles = (chat.members || []).filter((m) => m.id !== state.user.id).map((m) => '@' + m.username).slice(0, 5).join(', ');
  header.querySelector('.peer-handle').textContent = handles + ((chat.members || []).length > 6 ? ', ...' : '');
  header.querySelector('[data-action="gchat-rename"]').addEventListener('click', () => promptRenameGroup(chat));
  header.querySelector('[data-action="gchat-add"]').addEventListener('click', () => openAddGroupMembersModal(chat));
}

async function promptRenameGroup(chat) {
  const next = prompt('Group name (leave blank to remove the custom name):', chat.name || '');
  if (next == null) return;
  const trimmed = next.trim();
  if (trimmed === (chat.name || '')) return;
  try { await api.renameGroupChat(chat.id, trimmed); }
  catch (e) { alert('Rename failed: ' + (e.message || 'error')); }
}

function renderGroupChatMessages(chat) {
  const list = root.querySelector('[data-messages]');
  clear(list);
  const intro = document.createElement('div');
  intro.className = 'channel-intro';
  intro.innerHTML = `<div class="badge"></div><h3>Group line</h3><p></p>`;
  intro.querySelector('.badge').appendChild(svgIcon('klar-users', 36));
  intro.querySelector('p').textContent = `${chat.members.length} crew member${chat.members.length === 1 ? '' : 's'} in this group.`;
  list.appendChild(intro);
  const messages = state.messagesByGroup.get(chat.id) || [];
  let prevDay = null;
  for (const m of messages) {
    const day = dayLabel(m.createdAt);
    if (day !== prevDay) { list.appendChild(buildDayDivider(day, m.createdAt)); prevDay = day; }
    const showHeader = shouldShowHeader(list.lastElementChild, m.senderId, m.createdAt);
    const row = buildDmMessageRow({ other: { id: '?', displayName: '?' } }, m, showHeader); // reuse DM row builder; sender info comes from userById
    list.appendChild(row);
  }
  list.scrollTop = list.scrollHeight;
}

function appendGroupMessage(chat, m) {
  const list = root.querySelector('[data-messages]');
  if (!list) return;
  // Day divider if needed.
  const day = dayLabel(m.createdAt);
  const lastDay = list.lastElementChild && list.lastElementChild.dataset && list.lastElementChild.dataset.day;
  if (day !== lastDay && !list.querySelector(`[data-day="${day}"]`)) {
    list.appendChild(buildDayDivider(day, m.createdAt));
  }
  const showHeader = shouldShowHeader(list.lastElementChild, m.senderId, m.createdAt);
  const row = buildDmMessageRow({ other: { id: '?', displayName: '?' } }, m, showHeader);
  list.appendChild(row);
  list.scrollTop = list.scrollHeight;
}

// Create-group-chat modal — multi-pick from your DM contacts.
function openCreateGroupChatModal() {
  openModal('tpl-modal-create-group-chat', (modal, close) => {
    const picker = modal.querySelector('[data-member-picker]');
    const submit = modal.querySelector('[data-form-submit]');
    const selected = new Set();
    // Use existing 1:1 DM peers as the contact list. Could be expanded to
    // a user search in the future.
    const candidates = state.dms.map((dm) => dm.other).filter(Boolean);
    if (!candidates.length) {
      picker.innerHTML = '<div class="muted small">No contacts yet — start a DM with someone first.</div>';
      return;
    }
    picker.innerHTML = '';
    for (const u of candidates) {
      const row = document.createElement('label');
      row.className = 'member-pick';
      row.innerHTML = `<input type="checkbox" /><div class="avatar"></div><div class="member-name"></div>`;
      paintAvatar(row.querySelector('.avatar'), u);
      row.querySelector('.member-name').textContent = u.displayName + ' · @' + u.username;
      row.querySelector('input').addEventListener('change', (e) => {
        if (e.target.checked) selected.add(u.id); else selected.delete(u.id);
        submit.disabled = selected.size === 0;
        row.classList.toggle('picked', e.target.checked);
      });
      picker.appendChild(row);
    }
    const form = modal.querySelector('[data-form="create-group-chat"]');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      showModalError(modal, null);
      const name = (new FormData(form).get('name') || '').toString().trim();
      submit.disabled = true; submit.textContent = 'Creating…';
      try {
        const chat = await api.createGroupChat({ name, memberIds: Array.from(selected) });
        close();
        // Server broadcasts group_chat_created which inserts into state +
        // re-renders the sidebar; we just open it.
        setTimeout(() => openGroupChat(chat.id), 30);
      } catch (err) {
        showModalError(modal, err.message || 'failed to create group');
        submit.disabled = false; submit.textContent = 'Create';
      }
    });
  });
}

function openAddGroupMembersModal(chat) {
  openModal('tpl-modal-add-group-members', (modal, close) => {
    const picker = modal.querySelector('[data-member-picker]');
    const submit = modal.querySelector('[data-form-submit]');
    const selected = new Set();
    const existingIds = new Set((chat.members || []).map((m) => m.id));
    const candidates = state.dms.map((dm) => dm.other).filter((u) => u && !existingIds.has(u.id));
    if (!candidates.length) {
      picker.innerHTML = '<div class="muted small">All your DM contacts are already in this group.</div>';
      return;
    }
    picker.innerHTML = '';
    for (const u of candidates) {
      const row = document.createElement('label');
      row.className = 'member-pick';
      row.innerHTML = `<input type="checkbox" /><div class="avatar"></div><div class="member-name"></div>`;
      paintAvatar(row.querySelector('.avatar'), u);
      row.querySelector('.member-name').textContent = u.displayName + ' · @' + u.username;
      row.querySelector('input').addEventListener('change', (e) => {
        if (e.target.checked) selected.add(u.id); else selected.delete(u.id);
        submit.disabled = selected.size === 0;
        row.classList.toggle('picked', e.target.checked);
      });
      picker.appendChild(row);
    }
    const form = modal.querySelector('[data-form="add-group-members"]');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submit.disabled = true; submit.textContent = 'Adding…';
      try {
        await api.addGroupMembers(chat.id, Array.from(selected));
        close();
      } catch (err) {
        showModalError(modal, err.message || 'failed to add members');
        submit.disabled = false; submit.textContent = 'Add';
      }
    });
  });
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

// Hosts whose pages publish og:video and are server-side resolvable via
// /api/embed/resolve. The renderer shows a placeholder, fetches metadata,
// then swaps in the custom video player.
const REMOTE_VIDEO_HOSTS = /^(?:www\.)?medal\.tv$/i;

function classifyUrl(u) {
  const noFrag = u.split('#')[0];
  if (IMG_EXT.test(noFrag)) return 'image';
  if (VID_EXT.test(noFrag)) return 'video';
  if (AUD_EXT.test(noFrag)) return 'audio';
  // Remote video hosts (medal.tv etc.) — server resolves the og:video URL.
  try {
    const parsed = new URL(u);
    if (REMOTE_VIDEO_HOSTS.test(parsed.hostname)) return 'remote-video';
  } catch {}
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

// Resolve an attachment / embed URL to an absolute one. Bare paths like
// /uploads/<id>/<name> work fine in a regular browser (they resolve
// against location.origin), but the Electron renderer is loaded from
// file:// so the same paths 404. We always prefix with the server URL
// when the URL is path-relative.
function absoluteAttachmentUrl(url) {
  if (!url) return url;
  if (/^[a-z]+:\/\//i.test(url)) return url;
  if (!url.startsWith('/'))      return url; // already a relative-to-doc path; leave it
  const cfg = (typeof window !== 'undefined' && window.KLAR_CONFIG) || {};
  // Prefer the runtime-discovered URL if present (set by api.discoverServerUrl)
  // — same source of truth as serverBase() in api.js. We don't have direct
  // access to _runtimeServerUrl from here, so fall back to KLAR_CONFIG.
  const base = (cfg.serverUrl || '').replace(/\/+$/, '');
  if (base) return base + url;
  // Last resort: use location.origin (works in browser + Tailscale URL).
  return location.origin + url;
}

// Build a single embed DOM node for an image/video/audio URL. Falls back to
// a download link if the URL turned out to be untyped (shouldn't happen,
// but defensive).
function buildEmbed(url, type, attachmentMeta) {
  const abs = absoluteAttachmentUrl(url);
  const wrap = document.createElement('div');
  wrap.className = 'embed embed-' + (type || 'file');
  if (type === 'image') {
    const img = document.createElement('img');
    img.src = abs;
    img.alt = attachmentMeta && attachmentMeta.name ? attachmentMeta.name : '';
    img.loading = 'lazy';
    img.addEventListener('click', () => window.open(abs, '_blank'));
    img.addEventListener('error', () => { wrap.classList.add('failed'); img.alt = 'Image failed to load'; });
    wrap.appendChild(img);
  } else if (type === 'video') {
    wrap.appendChild(buildCustomVideoPlayer(abs));
  } else if (type === 'remote-video') {
    // medal.tv etc. — show a placeholder card, fetch metadata, swap to the
    // custom video player when the og:video URL resolves.
    wrap.classList.add('embed-video');
    const card = document.createElement('div');
    card.className = 'remote-video-loading';
    card.innerHTML = `
      <div class="rvl-spinner"></div>
      <div class="rvl-host"></div>
      <a class="rvl-link" target="_blank" rel="noopener noreferrer"></a>
    `;
    let host = '';
    try { host = new URL(abs).hostname.replace(/^www\./, ''); } catch {}
    card.querySelector('.rvl-host').textContent = 'Loading ' + host + ' clip…';
    const link = card.querySelector('.rvl-link');
    link.href = abs; link.textContent = abs;
    wrap.appendChild(card);
    api.resolveEmbed(abs).then((info) => {
      if (info && info.videoUrl) {
        wrap.innerHTML = '';
        wrap.appendChild(buildCustomVideoPlayer(info.videoUrl));
        if (info.thumbnail) {
          const v = wrap.querySelector('video');
          if (v) v.poster = info.thumbnail;
        }
      } else {
        // Couldn't extract a video URL — fall back to a clickable preview.
        wrap.innerHTML = '';
        const fallback = document.createElement('a');
        fallback.className = 'remote-video-fallback';
        fallback.href = abs; fallback.target = '_blank'; fallback.rel = 'noopener noreferrer';
        if (info && info.thumbnail) {
          const img = document.createElement('img');
          img.src = info.thumbnail; img.loading = 'lazy';
          fallback.appendChild(img);
        }
        const meta = document.createElement('div');
        meta.className = 'rvl-meta';
        meta.innerHTML = `<div class="rvl-title"></div><div class="rvl-site"></div>`;
        meta.querySelector('.rvl-title').textContent = (info && info.title) || abs;
        meta.querySelector('.rvl-site').textContent  = (info && info.site)  || host;
        fallback.appendChild(meta);
        wrap.appendChild(fallback);
      }
    }).catch((e) => {
      klog.warn('embed.resolve', 'failed', { url: abs, err: e.message });
      // Keep the loading card with the link so the user can still click out.
      card.querySelector('.rvl-host').textContent = 'Couldn\'t load preview — open link';
      card.querySelector('.rvl-spinner').remove();
    });
  } else if (type === 'audio') {
    const a = document.createElement('audio');
    a.src = abs;
    a.controls = true;
    a.preload = 'metadata';
    wrap.appendChild(a);
  } else {
    // Generic file chip
    const a = document.createElement('a');
    a.href = abs;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.className = 'attachment-chip';
    const sizeKb = attachmentMeta && attachmentMeta.size ? Math.round(attachmentMeta.size / 1024) + ' KB' : '';
    a.textContent = (attachmentMeta && attachmentMeta.name ? attachmentMeta.name : abs) + (sizeKb ? ' · ' + sizeKb : '');
    wrap.appendChild(a);
  }
  return wrap;
}

// Custom video player. Native <video controls> looks inconsistent across
// platforms and clashes with the cosmic theme — this gives us a controls
// overlay we can style. Hover to reveal; click anywhere on the video to
// play/pause; double-click for fullscreen.
function buildCustomVideoPlayer(src) {
  const wrap = document.createElement('div');
  wrap.className = 'kvp';
  wrap.innerHTML = `
    <video data-kvp-video preload="metadata" playsinline></video>
    <button class="kvp-bigplay" data-kvp-bigplay type="button" aria-label="Play">
      <svg viewBox="0 0 24 24" width="36" height="36"><path d="M7 5l13 7-13 7z" fill="currentColor"/></svg>
    </button>
    <div class="kvp-loading" data-kvp-loading hidden></div>
    <div class="kvp-controls" data-kvp-controls>
      <button class="kvp-btn" data-kvp-play type="button" aria-label="Play / pause">
        <svg viewBox="0 0 24 24" width="16" height="16" data-kvp-play-icon><path d="M7 5l13 7-13 7z" fill="currentColor"/></svg>
      </button>
      <span class="kvp-time" data-kvp-time>0:00 / 0:00</span>
      <div class="kvp-scrub" data-kvp-scrub>
        <div class="kvp-scrub-buf"  data-kvp-buf></div>
        <div class="kvp-scrub-fill" data-kvp-fill></div>
        <div class="kvp-scrub-thumb" data-kvp-thumb></div>
      </div>
      <button class="kvp-btn" data-kvp-volbtn type="button" aria-label="Mute / unmute">
        <svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 9v6h4l6 5V4L8 9H4z" fill="currentColor"/></svg>
      </button>
      <div class="kvp-vol" data-kvp-vol>
        <div class="kvp-vol-fill" data-kvp-volfill></div>
        <div class="kvp-vol-thumb" data-kvp-volthumb></div>
      </div>
      <button class="kvp-btn" data-kvp-fs type="button" aria-label="Fullscreen">
        <svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
    </div>
  `;
  const vid    = wrap.querySelector('[data-kvp-video]');
  const bigPlay= wrap.querySelector('[data-kvp-bigplay]');
  const loader = wrap.querySelector('[data-kvp-loading]');
  const playBtn= wrap.querySelector('[data-kvp-play]');
  const playIc = wrap.querySelector('[data-kvp-play-icon]');
  const timeEl = wrap.querySelector('[data-kvp-time]');
  const scrub  = wrap.querySelector('[data-kvp-scrub]');
  const fill   = wrap.querySelector('[data-kvp-fill]');
  const thumb  = wrap.querySelector('[data-kvp-thumb]');
  const buf    = wrap.querySelector('[data-kvp-buf]');
  const volBtn = wrap.querySelector('[data-kvp-volbtn]');
  const vol    = wrap.querySelector('[data-kvp-vol]');
  const volFill= wrap.querySelector('[data-kvp-volfill]');
  const volThumb=wrap.querySelector('[data-kvp-volthumb]');
  const fsBtn  = wrap.querySelector('[data-kvp-fs]');
  vid.src = src;

  // Restore last volume across player instances.
  const savedVol = parseFloat(localStorage.getItem('klar.kvp.vol'));
  vid.volume = (Number.isFinite(savedVol) && savedVol >= 0 && savedVol <= 1) ? savedVol : 0.8;

  const fmt = (s) => {
    if (!Number.isFinite(s)) return '0:00';
    s = Math.max(0, Math.floor(s));
    const m = Math.floor(s / 60), ss = String(s % 60).padStart(2, '0');
    if (m >= 60) { const h = Math.floor(m / 60), mm = String(m % 60).padStart(2, '0'); return `${h}:${mm}:${ss}`; }
    return `${m}:${ss}`;
  };
  const setVolUI = () => {
    const v = vid.muted ? 0 : vid.volume;
    volFill.style.width = (v * 100) + '%';
    volThumb.style.left = (v * 100) + '%';
  };
  const setProgressUI = () => {
    const d = vid.duration || 0;
    const p = d > 0 ? (vid.currentTime / d) : 0;
    fill.style.width  = (p * 100) + '%';
    thumb.style.left  = (p * 100) + '%';
    if (vid.buffered && vid.buffered.length) {
      const end = vid.buffered.end(vid.buffered.length - 1);
      buf.style.width = (Math.min(1, end / Math.max(1, d)) * 100) + '%';
    }
    timeEl.textContent = fmt(vid.currentTime) + ' / ' + fmt(d);
  };
  const setPlayUI = () => {
    if (vid.paused) {
      playIc.innerHTML = '<path d="M7 5l13 7-13 7z" fill="currentColor"/>';
      bigPlay.hidden = false;
    } else {
      playIc.innerHTML = '<path d="M6 4h4v16H6zM14 4h4v16h-4z" fill="currentColor"/>';
      bigPlay.hidden = true;
    }
  };
  const togglePlay = () => { if (vid.paused) vid.play().catch(() => {}); else vid.pause(); };

  vid.addEventListener('loadedmetadata', setProgressUI);
  vid.addEventListener('timeupdate',     setProgressUI);
  vid.addEventListener('progress',       setProgressUI);
  vid.addEventListener('volumechange',   setVolUI);
  vid.addEventListener('play',  setPlayUI);
  vid.addEventListener('pause', setPlayUI);
  vid.addEventListener('waiting', () => loader.hidden = false);
  vid.addEventListener('playing', () => loader.hidden = true);
  vid.addEventListener('canplay', () => loader.hidden = true);

  // Click video / big play toggles play; dblclick goes fullscreen.
  vid.addEventListener('click',    togglePlay);
  bigPlay.addEventListener('click',togglePlay);
  playBtn.addEventListener('click',togglePlay);
  vid.addEventListener('dblclick', () => fsBtn.click());

  // Scrubber: drag to seek (works for click + drag).
  let scrubbing = false;
  const seekFromEvent = (e) => {
    const r = scrub.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, (e.clientX || (e.touches && e.touches[0].clientX) || 0) - r.left));
    const p = r.width > 0 ? x / r.width : 0;
    if (Number.isFinite(vid.duration)) vid.currentTime = vid.duration * p;
  };
  scrub.addEventListener('mousedown', (e) => { scrubbing = true; seekFromEvent(e); });
  document.addEventListener('mousemove', (e) => { if (scrubbing) seekFromEvent(e); });
  document.addEventListener('mouseup', () => { scrubbing = false; });

  // Volume: same drag pattern.
  let volDragging = false;
  const setVolFromEvent = (e) => {
    const r = vol.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, (e.clientX || (e.touches && e.touches[0].clientX) || 0) - r.left));
    vid.volume = r.width > 0 ? x / r.width : 0;
    vid.muted = vid.volume === 0;
    localStorage.setItem('klar.kvp.vol', String(vid.volume));
  };
  vol.addEventListener('mousedown', (e) => { volDragging = true; setVolFromEvent(e); });
  document.addEventListener('mousemove', (e) => { if (volDragging) setVolFromEvent(e); });
  document.addEventListener('mouseup', () => { volDragging = false; });
  volBtn.addEventListener('click', () => {
    vid.muted = !vid.muted;
    if (!vid.muted && vid.volume === 0) vid.volume = 0.5;
  });

  fsBtn.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else wrap.requestFullscreen().catch(() => {});
  });

  setVolUI();
  setProgressUI();
  setPlayUI();
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
  // Right-click on a message row → context menu. Currently the only entry
  // is "Delete" for messages you sent (and channel-owners can delete others'
  // messages in their server).
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openMessageContextMenu(e.clientX, e.clientY, m);
  });
  return row;
}

function openMessageContextMenu(x, y, m) {
  const isMine = state.user && m.senderId === state.user.id;
  // Channel owner can also delete others' messages in their server.
  let isChannelOwner = false;
  if (m.channelId) {
    for (const detail of state.serverDetails.values()) {
      if (detail.channels.find((c) => c.id === m.channelId)) {
        isChannelOwner = detail.server.ownerId === state.user.id;
        break;
      }
    }
  }
  const items = [];
  if (m.content) {
    items.push({ label: 'Copy text', icon: 'klar-asteroid', onClick: () => {
      try { navigator.clipboard.writeText(m.content); } catch {}
    }});
  }
  if (m.attachments && m.attachments.length) {
    for (const a of m.attachments) {
      items.push({ label: 'Copy link to ' + (a.name || 'file'), icon: 'klar-compass', onClick: () => {
        try { navigator.clipboard.writeText(serverPrefixedAttachmentUrl(a.url)); } catch {}
      }});
    }
  }
  if (isMine || isChannelOwner) {
    if (items.length) items.push({ divider: true });
    items.push({
      label: 'Delete message',
      icon: 'klar-x',
      danger: true,
      onClick: () => confirmAndDeleteMessage(m),
    });
  }
  if (!items.length) return;
  openContextMenu(x, y, items);
}

function serverPrefixedAttachmentUrl(url) {
  // Attachments are stored as relative paths like /uploads/<id>/<name>. We
  // surface absolute URLs in clipboard so they're shareable outside the app.
  if (/^https?:\/\//i.test(url)) return url;
  const cfg = (typeof window !== 'undefined' && window.KLAR_CONFIG) || {};
  const base = (cfg.serverUrl || location.origin).replace(/\/+$/, '');
  return base + url;
}

async function confirmAndDeleteMessage(m) {
  const what = (m.attachments && m.attachments.length)
    ? `this message and ${m.attachments.length} attachment${m.attachments.length === 1 ? '' : 's'}`
    : 'this message';
  if (!confirm(`Delete ${what}? This cannot be undone.`)) return;
  try {
    if (m.dmId) await api.deleteMessage(m.dmId, m.id);
    else if (m.channelId) await api.deleteChannelMessage(m.channelId, m.id);
  } catch (e) {
    alert('Delete failed: ' + (e.message || 'error'));
  }
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
  state.activeGroupChatId = null;
  if (state.view.kind !== 'server') return;
  const detail = state.serverDetails.get(state.view.serverId);
  if (!detail) return;
  const ch = detail.channels.find((c) => c.id === channelId);
  if (ch && ch.kind === 'voice') {
    // Voice channels aren't text — clicking joins the mesh room.
    joinVoiceChannel(ch);
    return;
  }
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
      else if (state.activeGroupChatId) await sendGroupChatMessage(text, ready);
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

async function sendGroupChatMessage(text, attachments) {
  const chat = state.groupChats.find((g) => g.id === state.activeGroupChatId);
  if (!chat) return;
  const att = Array.isArray(attachments) ? attachments : [];
  const clientId = newClientId();
  const optimistic = {
    id: 'tmp_' + clientId,
    clientId,
    groupChatId: chat.id,
    senderId: state.user.id,
    content: text,
    encrypted: false,
    nonce: null,
    createdAt: Date.now(),
    pending: true,
    attachments: att,
  };
  let list = state.messagesByGroup.get(chat.id);
  if (!list) { list = []; state.messagesByGroup.set(chat.id, list); }
  list.push(optimistic);
  appendGroupMessage(chat, optimistic);
  klog.info('msg.gchat.send', 'sending', { chat: chat.id, clientId, bytes: text.length, attachments: att.length });
  try {
    await api.sendGroupMessage(chat.id, text, clientId, att);
  } catch (err) {
    klog.error('msg.gchat.send', 'failed', { chat: chat.id, clientId, err: err.message });
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

function onRemoteChannelUpdated(channel) {
  const detail = state.serverDetails.get(channel.serverId);
  if (!detail) return;
  const idx = detail.channels.findIndex((c) => c.id === channel.id);
  if (idx >= 0) detail.channels[idx] = channel;
  if (state.view.kind === 'server' && state.view.serverId === channel.serverId) {
    renderChannelList(channel.serverId);
  }
  if (state.activeChannelId === channel.id) {
    // Re-render the chat header so name/kind changes show immediately.
    openChannel(channel.id);
  }
}

function onRemoteChannelDeleted(payload) {
  const detail = state.serverDetails.get(payload.serverId);
  if (!detail) return;
  detail.channels = detail.channels.filter((c) => c.id !== payload.channelId);
  state.channelMessagesByChan.delete(payload.channelId);
  state.channelHistoryFetched.delete(payload.channelId);
  if (state.view.kind === 'server' && state.view.serverId === payload.serverId) {
    renderChannelList(payload.serverId);
    if (state.activeChannelId === payload.channelId) {
      // Snap to first remaining channel, or chat-empty if none.
      const first = detail.channels[0];
      if (first) openChannel(first.id);
      else {
        state.activeChannelId = null;
        root.querySelector('[data-chat-active]').classList.add('hidden');
        root.querySelector('[data-chat-empty]').classList.remove('hidden');
      }
    }
  }
}

function onRemoteMessageDeleted(payload) {
  const list = state.messagesByDm.get(payload.dmId);
  if (list) {
    const idx = list.findIndex((m) => m.id === payload.messageId);
    if (idx >= 0) list.splice(idx, 1);
  }
  // Remove the rendered row if visible.
  if (state.activeDmId === payload.dmId) {
    const row = root.querySelector(`[data-messages] [data-message-id="${payload.messageId}"]`);
    if (row) row.remove();
  }
  klog.info('msg.dm.deleted', 'remote delete', { dm: payload.dmId, msg: payload.messageId });
}

function onRemoteChannelMessageDeleted(payload) {
  const list = state.channelMessagesByChan.get(payload.channelId);
  if (list) {
    const idx = list.findIndex((m) => m.id === payload.messageId);
    if (idx >= 0) list.splice(idx, 1);
  }
  if (state.activeChannelId === payload.channelId) {
    const row = root.querySelector(`[data-messages] [data-message-id="${payload.messageId}"]`);
    if (row) row.remove();
  }
  klog.info('msg.channel.deleted', 'remote delete', { channel: payload.channelId, msg: payload.messageId });
}

function onRemoteBlockUpdated(payload) {
  // Server side already enforces. We just need to refresh the local DM
  // list so the blocked user disappears (or reappears, on unblock).
  loadDms().catch(() => {});
  // If we were chatting with the now-blocked user, kick back home.
  if (payload.blocked && state.activeDmId) {
    const dm = state.dms.find((d) => d.id === state.activeDmId);
    if (dm && dm.other && dm.other.id === payload.userId) {
      switchView({ kind: 'home' });
    }
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

// ---------------------------------------------------------------------------
// Context menus
// ---------------------------------------------------------------------------
//
// Single shared right-click menu. Caller provides screen coords + an array
// of item descriptors:
//   [{ label, onClick, danger?, hidden?, icon? }, ...]   // string items
//   { divider: true }                                    // separator
// We position the menu at the click and flip it left/up if it would clip
// the viewport. Closes on outside click, Esc, scroll, or window blur.

let _ctxMenuEl = null;
let _ctxCloseListeners = null;

function closeContextMenu() {
  if (!_ctxMenuEl) return;
  try { _ctxMenuEl.remove(); } catch {}
  _ctxMenuEl = null;
  if (_ctxCloseListeners) {
    document.removeEventListener('mousedown', _ctxCloseListeners.mousedown, true);
    document.removeEventListener('keydown',   _ctxCloseListeners.keydown);
    window.removeEventListener('blur',        _ctxCloseListeners.blur);
    window.removeEventListener('resize',      _ctxCloseListeners.resize);
    document.removeEventListener('scroll',    _ctxCloseListeners.scroll, true);
    _ctxCloseListeners = null;
  }
}

function openContextMenu(x, y, items) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.setAttribute('role', 'menu');
  for (const it of items) {
    if (!it || it.hidden) continue;
    if (it.divider) {
      const d = document.createElement('div');
      d.className = 'ctx-divider';
      menu.appendChild(d);
      continue;
    }
    if (it.slider) {
      // Inline slider row: { slider: { label, min, max, value, format, onInput } }
      const s = it.slider;
      const wrap = document.createElement('div');
      wrap.className = 'ctx-slider';
      const lbl = document.createElement('div');
      lbl.className = 'ctx-slider-label';
      const text = document.createElement('span'); text.textContent = s.label || '';
      const val  = document.createElement('span'); val.className = 'ctx-slider-value';
      val.textContent = s.format ? s.format(s.value) : String(s.value);
      lbl.appendChild(text); lbl.appendChild(val);
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(s.min ?? 0);
      input.max = String(s.max ?? 100);
      input.value = String(s.value ?? 0);
      input.addEventListener('input', (e) => {
        const v = +input.value;
        val.textContent = s.format ? s.format(v) : String(v);
        try { s.onInput?.(v); } catch (err) { klog.error('ctx.slider', 'onInput failed', { err: err.message }); }
      });
      // Don't dismiss the menu while dragging the slider.
      input.addEventListener('mousedown', (e) => e.stopPropagation());
      input.addEventListener('keydown',   (e) => e.stopPropagation());
      wrap.appendChild(lbl); wrap.appendChild(input);
      menu.appendChild(wrap);
      continue;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctx-item' + (it.danger ? ' danger' : '');
    if (it.disabled) { b.disabled = true; b.classList.add('disabled'); }
    if (it.icon) {
      const ic = svgIcon(it.icon, 14);
      ic.classList.add('ctx-ico');
      b.appendChild(ic);
    }
    const lbl = document.createElement('span');
    lbl.textContent = it.label;
    b.appendChild(lbl);
    if (typeof it.onClick === 'function' && !it.disabled) {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        closeContextMenu();
        try { it.onClick(); } catch (err) { klog.error('ctx.click', 'failed', { err: err && err.message }); }
      });
    } else {
      b.addEventListener('click', (e) => e.stopPropagation());
    }
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  _ctxMenuEl = menu;

  // Flip left/up if the menu would overflow.
  const rect = menu.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = x, top = y;
  if (left + rect.width  > vw - 6) left = Math.max(6, vw - rect.width  - 6);
  if (top  + rect.height > vh - 6) top  = Math.max(6, vh - rect.height - 6);
  menu.style.left = left + 'px';
  menu.style.top  = top + 'px';

  _ctxCloseListeners = {
    mousedown: (e) => { if (!menu.contains(e.target)) closeContextMenu(); },
    keydown:   (e) => { if (e.key === 'Escape') closeContextMenu(); },
    blur:      () => closeContextMenu(),
    resize:    () => closeContextMenu(),
    scroll:    () => closeContextMenu(),
  };
  document.addEventListener('mousedown', _ctxCloseListeners.mousedown, true);
  document.addEventListener('keydown',   _ctxCloseListeners.keydown);
  window.addEventListener('blur',        _ctxCloseListeners.blur);
  window.addEventListener('resize',      _ctxCloseListeners.resize);
  document.addEventListener('scroll',    _ctxCloseListeners.scroll, true);
}

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
    const rnnoise     = modal.querySelector('[data-rnnoise]');
    const noiseSup    = modal.querySelector('[data-noise-suppression]');
    const echoCancel  = modal.querySelector('[data-echo-cancellation]');
    const autoGain    = modal.querySelector('[data-auto-gain]');

    inputVol.value  = settings.voice.inputVol;  inputVolV.textContent  = settings.voice.inputVol  + '%';
    outputVol.value = settings.voice.outputVol; outputVolV.textContent = settings.voice.outputVol + '%';
    if (rnnoise) rnnoise.checked = settings.voice.rnnoise;
    noiseSup.checked   = settings.voice.noiseSuppression;
    echoCancel.checked = settings.voice.echoCancellation;
    autoGain.checked   = settings.voice.autoGain;

    // Noise gate slider (Web Audio gate threshold). Updates live so the
    // user can hear the effect during the mic test loopback below.
    const noiseGate = modal.querySelector('[data-noise-gate]');
    const noiseGateV = modal.querySelector('[data-noise-gate-value]');
    const setNgLabel = (v) => noiseGateV.textContent = v > 0 ? v + ' / 100' : 'off';
    noiseGate.value = settings.voice.noiseGate;
    setNgLabel(settings.voice.noiseGate);
    noiseGate.addEventListener('input', () => {
      settings.voice.noiseGate = +noiseGate.value;
      setNgLabel(settings.voice.noiseGate);
      saveSettings();
    });

    inputVol.addEventListener('input', () => {
      // The MicPipeline's interval reads inputVol live, so changing this
      // setting takes effect within ~50ms in active calls and the test
      // loopback. No teardown needed.
      settings.voice.inputVol  = +inputVol.value;
      inputVolV.textContent    = inputVol.value + '%';
      saveSettings();
    });
    outputVol.addEventListener('input', () => {
      settings.voice.outputVol = +outputVol.value;
      outputVolV.textContent   = outputVol.value + '%';
      saveSettings();
      applyOutputVolumeToActiveAudios();
      // Mic-test loopback isn't tracked by the global helper.
      if (testLoopAudio) testLoopAudio.volume = Math.min(1, settings.voice.outputVol / 100);
    });
    if (rnnoise) rnnoise.addEventListener('change', () => { settings.voice.rnnoise = rnnoise.checked; saveSettings(); });
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
    const refreshBtn = modal.querySelector('[data-refresh-devices]');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', async () => {
        refreshBtn.disabled = true;
        await populateDeviceLists(modal);
        refreshBtn.disabled = false;
      });
    }
    // Devices can change without our knowing (USB plug/unplug). Re-enumerate
    // automatically when the OS tells us about it.
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      const onChange = () => populateDeviceLists(modal);
      navigator.mediaDevices.addEventListener('devicechange', onChange);
      // Clean up on modal close.
      const obs = new MutationObserver(() => {
        if (!document.body.contains(modal)) {
          navigator.mediaDevices.removeEventListener('devicechange', onChange);
          obs.disconnect();
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
    }

    // Mic test with loopback. Uses the same MicPipeline as live calls so
    // the test reflects exactly what peers will hear: RNNoise suppression,
    // input volume, and the noise gate all run inside the pipeline. The
    // analyser node from the pipeline drives the meter.
    let testPipeline = null, testRawStream = null, testRaf = 0, testLoopAudio = null;
    const testBtn      = modal.querySelector('[data-mic-test-btn]');
    const loopbackChk  = modal.querySelector('[data-mic-loopback]');
    const meter        = modal.querySelector('[data-mic-meter]');
    const meterFill    = meter.querySelector('span');
    const stopTest = () => {
      if (testPipeline) { try { testPipeline.destroy(); } catch {} testPipeline = null; }
      if (testRawStream) { for (const t of testRawStream.getTracks()) try { t.stop(); } catch {}; testRawStream = null; }
      if (testLoopAudio) { try { testLoopAudio.pause(); testLoopAudio.srcObject = null; testLoopAudio.remove(); } catch {} testLoopAudio = null; }
      cancelAnimationFrame(testRaf); meterFill.style.width = '0%';
      testBtn.textContent = 'Start test';
    };
    testBtn.addEventListener('click', async () => {
      if (testPipeline) { stopTest(); return; }
      try {
        testRawStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId:         settings.voice.inputDeviceId ? { exact: settings.voice.inputDeviceId } : undefined,
            noiseSuppression: !!settings.voice.noiseSuppression,
            echoCancellation: !!settings.voice.echoCancellation,
            autoGainControl:  !!settings.voice.autoGain,
          },
          video: false,
        });
        testPipeline = new MicPipeline(testRawStream);
        await testPipeline.build();
        if (loopbackChk && loopbackChk.checked) {
          // Audio element rather than ctx.destination so we honour
          // setSinkId for output-device routing.
          testLoopAudio = document.createElement('audio');
          testLoopAudio.autoplay = true;
          testLoopAudio.srcObject = testPipeline.stream;
          testLoopAudio.volume = Math.min(1, (settings.voice.outputVol ?? 100) / 100);
          if (settings.voice.outputDeviceId && testLoopAudio.setSinkId) {
            testLoopAudio.setSinkId(settings.voice.outputDeviceId).catch(() => {});
          }
          document.body.appendChild(testLoopAudio);
        }
        const an = testPipeline.analyser;
        const buf = new Uint8Array(an.frequencyBinCount);
        const tick = () => {
          an.getByteFrequencyData(buf);
          let sum = 0; for (const v of buf) sum += v;
          const avg = sum / buf.length;
          const gateThreshold = settings.voice.noiseGate || 0;
          // Meter shows post-suppression, post-gain, post-gate level. Gate
          // mutes loopback already; this just visualises the gate state.
          const gated = gateThreshold > 0 && avg < gateThreshold;
          const pct = gated ? 0 : Math.min(100, Math.round(avg));
          meterFill.style.width = pct + '%';
          meter.classList.toggle('gated', gated);
          testRaf = requestAnimationFrame(tick);
        };
        tick();
        testBtn.textContent = 'Stop test';
      } catch (e) {
        meterFill.style.width = '0%';
        klog.warn('settings.mictest', 'failed', { err: e.message });
        stopTest();
      }
    });

    // ---- Keybinds tab ----
    const hkList = modal.querySelector('[data-hotkey-list]');
    const hkReset = modal.querySelector('[data-hotkey-reset]');
    if (hkList) {
      const labels = {
        mute:   'Toggle mute',
        deafen: 'Toggle deafen',
        hangup: 'Leave call',
        screen: 'Toggle screen share',
      };
      const renderHotkeys = () => {
        hkList.innerHTML = '';
        for (const action of Object.keys(labels)) {
          const row = document.createElement('div');
          row.className = 'hotkey-row';
          const lbl = document.createElement('div'); lbl.className = 'hotkey-label'; lbl.textContent = labels[action];
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'hotkey-binding';
          btn.textContent = settings.hotkeys[action] ? comboToLabel(settings.hotkeys[action]) : '(unbound)';
          btn.addEventListener('click', () => {
            btn.classList.add('listening');
            btn.textContent = 'Press a combo… (Esc to clear)';
            const onKey = (e) => {
              if (e.key === 'Escape') {
                settings.hotkeys[action] = '';
                e.preventDefault(); e.stopPropagation();
              } else {
                const combo = comboFromEvent(e);
                if (!combo) return; // bare modifier — wait for the actual key
                e.preventDefault(); e.stopPropagation();
                settings.hotkeys[action] = combo;
              }
              saveSettings();
              btn.classList.remove('listening');
              document.removeEventListener('keydown', onKey, true);
              renderHotkeys();
            };
            document.addEventListener('keydown', onKey, true);
          });
          row.appendChild(lbl); row.appendChild(btn);
          hkList.appendChild(row);
        }
      };
      renderHotkeys();
      if (hkReset) {
        hkReset.addEventListener('click', () => {
          settings.hotkeys = { ...DEFAULT_SETTINGS.hotkeys };
          saveSettings();
          renderHotkeys();
        });
      }
    }

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

    // Blocked-users list — populated lazily so we don't block modal open.
    const blockedListEl = modal.querySelector('[data-blocked-list]');
    const renderBlockedList = (users) => {
      blockedListEl.innerHTML = '';
      if (!users.length) {
        const m = document.createElement('div');
        m.className = 'muted small';
        m.textContent = 'You haven\'t blocked anyone.';
        blockedListEl.appendChild(m);
        return;
      }
      for (const u of users) {
        const row = document.createElement('div');
        row.className = 'blocked-row';
        const av = document.createElement('div'); av.className = 'avatar';
        paintAvatar(av, u);
        const meta = document.createElement('div'); meta.className = 'blocked-meta';
        const name = document.createElement('div'); name.className = 'blocked-name';
        name.textContent = u.displayName || u.username;
        const handle = document.createElement('div'); handle.className = 'blocked-handle muted';
        handle.textContent = '@' + u.username;
        meta.appendChild(name); meta.appendChild(handle);
        const btn = document.createElement('button');
        btn.className = 'ghost';
        btn.textContent = 'Unblock';
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try { await api.unblockUser(u.id); row.remove(); }
          catch (e) { btn.disabled = false; alert('Unblock failed: ' + (e.message || 'error')); }
        });
        row.appendChild(av); row.appendChild(meta); row.appendChild(btn);
        blockedListEl.appendChild(row);
      }
    };
    api.listBlocks().then((r) => renderBlockedList(r.blocks || [])).catch((e) => {
      blockedListEl.innerHTML = '<div class="muted small">Failed: ' + (e.message || 'error') + '</div>';
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
    const checkBtn = modal.querySelector('[data-check-updates]');
    const checkStatus = modal.querySelector('[data-update-status]');
    if (checkBtn) {
      const hasCheck = !!(window.klar && window.klar.updates && window.klar.updates.checkNow);
      if (!hasCheck) { checkBtn.disabled = true; checkBtn.textContent = 'Updates require desktop app'; }
      else checkBtn.addEventListener('click', async () => {
        checkBtn.disabled = true;
        checkStatus.textContent = 'Checking…';
        // Forget the dismissed marker so the toast pops if there's a pending update.
        _dismissedUpdateVersion = null;
        try {
          const r = await window.klar.updates.checkNow();
          if (r && r.upToDate)        checkStatus.textContent = `Up to date (${r.installed})`;
          else if (r && r.downloaded) checkStatus.textContent = `Update ${r.latest} downloaded — toast incoming`;
          else if (r && r.error)      checkStatus.textContent = 'Failed: ' + r.error;
          else                        checkStatus.textContent = 'Checked';
        } catch (e) { checkStatus.textContent = 'Failed: ' + (e.message || 'error'); }
        checkBtn.disabled = false;
      });
    }

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
  const status   = modal.querySelector('[data-device-status]');
  if (status) status.textContent = 'Looking for audio devices…';
  // Trigger permission prompt so device labels populate. enumerateDevices
  // returns empty labels until at least one getUserMedia has succeeded.
  let permErr = null;
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const t of tmp.getTracks()) try { t.stop(); } catch {}
  } catch (e) {
    permErr = e;
    klog.warn('settings.devices', 'getUserMedia failed', { err: e.message, name: e.name });
  }
  let devices = [];
  try { devices = await navigator.mediaDevices.enumerateDevices(); }
  catch (e) { klog.error('settings.devices', 'enumerateDevices failed', { err: e.message }); }

  const ins  = devices.filter((x) => x.kind === 'audioinput');
  const outs = devices.filter((x) => x.kind === 'audiooutput');
  const vids = devices.filter((x) => x.kind === 'videoinput');

  const fill = (sel, list, kind, current) => {
    if (!sel) return;
    sel.innerHTML = '';
    const def = document.createElement('option');
    def.value = ''; def.textContent = '(system default)';
    sel.appendChild(def);
    for (const d of list) {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `${kind} (${d.deviceId.slice(0,6)})`;
      sel.appendChild(o);
    }
    sel.value = current || '';
  };
  fill(voiceIn,  ins,  'microphone',  state.settings.voice.inputDeviceId);
  fill(voiceOut, outs, 'output',      state.settings.voice.outputDeviceId);
  fill(videoIn,  vids, 'camera',      state.settings.video.inputDeviceId);

  if (status) {
    if (permErr) {
      status.style.color = 'var(--redshift)';
      status.textContent = 'Microphone permission denied — devices won\'t show. Open Windows Settings → Privacy → Microphone and allow Klar.';
    } else {
      status.style.color = '';
      status.textContent = `Found ${ins.length} mic${ins.length === 1 ? '' : 's'}, ${outs.length} output${outs.length === 1 ? '' : 's'}, ${vids.length} camera${vids.length === 1 ? '' : 's'}.`;
    }
  }
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
      const fd = new FormData(form);
      const name = fd.get('name').toString().trim().toLowerCase();
      const kind = (fd.get('kind') || 'text').toString();
      try {
        const { channel } = await api.createChannel(serverId, name, kind);
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

// Track which version the user has explicitly dismissed in this session, so
// we don't keep re-popping the same toast every minute. A NEWER version
// will still pop the toast (because the version key won't match).
let _dismissedUpdateVersion = null;

function setupUpdateToast() {
  if (!(window.klar && window.klar.updates && typeof window.klar.updates.onAvailable === 'function')) return;

  window.klar.updates.onAvailable((info) => {
    if (_dismissedUpdateVersion === info.to) {
      // User said "Later" for this version. Don't nag them again until a
      // newer version lands.
      return;
    }
    showUpdateToast(info);
  });

  // Renderer-driven polling so we always listen for new releases regardless
  // of the bundled updateCheckIntervalMs (which might be locked at 1hr in
  // older MSIs). Once a friend's MSI picks up this client, every subsequent
  // release reaches them within ~60 seconds.
  if (typeof window.klar.updates.checkNow === 'function') {
    // Quick first check 5s after boot — gives the bundled updater a head
    // start but kicks ours in if it didn't fire.
    setTimeout(() => { window.klar.updates.checkNow().catch(() => {}); }, 5000);
    setInterval(() => {
      window.klar.updates.checkNow().catch(() => {});
    }, 60_000);
  }
}

function showUpdateToast(info) {
  const existing = document.querySelector('[data-update-toast]');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'update-toast';
  toast.dataset.updateToast = '';
  toast.innerHTML = `
    <div class="ut-icon">
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 4v10m0 0l-4-4m4 4l4-4M4 18h16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>
    <div class="ut-body">
      <div class="ut-title">A new version of Klar is ready</div>
      <div class="ut-meta"></div>
    </div>
    <div class="ut-actions">
      <button class="ut-later" type="button">Later</button>
      <button class="ut-apply" type="button">Reload now</button>
    </div>
  `;
  toast.querySelector('.ut-meta').textContent = `${info.from || '?'}  →  ${info.to || '?'}` + (info.alreadyDownloaded ? '  (downloaded, ready)' : '');
  toast.querySelector('.ut-later').addEventListener('click', () => {
    _dismissedUpdateVersion = info.to || null;
    toast.remove();
  });
  toast.querySelector('.ut-apply').addEventListener('click', async () => {
    const btn = toast.querySelector('.ut-apply');
    btn.textContent = 'Applying…';
    btn.disabled = true;
    try { await window.klar.updates.apply(); }
    catch (err) { klog.error('update.apply', 'failed', { err: err.message }); btn.textContent = 'Reload now'; btn.disabled = false; }
  });
  document.body.appendChild(toast);

  // Surface the update via the existing OS-notification + taskbar-flash
  // path — same channel the user already trusts for incoming DMs.
  if (window.klar && window.klar.shell && window.klar.shell.flash) {
    try { window.klar.shell.flash(); } catch {}
  }
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      const n = new Notification('Klar update ready', {
        body: `${info.from || '?'} → ${info.to || '?'}. Click to reload.`,
        silent: true,
        tag: 'klar-update-' + (info.to || 'v'),
        renotify: false,
      });
      n.onclick = async () => {
        try { window.klar.shell.show && window.klar.shell.show(); } catch {}
        try { await window.klar.updates.apply(); } catch {}
        try { n.close(); } catch {}
      };
    } catch {}
  }
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

  // Version chip (top-left). KLAR_CONFIG.version comes from desktop/preload
  // baked-in build metadata (the bundled MSI version). For renderer-only
  // updates we fall back to the auto-update version.json that ensureClient
  // wrote in userData/client/version.json — but we don't have direct
  // access from here. So just show whichever is most accurate; the bundled
  // version is fine since the Settings → Advanced tab shows the full
  // story.
  const verEl = bar.querySelector('[data-titlebar-version]');
  if (verEl) {
    const cfg = (typeof window !== 'undefined' && window.KLAR_CONFIG) || {};
    const v = cfg.clientVersion || cfg.version || 'dev';
    verEl.textContent = 'v' + v;
    verEl.title = 'Klar version ' + v + ' — click for full update info';
    verEl.style.cursor = 'pointer';
    verEl.addEventListener('click', () => openSettingsModal());
  }

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
  setupHotkeys();

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
