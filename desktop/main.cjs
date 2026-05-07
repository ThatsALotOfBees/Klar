// Klar desktop shell (Electron main process, CommonJS).
//
// Two operating modes:
//
//  1. DEV (npm run app, app.isPackaged === false): spawn the local
//     server.js as a child of the user's system Node and point the
//     BrowserWindow at http://localhost:<port>. Same behavior as before.
//
//  2. PACKAGED (the EXE produced by `npm run dist`): the backend lives on
//     the user's own server somewhere on the internet. The Electron shell
//     does NOT spawn a server. It loads the client files from
//     userData/client/ (auto-updated from a GitHub repo) and the renderer
//     talks to the configured KLAR_CONFIG.serverUrl over HTTPS / WSS.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const updater = require('./updater.cjs');

// ---------- Per-session log file ----------
//
// The renderer pipes log lines here over IPC. We append them to a fresh
// file under <userData>/Klar/logs/<ts>.log for the lifetime of this Electron
// window, plus mirror to the main-process stdout (which the dev shell can
// capture via `npm run app`). Main-process events (boot, shutdown, IPC
// handlers themselves) are also written so the file is a complete
// per-session record.

let _sessionLogStream = null;
let _sessionLogPath = null;

function ensureSessionLog() {
  if (_sessionLogStream) return;
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    _sessionLogPath = path.join(dir, `${stamp}.log`);
    _sessionLogStream = fs.createWriteStream(_sessionLogPath, { flags: 'a' });
    sessionLog('INFO', 'session.start', `Klar session ${stamp}`, {
      pid: process.pid, electron: process.versions.electron, chrome: process.versions.chrome,
      platform: process.platform, arch: process.arch, logFile: _sessionLogPath,
    });
    // Best-effort housekeeping — keep the 50 newest log files.
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.log'));
      files.sort();
      if (files.length > 50) {
        for (const f of files.slice(0, files.length - 50)) {
          try { fs.unlinkSync(path.join(dir, f)); } catch {}
        }
      }
    } catch {}
  } catch (e) {
    console.error('[klar] failed to open session log:', e.message);
  }
}

function sessionLog(level, category, message, extra) {
  const ts = new Date().toISOString();
  let line = `[${ts}] ${String(level).padEnd(5)} ${String(category || '').padEnd(22)} ${message || ''}`;
  if (extra && typeof extra === 'object') {
    const parts = [];
    for (const k of Object.keys(extra)) {
      const v = extra[k];
      if (v === undefined || v === null) continue;
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      parts.push(`${k}=${s}`);
    }
    if (parts.length) line += (message ? ' ' : '') + parts.join(' ');
  }
  if (_sessionLogStream) {
    try { _sessionLogStream.write(line + '\n'); } catch {}
  }
  // Also surface to main-process stdout for `npm run app` users.
  process.stdout.write(line + '\n');
}

function closeSessionLog() {
  if (!_sessionLogStream) return;
  sessionLog('INFO', 'session.end', 'closing log');
  try { _sessionLogStream.end(); } catch {}
  _sessionLogStream = null;
}

let mainWindow = null;
let serverProc = null;
let runtimeConfig = null; // resolved KLAR_CONFIG (server URL etc.) for this run

// ---------- Path resolution ----------

function findFile(candidates) {
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  throw new Error(`not found in any of: ${candidates.filter(Boolean).join(', ')}`);
}

function findServerJs() {
  return findFile([
    path.join(__dirname, '..', 'server.js'),
    process.resourcesPath ? path.join(process.resourcesPath, 'app', 'server.js') : null,
  ]);
}
function findBundledClientDir() {
  return findFile([
    path.join(__dirname, '..', 'public'),
    process.resourcesPath ? path.join(process.resourcesPath, 'app', 'public') : null,
  ]);
}
function findBundledConfigPath() {
  return findFile([
    path.join(__dirname, '..', 'client-config.json'),
    process.resourcesPath ? path.join(process.resourcesPath, 'app', 'client-config.json') : null,
  ]);
}

// ---------- Config ----------

