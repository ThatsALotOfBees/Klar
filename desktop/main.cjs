// Klar bootstrap (the MSI's actual entry point per package.json "main").
//
// On launch, this thin shim:
//   1. Tries to fetch the freshest desktop/host.cjs + desktop/updater.cjs
//      + desktop/preload.cjs from the configured GitHub repo, writing
//      them under userData/host/. Best-effort — silently continues if
//      offline / GitHub is down.
//   2. Loads userData/host/host.cjs if present (the just-downloaded or
//      previously-cached version), else falls back to the bundled
//      desktop/host.cjs that shipped inside the MSI.
//   3. Calls host.start() to actually boot the app.
//
// Result: the MSI is "universal" — feature changes in main-process code
// land via the same GitHub-driven path as renderer changes. The MSI
// itself only needs to be rebuilt when this bootstrap changes (rare).
//
// Failure modes:
//   - No internet on first ever launch: falls back to bundled host.
//   - Corrupt downloaded host.cjs: caught, falls back to bundled.
//   - Bundled host.cjs missing or broken: app.quit() with a log.

const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');

const BUNDLED_HOST_PATH    = path.join(__dirname, 'host.cjs');
const BUNDLED_PRELOAD_PATH = path.join(__dirname, 'preload.cjs');
const BUNDLED_UPDATER_PATH = path.join(__dirname, 'updater.cjs');

// Files we try to keep fresh from GitHub on each launch. The require
// graph for host.cjs needs updater.cjs in the same dir, hence both.
// preload.cjs is also colocated because host.cjs's createWindow uses
// `path.join(__dirname, 'preload.cjs')`.
const HOST_FILES = ['host.cjs', 'updater.cjs', 'preload.cjs'];

function userDataDir() { return app.getPath('userData'); }
function liveHostDir() { return path.join(userDataDir(), 'host'); }
function liveHostPath() { return path.join(liveHostDir(), 'host.cjs'); }

function readBundledConfig() {
  // We can't use desktop/host.cjs's readConfig() because that's part of
  // what we're trying to load — and we need the updateRepo/branch BEFORE
  // we decide where to fetch from.
  const candidates = [
    path.join(__dirname, '..', 'client-config.json'),
    process.resourcesPath ? path.join(process.resourcesPath, 'app', 'client-config.json') : null,
  ].filter(Boolean);
  for (const c of candidates) {
    try { return JSON.parse(fs.readFileSync(c, 'utf8')); } catch {}
  }
  return {};
}

function fetchText(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent':    'klar-bootstrap/0.1',
        'Cache-Control': 'no-cache',
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('status ' + res.statusCode));
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => data += c);
      res.on('end',  () => resolve(data));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 8000, () => req.destroy(new Error('timeout')));
  });
}

async function pullHostUpdate(repo, branch) {
  if (!repo) return { skipped: 'no updateRepo configured' };
  fs.mkdirSync(liveHostDir(), { recursive: true });
  const base = `https://raw.githubusercontent.com/${repo}/${branch || 'main'}/desktop`;
  const written = [];
  for (const file of HOST_FILES) {
    try {
      const text = await fetchText(`${base}/${file}?t=${Date.now()}`, 8000);
      // Sanity check — host.cjs MUST export a start() function. If the
      // download is truncated or otherwise broken, we don't want to
      // overwrite the cached working copy.
      if (file === 'host.cjs' && !text.includes('module.exports') && !text.includes('exports.start')) {
        throw new Error('downloaded host.cjs missing exports');
      }
      fs.writeFileSync(path.join(liveHostDir(), file), text, 'utf8');
      written.push(file);
    } catch (e) {
      // Non-fatal. We'll use whatever's already in liveHostDir() or
      // the bundled copy.
      console.error('[bootstrap] fetch ' + file + ': ' + e.message);
    }
  }
  return { written };
}

function loadHost() {
  // Prefer userData live copy (latest from GitHub). Fall back to the
  // bundled copy if live is missing or unreadable.
  if (fs.existsSync(liveHostPath())) {
    try {
      const live = require(liveHostPath());
      if (live && typeof live.start === 'function') {
        console.log('[bootstrap] using live host from ' + liveHostPath());
        return live;
      }
      console.error('[bootstrap] live host has no start() — falling back to bundled');
    } catch (e) {
      console.error('[bootstrap] live host failed to load: ' + e.message);
    }
  }
  if (fs.existsSync(BUNDLED_HOST_PATH)) {
    try {
      const bundled = require(BUNDLED_HOST_PATH);
      if (bundled && typeof bundled.start === 'function') {
        console.log('[bootstrap] using bundled host from ' + BUNDLED_HOST_PATH);
        return bundled;
      }
    } catch (e) {
      console.error('[bootstrap] bundled host failed to load: ' + e.message);
    }
  }
  return null;
}

(async () => {
  await app.whenReady();
  const cfg = readBundledConfig();
  // Best-effort GitHub pull. Don't block app startup on it.
  try {
    const r = await pullHostUpdate(cfg.updateRepo, cfg.updateBranch || 'main');
    if (r.written && r.written.length) {
      console.log('[bootstrap] pulled host files: ' + r.written.join(', '));
    }
  } catch (e) {
    console.error('[bootstrap] pullHostUpdate threw: ' + e.message);
  }
  const host = loadHost();
  if (!host) {
    console.error('[bootstrap] no working host available, quitting');
    app.quit();
    return;
  }
  try { await host.start(); }
  catch (e) {
    console.error('[bootstrap] host.start() threw: ' + (e && e.stack || e));
    app.quit();
  }
})();
