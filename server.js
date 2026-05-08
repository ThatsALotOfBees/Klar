import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// `KLAR_DATA_DIR` lets a host (e.g. the packaged Electron desktop app) point
// the writable data root somewhere other than the source directory — typically
// `app.getPath('userData')`. In dev/CLI we just keep everything next to
// server.js. The static assets (PUBLIC_DIR) always live next to server.js.
const DATA_ROOT = process.env.KLAR_DATA_DIR
  ? path.resolve(process.env.KLAR_DATA_DIR)
  : __dirname;
if (!fs.existsSync(DATA_ROOT)) fs.mkdirSync(DATA_ROOT, { recursive: true });

const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_PATH = path.join(DATA_ROOT, 'klar.db');
const KDB_DIR = path.join(DATA_ROOT, 'messages');
const ACCOUNTS_DIR = path.join(DATA_ROOT, 'DATA', 'ACCOUNTS');
const UPLOADS_DIR = path.join(DATA_ROOT, 'DATA', 'UPLOADS');
const PORT = Number(process.env.PORT) || 3000;
const KDB_VERSION = 1;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MiB per file

// .KDB archive: per-DM, per-day JSON Lines log of every message ever sent in
// the conversation. SQLite is still the operational store (indexed, queried);
// these files are an authoritative on-disk archive that's well-sorted by date
// and easy to inspect by hand. One folder per DM, one file per UTC day.
//
// Layout:
//   messages/<usernameA>__<usernameB>/<YYYY-MM-DD>.KDB
//   messages/<usernameA>__<usernameB>/_meta.json
//
// Each line in a .KDB file is a single JSON record:
//   {"v":1,"id":"...","at":"2026-05-06T18:30:45.123Z","from":"alice",
//    "encrypted":false,"content":"hi"}
// For encrypted messages, "content" holds the base64 ciphertext and "nonce"
// holds the base64 IV; the server cannot decrypt them.

function dmFolderName(usernameA, usernameB) {
  // Usernames are validated server-side as [a-z0-9_.-]{3,24}, so no path
  // traversal is possible. Sorted so a DM resolves to one stable folder
  // regardless of who initiated it.
  const sorted = [usernameA, usernameB].slice().sort();
  return `${sorted[0]}__${sorted[1]}`;
}

function ensureKdbFolder(usernameA, usernameB) {
  const folder = path.join(KDB_DIR, dmFolderName(usernameA, usernameB));
  if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder, { recursive: true });
    const meta = {
      v: KDB_VERSION,
      kind: 'klar-dm-archive',
      users: [usernameA, usernameB].slice().sort(),
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(folder, '_meta.json'), JSON.stringify(meta, null, 2) + '\n');
  }
  return folder;
}