function readConfig() {
  let bundled = {};
  try { bundled = JSON.parse(fs.readFileSync(findBundledConfigPath(), 'utf8')); }
  catch (e) { console.error('failed to read bundled client-config.json:', e.message); }

  // Runtime override: userData/client-config.json (rarely used; reserved for
  // changing serverUrl post-install without rebuilding).
  let override = {};
  try {
    const p = path.join(app.getPath('userData'), 'client-config.json');
    if (fs.existsSync(p)) override = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { console.error('failed to read userData/client-config.json:', e.message); }

  const merged = { ...bundled, ...override };
  // Env vars beat all (lets developers point a packaged build at staging).
  if (process.env.KLAR_SERVER_URL) merged.serverUrl = process.env.KLAR_SERVER_URL;
  if (process.env.KLAR_UPDATE_REPO) merged.updateRepo = process.env.KLAR_UPDATE_REPO;
  // Bundled version comes from package.json — read it once.
  try {
    const pkgPath = findFile([
      path.join(__dirname, '..', 'package.json'),
      process.resourcesPath ? path.join(process.resourcesPath, 'app', 'package.json') : null,
    ]);
    merged.version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || '0.0.0';
  } catch {}
  return merged;
}

// ---------- Dev: spawn local server ----------

function startLocalServer() {
  return new Promise((resolve, reject) => {
    const serverPath = findServerJs();
    const projectRoot = path.dirname(serverPath);
    const PORT = process.env.PORT || '3000';
    const node = process.platform === 'win32' ? 'node.exe' : 'node';
    serverProc = spawn(node,
      ['--disable-warning=ExperimentalWarning', serverPath],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PORT, KLAR_DATA_DIR: projectRoot },
        cwd: projectRoot,
        windowsHide: true,
      });
    let stderrBuf = '';
    let resolved = false;
    serverProc.stdout.on('data', (d) => {
      const s = d.toString();
      process.stdout.write(`[klar-server] ${s}`);
      if (!resolved && /running at http:\/\/localhost:(\d+)/.test(s)) {
        resolved = true;
        resolve(`http://localhost:${s.match(/running at http:\/\/localhost:(\d+)/)[1]}`);
      }
    });
    serverProc.stderr.on('data', (d) => {
      stderrBuf += d.toString();
      process.stderr.write(`[klar-server] ${d}`);
    });
    serverProc.on('exit', (code) => {
      console.error(`[klar-server] exited (code=${code})`);
      if (!resolved) reject(new Error(`server failed to start: ${stderrBuf || `exit ${code}`}`));
      if (resolved && !app.isQuiting) app.quit();
    });
    serverProc.on('error', (err) => {
      if (!resolved) reject(new Error(`failed to spawn '${node}': ${err.message}`));
    });
  });
}

// ---------- Window ----------

async function createWindow() {
  const userDataDir = app.getPath('userData');
  const bundledClientDir = findBundledClientDir();

  // Resolve target URL/file + window config BEFORE creating the BrowserWindow,
  // so additionalArguments carry the correct serverUrl on the first paint.
  let configForWindow;
  let loadAction; // (win) => Promise

  if (app.isPackaged) {
    await updater.init({
      window: null, // set below after the window is created
      config: runtimeConfig,
      paths: { userData: userDataDir, bundledClient: bundledClientDir },
    });
    configForWindow = {
      serverUrl: runtimeConfig.serverUrl || '',
      version: runtimeConfig.version || '0.0.0',
      updateRepo: runtimeConfig.updateRepo || null,
    };
    const indexPath = path.join(userDataDir, 'client', 'index.html');
    loadAction = (win) => win.loadFile(indexPath);
  } else {
    const url = await startLocalServer();
    runtimeConfig.serverUrl = url;
    configForWindow = { serverUrl: url, version: runtimeConfig.version || 'dev', updateRepo: null };
    loadAction = (win) => win.loadURL(url);
  }

  mainWindow = new BrowserWindow({
    width: 1280, height: 800, minWidth: 880, minHeight: 540,
    backgroundColor: '#06040c', show: false,
    frame: false, titleBarStyle: 'hidden', autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      additionalArguments: ['--klar-config=' + encodeURIComponent(JSON.stringify(configForWindow))],
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.on('maximize',   () => pushMaxState());
  mainWindow.on('unmaximize', () => pushMaxState());

  if (app.isPackaged) updater.setWindow(mainWindow);

  await loadAction(mainWindow);
}

function pushMaxState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('klar:max-state', mainWindow.isMaximized());
  }
}

// ---------- IPC ----------

ipcMain.handle('klar:close',           () => { if (mainWindow) mainWindow.close(); });
ipcMain.handle('klar:minimize',        () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.handle('klar:toggle-maximize', () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) { mainWindow.unmaximize(); return false; }
  mainWindow.maximize();
  return true;
});
ipcMain.handle('klar:is-maximized',    () => mainWindow ? mainWindow.isMaximized() : false);

// Renderer-side log lines pipe in here.
ipcMain.on('klar:log', (_e, level, category, message, extra) => {
  sessionLog(level || 'INFO', category, message, extra);
});

ipcMain.handle('klar:check-now', async () => updater.checkOnce());
ipcMain.handle('klar:apply-update', async () => {
  const ok = await updater.applyPending();
  if (ok && mainWindow && !mainWindow.isDestroyed()) {
    const indexPath = path.join(app.getPath('userData'), 'client', 'index.html');
    await mainWindow.loadFile(indexPath);
  }
  return ok;
});

// ---------- Lifecycle ----------

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  app.isQuiting = true;
  updater.dispose();
  if (serverProc && !serverProc.killed) {
    try { serverProc.kill(); } catch {}
  }
  closeSessionLog();
});

(async () => {
  await app.whenReady();
  ensureSessionLog();
  runtimeConfig = readConfig();
  sessionLog('INFO', 'app.config', 'resolved', {
    serverUrl: runtimeConfig.serverUrl,
    version: runtimeConfig.version,
    updateRepo: runtimeConfig.updateRepo,
    isPackaged: app.isPackaged,
  });
  try {
    await createWindow();
    sessionLog('INFO', 'app.window', 'shown');
  } catch (e) {
    sessionLog('ERROR', 'app.startup', 'failed', { err: e.message });
    app.quit();
  }
})().catch((e) => {
  console.error('klar electron startup failed:', e);
  app.quit();
});
