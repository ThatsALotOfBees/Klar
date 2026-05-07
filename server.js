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
    dmId: m.dm_id,
    senderId: m.sender_id,
    content: m.content,
    nonce: m.nonce,
    encrypted: !!m.encrypted,
    createdAt: m.created_at,
    attachments: parseAttachments(m.attachments),
  };
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

  // Validate attachment refs — they must point at uploads we own. Drop any
  // bogus entries silently.
  const attachments = [];
  for (const a of rawAtt.slice(0, 10)) {
    if (!a || typeof a.url !== 'string') continue;
    const m = a.url.match(/^\/uploads\/([a-f0-9]{8,})\/([^/]+)$/);
    if (!m) continue;
    const row = db.prepare('SELECT * FROM uploads WHERE id = ?').get(m[1]);
    if (!row) continue;
    attachments.push({ url: a.url, name: row.filename, mime: row.mime, size: row.size });
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
  const { name } = await readJson(req);
  const candidate = (name || '').toString().trim().toLowerCase();
  if (!CHANNEL_NAME_RE.test(candidate)) return sendError(res, 400, `name must match ${CHANNEL_NAME_RE} (lowercase letters, digits, dash, underscore; max ${MAX_CHANNEL_NAME})`);
  const id = newId();
  const now = Date.now();
  const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM channels WHERE server_id = ?').get(serverId).p;
  db.prepare('INSERT INTO channels (id, server_id, name, position, created_at) VALUES (?,?,?,?,?)').run(id, serverId, candidate, maxPos + 1, now);
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
  log.info('channel.create', 'new channel', { server: serverId, channel: id, name: candidate, by: me.username });
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
  const body = await readJson(req);
  const content = (body.content || '').toString();
  const rawAtt = Array.isArray(body.attachments) ? body.attachments : [];
  if (!content.trim() && rawAtt.length === 0) return sendError(res, 400, 'content or attachments required');
  if (content.length > 4000) return sendError(res, 400, 'content too long');

  const attachments = [];
  for (const a of rawAtt.slice(0, 10)) {
    if (!a || typeof a.url !== 'string') continue;
    const m2 = a.url.match(/^\/uploads\/([a-f0-9]{8,})\/([^/]+)$/);
    if (!m2) continue;
    const row = db.prepare('SELECT * FROM uploads WHERE id = ?').get(m2[1]);
    if (!row) continue;
    attachments.push({ url: a.url, name: row.filename, mime: row.mime, size: row.size });
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
    } else if (msg.type && msg.type.startsWith('call.')) {
      // WebRTC signaling relay for 1:1 voice calls. The server does not
      // peek inside the SDP/ICE payloads — it just forwards them between
      // the two parties of a DM. msg.toUserId identifies the recipient;
      // we tag the forwarded message with the authenticated sender so the
      // recipient can verify and ignore unsolicited offers.
      if (!ws.userId) return;
      const toUserId = String(msg.toUserId || '');
      if (!toUserId || toUserId === ws.userId) return;
      const subType = msg.type.slice(5); // 'invite' | 'accept' | 'decline' | 'signal' | 'hangup'
      if (!['invite', 'accept', 'decline', 'signal', 'hangup'].includes(subType)) return;
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
      if (set.size === 0) sockets.delete(ws.userId);
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
