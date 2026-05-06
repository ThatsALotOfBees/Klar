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
});

(async () => {
  await app.whenReady();
  runtimeConfig = readConfig();
  try {
    await createWindow();
  } catch (e) {
    console.error('klar electron startup failed:', e);
    app.quit();
  }
})().catch((e) => {
  console.error('klar electron startup failed:', e);
  app.quit();
});
