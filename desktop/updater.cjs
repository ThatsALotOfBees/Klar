// Auto-updater for Klar's client files.
//
// Model:
// - The app's bundled client lives at <resourcesPath>/app/public/ in a packaged build
//   (or <project>/public in dev). On first launch we copy that baseline into
//   <userData>/client/ so updates have a writable directory to mutate.
// - A GitHub repo holds versioned releases under client-releases/<version>/
//   plus a top-level client-releases/manifest.json listing the latest version.
// - On a configurable interval (and once at startup) we fetch the manifest,
//   compare with the installed version, and if newer download every file in
//   the listed manifest into <userData>/client-next/.
// - When the renderer is told an update is ready, the user can click a toast
//   that triggers `apply` here: we atomically swap client/ <-> client-next/
//   and reload the BrowserWindow.
//
// SHA-256s in the manifest are honored when present.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

let mainWindow = null;
let cfg = null;          // bundled + override config object
let userDataDir = null;  // app.getPath('userData')
let bundledClientDir = null;
let pollTimer = null;
let pendingVersion = null;

const CLIENT_DIR_NAME = 'client';
const CLIENT_NEXT_DIR_NAME = 'client-next';
const VERSION_FILE = 'version.json';

function clientDir()      { return path.join(userDataDir, CLIENT_DIR_NAME); }
function clientNextDir()  { return path.join(userDataDir, CLIENT_NEXT_DIR_NAME); }
function versionFilePath(){ return path.join(clientDir(), VERSION_FILE); }

function readInstalledVersion() {
  try {
    const raw = fs.readFileSync(versionFilePath(), 'utf8');
    return JSON.parse(raw).version || '0.0.0';
  } catch { return '0.0.0'; }
}

function semverCmp(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

async function copyDir(src, dst) {
  await fsp.mkdir(dst, { recursive: true });
  for (const entry of await fsp.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else if (entry.isFile()) await fsp.copyFile(s, d);
  }
}

async function rmrf(p) {
  try { await fsp.rm(p, { recursive: true, force: true }); } catch {}
}

async function ensureClientBaseline() {
  // If userData/client doesn't exist (or has no index.html), copy from the
  // bundled baseline. Same idea if the bundled version is newer than what's
  // in userData (shipped EXE upgrade): refresh.
  const have = fs.existsSync(path.join(clientDir(), 'index.html'));
  const installedV = readInstalledVersion();
  const bundledV = cfg.version || '0.0.0';
  if (!have || semverCmp(bundledV, installedV) > 0) {
    await rmrf(clientDir());
    await copyDir(bundledClientDir, clientDir());
    await fsp.writeFile(
      versionFilePath(),
      JSON.stringify({ version: bundledV, source: 'bundle', appliedAt: Date.now() }, null, 2),
    );
  }
}

function manifestUrl() {
  if (!cfg.updateRepo) return null;
  const branch = cfg.updateBranch || 'main';
  return `https://raw.githubusercontent.com/${cfg.updateRepo}/${branch}/client-releases/manifest.json`;
}

function fileUrl(version, filePath) {
  const branch = cfg.updateBranch || 'main';
  return `https://raw.githubusercontent.com/${cfg.updateRepo}/${branch}/client-releases/${version}/${filePath}`;
}

async function httpGet(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': `klar-updater/${cfg.version || '0.0.0'}`, 'Cache-Control': 'no-cache' },
  });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res;
}

async function fetchJson(url) {
  const res = await httpGet(url);
  return res.json();
}
async function fetchBuffer(url) {
  const res = await httpGet(url);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

async function downloadVersionInto(version, files, destDir) {
  await rmrf(destDir);
  await fsp.mkdir(destDir, { recursive: true });
  for (const f of files) {
    const url = f.url || fileUrl(version, f.path);
    const buf = await fetchBuffer(url);
    if (f.sha256) {
      const got = sha256(buf);
      if (got !== f.sha256) throw new Error(`sha256 mismatch for ${f.path}: expected ${f.sha256}, got ${got}`);
    }
    const target = path.join(destDir, f.path);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, buf);
  }
  await fsp.writeFile(
    path.join(destDir, VERSION_FILE),
    JSON.stringify({ version, source: 'github', appliedAt: Date.now() }, null, 2),
  );
}

async function checkOnce() {
  const url = manifestUrl();
  if (!url) return { skipped: 'no updateRepo configured' };
  let manifest;
  try { manifest = await fetchJson(url); }
  catch (e) { return { error: e.message }; }
  const installed = readInstalledVersion();
  const latest = manifest.version || '0.0.0';
  if (semverCmp(latest, installed) <= 0) return { upToDate: true, installed, latest };
  if (!Array.isArray(manifest.files) || !manifest.files.length) return { error: 'manifest has no files' };

  await downloadVersionInto(latest, manifest.files, clientNextDir());
  pendingVersion = latest;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('klar:update-available', {
      from: installed,
      to: latest,
      serverUrl: manifest.serverUrl || cfg.serverUrl,
      notes: manifest.notes || null,
    });
  }
  return { downloaded: true, installed, latest };
}

async function applyPending() {
  if (!pendingVersion) return false;
  const next = clientNextDir();
  const cur = clientDir();
  if (!fs.existsSync(path.join(next, 'index.html'))) return false;
  // Best-effort atomic swap: rename current away, rename next into place,
  // delete the old. On Windows rename across same drive is atomic.
  const trash = path.join(userDataDir, `client-old-${Date.now()}`);
  try { await fsp.rename(cur, trash); }
  catch { /* current may not exist */ }
  await fsp.rename(next, cur);
  rmrf(trash); // fire-and-forget
  pendingVersion = null;
  return true;
}

function init({ window, config, paths }) {
  mainWindow = window;
  cfg = config;
  userDataDir = paths.userData;
  bundledClientDir = paths.bundledClient;
  return ensureClientBaseline().then(() => {
    if (!cfg.updateRepo) return;
    setTimeout(() => { checkOnce().catch((e) => console.error('updater check failed:', e)); }, 5000);
    const interval = Number(cfg.updateCheckIntervalMs) || 60 * 60 * 1000;
    pollTimer = setInterval(() => {
      checkOnce().catch((e) => console.error('updater check failed:', e));
    }, interval);
  });
}

function setWindow(w) { mainWindow = w; }

function dispose() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  mainWindow = null;
}

module.exports = { init, setWindow, checkOnce, applyPending, dispose };
