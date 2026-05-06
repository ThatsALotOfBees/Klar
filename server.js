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
const PORT = Number(process.env.PORT) || 3000;
const KDB_VERSION = 1;

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
    dmId: m.dm_id,
    senderId: m.sender_id,
    content: m.content,
    nonce: m.nonce,
    encrypted: !!m.encrypted,
    createdAt: m.created_at,
  };
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
  return { id: c.id, serverId: c.server_id, name: c.name, position: c.position, createdAt: c.created_at };
}
function channelMessageRow(m) {
  return {
    id: m.id,
    channelId: m.channel_id,
    senderId: m.sender_id,
    content: m.content,
    createdAt: m.created_at,
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
if (accountsRestored || accountsExported) {
  console.log(`Klar accounts: restored ${accountsRestored} from KDB, exported ${accountsExported} to KDB`);
}

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
    'Content-Length': Buffer.byteLength(data),
    ...headers,
  });
  res.end(data);
}
function sendError(res, status, message) {
  send(res, status, { error: message });
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
};

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
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

const routes = [];
function route(method, pattern, handler) { routes.push({ method, pattern, handler }); }

route('POST', /^\/api\/register$/, async (req, res) => {
  const body = await readJson(req);
  const { username, displayName, password, publicKey, encryptedPrivateKey, encryptedPrivateKeyNonce, keySalt } = body;
  if (typeof username !== 'string' || !/^[a-z0-9_.-]{3,24}$/i.test(username)) return sendError(res, 400, 'invalid username (3-24 chars, letters/digits/._-)');
  if (typeof password !== 'string' || password.length < 8) return sendError(res, 400, 'password must be at least 8 characters');
  if (!publicKey || !encryptedPrivateKey || !encryptedPrivateKeyNonce || !keySalt) return sendError(res, 400, 'missing key material');
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
  send(res, 200, { token, user: selfUser(user) });
});

route('POST', /^\/api\/login$/, async (req, res) => {
  const { username, password } = await readJson(req);
  if (typeof username !== 'string' || typeof password !== 'string') return sendError(res, 400, 'username and password required');
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.toLowerCase());
  if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) return sendError(res, 401, 'invalid credentials');
  const token = newToken();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(token, user.id, Date.now(), Date.now() + SESSION_TTL_MS);
  send(res, 200, { token, user: selfUser(user) });
});

route('POST', /^\/api\/logout$/, async (req, res) => {
  const auth = req.headers['authorization'];
  if (auth?.startsWith('Bearer ')) db.prepare('DELETE FROM sessions WHERE token = ?').run(auth.slice(7));
  send(res, 200, { ok: true });
});

route('GET', /^\/api\/me$/, async (req, res) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  send(res, 200, { user: selfUser(me) });
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

route('GET', /^\/api\/dms$/, async (req, res) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  const rows = db.prepare(`SELECT d.*, m.last_at FROM dms d
    LEFT JOIN (SELECT dm_id, MAX(created_at) AS last_at FROM messages GROUP BY dm_id) m ON m.dm_id = d.id
    WHERE d.user_a = ? OR d.user_b = ?
    ORDER BY COALESCE(m.last_at, d.created_at) DESC`).all(me.id, me.id);
  const out = rows.map((d) => {
    const otherId = d.user_a === me.id ? d.user_b : d.user_a;
    const other = db.prepare('SELECT * FROM users WHERE id = ?').get(otherId);
    return { ...dmRow(d), other: publicUser(other), lastAt: d.last_at || d.created_at };
  });
  send(res, 200, { dms: out });
});

route('POST', /^\/api\/dms$/, async (req, res) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  const { userId } = await readJson(req);
  if (!userId || userId === me.id) return sendError(res, 400, 'invalid userId');
  const other = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!other) return sendError(res, 404, 'user not found');
  let dm = getDmFor(me, other.id);
  if (!dm) {
    const [a, b] = [me.id, other.id].sort();
    const id = newId();
    db.prepare('INSERT INTO dms (id, user_a, user_b, e2ee_enabled, created_at) VALUES (?,?,?,0,?)')
      .run(id, a, b, Date.now());
    dm = db.prepare('SELECT * FROM dms WHERE id = ?').get(id);
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
  const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 100);
  const rows = db.prepare(`SELECT * FROM messages WHERE dm_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`)
    .all(dm.id, before, limit);
  send(res, 200, { messages: rows.reverse().map(messageRow) });
});