function appendKdb(usernameA, usernameB, senderUsername, message) {
  try {
    const folder = ensureKdbFolder(usernameA, usernameB);
    const at = new Date(message.createdAt);
    const date = at.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    const file = path.join(folder, `${date}.KDB`);
    const record = {
      v: KDB_VERSION,
      id: message.id,
      at: at.toISOString(),
      from: senderUsername,
      encrypted: !!message.encrypted,
      content: message.content,
    };
    if (message.encrypted) record.nonce = message.nonce;
    if (message.attachments && message.attachments.length) record.attachments = message.attachments;
    fs.appendFileSync(file, JSON.stringify(record) + '\n');
  } catch (e) {
    console.error('appendKdb failed', e);
  }
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  public_key TEXT NOT NULL,
  encrypted_private_key TEXT NOT NULL,
  encrypted_private_key_nonce TEXT NOT NULL,
  key_salt TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS dms (
  id TEXT PRIMARY KEY,
  user_a TEXT NOT NULL,
  user_b TEXT NOT NULL,
  e2ee_enabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(user_a, user_b),
  FOREIGN KEY(user_a) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(user_b) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  dm_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  content TEXT,
  nonce TEXT,
  encrypted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(dm_id) REFERENCES dms(id) ON DELETE CASCADE,
  FOREIGN KEY(sender_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_dm_created ON messages(dm_id, created_at);

CREATE TABLE IF NOT EXISTS servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS server_members (
  server_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, user_id),
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_members_user ON server_members(user_id);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_channels_server ON channels(server_id, position);

-- Discord-style channel categories. Each category groups channels in the
-- server sidebar; channels with category_id = NULL float above all
-- categories. position orders categories within a server.
CREATE TABLE IF NOT EXISTS channel_categories (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chcat_server ON channel_categories(server_id, position);

CREATE TABLE IF NOT EXISTS channel_messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chmsg_ch_created ON channel_messages(channel_id, created_at);

CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  uploader_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (uploader_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id TEXT NOT NULL,
  blocked_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id),
  FOREIGN KEY (blocker_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (blocked_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked_id);

-- Friendships gate every DM message: status must be 'accepted' before
-- either side can send. Stored with sorted (user_a < user_b) so each
-- pair has exactly one row regardless of who initiated. requester_id
-- records who sent the original request so the recipient can accept.
CREATE TABLE IF NOT EXISTS friendships (
  user_a TEXT NOT NULL,
  user_b TEXT NOT NULL,
  status TEXT NOT NULL,            -- 'pending' | 'accepted'
  requester_id TEXT NOT NULL,      -- whoever called POST /api/friends/request
  created_at INTEGER NOT NULL,
  accepted_at INTEGER,
  PRIMARY KEY (user_a, user_b),
  FOREIGN KEY (user_a) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (user_b) REFERENCES users(id) ON DELETE CASCADE,
  CHECK (user_a < user_b)
);
CREATE INDEX IF NOT EXISTS idx_friendships_a ON friendships(user_a);
CREATE INDEX IF NOT EXISTS idx_friendships_b ON friendships(user_b);

-- Group DMs (separate from 1:1 dms so existing logic stays untouched).
-- members are tracked in group_chat_members. Group messages live in the
-- existing messages table via the new group_chat_id column.
CREATE TABLE IF NOT EXISTS group_chats (
  id TEXT PRIMARY KEY,
  name TEXT,
  owner_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS group_chat_members (
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id),
  FOREIGN KEY (chat_id) REFERENCES group_chats(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_gchat_members_user ON group_chat_members(user_id);

-- Group-chat messages live in their own table to avoid making the
-- existing messages.dm_id column nullable (SQLite ALTER TABLE does not
-- let us drop NOT NULL without recreating). Schema mirrors the
-- messages table minus the legacy E2EE columns.
CREATE TABLE IF NOT EXISTS group_chat_messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  content TEXT,
  created_at INTEGER NOT NULL,
  attachments TEXT,
  FOREIGN KEY (chat_id) REFERENCES group_chats(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_gchat_messages_chat ON group_chat_messages(chat_id, created_at);
`);

// SQLite has no ALTER TABLE ADD COLUMN IF NOT EXISTS — we have to feature-
// detect and ALTER conditionally. The `attachments` column on messages /
// channel_messages stores a JSON array of {url, name, mime, size} objects;
// older rows have NULL and render as "no attachments" without breaking.
function addColumnIfMissing(table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}
addColumnIfMissing('messages',         'attachments', 'TEXT');
addColumnIfMissing('channel_messages', 'attachments', 'TEXT');
// Group DM messages reuse the messages table — make dm_id nullable and
// add a sibling group_chat_id column. Constrained at write-time so
// exactly one is set.
addColumnIfMissing('messages',         'group_chat_id', 'TEXT');
// 'text' | 'announcement' | 'voice'. Voice channels are persistent
// rooms — joining = entering a mesh call scoped to the channel.
addColumnIfMissing('channels',         'kind',        "TEXT NOT NULL DEFAULT 'text'");
// Channel categories (Discord-style). category_id NULL means "uncategorized"
// — those render at the top of the server sidebar above all categories.
// topic is the small description shown in the chat header. user_limit is
// advisory for voice channels: 0 = no soft cap, otherwise a warning shows
// when occupancy approaches it (mesh degrades fast above ~12 active
// speakers, so the default sane cap is 12 unless owner overrides).
addColumnIfMissing('channels',         'category_id',  'TEXT');
addColumnIfMissing('channels',         'topic',        'TEXT');
addColumnIfMissing('channels',         'user_limit',   'INTEGER NOT NULL DEFAULT 0');

db.exec(`
  -- placeholder so the surrounding template literal terminator stays valid

CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  inviter_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  max_uses INTEGER,
  uses INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
  FOREIGN KEY (inviter_id) REFERENCES users(id) ON DELETE CASCADE
);
`);

// ---------- Structured logging ----------
//
// Every event the server handles gets a timestamped, level-tagged line on
// stdout, so the dev shell's `up` / `logs` / `tail` commands give a live
// feed of what's happening. Format:
//   [2026-05-07T01:23:45.678Z] INFO  ws.connect            user=alice n=2
// Level columns are width-aligned and category strings are short tokens,
// so `grep ws.` or `grep auth.` filters cleanly.

function _logFmt(level, category, message, extra) {
  const ts = new Date().toISOString();
  let out = `[${ts}] ${level.padEnd(5)} ${category.padEnd(22)} ${message || ''}`;
  if (extra && typeof extra === 'object') {
    const parts = [];
    for (const k of Object.keys(extra)) {
      const v = extra[k];
      if (v === undefined || v === null) continue;
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      parts.push(`${k}=${s}`);
    }
    if (parts.length) out += (message ? ' ' : '') + parts.join(' ');
  }
  return out;
}
const log = {
  info:  (cat, msg, extra) => console.log(_logFmt('INFO',  cat, msg, extra)),
  warn:  (cat, msg, extra) => console.log(_logFmt('WARN',  cat, msg, extra)),
  error: (cat, msg, extra) => console.error(_logFmt('ERROR', cat, msg, extra)),
};

log.info('server.boot', 'starting', {
  port: Number(process.env.PORT) || 3000,
  pid: process.pid,
  node: process.version,
  dataDir: DATA_ROOT,
});

const newId = () => crypto.randomBytes(12).toString('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const newInviteCode = () => crypto.randomBytes(6).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || crypto.randomBytes(6).toString('hex');
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SERVER_NAME = 60;
const MAX_CHANNEL_NAME = 32;
const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9-_]{0,30}$/i;

function hashPassword(password, saltB64) {
  const salt = saltB64 ? Buffer.from(saltB64, 'base64') : crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return { hash: hash.toString('base64'), salt: salt.toString('base64') };
}
function verifyPassword(password, saltB64, hashB64) {
  const { hash } = hashPassword(password, saltB64);
  const a = Buffer.from(hash, 'base64');
  const b = Buffer.from(hashB64, 'base64');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    publicKey: u.public_key,
  };
}
function selfUser(u) {
  return {
    ...publicUser(u),
    encryptedPrivateKey: u.encrypted_private_key,
    encryptedPrivateKeyNonce: u.encrypted_private_key_nonce,
    keySalt: u.key_salt,
  };
}
function dmRow(d) {
  return {
    id: d.id,
    userA: d.user_a,
    userB: d.user_b,
    e2eeEnabled: !!d.e2ee_enabled,
    createdAt: d.created_at,
  };
}
function messageRow(m) {
  return {
    id: m.id,
    dmId: m.dm_id || null,
    groupChatId: m.group_chat_id || null,
    senderId: m.sender_id,
    content: m.content,
    nonce: m.nonce,
    encrypted: !!m.encrypted,
    createdAt: m.created_at,
    attachments: parseAttachments(m.attachments),
  };
}

// ---- Group chats ----
function groupChatRow(g) {
  if (!g) return null;
  return { id: g.id, name: g.name || '', ownerId: g.owner_id, createdAt: g.created_at };
}
function isGroupChatMember(userId, chatId) {
  return !!db.prepare('SELECT 1 FROM group_chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, userId);
}
function groupChatMembers(chatId) {
  return db.prepare(`
    SELECT u.* FROM users u
    JOIN group_chat_members m ON m.user_id = u.id
    WHERE m.chat_id = ?
    ORDER BY u.display_name ASC
  `).all(chatId);
}
function broadcastToGroupChat(chatId, payload) {
  const members = db.prepare('SELECT user_id FROM group_chat_members WHERE chat_id = ?').all(chatId);
  const msg = JSON.stringify(payload);
  for (const { user_id } of members) {
    const set = sockets.get(user_id);
    if (!set) continue;
    for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

function parseAttachments(raw) {
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}

function sanitizeFilename(name) {
  // Strip path separators + control chars; cap at a reasonable length.
  let s = String(name || 'file').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').trim();
  if (!s) s = 'file';
  if (s.length > 100) {
    const ext = path.extname(s);
    s = s.slice(0, 100 - ext.length) + ext;
  }
  return s;
}

function getUserByToken(token) {
  if (!token) return null;
  const row = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
}

function getDmFor(user, otherUserId) {
  const [a, b] = [user.id, otherUserId].sort();
  return db.prepare('SELECT * FROM dms WHERE user_a = ? AND user_b = ?').get(a, b);
}
function userInDm(user, dm) {
  return dm && (dm.user_a === user.id || dm.user_b === user.id);
}
function otherUserId(user, dm) {
  return dm.user_a === user.id ? dm.user_b : dm.user_a;
}

const sockets = new Map();

// In-memory mesh-room state. roomId can be:
//   - a call UUID (group call session — ephemeral, dies with last leaver)
//   - a voice channel id (persistent room scoped to the channel)
// Each room is just a Set<userId> currently inside it. When a user's WS
// closes we sweep them out of every room they were in.
const rooms = new Map(); // roomId -> Set<userId>
const userRooms = new Map(); // userId -> Set<roomId>

function joinRoom(roomId, userId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  rooms.get(roomId).add(userId);
  if (!userRooms.has(userId)) userRooms.set(userId, new Set());
  userRooms.get(userId).add(roomId);
}
function leaveRoom(roomId, userId) {
  const r = rooms.get(roomId);
  if (r) {
    r.delete(userId);
    if (r.size === 0) rooms.delete(roomId);
  }
  const u = userRooms.get(userId);
  if (u) { u.delete(roomId); if (u.size === 0) userRooms.delete(userId); }
}
function roomMembers(roomId) {
  const r = rooms.get(roomId);
  return r ? Array.from(r) : [];
}
function userIsInRoom(userId, roomId) {
  const u = userRooms.get(userId);
  return !!(u && u.has(roomId));
}
function sweepUserFromRooms(userId) {
  const u = userRooms.get(userId);
  if (!u) return [];
  const swept = Array.from(u);
  for (const roomId of swept) {
    const r = rooms.get(roomId);
    if (r) {
      r.delete(userId);
      if (r.size === 0) rooms.delete(roomId);
    }
  }
  userRooms.delete(userId);
  return swept;
}

function broadcastToUser(userId, payload) {
  const set = sockets.get(userId);
  if (!set) return;
  const msg = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

function broadcastToServer(serverId, payload) {
  const members = db.prepare('SELECT user_id FROM server_members WHERE server_id = ?').all(serverId);
  const msg = JSON.stringify(payload);
  for (const { user_id } of members) {
    const set = sockets.get(user_id);
    if (!set) continue;
    for (const ws of set) {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
  }
}

function publicServer(s) {
  if (!s) return null;
  return { id: s.id, name: s.name, ownerId: s.owner_id, createdAt: s.created_at };
}
function channelRow(c) {
  if (!c) return null;
  const out = {
    id: c.id,
    serverId: c.server_id,
    name: c.name,
    kind: c.kind || 'text',
    position: c.position,
    categoryId: c.category_id || null,
    topic: c.topic || '',
    userLimit: c.user_limit || 0,
    createdAt: c.created_at,
  };
  if (out.kind === 'voice') {
    // Voice channels show live presence in the sidebar. The room id IS
    // the channel id (room.join with that id puts you in this channel's
    // mesh).
    out.voiceMembers = roomMembers(c.id);
  }
  return out;
}

function categoryRow(cat) {
  if (!cat) return null;
  return {
    id: cat.id,
    serverId: cat.server_id,
    name: cat.name,
    position: cat.position,
    createdAt: cat.created_at,
  };
}

// Block lookups. blocks(blocker_id, blocked_id) — directional. We treat
// either direction as "do not deliver", so once A blocks B neither side
// sees the other's messages or DM list entry.
function isBlocked(aId, bId) {
  const row = db.prepare(
    'SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)'
  ).get(aId, bId, bId, aId);
  return !!row;
}
function blockedByMe(meId, otherId) {
  return !!db.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?').get(meId, otherId);
}

// ---- Friendships --------------------------------------------------------
//
// Pairs are stored sorted (user_a < user_b) so a single row covers both
// directions. requester_id records who sent the original request — the
// other party is the only one who can accept it. status is 'pending' or
// 'accepted'. Removing a friend (or declining a request) just deletes
// the row so a fresh request later starts clean.
function _sortedPair(a, b) { return a < b ? [a, b] : [b, a]; }
function getFriendship(aId, bId) {
  const [a, b] = _sortedPair(aId, bId);
  return db.prepare('SELECT * FROM friendships WHERE user_a = ? AND user_b = ?').get(a, b);
}
function areFriends(aId, bId) {
  const f = getFriendship(aId, bId);
  return !!(f && f.status === 'accepted');
}
function friendshipRow(f, meId) {
  if (!f) return null;
  const otherId = f.user_a === meId ? f.user_b : f.user_a;
  const other = db.prepare('SELECT * FROM users WHERE id = ?').get(otherId);
  // status is the public-facing label the renderer checks against.
  // Internally we store 'accepted' but the rest of the codebase uses
  // 'mutual' as the friendly term for a two-sided friendship.
  const publicStatus = f.status === 'accepted' ? 'mutual' : f.status;
  return {
    user: other ? publicUser(other) : null,
    status: publicStatus,
    direction: f.status === 'pending' ? (f.requester_id === meId ? 'outgoing' : 'incoming') : 'mutual',
    createdAt: f.created_at,
    acceptedAt: f.accepted_at || null,
  };
}

// One-shot migration: every existing 1:1 DM gets an auto-accepted
// friendship so older conversations don't go silent the moment the
// gate ships. INSERT OR IGNORE lets us run on every boot safely.
(() => {
  const dms = db.prepare('SELECT user_a, user_b, created_at FROM dms').all();
  const ins = db.prepare(`
    INSERT OR IGNORE INTO friendships
      (user_a, user_b, status, requester_id, created_at, accepted_at)
    VALUES (?, ?, 'accepted', ?, ?, ?)
  `);
  let backfilled = 0;
  for (const d of dms) {
    const [a, b] = _sortedPair(d.user_a, d.user_b);
    const r = ins.run(a, b, a, d.created_at, d.created_at);
    if (r.changes) backfilled++;
  }
  if (backfilled) log.info('friendships.migrate', `auto-friended ${backfilled} existing DM pairs`);
})();
function channelMessageRow(m) {
  return {
    id: m.id,
    channelId: m.channel_id,
    senderId: m.sender_id,
    content: m.content,
    createdAt: m.created_at,
    attachments: parseAttachments(m.attachments),
  };
}

function userIsServerMember(userId, serverId) {
  return !!db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, userId);
}
function userOwnsServer(userId, serverId) {
  const row = db.prepare('SELECT owner_id FROM servers WHERE id = ?').get(serverId);
  return row && row.owner_id === userId;
}

// Channel .KDB archive: messages/server__<server-slug>/<channel-slug>/YYYY-MM-DD.KDB
function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'unnamed';
}
function ensureChannelKdbFolder(server, channel) {
  const folder = path.join(KDB_DIR, `server__${slugify(server.name)}`, slugify(channel.name));
  if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder, { recursive: true });
    const meta = {
      v: KDB_VERSION,
      kind: 'klar-channel-archive',
      serverId: server.id,
      serverName: server.name,
      channelId: channel.id,
      channelName: channel.name,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(folder, '_meta.json'), JSON.stringify(meta, null, 2) + '\n');
  }
  return folder;
}
function appendKdbChannel(server, channel, senderUsername, message) {
  try {
    const folder = ensureChannelKdbFolder(server, channel);
    const at = new Date(message.createdAt);
    const date = at.toISOString().slice(0, 10);
    const file = path.join(folder, `${date}.KDB`);
    const record = {
      v: KDB_VERSION,
      id: message.id,
      at: at.toISOString(),
      from: senderUsername,
      content: message.content,
    };
    if (message.attachments && message.attachments.length) record.attachments = message.attachments;
    fs.appendFileSync(file, JSON.stringify(record) + '\n');
  } catch (e) {
    console.error('appendKdbChannel failed', e);
  }
}

// ---------- Account .KDB persistence ----------
//
// Every registered account is mirrored to DATA/ACCOUNTS/<username>.KDB. On
// boot we (a) restore any account whose KDB file exists but whose row is
// missing from SQLite (recovery from a wiped klar.db) and (b) export any
// existing SQLite row that doesn't yet have a KDB file (one-time migration
// for upgrades). On register we write the file. On username changes we'd
// need to rename the file — usernames are immutable in this schema, so no
// rename path yet.
//
// Each .KDB file is a single JSON line containing the same fields the users
// table stores, including the password hash + salt and the encrypted
// private-key bundle. The file is just as sensitive as the SQLite database;
// DATA/ is in .gitignore.

function ensureAccountsDir() {
  if (!fs.existsSync(ACCOUNTS_DIR)) fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
}
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function writeAccountKdb(u) {
  ensureAccountsDir();
  const file = path.join(ACCOUNTS_DIR, `${u.username}.KDB`);
  const record = {
    v: KDB_VERSION,
    kind: 'klar-account',
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    passwordHash: u.password_hash,
    passwordSalt: u.password_salt,
    publicKey: u.public_key,
    encryptedPrivateKey: u.encrypted_private_key,
    encryptedPrivateKeyNonce: u.encrypted_private_key_nonce,
    keySalt: u.key_salt,
    createdAt: u.created_at,
  };
  fs.writeFileSync(file, JSON.stringify(record) + '\n');
}

function loadAccountsFromKdb() {
  if (!fs.existsSync(ACCOUNTS_DIR)) return 0;
  let restored = 0;
  for (const f of fs.readdirSync(ACCOUNTS_DIR)) {
    if (!f.endsWith('.KDB')) continue;
    try {
      const raw = fs.readFileSync(path.join(ACCOUNTS_DIR, f), 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        const r = JSON.parse(line);
        if (r.kind !== 'klar-account') continue;
        const exists = db.prepare('SELECT 1 FROM users WHERE id = ? OR username = ?').get(r.id, r.username);
        if (exists) continue;
        db.prepare(`INSERT INTO users (id, username, display_name, password_hash, password_salt, public_key, encrypted_private_key, encrypted_private_key_nonce, key_salt, created_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
          r.id, r.username, r.displayName, r.passwordHash, r.passwordSalt,
          r.publicKey, r.encryptedPrivateKey, r.encryptedPrivateKeyNonce, r.keySalt, r.createdAt
        );
        restored++;
      }
    } catch (e) {
      console.error(`load account kdb ${f}:`, e.message);
    }
  }
  return restored;
}

function exportExistingAccountsToKdb() {
  ensureAccountsDir();
  const rows = db.prepare('SELECT * FROM users').all();
  let exported = 0;
  for (const u of rows) {
    const file = path.join(ACCOUNTS_DIR, `${u.username}.KDB`);
    if (!fs.existsSync(file)) {
      writeAccountKdb(u);
      exported++;
    }
  }
  return exported;
}

const accountsRestored = loadAccountsFromKdb();
const accountsExported = exportExistingAccountsToKdb();
log.info('accounts.kdb', 'KDB sync done', {
  restored: accountsRestored,
  exported: accountsExported,
  dir: path.relative(__dirname, ACCOUNTS_DIR),
});

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
    'Content-Length': Buffer.byteLength(data),
    ...headers,
  });
  res.end(data);
}
function sendError(res, status, message, extra) {
  send(res, status, { error: message, ...(extra || {}) });
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > 1_000_000) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

