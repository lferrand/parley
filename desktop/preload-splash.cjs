/**
 * Splash preload.
 *
 * CommonJS (.cjs), not ESM. A sandboxed renderer preload is evaluated as a
 * classic script, so `import { ... } from 'electron'` throws
 * "Cannot use import statement outside a module" — the preload never runs,
 * `window.boot` stays undefined, and splash.html sits on "Starting…" forever
 * with no visible error. The extension must be .cjs so Node does not treat it
 * as an ES module regardless of the parent package.json "type".
 *
 * Messages are buffered as well as forwarded. Boot starts as soon as the page
 * finishes loading, which can be a moment before splash.html has registered its
 * listener; without this queue the first status line — the one that explains
 * the download — is silently dropped and the window looks stuck.
 */

const { contextBridge, ipcRenderer } = require('electron');

const pending = [];
let sink = null;

ipcRenderer.on('boot:status', (_event, payload) => {
  if (sink) sink(payload);
  else pending.push(payload);
});

contextBridge.exposeInMainWorld('boot', {
  onStatus: (cb) => {
    sink = cb;
    // Replay anything that arrived before the page was listening.
    while (pending.length) cb(pending.shift());
    return () => { sink = null; };
  },
  retry: () => ipcRenderer.send('boot:retry'),
  quit: () => ipcRenderer.send('boot:quit'),
});
