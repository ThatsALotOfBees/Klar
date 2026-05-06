// Klar preload — exposes a tiny IPC surface plus the runtime client config.
// Renderer detects the desktop shell via `window.klar?.shell`, reads its
// server URL + version from `window.KLAR_CONFIG`, and listens for update
// notifications from the main process.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('klar', {
  shell: {
    isAvailable: true,
    close:            () => ipcRenderer.invoke('klar:close'),
    minimize:         () => ipcRenderer.invoke('klar:minimize'),
    toggleMaximize:   () => ipcRenderer.invoke('klar:toggle-maximize'),
    isMaximized:      () => ipcRenderer.invoke('klar:is-maximized'),
    onMaxStateChange: (cb) => {
      const listener = (_e, isMax) => cb(!!isMax);
      ipcRenderer.on('klar:max-state', listener);
      return () => ipcRenderer.removeListener('klar:max-state', listener);
    },
  },

  updates: {
    // Fires once the main process has staged a new client release in
    // userData/client-next/. The renderer pops a toast inviting the user
    // to reload; clicking it calls `apply()` which atomically swaps and
    // reloads the BrowserWindow.
    onAvailable: (cb) => {
      const listener = (_e, info) => cb(info);
      ipcRenderer.on('klar:update-available', listener);
      return () => ipcRenderer.removeListener('klar:update-available', listener);
    },
    apply: () => ipcRenderer.invoke('klar:apply-update'),
    checkNow: () => ipcRenderer.invoke('klar:check-now'),
  },
});

// `KLAR_CONFIG` carries `serverUrl` and `version`. The main process passes it
// via additionalArguments as `--klar-config=<urlencoded JSON>`. We never read
// the config from disk in the renderer — main is the single source of truth.
try {
  const arg = (process.argv || []).find(a => typeof a === 'string' && a.startsWith('--klar-config='));
  if (arg) {
    const cfg = JSON.parse(decodeURIComponent(arg.slice('--klar-config='.length)));
    contextBridge.exposeInMainWorld('KLAR_CONFIG', cfg);
  } else {
    contextBridge.exposeInMainWorld('KLAR_CONFIG', { serverUrl: '', version: 'dev' });
  }
} catch (e) {
  contextBridge.exposeInMainWorld('KLAR_CONFIG', { serverUrl: '', version: 'dev', error: String(e) });
}