function authedUser(req) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return getUserByToken(auth.slice(7));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
};

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  // /uploads/<id>/<filename> -> DATA/UPLOADS/<id>/<filename>
  // We look up the row to validate the id exists and to reject stray
  // requests, but we serve the file straight from disk for streaming.
  if (urlPath.startsWith('/uploads/')) {
    const m = urlPath.match(/^\/uploads\/([a-f0-9]{8,})\/([^/]+)$/);
    if (!m) return sendError(res, 404, 'not found');
    const row = db.prepare('SELECT * FROM uploads WHERE id = ?').get(m[1]);
    if (!row) return sendError(res, 404, 'not found');
    const file = path.join(UPLOADS_DIR, row.id, row.filename);
    try {
      const stat = await fs.promises.stat(file);
      const stream = fs.createReadStream(file);
      res.writeHead(200, {
        'Content-Type': row.mime || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      return stream.pipe(res);
    } catch {
      return sendError(res, 404, 'not found');
    }
  }

  const safe = path.normalize(urlPath).replace(/^([\\/])+/, '');
  let filePath = path.join(PUBLIC_DIR, safe === '' ? 'index.html' : safe);
  if (!filePath.startsWith(PUBLIC_DIR)) return sendError(res, 403, 'forbidden');
  let stat;
  try { stat = await fs.promises.stat(filePath); } catch { stat = null; }
  if (!stat || stat.isDirectory()) filePath = path.join(PUBLIC_DIR, 'index.html');
  try {
    const data = await fs.promises.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
    });
    res.end(data);
  } catch (e) {
    sendError(res, 404, 'not found');
  }
}

// POST /api/uploads — single-file upload. The renderer sets:
//   Content-Type:    <mime/type>
//   X-Klar-Filename: original-filename.ext   (optional; defaults to "file")
// and PUTs the raw bytes. We avoid multipart entirely because parsing it in
// vanilla Node is annoying and Klar's clients are all in our control.
async function handleUpload(req, res) {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  const declared = Number(req.headers['content-length'] || '0');
  if (declared > MAX_UPLOAD_BYTES) return sendError(res, 413, `file too large (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB)`);
  const mime = (req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
  const rawName = req.headers['x-klar-filename'] || 'file';
  const safeName = sanitizeFilename(decodeURIComponent(String(rawName)));

  const id = newId();
  const dir = path.join(UPLOADS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, safeName);

  let total = 0;
  let aborted = false;
  const ws = fs.createWriteStream(target);
  await new Promise((resolve, reject) => {
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_UPLOAD_BYTES) {
        aborted = true;
        ws.destroy();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
        sendError(res, 413, `file too large (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB)`);
        req.destroy();
        return reject(new Error('too large'));
      }
      ws.write(c);
    });
    req.on('end', () => { ws.end(); });
    req.on('error', reject);
    ws.on('finish', resolve);
    ws.on('error', reject);
  }).catch(() => {});
  if (aborted) return;
  if (!total) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    return sendError(res, 400, 'empty file');
  }

  db.prepare('INSERT INTO uploads (id, uploader_id, filename, mime, size, created_at) VALUES (?,?,?,?,?,?)')
    .run(id, me.id, safeName, mime, total, Date.now());

  const url = `/uploads/${id}/${encodeURIComponent(safeName)}`;
  log.info('upload.create', 'file received', { user: me.username, id, mime, bytes: total, name: safeName });
  send(res, 200, { id, url, filename: safeName, mime, size: total });
}