route('POST', /^\/api\/dms\/([a-f0-9]+)\/messages$/, async (req, res, [, dmId]) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  const dm = db.prepare('SELECT * FROM dms WHERE id = ?').get(dmId);
  if (!dm || !userInDm(me, dm)) return sendError(res, 404, 'dm not found');
  const body = await readJson(req);
  const encrypted = !!body.encrypted;
  let content = body.content;
  let nonce = body.nonce || null;
  if (encrypted) {
    if (typeof content !== 'string' || typeof nonce !== 'string') return sendError(res, 400, 'ciphertext and nonce required');
  } else {
    if (typeof content !== 'string' || !content.trim()) return sendError(res, 400, 'content required');
    if (content.length > 4000) return sendError(res, 400, 'content too long');
  }
  const id = newId();
  const createdAt = Date.now();
  db.prepare('INSERT INTO messages (id, dm_id, sender_id, content, nonce, encrypted, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, dm.id, me.id, content, nonce, encrypted ? 1 : 0, createdAt);
  const message = messageRow({ id, dm_id: dm.id, sender_id: me.id, content, nonce, encrypted: encrypted ? 1 : 0, created_at: createdAt });

  // Also append to the on-disk .KDB archive for this conversation.
  const userA = db.prepare('SELECT username FROM users WHERE id = ?').get(dm.user_a);
  const userB = db.prepare('SELECT username FROM users WHERE id = ?').get(dm.user_b);
  if (userA && userB) appendKdb(userA.username, userB.username, me.username, message);

  const payload = { type: 'message', message };
  broadcastToUser(dm.user_a, payload);
  if (dm.user_a !== dm.user_b) broadcastToUser(dm.user_b, payload);
  send(res, 200, { message });
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
  const members = db.prepare(`
    SELECT u.* FROM users u
    JOIN server_members m ON m.user_id = u.id
    WHERE m.server_id = ?
    ORDER BY u.display_name ASC
  `).all(serverId);
  send(res, 200, {
    server: publicServer(server),
    channels: channels.map(channelRow),
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
  send(res, 200, { ok: true });
});

route('POST', /^\/api\/servers\/([a-f0-9]+)\/leave$/, async (req, res, [, serverId]) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  if (userOwnsServer(me.id, serverId)) return sendError(res, 400, 'owner cannot leave their own server (delete it instead)');
  if (!userIsServerMember(me.id, serverId)) return sendError(res, 404, 'server not found');
  db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(serverId, me.id);
  broadcastToServer(serverId, { type: 'server_member_left', serverId, userId: me.id });
  send(res, 200, { ok: true });
});

route('POST', /^\/api\/servers\/([a-f0-9]+)\/channels$/, async (req, res, [, serverId]) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  if (!userOwnsServer(me.id, serverId)) return sendError(res, 403, 'only the owner can create channels');
  const { name } = await readJson(req);
  const candidate = (name || '').toString().trim().toLowerCase();
  if (!CHANNEL_NAME_RE.test(candidate)) return sendError(res, 400, `name must match ${CHANNEL_NAME_RE} (lowercase letters, digits, dash, underscore; max ${MAX_CHANNEL_NAME})`);
  const id = newId();
  const now = Date.now();
  const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM channels WHERE server_id = ?').get(serverId).p;
  db.prepare('INSERT INTO channels (id, server_id, name, position, created_at) VALUES (?,?,?,?,?)').run(id, serverId, candidate, maxPos + 1, now);
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
  const payload = { type: 'channel_created', channel: channelRow(ch) };
  broadcastToServer(serverId, payload);
  send(res, 200, { channel: channelRow(ch) });
});

route('GET', /^\/api\/channels\/([a-f0-9]+)\/messages$/, async (req, res, [, channelId]) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!ch || !userIsServerMember(me.id, ch.server_id)) return sendError(res, 404, 'channel not found');
  const url = new URL(req.url, 'http://x');
  const before = Number(url.searchParams.get('before')) || Date.now() + 1;
  const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 100);
  const rows = db.prepare(`SELECT * FROM channel_messages WHERE channel_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`)
    .all(channelId, before, limit);
  send(res, 200, { messages: rows.reverse().map(channelMessageRow) });
});

route('POST', /^\/api\/channels\/([a-f0-9]+)\/messages$/, async (req, res, [, channelId]) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!ch || !userIsServerMember(me.id, ch.server_id)) return sendError(res, 404, 'channel not found');
  const body = await readJson(req);
  const content = (body.content || '').toString();
  if (!content.trim()) return sendError(res, 400, 'content required');
  if (content.length > 4000) return sendError(res, 400, 'content too long');
  const id = newId();
  const createdAt = Date.now();
  db.prepare('INSERT INTO channel_messages (id, channel_id, sender_id, content, created_at) VALUES (?,?,?,?,?)')
    .run(id, channelId, me.id, content, createdAt);
  const message = channelMessageRow({ id, channel_id: channelId, sender_id: me.id, content, created_at: createdAt });

  // Append to .KDB archive.
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(ch.server_id);
  appendKdbChannel(server, ch, me.username, message);

  broadcastToServer(ch.server_id, { type: 'channel_message', message });
  send(res, 200, { message });
});

// ---------------- Invites ----------------

route('POST', /^\/api\/servers\/([a-f0-9]+)\/invites$/, async (req, res, [, serverId]) => {
  const me = authedUser(req);
  if (!me) return sendError(res, 401, 'not authenticated');
  if (!userIsServerMember(me.id, serverId)) return sendError(res, 404, 'server not found');
  const code = newInviteCode();
  const now = Date.now();
  db.prepare('INSERT INTO invites (code, server_id, inviter_id, created_at) VALUES (?,?,?,?)').run(code, serverId, me.id, now);
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
    broadcastToServer(inv.server_id, { type: 'server_member_joined', serverId: inv.server_id, user: publicUser(me) });
  }
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(inv.server_id);
  send(res, 200, { server: publicServer(server), alreadyMember: already });
});

const server = http.createServer(async (req, res) => {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
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
    console.error('request error', e);
    if (!res.headersSent) sendError(res, 500, e.message || 'internal error');
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws')) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
wss.on('connection', (ws) => {
  ws.userId = null;
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'auth') {
      const user = getUserByToken(msg.token);
      if (!user) return ws.send(JSON.stringify({ type: 'auth_fail' }));
      ws.userId = user.id;
      if (!sockets.has(user.id)) sockets.set(user.id, new Set());
      sockets.get(user.id).add(ws);
      ws.send(JSON.stringify({ type: 'auth_ok' }));
    } else if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    }
  });
  ws.on('close', () => {
    if (ws.userId && sockets.has(ws.userId)) {
      const set = sockets.get(ws.userId);
      set.delete(ws);
      if (set.size === 0) sockets.delete(ws.userId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Klar server running at http://localhost:${PORT}`);
});

// Exported so the Electron main process can import this module and wait for
// the HTTP server to be listening before opening the BrowserWindow.
export { server, PORT };