// POST /api/uploads/catbox — proxy upload to catbox.moe.
// catbox doesn't send CORS headers, so browsers can't POST to it directly.
// We buffer the body in memory (capped at MAX_UPLOAD_BYTES), forward via
// multipart/form-data, and return the catbox URL. Catbox-hosted media
// embeds via the same URL-extension detection as any other CDN.
async function handleCatboxUpload(req, res) {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  const declared = Number(req.headers['content-length'] || '0');
  if (declared > MAX_UPLOAD_BYTES) return sendError(res, 413, `file too large (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB)`);
  const mime = (req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
  const rawName = req.headers['x-klar-filename'] || 'file';
  const safeName = sanitizeFilename(decodeURIComponent(String(rawName)));

  // Buffer the body. We cap aggressively so a malicious client can't OOM us.
  const chunks = [];
  let total = 0;
  let aborted = false;
  await new Promise((resolve) => {
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_UPLOAD_BYTES) {
        aborted = true;
        sendError(res, 413, `file too large (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB)`);
        try { req.destroy(); } catch {}
        return resolve();
      }
      chunks.push(c);
    });
    req.on('end', resolve);
    req.on('error', resolve);
  });
  if (aborted) return;
  if (!total) return sendError(res, 400, 'empty file');
  const buf = Buffer.concat(chunks);

  // Build multipart body for catbox.
  const boundary = '----klar' + crypto.randomBytes(16).toString('hex');
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="reqtype"\r\n\r\n` +
    `fileupload\r\n` +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="fileToUpload"; filename="${safeName.replace(/"/g, '_')}"\r\n` +
    `Content-Type: ${mime}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, buf, tail]);

  let upstream;
  try {
    upstream = await fetch('https://catbox.moe/user/api.php', {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
        'User-Agent': 'klar/0.1 (+https://github.com/ThatsALotOfBees/Klar)',
      },
      body,
    });
  } catch (e) {
    log.error('upload.catbox', 'network failure', { err: e.message, name: safeName });
    return sendError(res, 502, 'catbox unreachable: ' + e.message);
  }
  const text = (await upstream.text()).trim();
  if (!upstream.ok || !text.startsWith('https://files.catbox.moe/')) {
    log.error('upload.catbox', 'rejected', { status: upstream.status, body: text.slice(0, 200), name: safeName });
    return sendError(res, 502, 'catbox upload failed (' + upstream.status + '): ' + text.slice(0, 200));
  }
  log.info('upload.catbox', 'uploaded', { user: me.username, url: text, mime, bytes: total, name: safeName });
  send(res, 200, { url: text, filename: safeName, mime, size: total });
}

// Tiny URL-allowlist so the embed resolver doesn't become a generic SSRF
// proxy. Add hosts here as needed; we currently only need medal.tv. Other
// hosts that publish og:video can be added freely.
const EMBED_ALLOWED_HOSTS = new Set([
  'medal.tv',
  'www.medal.tv',
]);

// POST /api/embed/resolve — fetch a third-party URL and extract OpenGraph
// video / thumbnail / title metadata. Used by the renderer to inline a
// custom video player for sites like medal.tv that publish og:video.
async function handleEmbedResolve(req, res) {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  let body;
  try { body = await readJson(req); }
  catch { return sendError(res, 400, 'invalid json'); }
  const url = String(body && body.url || '');
  let parsed;
  try { parsed = new URL(url); }
  catch { return sendError(res, 400, 'invalid url'); }
  if (parsed.protocol !== 'https:') return sendError(res, 400, 'https only');
  if (!EMBED_ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
    return sendError(res, 403, 'host not allowlisted');
  }

  let upstream;
  try {
    upstream = await fetch(parsed.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; klar-embed/0.1)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
  } catch (e) {
    return sendError(res, 502, 'fetch failed: ' + e.message);
  }
  if (!upstream.ok) return sendError(res, 502, 'upstream ' + upstream.status);
  const html = (await upstream.text()).slice(0, 256 * 1024); // cap parse cost

  const meta = (prop) => {
    // Match meta tags with property="..." OR name="..." in either attribute order.
    const re = new RegExp(`<meta\\s+(?:property|name)=["']${prop}["']\\s+content=["']([^"']+)["']|<meta\\s+content=["']([^"']+)["']\\s+(?:property|name)=["']${prop}["']`, 'i');
    const m = html.match(re);
    return m ? (m[1] || m[2]) : null;
  };
  const out = {
    url: parsed.toString(),
    videoUrl:  meta('og:video:secure_url') || meta('og:video:url') || meta('og:video') || null,
    videoType: meta('og:video:type') || null,
    thumbnail: meta('og:image:secure_url') || meta('og:image') || null,
    title:     meta('og:title') || null,
    site:      meta('og:site_name') || parsed.hostname,
    width:     Number(meta('og:video:width'))  || null,
    height:    Number(meta('og:video:height')) || null,
  };
  log.info('embed.resolve', 'ok', { user: me.username, host: parsed.hostname, hasVideo: !!out.videoUrl });
  send(res, 200, out);
}

const routes = [];
function route(method, pattern, handler) { routes.push({ method, pattern, handler }); }

route('POST', /^\/api\/register$/, async (req, res) => {
  const body = await readJson(req);
  const { username, displayName, password } = body;
  if (typeof username !== 'string' || !/^[a-z0-9_.-]{3,24}$/i.test(username)) return sendError(res, 400, 'invalid username (3-24 chars, letters/digits/._-)');
  if (typeof password !== 'string' || password.length < 8) return sendError(res, 400, 'password must be at least 8 characters');
  // Key material is optional now (E2EE was removed in 0.1.8). Older clients
  // may still send the fields; we accept them but never use them.
  const publicKey                = (body.publicKey || '');
  const encryptedPrivateKey      = (body.encryptedPrivateKey || '');
  const encryptedPrivateKeyNonce = (body.encryptedPrivateKeyNonce || '');
  const keySalt                  = (body.keySalt || '');
  const lname = username.toLowerCase();
  const dname = (displayName && String(displayName).trim()) || username;
  const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(lname);
  if (exists) return sendError(res, 409, 'username taken');
  const { hash, salt } = hashPassword(password);
  const id = newId();
  db.prepare(`INSERT INTO users (id, username, display_name, password_hash, password_salt, public_key, encrypted_private_key, encrypted_private_key_nonce, key_salt, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    id, lname, dname, hash, salt, publicKey, encryptedPrivateKey, encryptedPrivateKeyNonce, keySalt, Date.now()
  );
  const token = newToken();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(token, id, Date.now(), Date.now() + SESSION_TTL_MS);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  writeAccountKdb(user);
  log.info('auth.register', 'new account', { user: user.username, id: user.id });
  send(res, 200, { token, user: selfUser(user) });
});

route('POST', /^\/api\/login$/, async (req, res) => {
  const { username, password } = await readJson(req);
  if (typeof username !== 'string' || typeof password !== 'string') return sendError(res, 400, 'username and password required');
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.toLowerCase());
  if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
    log.warn('auth.login', 'invalid credentials', { user: String(username).toLowerCase() });
    return sendError(res, 401, 'invalid credentials');
  }
  const token = newToken();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(token, user.id, Date.now(), Date.now() + SESSION_TTL_MS);
  log.info('auth.login', 'logged in', { user: user.username });
  send(res, 200, { token, user: selfUser(user) });
});

route('POST', /^\/api\/logout$/, async (req, res) => {
  const auth = req.headers['authorization'];
  let username = null;
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7);
    const u = getUserByToken(token);
    if (u) username = u.username;
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }
  log.info('auth.logout', 'session ended', { user: username || '(unknown)' });
  send(res, 200, { ok: true });
});

route('GET', /^\/api\/me$/, async (req, res) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  send(res, 200, { user: selfUser(me) });
});

// PATCH /api/me — update mutable profile fields. Currently only displayName.
// Username is immutable (used as filesystem identifier in DATA/ACCOUNTS).
route('PATCH', /^\/api\/me$/, async (req, res) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  const body = await readJson(req);
  const updates = [];
  const args = [];
  if (typeof body.displayName === 'string') {
    const dn = body.displayName.trim();
    if (!dn || dn.length > 60) return sendError(res, 400, 'displayName must be 1-60 characters');
    updates.push('display_name = ?');
    args.push(dn);
  }
  if (!updates.length) return sendError(res, 400, 'no updatable fields provided');
  args.push(me.id);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...args);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(me.id);
  writeAccountKdb(updated);
  log.info('user.update', 'profile updated', { user: updated.username, fields: updates.length });
  send(res, 200, { user: selfUser(updated) });
});

route('GET', /^\/api\/blocks$/, async (req, res) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  const rows = db.prepare(`
    SELECT u.* FROM blocks b
    JOIN users u ON u.id = b.blocked_id
    WHERE b.blocker_id = ?
    ORDER BY b.created_at DESC
  `).all(me.id);
  send(res, 200, { blocks: rows.map(publicUser) });
});

route('POST', /^\/api\/users\/([a-f0-9]+)\/block$/, async (req, res, [, userId]) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  if (userId === me.id) return sendError(res, 400, 'cannot block yourself');
  const other = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!other) return sendError(res, 404, 'user not found');
  db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?,?,?)')
    .run(me.id, userId, Date.now());
  log.info('user.block', 'blocked', { by: me.username, target: other.username });
  // Tell both clients (mine + theirs) so DM lists refresh.
  broadcastToUser(me.id,    { type: 'block_updated', userId: other.id, blocked: true,  by: 'me' });
  broadcastToUser(other.id, { type: 'block_updated', userId: me.id,    blocked: true,  by: 'them' });
  send(res, 200, { ok: true });
});

route('DELETE', /^\/api\/users\/([a-f0-9]+)\/block$/, async (req, res, [, userId]) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(me.id, userId);
  log.info('user.unblock', 'unblocked', { by: me.username, target: userId.slice(0, 8) });
  broadcastToUser(me.id,   { type: 'block_updated', userId, blocked: false, by: 'me' });
  broadcastToUser(userId,  { type: 'block_updated', userId: me.id, blocked: false, by: 'them' });
  send(res, 200, { ok: true });
});

route('GET', /^\/api\/users\/search/, async (req, res) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  const url = new URL(req.url, 'http://x');
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  if (!q) return send(res, 200, { users: [] });
  const rows = db.prepare(`SELECT * FROM users WHERE username LIKE ? AND id != ? ORDER BY username LIMIT 20`)
    .all(`%${q}%`, me.id);
  send(res, 200, { users: rows.map(publicUser) });
});

// ---- Friendships --------------------------------------------------------

route('GET', /^\/api\/friends$/, async (req, res) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  const rows = db.prepare(`SELECT * FROM friendships WHERE user_a = ? OR user_b = ? ORDER BY created_at DESC`).all(me.id, me.id);
  send(res, 200, { friends: rows.map((f) => friendshipRow(f, me.id)).filter(Boolean) });
});

// Send a friend request by username. Body: { username }.
// 200 → { friend } with status 'pending' if new, or whatever the row already is.
route('POST', /^\/api\/friends\/request$/, async (req, res) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  const body = await readJson(req);
  const username = String((body.username || '')).trim().toLowerCase();
  if (!username) return sendError(res, 400, 'username required');
  const other = db.prepare('SELECT * FROM users WHERE LOWER(username) = ?').get(username);
  if (!other) return sendError(res, 404, 'user not found');
  if (other.id === me.id) return sendError(res, 400, 'cannot friend yourself');
  if (isBlocked(me.id, other.id)) return sendError(res, 403, 'cannot friend a blocked user');

  const existing = getFriendship(me.id, other.id);
  if (existing) {
    // If the other side already requested us, treat this as an accept so
    // the request → counter-request flow Just Works.
    if (existing.status === 'pending' && existing.requester_id === other.id) {
      const [a, b] = _sortedPair(me.id, other.id);
      db.prepare("UPDATE friendships SET status = 'accepted', accepted_at = ? WHERE user_a = ? AND user_b = ?")
        .run(Date.now(), a, b);
      const updated = getFriendship(me.id, other.id);
      log.info('friend.accept', 'auto-accepted via reverse-request', { me: me.username, other: other.username });
      broadcastToUser(me.id,   { type: 'friend_updated', friend: friendshipRow(updated, me.id) });
      broadcastToUser(other.id,{ type: 'friend_updated', friend: friendshipRow(updated, other.id) });
      return send(res, 200, { friend: friendshipRow(updated, me.id) });
    }
    return send(res, 200, { friend: friendshipRow(existing, me.id) });
  }
  const [a, b] = _sortedPair(me.id, other.id);
  const now = Date.now();
  db.prepare(`INSERT INTO friendships (user_a, user_b, status, requester_id, created_at) VALUES (?,?,?,?,?)`)
    .run(a, b, 'pending', me.id, now);
  const created = getFriendship(me.id, other.id);
  log.info('friend.request', 'created', { from: me.username, to: other.username });
  broadcastToUser(me.id,    { type: 'friend_updated', friend: friendshipRow(created, me.id) });
  broadcastToUser(other.id, { type: 'friend_updated', friend: friendshipRow(created, other.id) });
  send(res, 200, { friend: friendshipRow(created, me.id) });
});

// Accept a pending request from userId.
route('POST', /^\/api\/friends\/([a-f0-9]+)\/accept$/, async (req, res, [, userId]) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  const f = getFriendship(me.id, userId);
  if (!f || f.status !== 'pending') return sendError(res, 404, 'no pending request from that user');
  if (f.requester_id === me.id)     return sendError(res, 400, 'only the recipient can accept');
  const [a, b] = _sortedPair(me.id, userId);
  db.prepare("UPDATE friendships SET status = 'accepted', accepted_at = ? WHERE user_a = ? AND user_b = ?")
    .run(Date.now(), a, b);
  const updated = getFriendship(me.id, userId);
  log.info('friend.accept', 'accepted', { me: me.username, other: userId.slice(0, 8) });
  broadcastToUser(me.id,   { type: 'friend_updated', friend: friendshipRow(updated, me.id) });
  broadcastToUser(userId,  { type: 'friend_updated', friend: friendshipRow(updated, userId) });
  send(res, 200, { friend: friendshipRow(updated, me.id) });
});

// Decline a pending request OR remove an existing friend OR cancel an
// outgoing request — all collapse to "delete the row".
route('DELETE', /^\/api\/friends\/([a-f0-9]+)$/, async (req, res, [, userId]) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  const f = getFriendship(me.id, userId);
  if (!f) return send(res, 200, { ok: true });
  const [a, b] = _sortedPair(me.id, userId);
  db.prepare('DELETE FROM friendships WHERE user_a = ? AND user_b = ?').run(a, b);
  log.info('friend.remove', 'removed', { me: me.username, other: userId.slice(0, 8), wasStatus: f.status });
  broadcastToUser(me.id,  { type: 'friend_removed', userId });
  broadcastToUser(userId, { type: 'friend_removed', userId: me.id });
  send(res, 200, { ok: true });
});

route('GET', /^\/api\/dms$/, async (req, res) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  const rows = db.prepare(`SELECT d.*, m.last_at FROM dms d
    LEFT JOIN (SELECT dm_id, MAX(created_at) AS last_at FROM messages GROUP BY dm_id) m ON m.dm_id = d.id
    WHERE d.user_a = ? OR d.user_b = ?
    ORDER BY COALESCE(m.last_at, d.created_at) DESC`).all(me.id, me.id);
  const out = [];
  for (const d of rows) {
    const otherId = d.user_a === me.id ? d.user_b : d.user_a;
    // Hide DMs where either side has blocked the other.
    if (isBlocked(me.id, otherId)) continue;
    const other = db.prepare('SELECT * FROM users WHERE id = ?').get(otherId);
    out.push({ ...dmRow(d), other: publicUser(other), lastAt: d.last_at || d.created_at });
  }
  send(res, 200, { dms: out });
});

route('POST', /^\/api\/dms$/, async (req, res) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  const { userId } = await readJson(req);
  if (!userId || userId === me.id) return sendError(res, 400, 'invalid userId');
  const other = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!other) return sendError(res, 404, 'user not found');
  if (isBlocked(me.id, other.id)) return sendError(res, 403, 'user is blocked');
  let dm = getDmFor(me, other.id);
  if (!dm) {
    const [a, b] = [me.id, other.id].sort();
    const id = newId();
    db.prepare('INSERT INTO dms (id, user_a, user_b, e2ee_enabled, created_at) VALUES (?,?,?,0,?)')
      .run(id, a, b, Date.now());
    dm = db.prepare('SELECT * FROM dms WHERE id = ?').get(id);
    log.info('dm.create', 'new dm', { dm: dm.id, a: me.username, b: other.username });
    const payload = { type: 'dm_created', dm: { ...dmRow(dm), other: publicUser(me), lastAt: dm.created_at } };
    broadcastToUser(other.id, payload);
  }
  send(res, 200, { dm: { ...dmRow(dm), other: publicUser(other), lastAt: dm.created_at } });
});

route('PATCH', /^\/api\/dms\/([a-f0-9]+)$/, async (req, res, [, dmId]) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  const dm = db.prepare('SELECT * FROM dms WHERE id = ?').get(dmId);
  if (!dm || !userInDm(me, dm)) return sendError(res, 404, 'dm not found');
  const { e2eeEnabled } = await readJson(req);
  if (typeof e2eeEnabled !== 'boolean') return sendError(res, 400, 'e2eeEnabled must be boolean');
  db.prepare('UPDATE dms SET e2ee_enabled = ? WHERE id = ?').run(e2eeEnabled ? 1 : 0, dm.id);
  const updated = db.prepare('SELECT * FROM dms WHERE id = ?').get(dm.id);
  log.info('dm.e2ee', 'toggled', { dm: dm.id, by: me.username, enabled: e2eeEnabled });
  const payload = { type: 'dm_updated', dmId: dm.id, e2eeEnabled };
  broadcastToUser(dm.user_a, payload);
  broadcastToUser(dm.user_b, payload);
  send(res, 200, { dm: dmRow(updated) });
});

route('GET', /^\/api\/dms\/([a-f0-9]+)\/messages$/, async (req, res, [, dmId]) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  const dm = db.prepare('SELECT * FROM dms WHERE id = ?').get(dmId);
  if (!dm || !userInDm(me, dm)) return sendError(res, 404, 'dm not found');
  const url = new URL(req.url, 'http://x');
  const before = Number(url.searchParams.get('before')) || Date.now() + 1;
  // Default to 1000 (and cap at 5000) — Klar conversations are small enough
  // that returning the full history on first open is fine and saves a
  // scrollback-pagination round-trip. Bump higher if anyone hits the cap.
  const limit = Math.min(Number(url.searchParams.get('limit')) || 1000, 5000);
  const rows = db.prepare(`SELECT * FROM messages WHERE dm_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`)
    .all(dm.id, before, limit);
  send(res, 200, { messages: rows.reverse().map(messageRow) });
});

route('POST', /^\/api\/dms\/([a-f0-9]+)\/messages$/, async (req, res, [, dmId]) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  const dm = db.prepare('SELECT * FROM dms WHERE id = ?').get(dmId);
  if (!dm || !userInDm(me, dm)) return sendError(res, 404, 'dm not found');
  // Refuse if either side has blocked the other.
  const otherId = otherUserId(me, dm);
  if (isBlocked(me.id, otherId)) return sendError(res, 403, 'cannot send: user is blocked');
  // Friendship gate: both sides must have accepted before chat is allowed.
  // 403 + code:'not_friends' so the renderer can show a tailored message
  // instead of the generic error.
  if (!areFriends(me.id, otherId)) {
    const f = getFriendship(me.id, otherId);
    let detail = 'send a friend request first';
    if (f && f.status === 'pending') {
      detail = f.requester_id === me.id
        ? 'waiting for them to accept your friend request'
        : 'they sent you a friend request — accept it first';
    }
    return sendError(res, 403, 'not friends — ' + detail, { code: 'not_friends' });
  }
  const body = await readJson(req);
  const content = body.content || '';
  // E2EE was removed in 0.1.8; we ignore any encrypted/nonce fields a stale
  // client might still send and store the message as plaintext.
  const rawAtt = Array.isArray(body.attachments) ? body.attachments : [];
  // A message must have content OR attachments. Attachment-only messages
  // (e.g. just an image upload) are valid.
  if ((typeof content !== 'string' || !content.trim()) && rawAtt.length === 0) {
    return sendError(res, 400, 'content or attachments required');
  }
  if (content.length > 4000) return sendError(res, 400, 'content too long');

  // Validate attachment refs:
  //   - relative /uploads/<id>/<name> URLs must resolve to a known upload
  //   - https://files.catbox.moe/* URLs are accepted at face value (the
  //     upload went through our /api/uploads/catbox proxy which already
  //     authenticated the user; the URL is publicly resolvable).
  // Anything else is dropped silently to avoid letting clients smuggle
  // arbitrary URLs into messages as "attachments".
  const attachments = [];
  for (const a of rawAtt.slice(0, 10)) {
    if (!a || typeof a.url !== 'string') continue;
    const m = a.url.match(/^\/uploads\/([a-f0-9]{8,})\/([^/]+)$/);
    if (m) {
      const row = db.prepare('SELECT * FROM uploads WHERE id = ?').get(m[1]);
      if (!row) continue;
      attachments.push({ url: a.url, name: row.filename, mime: row.mime, size: row.size });
      continue;
    }
    if (/^https:\/\/files\.catbox\.moe\/[a-z0-9._-]+$/i.test(a.url)) {
      attachments.push({
        url: a.url,
        name: typeof a.name === 'string' ? a.name.slice(0, 100) : a.url.split('/').pop(),
        mime: typeof a.mime === 'string' ? a.mime.slice(0, 80) : 'application/octet-stream',
        size: Number.isFinite(a.size) && a.size > 0 ? Math.min(a.size, 1_000_000_000) : 0,
      });
      continue;
    }
  }
  const attJson = attachments.length ? JSON.stringify(attachments) : null;

  // Optional client-side tracking id, used by the optimistic-send UI to
  // match the WS broadcast against the dimmed local row and replace it.
  const clientId = (typeof body.clientId === 'string' && body.clientId.length <= 64) ? body.clientId : null;

  const id = newId();
  const createdAt = Date.now();
  db.prepare('INSERT INTO messages (id, dm_id, sender_id, content, nonce, encrypted, created_at, attachments) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, dm.id, me.id, content, null, 0, createdAt, attJson);
  const message = messageRow({ id, dm_id: dm.id, sender_id: me.id, content, nonce: null, encrypted: 0, created_at: createdAt, attachments: attJson });
  if (clientId) message.clientId = clientId;

  // Also append to the on-disk .KDB archive for this conversation.
  const userA = db.prepare('SELECT username FROM users WHERE id = ?').get(dm.user_a);
  const userB = db.prepare('SELECT username FROM users WHERE id = ?').get(dm.user_b);
  if (userA && userB) appendKdb(userA.username, userB.username, me.username, message);

  log.info('msg.dm', 'message sent', {
    dm: dm.id, from: me.username,
    to: (me.id === dm.user_a ? userB && userB.username : userA && userA.username) || '?',
    bytes: content.length,
  });

  const payload = { type: 'message', message };
  broadcastToUser(dm.user_a, payload);
  if (dm.user_a !== dm.user_b) broadcastToUser(dm.user_b, payload);
  send(res, 200, { message });
});

// DELETE /api/dms/:dmId/messages/:msgId — only the original sender can
// delete their own message. We append a delete marker to the .KDB archive
// (auditable) but don't actually rewrite the day's KDB file. Attachment
// uploads are kept on disk in case other messages reference the same URL;
// orphan-cleanup is a separate housekeeping concern.
route('DELETE', /^\/api\/dms\/([a-f0-9]+)\/messages\/([a-f0-9]+)$/, async (req, res, [, dmId, msgId]) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  const dm = db.prepare('SELECT * FROM dms WHERE id = ?').get(dmId);
  if (!dm || !userInDm(me, dm)) return sendError(res, 404, 'dm not found');
  const m = db.prepare('SELECT * FROM messages WHERE id = ? AND dm_id = ?').get(msgId, dmId);
  if (!m) return sendError(res, 404, 'message not found');
  if (m.sender_id !== me.id) return sendError(res, 403, 'only the sender can delete a message');
  db.prepare('DELETE FROM messages WHERE id = ?').run(msgId);
  log.info('msg.dm.delete', 'deleted', { dm: dmId, msg: msgId, by: me.username });
  const payload = { type: 'message_deleted', dmId, messageId: msgId };
  broadcastToUser(dm.user_a, payload);
  if (dm.user_a !== dm.user_b) broadcastToUser(dm.user_b, payload);
  send(res, 200, { ok: true });
});

route('GET', /^\/api\/dms\/([a-f0-9]+)\/archive$/, async (req, res, [, dmId]) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  const dm = db.prepare('SELECT * FROM dms WHERE id = ?').get(dmId);
  if (!dm || !userInDm(me, dm)) return sendError(res, 404, 'dm not found');
  const userA = db.prepare('SELECT username FROM users WHERE id = ?').get(dm.user_a);
  const userB = db.prepare('SELECT username FROM users WHERE id = ?').get(dm.user_b);
  if (!userA || !userB) return sendError(res, 404, 'dm not found');
  const folder = path.join(KDB_DIR, dmFolderName(userA.username, userB.username));
  if (!fs.existsSync(folder)) return send(res, 200, { folder: null, files: [] });
  const files = fs.readdirSync(folder)
    .filter((f) => f.endsWith('.KDB'))
    .sort()
    .map((f) => {
      const full = path.join(folder, f);
      const st = fs.statSync(full);
      return { name: f, size: st.size, mtime: st.mtimeMs };
    });
  send(res, 200, { folder: path.relative(__dirname, folder), files });
});

// ---------------- Group chats (multi-party DMs) ----------------

route('GET', /^\/api\/group-chats$/, async (req, res) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  const rows = db.prepare(`
    SELECT g.*, m.last_at FROM group_chats g
    JOIN group_chat_members me ON me.chat_id = g.id AND me.user_id = ?
    LEFT JOIN (SELECT chat_id, MAX(created_at) AS last_at FROM group_chat_messages GROUP BY chat_id) m
      ON m.chat_id = g.id
    ORDER BY COALESCE(m.last_at, g.created_at) DESC
  `).all(me.id);
  const out = rows.map((g) => ({
    ...groupChatRow(g),
    members: groupChatMembers(g.id).map(publicUser),
    lastAt: g.last_at || g.created_at,
  }));
  send(res, 200, { groupChats: out });
});

route('POST', /^\/api\/group-chats$/, async (req, res) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  const body = await readJson(req);
  const name = (body.name || '').toString().trim().slice(0, 60);
  const memberIds = Array.isArray(body.memberIds) ? body.memberIds.slice(0, 24) : [];
  if (!memberIds.length) return sendError(res, 400, 'at least one other member required');
  // Validate every member id resolves to a real user.
  const validMembers = [];
  for (const id of memberIds) {
    if (id === me.id) continue;
    const u = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
    if (u) validMembers.push(id);
  }
  if (!validMembers.length) return sendError(res, 400, 'no valid members');
  const id = newId();
  const now = Date.now();
  db.prepare('INSERT INTO group_chats (id, name, owner_id, created_at) VALUES (?,?,?,?)').run(id, name, me.id, now);
  db.prepare('INSERT INTO group_chat_members (chat_id, user_id, joined_at) VALUES (?,?,?)').run(id, me.id, now);
  for (const mid of validMembers) {
    db.prepare('INSERT INTO group_chat_members (chat_id, user_id, joined_at) VALUES (?,?,?)').run(id, mid, now);
  }
  const row = db.prepare('SELECT * FROM group_chats WHERE id = ?').get(id);
  log.info('gchat.create', 'created', { chat: id, owner: me.username, members: validMembers.length + 1 });
  // Notify all members so their sidebars update in real time.
  const payload = {
    type: 'group_chat_created',
    chat: { ...groupChatRow(row), members: groupChatMembers(id).map(publicUser), lastAt: now },
  };
  broadcastToGroupChat(id, payload);
  send(res, 200, payload.chat);
});

route('GET', /^\/api\/group-chats\/([a-f0-9]+)$/, async (req, res, [, chatId]) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  if (!isGroupChatMember(me.id, chatId)) return sendError(res, 404, 'group chat not found');
  const row = db.prepare('SELECT * FROM group_chats WHERE id = ?').get(chatId);
  if (!row) return sendError(res, 404, 'group chat not found');
  send(res, 200, {
    ...groupChatRow(row),
    members: groupChatMembers(chatId).map(publicUser),
  });
});

route('PATCH', /^\/api\/group-chats\/([a-f0-9]+)$/, async (req, res, [, chatId]) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  if (!isGroupChatMember(me.id, chatId)) return sendError(res, 404, 'group chat not found');
  const body = await readJson(req);
  const updates = []; const args = [];
  if (typeof body.name === 'string') {
    updates.push('name = ?'); args.push(body.name.trim().slice(0, 60));
  }
  if (!updates.length) return sendError(res, 400, 'no updatable fields');
  args.push(chatId);
  db.prepare(`UPDATE group_chats SET ${updates.join(', ')} WHERE id = ?`).run(...args);
  const row = db.prepare('SELECT * FROM group_chats WHERE id = ?').get(chatId);
  broadcastToGroupChat(chatId, {
    type: 'group_chat_updated',
    chat: { ...groupChatRow(row), members: groupChatMembers(chatId).map(publicUser) },
  });
  send(res, 200, groupChatRow(row));
});

route('POST', /^\/api\/group-chats\/([a-f0-9]+)\/members$/, async (req, res, [, chatId]) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  if (!isGroupChatMember(me.id, chatId)) return sendError(res, 404, 'group chat not found');
  const body = await readJson(req);
  const userIds = Array.isArray(body.userIds) ? body.userIds.slice(0, 24) : [];
  if (!userIds.length) return sendError(res, 400, 'userIds required');
  const now = Date.now();
  let added = 0;
  for (const uid of userIds) {
    const u = db.prepare('SELECT id FROM users WHERE id = ?').get(uid);
    if (!u) continue;
    const existing = db.prepare('SELECT 1 FROM group_chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, uid);
    if (existing) continue;
    db.prepare('INSERT INTO group_chat_members (chat_id, user_id, joined_at) VALUES (?,?,?)').run(chatId, uid, now);
    added++;
  }
  const row = db.prepare('SELECT * FROM group_chats WHERE id = ?').get(chatId);
  broadcastToGroupChat(chatId, {
    type: 'group_chat_updated',
    chat: { ...groupChatRow(row), members: groupChatMembers(chatId).map(publicUser) },
  });
  log.info('gchat.members.add', 'added', { chat: chatId, by: me.username, n: added });
  send(res, 200, { added });
});

route('DELETE', /^\/api\/group-chats\/([a-f0-9]+)\/members\/([a-f0-9]+)$/, async (req, res, [, chatId, userId]) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  if (!isGroupChatMember(me.id, chatId)) return sendError(res, 404, 'group chat not found');
  // You can remove yourself; otherwise only the owner can kick.
  const chat = db.prepare('SELECT * FROM group_chats WHERE id = ?').get(chatId);
  if (!chat) return sendError(res, 404, 'group chat not found');
  if (userId !== me.id && chat.owner_id !== me.id) return sendError(res, 403, 'only the owner can remove members');
  db.prepare('DELETE FROM group_chat_members WHERE chat_id = ? AND user_id = ?').run(chatId, userId);
  // If we just removed the last member, kill the chat entirely.
  const remaining = db.prepare('SELECT COUNT(*) AS n FROM group_chat_members WHERE chat_id = ?').get(chatId).n;
  if (remaining === 0) {
    db.prepare('DELETE FROM group_chats WHERE id = ?').run(chatId);
    log.info('gchat.delete', 'last member left', { chat: chatId });
  } else {
    broadcastToGroupChat(chatId, {
      type: 'group_chat_updated',
      chat: { ...groupChatRow(chat), members: groupChatMembers(chatId).map(publicUser) },
    });
  }
  // Tell the removed user too so their sidebar drops the chat.
  broadcastToUser(userId, { type: 'group_chat_left', chatId });
  log.info('gchat.members.remove', 'removed', { chat: chatId, target: userId.slice(0,8), by: me.username });
  send(res, 200, { ok: true });
});

function groupChatMessageRow(m) {
  if (!m) return null;
  return {
    id: m.id,
    groupChatId: m.chat_id,
    senderId: m.sender_id,
    content: m.content,
    createdAt: m.created_at,
    attachments: parseAttachments(m.attachments),
    encrypted: false,
    nonce: null,
  };
}

route('GET', /^\/api\/group-chats\/([a-f0-9]+)\/messages$/, async (req, res, [, chatId]) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  if (!isGroupChatMember(me.id, chatId)) return sendError(res, 404, 'group chat not found');
  const url = new URL(req.url, 'http://x');
  const before = Number(url.searchParams.get('before')) || Date.now() + 1;
  const limit = Math.min(Number(url.searchParams.get('limit')) || 1000, 5000);
  const rows = db.prepare(`SELECT * FROM group_chat_messages WHERE chat_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`)
    .all(chatId, before, limit);
  send(res, 200, { messages: rows.reverse().map(groupChatMessageRow) });
});

route('POST', /^\/api\/group-chats\/([a-f0-9]+)\/messages$/, async (req, res, [, chatId]) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  if (!isGroupChatMember(me.id, chatId)) return sendError(res, 404, 'group chat not found');
  const body = await readJson(req);
  const content = body.content || '';
  const rawAtt = Array.isArray(body.attachments) ? body.attachments : [];
  if ((typeof content !== 'string' || !content.trim()) && rawAtt.length === 0) {
    return sendError(res, 400, 'content or attachments required');
  }
  if (content.length > 4000) return sendError(res, 400, 'content too long');
  // Validate attachments same as DM messages.
  const attachments = [];
  for (const a of rawAtt.slice(0, 10)) {
    if (!a || typeof a.url !== 'string') continue;
    const m = a.url.match(/^\/uploads\/([a-f0-9]{8,})\/([^/]+)$/);
    if (m) {
      const row = db.prepare('SELECT * FROM uploads WHERE id = ?').get(m[1]);
      if (!row) continue;
      attachments.push({ url: a.url, name: row.filename, mime: row.mime, size: row.size });
      continue;
    }
    if (/^https:\/\/files\.catbox\.moe\/[a-z0-9._-]+$/i.test(a.url)) {
      attachments.push({
        url: a.url,
        name: typeof a.name === 'string' ? a.name.slice(0, 100) : a.url.split('/').pop(),
        mime: typeof a.mime === 'string' ? a.mime.slice(0, 80) : 'application/octet-stream',
        size: Number.isFinite(a.size) && a.size > 0 ? Math.min(a.size, 1_000_000_000) : 0,
      });
    }
  }
  const attJson = attachments.length ? JSON.stringify(attachments) : null;
  const clientId = (typeof body.clientId === 'string' && body.clientId.length <= 64) ? body.clientId : null;
  const id = newId();
  const createdAt = Date.now();
  db.prepare('INSERT INTO group_chat_messages (id, chat_id, sender_id, content, created_at, attachments) VALUES (?,?,?,?,?,?)')
    .run(id, chatId, me.id, content, createdAt, attJson);
  const message = groupChatMessageRow({ id, chat_id: chatId, sender_id: me.id, content, created_at: createdAt, attachments: attJson });
  if (clientId) message.clientId = clientId;
  log.info('msg.gchat', 'message sent', { chat: chatId, from: me.username, bytes: content.length });
  broadcastToGroupChat(chatId, { type: 'group_chat_message', message });
  send(res, 200, { message });
});

route('DELETE', /^\/api\/group-chats\/([a-f0-9]+)\/messages\/([a-f0-9]+)$/, async (req, res, [, chatId, msgId]) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  if (!isGroupChatMember(me.id, chatId)) return sendError(res, 404, 'group chat not found');
  const m = db.prepare('SELECT * FROM group_chat_messages WHERE id = ? AND chat_id = ?').get(msgId, chatId);
  if (!m) return sendError(res, 404, 'message not found');
  // Only the sender can delete (group-chat-owner-as-mod could come later).
  if (m.sender_id !== me.id) return sendError(res, 403, 'not your message');
  db.prepare('DELETE FROM group_chat_messages WHERE id = ?').run(msgId);
  broadcastToGroupChat(chatId, { type: 'group_chat_message_deleted', chatId, messageId: msgId });
  log.info('msg.gchat.delete', 'deleted', { chat: chatId, msg: msgId, by: me.username });
  send(res, 200, { ok: true });
});

// ---------------- Servers (Discord-style guilds) ----------------

route('POST', /^\/api\/servers$/, async (req, res) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  const { name } = await readJson(req);
  const trimmed = (name || '').toString().trim();
  if (!trimmed || trimmed.length > MAX_SERVER_NAME) return sendError(res, 400, `name must be 1-${MAX_SERVER_NAME} characters`);
  const id = newId();
  const now = Date.now();
  db.prepare('INSERT INTO servers (id, name, owner_id, created_at) VALUES (?,?,?,?)').run(id, trimmed, me.id, now);
  db.prepare('INSERT INTO server_members (server_id, user_id, joined_at) VALUES (?,?,?)').run(id, me.id, now);
  // Default #general channel.
  const channelId = newId();
  db.prepare('INSERT INTO channels (id, server_id, name, position, created_at) VALUES (?,?,?,?,?)').run(channelId, id, 'general', 0, now);
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
  log.info('server.create', 'new server', { server: id, name: trimmed, owner: me.username });
  send(res, 200, { server: publicServer(server) });
});

route('GET', /^\/api\/servers$/, async (req, res) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  const rows = db.prepare(`
    SELECT s.* FROM servers s
    JOIN server_members m ON m.server_id = s.id
    WHERE m.user_id = ?
    ORDER BY m.joined_at ASC
  `).all(me.id);
  send(res, 200, { servers: rows.map(publicServer) });
});

route('GET', /^\/api\/servers\/([a-f0-9]+)$/, async (req, res, [, serverId]) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  if (!userIsServerMember(me.id, serverId)) return sendError(res, 404, 'server not found');
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
  if (!server) return sendError(res, 404, 'server not found');
  const channels = db.prepare('SELECT * FROM channels WHERE server_id = ? ORDER BY position ASC, created_at ASC').all(serverId);
  const categories = db.prepare('SELECT * FROM channel_categories WHERE server_id = ? ORDER BY position ASC, created_at ASC').all(serverId);
  const members = db.prepare(`
    SELECT u.* FROM users u
    JOIN server_members m ON m.user_id = u.id
    WHERE m.server_id = ?
    ORDER BY u.display_name ASC
  `).all(serverId);
  send(res, 200, {
    server: publicServer(server),
    channels: channels.map(channelRow),
    categories: categories.map(categoryRow),
    members: members.map(publicUser),
  });
});

route('DELETE', /^\/api\/servers\/([a-f0-9]+)$/, async (req, res, [, serverId]) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  if (!userOwnsServer(me.id, serverId)) return sendError(res, 403, 'only the owner can delete this server');
  // Notify members before we delete (so they can clean up local state).
  broadcastToServer(serverId, { type: 'server_deleted', serverId });
  db.prepare('DELETE FROM servers WHERE id = ?').run(serverId);
  log.info('server.delete', 'deleted', { server: serverId, by: me.username });
  send(res, 200, { ok: true });
});

route('POST', /^\/api\/servers\/([a-f0-9]+)\/leave$/, async (req, res, [, serverId]) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  if (userOwnsServer(me.id, serverId)) return sendError(res, 400, 'owner cannot leave their own server (delete it instead)');
  if (!userIsServerMember(me.id, serverId)) return sendError(res, 404, 'server not found');
  db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(serverId, me.id);
  log.info('server.leave', 'member left', { server: serverId, user: me.username });
  broadcastToServer(serverId, { type: 'server_member_left', serverId, userId: me.id });
  send(res, 200, { ok: true });
});

route('POST', /^\/api\/servers\/([a-f0-9]+)\/channels$/, async (req, res, [, serverId]) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  if (!userOwnsServer(me.id, serverId)) return sendError(res, 403, 'only the owner can create channels');
  const body = await readJson(req);
  const candidate = (body.name || '').toString().trim().toLowerCase();
  if (!CHANNEL_NAME_RE.test(candidate)) return sendError(res, 400, `name must match ${CHANNEL_NAME_RE} (lowercase letters, digits, dash, underscore; max ${MAX_CHANNEL_NAME})`);
  const kind = (body.kind === 'announcement') ? 'announcement'
             : (body.kind === 'voice')        ? 'voice'
             : 'text';
  // Optional category — must belong to this server if provided. Bad
  // category id silently drops to uncategorized so a stale UI never
  // hard-errors a creation.
  let categoryId = null;
  if (typeof body.categoryId === 'string' && body.categoryId) {
    const cat = db.prepare('SELECT id FROM channel_categories WHERE id = ? AND server_id = ?').get(body.categoryId, serverId);
    if (cat) categoryId = cat.id;
  }
  const id = newId();
  const now = Date.now();
  const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM channels WHERE server_id = ?').get(serverId).p;
  db.prepare('INSERT INTO channels (id, server_id, name, kind, position, category_id, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, serverId, candidate, kind, maxPos + 1, categoryId, now);
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
  log.info('channel.create', 'new channel', { server: serverId, channel: id, name: candidate, kind, by: me.username });
  const payload = { type: 'channel_created', channel: channelRow(ch) };
  broadcastToServer(serverId, payload);
  send(res, 200, { channel: channelRow(ch) });
});

route('PATCH', /^\/api\/channels\/([a-f0-9]+)$/, async (req, res, [, channelId]) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!ch) return sendError(res, 404, 'channel not found');
  if (!userOwnsServer(me.id, ch.server_id)) return sendError(res, 403, 'only the owner can edit channels');
  const body = await readJson(req);
  const updates = []; const args = [];
  if (typeof body.name === 'string') {
    const n = body.name.trim().toLowerCase();
    if (!CHANNEL_NAME_RE.test(n)) return sendError(res, 400, 'invalid channel name');
    updates.push('name = ?'); args.push(n);
  }
  if (typeof body.kind === 'string') {
    const k = (body.kind === 'announcement') ? 'announcement'
            : (body.kind === 'voice')        ? 'voice'
            : 'text';
    updates.push('kind = ?'); args.push(k);
  }
  if (typeof body.topic === 'string') {
    updates.push('topic = ?'); args.push(body.topic.slice(0, 1024));
  }
  if (Object.prototype.hasOwnProperty.call(body, 'categoryId')) {
    let cid = null;
    if (typeof body.categoryId === 'string' && body.categoryId) {
      const cat = db.prepare('SELECT id FROM channel_categories WHERE id = ? AND server_id = ?').get(body.categoryId, ch.server_id);
      if (cat) cid = cat.id;
    }
    updates.push('category_id = ?'); args.push(cid);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'userLimit')) {
    const n = Math.max(0, Math.min(99, Number(body.userLimit) || 0));
    updates.push('user_limit = ?'); args.push(n);
  }
  if (typeof body.position === 'number') {
    updates.push('position = ?'); args.push(Math.max(0, Math.floor(body.position)));
  }
  if (!updates.length) return sendError(res, 400, 'no updatable fields');
  args.push(channelId);
  db.prepare(`UPDATE channels SET ${updates.join(', ')} WHERE id = ?`).run(...args);
  const updated = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  log.info('channel.update', 'edited', { channel: channelId, by: me.username, fields: updates.length });
  broadcastToServer(ch.server_id, { type: 'channel_updated', channel: channelRow(updated) });
  send(res, 200, { channel: channelRow(updated) });
});

route('DELETE', /^\/api\/channels\/([a-f0-9]+)$/, async (req, res, [, channelId]) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!ch) return sendError(res, 404, 'channel not found');
  if (!userOwnsServer(me.id, ch.server_id)) return sendError(res, 403, 'only the owner can delete channels');
  // Refuse to delete the last channel — leaves the server unusable.
  const count = db.prepare('SELECT COUNT(*) AS n FROM channels WHERE server_id = ?').get(ch.server_id).n;
  if (count <= 1) return sendError(res, 400, 'cannot delete the last channel');
  db.prepare('DELETE FROM channels WHERE id = ?').run(channelId);
  log.info('channel.delete', 'deleted', { channel: channelId, by: me.username });
  broadcastToServer(ch.server_id, { type: 'channel_deleted', serverId: ch.server_id, channelId });
  send(res, 200, { ok: true });
});

// ---- Channel categories ----
//
// Discord-style sidebar groups. Owner-only mutation. Deleting a category
// re-parents its channels to NULL (uncategorized) instead of cascading,
// so a misclick doesn't nuke a server's channels.
const CATEGORY_NAME_RE = /^.{1,40}$/;

route('POST', /^\/api\/servers\/([a-f0-9]+)\/categories$/, async (req, res, [, serverId]) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  if (!userOwnsServer(me.id, serverId)) return sendError(res, 403, 'only the owner can create categories');
  const body = await readJson(req);
  const name = (body.name || '').toString().trim();
  if (!CATEGORY_NAME_RE.test(name)) return sendError(res, 400, 'name must be 1-40 chars');
  const id = newId();
  const now = Date.now();
  const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM channel_categories WHERE server_id = ?').get(serverId).p;
  db.prepare('INSERT INTO channel_categories (id, server_id, name, position, created_at) VALUES (?,?,?,?,?)')
    .run(id, serverId, name, maxPos + 1, now);
  const cat = db.prepare('SELECT * FROM channel_categories WHERE id = ?').get(id);
  log.info('category.create', 'new category', { server: serverId, category: id, name, by: me.username });
  broadcastToServer(serverId, { type: 'category_created', category: categoryRow(cat) });
  send(res, 200, { category: categoryRow(cat) });
});

route('PATCH', /^\/api\/categories\/([a-f0-9]+)$/, async (req, res, [, categoryId]) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  const cat = db.prepare('SELECT * FROM channel_categories WHERE id = ?').get(categoryId);
  if (!cat) return sendError(res, 404, 'category not found');
  if (!userOwnsServer(me.id, cat.server_id)) return sendError(res, 403, 'only the owner can edit categories');
  const body = await readJson(req);
  const updates = []; const args = [];
  if (typeof body.name === 'string') {
    const n = body.name.trim();
    if (!CATEGORY_NAME_RE.test(n)) return sendError(res, 400, 'name must be 1-40 chars');
    updates.push('name = ?'); args.push(n);
  }
  if (typeof body.position === 'number') {
    updates.push('position = ?'); args.push(Math.max(0, Math.floor(body.position)));
  }
  if (!updates.length) return sendError(res, 400, 'no updatable fields');
  args.push(categoryId);
  db.prepare(`UPDATE channel_categories SET ${updates.join(', ')} WHERE id = ?`).run(...args);
  const updated = db.prepare('SELECT * FROM channel_categories WHERE id = ?').get(categoryId);
  log.info('category.update', 'edited', { category: categoryId, by: me.username });
  broadcastToServer(cat.server_id, { type: 'category_updated', category: categoryRow(updated) });
  send(res, 200, { category: categoryRow(updated) });
});

route('DELETE', /^\/api\/categories\/([a-f0-9]+)$/, async (req, res, [, categoryId]) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  const cat = db.prepare('SELECT * FROM channel_categories WHERE id = ?').get(categoryId);
  if (!cat) return sendError(res, 404, 'category not found');
  if (!userOwnsServer(me.id, cat.server_id)) return sendError(res, 403, 'only the owner can delete categories');
  // Re-parent channels to uncategorized rather than cascade-delete.
  db.prepare('UPDATE channels SET category_id = NULL WHERE category_id = ?').run(categoryId);
  db.prepare('DELETE FROM channel_categories WHERE id = ?').run(categoryId);
  log.info('category.delete', 'deleted', { category: categoryId, by: me.username });
  broadcastToServer(cat.server_id, { type: 'category_deleted', serverId: cat.server_id, categoryId });
  send(res, 200, { ok: true });
});

route('GET', /^\/api\/channels\/([a-f0-9]+)\/messages$/, async (req, res, [, channelId]) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!ch || !userIsServerMember(me.id, ch.server_id)) return sendError(res, 404, 'channel not found');
  const url = new URL(req.url, 'http://x');
  const before = Number(url.searchParams.get('before')) || Date.now() + 1;
  // Default to 1000 (and cap at 5000) — Klar conversations are small enough
  // that returning the full history on first open is fine and saves a
  // scrollback-pagination round-trip. Bump higher if anyone hits the cap.
  const limit = Math.min(Number(url.searchParams.get('limit')) || 1000, 5000);
  const rows = db.prepare(`SELECT * FROM channel_messages WHERE channel_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`)
    .all(channelId, before, limit);
  send(res, 200, { messages: rows.reverse().map(channelMessageRow) });
});

route('POST', /^\/api\/channels\/([a-f0-9]+)\/messages$/, async (req, res, [, channelId]) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!ch || !userIsServerMember(me.id, ch.server_id)) return sendError(res, 404, 'channel not found');
  // Voice channels don't carry text messages — they're persistent mesh
  // rooms. Use room.* WS messages to join/leave instead.
  if (ch.kind === 'voice') return sendError(res, 400, 'voice channels do not support text messages');
  // Announcement channels: only the server owner can post.
  if (ch.kind === 'announcement' && !userOwnsServer(me.id, ch.server_id)) {
    return sendError(res, 403, 'only the server owner can post in announcement channels');
  }
  const body = await readJson(req);
  const content = (body.content || '').toString();
  const rawAtt = Array.isArray(body.attachments) ? body.attachments : [];
  if (!content.trim() && rawAtt.length === 0) return sendError(res, 400, 'content or attachments required');
  if (content.length > 4000) return sendError(res, 400, 'content too long');

  // Same validation rules as DM messages: local /uploads/<id>/<name> refs
  // must resolve to a known upload; https://files.catbox.moe/* refs are
  // accepted at face value (the proxy already authed the user).
  const attachments = [];
  for (const a of rawAtt.slice(0, 10)) {
    if (!a || typeof a.url !== 'string') continue;
    const m2 = a.url.match(/^\/uploads\/([a-f0-9]{8,})\/([^/]+)$/);
    if (m2) {
      const row = db.prepare('SELECT * FROM uploads WHERE id = ?').get(m2[1]);
      if (!row) continue;
      attachments.push({ url: a.url, name: row.filename, mime: row.mime, size: row.size });
      continue;
    }
    if (/^https:\/\/files\.catbox\.moe\/[a-z0-9._-]+$/i.test(a.url)) {
      attachments.push({
        url: a.url,
        name: typeof a.name === 'string' ? a.name.slice(0, 100) : a.url.split('/').pop(),
        mime: typeof a.mime === 'string' ? a.mime.slice(0, 80) : 'application/octet-stream',
        size: Number.isFinite(a.size) && a.size > 0 ? Math.min(a.size, 1_000_000_000) : 0,
      });
      continue;
    }
  }
  const attJson = attachments.length ? JSON.stringify(attachments) : null;

  const clientId = (typeof body.clientId === 'string' && body.clientId.length <= 64) ? body.clientId : null;
  const id = newId();
  const createdAt = Date.now();
  db.prepare('INSERT INTO channel_messages (id, channel_id, sender_id, content, created_at, attachments) VALUES (?,?,?,?,?,?)')
    .run(id, channelId, me.id, content, createdAt, attJson);
  const message = channelMessageRow({ id, channel_id: channelId, sender_id: me.id, content, created_at: createdAt, attachments: attJson });
  if (clientId) message.clientId = clientId;

  // Append to .KDB archive.
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(ch.server_id);
  appendKdbChannel(server, ch, me.username, message);

  log.info('msg.channel', 'message sent', {
    server: ch.server_id, channel: ch.name, from: me.username, bytes: content.length,
  });

  broadcastToServer(ch.server_id, { type: 'channel_message', message });
  send(res, 200, { message });
});

// DELETE /api/channels/:channelId/messages/:msgId — sender can delete
// their own message; the server owner can delete anyone's message in
// their server (moderation).
route('DELETE', /^\/api\/channels\/([a-f0-9]+)\/messages\/([a-f0-9]+)$/, async (req, res, [, channelId, msgId]) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!ch || !userIsServerMember(me.id, ch.server_id)) return sendError(res, 404, 'channel not found');
  const m = db.prepare('SELECT * FROM channel_messages WHERE id = ? AND channel_id = ?').get(msgId, channelId);
  if (!m) return sendError(res, 404, 'message not found');
  const isOwner = userOwnsServer(me.id, ch.server_id);
  if (m.sender_id !== me.id && !isOwner) return sendError(res, 403, 'not your message');
  db.prepare('DELETE FROM channel_messages WHERE id = ?').run(msgId);
  log.info('msg.channel.delete', 'deleted', { channel: channelId, msg: msgId, by: me.username, asOwner: isOwner && m.sender_id !== me.id });
  broadcastToServer(ch.server_id, { type: 'channel_message_deleted', channelId, messageId: msgId });
  send(res, 200, { ok: true });
});

// ---------------- Invites ----------------

route('POST', /^\/api\/servers\/([a-f0-9]+)\/invites$/, async (req, res, [, serverId]) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  if (!userIsServerMember(me.id, serverId)) return sendError(res, 404, 'server not found');
  const code = newInviteCode();
  const now = Date.now();
  db.prepare('INSERT INTO invites (code, server_id, inviter_id, created_at) VALUES (?,?,?,?)').run(code, serverId, me.id, now);
  log.info('invite.create', 'invite generated', { server: serverId, by: me.username, code });
  send(res, 200, { code });
});

route('GET', /^\/api\/invites\/([A-Za-z0-9]+)$/, async (req, res, [, code]) => {
  const inv = db.prepare('SELECT * FROM invites WHERE code = ?').get(code);
  if (!inv) return sendError(res, 404, 'invite not found');
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(inv.server_id);
  if (!server) return sendError(res, 404, 'server not found');
  const memberCount = db.prepare('SELECT COUNT(*) AS n FROM server_members WHERE server_id = ?').get(inv.server_id).n;
  send(res, 200, { code: inv.code, server: publicServer(server), memberCount });
});

route('POST', /^\/api\/invites\/([A-Za-z0-9]+)\/accept$/, async (req, res, [, code]) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  const inv = db.prepare('SELECT * FROM invites WHERE code = ?').get(code);
  if (!inv) return sendError(res, 404, 'invite not found');
  if (inv.expires_at && inv.expires_at < Date.now()) return sendError(res, 410, 'invite expired');
  if (inv.max_uses && inv.uses >= inv.max_uses) return sendError(res, 410, 'invite exhausted');
  const already = userIsServerMember(me.id, inv.server_id);
  if (!already) {
    db.prepare('INSERT INTO server_members (server_id, user_id, joined_at) VALUES (?,?,?)').run(inv.server_id, me.id, Date.now());
    db.prepare('UPDATE invites SET uses = uses + 1 WHERE code = ?').run(code);
    log.info('invite.accept', 'member joined', { server: inv.server_id, user: me.username, code });
    broadcastToServer(inv.server_id, { type: 'server_member_joined', serverId: inv.server_id, user: publicUser(me) });
  } else {
    log.info('invite.accept', 'already a member', { server: inv.server_id, user: me.username, code });
  }
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(inv.server_id);
  send(res, 200, { server: publicServer(server), alreadyMember: already });
});

const server = http.createServer(async (req, res) => {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, bypass-tunnel-reminder, X-Klar-Filename');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (req.url === '/api/uploads' && req.method === 'POST') {
      return handleUpload(req, res);
    }
    if (req.url === '/api/uploads/catbox' && req.method === 'POST') {
      return handleCatboxUpload(req, res);
    }
    if (req.url === '/api/embed/resolve' && req.method === 'POST') {
      return handleEmbedResolve(req, res);
    }
    if (req.url.startsWith('/api/')) {
      const url = req.url.split('?')[0];
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.match(r.pattern);
        if (m) return await r.handler(req, res, m);
      }
      return sendError(res, 404, 'not found');
    }
    return serveStatic(req, res);
  } catch (e) {
    log.error('http.error', e.message || String(e), { url: req.url, method: req.method });
    if (!res.headersSent) sendError(res, 500, e.message || 'internal error');
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws')) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
wss.on('connection', (ws, req) => {
  ws.userId = null;
  ws.username = null;
  ws._ip = (req && req.socket && req.socket.remoteAddress) || 'unknown';
  log.info('ws.open', 'connection opened', { ip: ws._ip });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'auth') {
      const user = getUserByToken(msg.token);
      if (!user) {
        log.warn('ws.auth', 'auth_fail', { ip: ws._ip });
        return ws.send(JSON.stringify({ type: 'auth_fail' }));
      }
      ws.userId = user.id;
      ws.username = user.username;
      if (!sockets.has(user.id)) sockets.set(user.id, new Set());
      sockets.get(user.id).add(ws);
      log.info('ws.auth', 'authed', { user: user.username, sockets: sockets.get(user.id).size });
      ws.send(JSON.stringify({ type: 'auth_ok' }));
    } else if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    } else if (msg.type && msg.type.startsWith('room.')) {
      // Multi-party voice rooms (group calls + voice channels). The room
      // identifier is opaque to the server: the renderer picks it as
      // either the call's UUID (for a group-call invite) or the
      // channel ID (for a persistent voice channel). Server just tracks
      // presence + relays member-joined / member-left events.
      if (!ws.userId) return;
      const subType = msg.type.slice(5);
      if (subType === 'join') {
        const roomId = String(msg.roomId || '');
        if (!roomId) return;
        joinRoom(roomId, ws.userId, ws);
        const others = roomMembers(roomId).filter((id) => id !== ws.userId);
        // Tell the joiner who's already in the room (so they can build
        // peer connections to each existing member).
        ws.send(JSON.stringify({
          type: 'room.joined',
          roomId,
          members: others,
          you: ws.userId,
        }));
        // For voice CHANNELS (persistent), broadcast presence to every
        // server member so non-room users see who's in the channel.
        // For ephemeral group-call rooms, just tell the existing peers.
        const ch = db.prepare("SELECT * FROM channels WHERE id = ? AND kind = 'voice'").get(roomId);
        if (ch) {
          broadcastToServer(ch.server_id, {
            type: 'voice_channel_member-joined',
            channelId: roomId,
            userId: ws.userId,
            username: ws.username,
          });
        }
        for (const otherId of others) {
          broadcastToUser(otherId, {
            type: 'room.member-joined',
            roomId,
            userId: ws.userId,
            username: ws.username,
          });
        }
        log.info('room.join', 'joined', { user: ws.username, room: roomId, n: others.length + 1, voice: !!ch });
      } else if (subType === 'leave') {
        const roomId = String(msg.roomId || '');
        if (!roomId) return;
        leaveRoom(roomId, ws.userId);
        const others = roomMembers(roomId);
        const ch = db.prepare("SELECT * FROM channels WHERE id = ? AND kind = 'voice'").get(roomId);
        if (ch) {
          broadcastToServer(ch.server_id, {
            type: 'voice_channel_member-left',
            channelId: roomId,
            userId: ws.userId,
          });
        }
        for (const otherId of others) {
          broadcastToUser(otherId, {
            type: 'room.member-left',
            roomId,
            userId: ws.userId,
          });
        }
        log.info('room.leave', 'left', { user: ws.username, room: roomId, remaining: others.length });
      } else if (subType === 'list') {
        // Used by voice-channel UI to show "who's currently in" a channel.
        const roomId = String(msg.roomId || '');
        if (!roomId) return;
        ws.send(JSON.stringify({
          type: 'room.list',
          roomId,
          members: roomMembers(roomId),
        }));
      }
    } else if (msg.type && msg.type.startsWith('call.')) {
      // WebRTC signaling relay for 1:1 voice calls. The server does not
      // peek inside the SDP/ICE payloads — it just forwards them between
      // the two parties of a DM. msg.toUserId identifies the recipient;
      // we tag the forwarded message with the authenticated sender so the
      // recipient can verify and ignore unsolicited offers.
      if (!ws.userId) return;
      const toUserId = String(msg.toUserId || '');
      if (!toUserId || toUserId === ws.userId) return;
      // Refuse to relay if either side has blocked the other.
      if (isBlocked(ws.userId, toUserId)) return;
      const subType = msg.type.slice(5); // 'invite' | 'accept' | 'decline' | 'signal' | 'hangup' | 'state'
      if (!['invite', 'accept', 'decline', 'signal', 'hangup', 'state'].includes(subType)) return;
      const forward = {
        type: msg.type,
        fromUserId: ws.userId,
        fromUsername: ws.username,
        callId: msg.callId || null,
        dmId: msg.dmId || null,
        payload: msg.payload || null,
      };
      broadcastToUser(toUserId, forward);
      // Light log — don't spam ICE candidate flow into the structured log.
      if (subType !== 'signal') {
        log.info('call.' + subType, 'relayed', { from: ws.username, to: toUserId.slice(0, 8), call: forward.callId });
      }
    }
  });
  ws.on('close', (code, reason) => {
    if (ws.userId && sockets.has(ws.userId)) {
      const set = sockets.get(ws.userId);
      set.delete(ws);
      if (set.size === 0) {
        sockets.delete(ws.userId);
        // Last socket gone — sweep this user out of every mesh room they
        // were in, and tell remaining room members so they can drop
        // their peer connections.
        const swept = sweepUserFromRooms(ws.userId);
        for (const roomId of swept) {
          const ch = db.prepare("SELECT * FROM channels WHERE id = ? AND kind = 'voice'").get(roomId);
          if (ch) {
            broadcastToServer(ch.server_id, {
              type: 'voice_channel_member-left',
              channelId: roomId,
              userId: ws.userId,
            });
          }
          for (const otherId of roomMembers(roomId)) {
            broadcastToUser(otherId, {
              type: 'room.member-left',
              roomId,
              userId: ws.userId,
              reason: 'disconnect',
            });
          }
        }
        if (swept.length) log.info('room.sweep', 'cleared on disconnect', { user: ws.username, rooms: swept.length });
      }
      log.info('ws.close', 'connection closed', {
        user: ws.username || '(unauth)',
        code,
        remaining: set.size,
      });
    } else {
      log.info('ws.close', 'connection closed (unauth)', { code });
    }
  });
});

server.listen(PORT, () => {
  // Keep the legacy "running at http://..." line so the Electron desktop
  // shell's regex parser still detects readiness — it's the de-facto
  // contract between server.js and desktop/main.cjs.
  console.log(`Klar server running at http://localhost:${PORT}`);
  log.info('server.listen', 'ready', { url: `http://localhost:${PORT}` });
});

function gracefulShutdown(signal) {
  log.info('server.shutdown', 'signal received', { signal });
  let closed = false;
  setTimeout(() => { if (!closed) { log.warn('server.shutdown', 'forced exit (timeout)'); process.exit(0); } }, 3000);
  server.close(() => {
    closed = true;
    log.info('server.shutdown', 'http closed');
    try { db.close(); log.info('server.shutdown', 'db closed'); } catch (e) { log.error('server.shutdown', 'db close failed', { err: e.message }); }
    process.exit(0);
  });
}
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', (e) => log.error('process.uncaught', e.message, { stack: e.stack }));
process.on('unhandledRejection', (e) => log.error('process.unhandled', String(e && e.message || e)));

// Exported so the Electron main process can import this module and wait for
// the HTTP server to be listening before opening the BrowserWindow.
export { server, PORT };
