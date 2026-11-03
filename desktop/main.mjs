/**
 * Parley — desktop shell.
 *
 * Design notes:
 *
 * 1. The Node server runs IN-PROCESS. Electron's main process is Node, so we
 *    import server.mjs directly instead of spawning `node`. The .app then has
 *    no external Node dependency.
 *
 * 2. llama.cpp is a separate child process. It is a C++ binary with no Node
 *    bindings, so the app supervises it: spawn, health-check, kill on exit.
 *
 * 3. There is no Ollama. The runtime ships inside the bundle and the models are
 *    fetched on first run, so a new machine needs nothing installed.
 *
 * 4. A Finder-launched .app inherits a minimal environment: bare PATH and no
 *    DYLD_LIBRARY_PATH. Both are fixed before anything is spawned, or the
 *    vendored dylibs are invisible and llama-server dies on launch.
 *
 * 5. Boot is gated. An .app icon does not imply a working translator, so the
 *    splash window owns preflight and only reveals the UI when /api/health
 *    answers.
 */

import { app, BrowserWindow, shell, systemPreferences, Menu, ipcMain, session, desktopCapturer } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { startLlamaServer, startMany, stopAll, runtimeEnv } from './llama.mjs';
import { ensureModels, modelsDir, modelPaths, modelsReady, MODEL_FILES } from './models.mjs';

const IS_WIN = process.platform === 'win32';

// Must be set before app.getPath('userData') is first read, or dev and packaged
// builds resolve different model folders ("Electron" vs "Parley") and quietly
// re-download 1.4 GB.
app.setName('Parley');

// Windows groups taskbar buttons and toast notifications by AppUserModelID. Set
// before the first window, or the app shows up as "electron.app.Electron" in
// the taskbar and its notifications are dropped.
if (IS_WIN) app.setAppUserModelId('com.lionel.parley');

/**
 * One-time migration from the previous product name.
 *
 * The app was called "Live Translate" while the models were first downloaded,
 * so they live under `Application Support/Live Translate`. `app.setName()` is
 * what decides that folder, so renaming the app silently repoints it at an
 * empty directory — and the next launch would treat a 2.2 GB download as never
 * having happened.
 *
 * Rename the old folder in place. `renameSync` is atomic within a volume and
 * costs nothing, unlike copying. If both exist, keep the new one and leave the
 * old alone rather than guessing which is authoritative.
 */
function migrateOldDataDir() {
  // Windows keeps userData under %APPDATA%\Parley. There is no legacy folder
  // there: the app was never called "Live Translate" on this platform.
  if (IS_WIN) return;

  const support = path.join(app.getPath('appData'));           // ~/Library/Application Support
  const current = path.join(support, 'Parley');
  const legacy = path.join(support, 'Live Translate');

  if (fs.existsSync(current)) return;
  try {
    if (!fs.existsSync(legacy)) return;
    fs.renameSync(legacy, current);
    console.log('[migrate] moved Application Support/Live Translate -> Parley');
  } catch (err) {
    // A cross-device move or a permissions problem must not block startup: the
    // app can still run, it will just offer the download again.
    console.warn('[migrate] could not move old data folder:', err.message);
  }
}

migrateOldDataDir();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ *
 * Where the app payload lives
 *   dev      -> the repo root (one level up)
 *   packaged -> Resources/app
 * ------------------------------------------------------------------ */
const APP_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'app')
  : path.resolve(__dirname, '..');

/**
 * Native runtime folder.
 *
 *   packaged  Resources/llama          (one platform's binaries per installer)
 *   dev mac   desktop/vendor/llama     (Metal dylibs + llama-server)
 *   dev win   desktop/vendor/llama-win (Vulkan dlls + llama-server.exe)
 *
 * Windows ships its own folder rather than sharing `vendor/llama`, because the
 * two builds have no filenames in common and a half-overwritten directory is
 * impossible to debug from a support report.
 */
const LLAMA_BIN_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'llama')
  : path.join(__dirname, 'vendor', IS_WIN ? 'llama-win' : 'llama');

/**
 * ffmpeg decodes whatever the browser recorded into 16 kHz WAV.
 *
 * macOS uses the Homebrew binary found on PATH. Windows cannot: a normal
 * machine has no ffmpeg, and asking someone to install one before the app will
 * transcribe breaks the "nothing to install" promise. The Windows bundle
 * carries ffmpeg.exe next to the model runtime.
 */
const FFMPEG_BIN = app.isPackaged
  ? path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe')
  : path.join(__dirname, 'vendor', 'ffmpeg-win', 'ffmpeg.exe');

let mainWindow = null;
let splash = null;
let serverUrl = null;
let booting = false;

/* ------------------------------------------------------------------ *
 * PATH repair — before any spawn.
 * ------------------------------------------------------------------ */
function repairPath() {
  if (IS_WIN) {
    // A shortcut launch inherits System32 and little else; the vendored
    // runtime is reached by absolute path, so PATH only needs the app's own
    // folder for sibling lookups.
    const current = (process.env.PATH || '').split(';').filter(Boolean);
    process.env.PATH = [...new Set([path.dirname(FFMPEG_BIN), ...current])].join(';');
  } else {
    const extra = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
    const current = (process.env.PATH || '').split(':').filter(Boolean);
    process.env.PATH = [...new Set([...current, ...extra])].join(':');
  }
  const env = runtimeEnv(LLAMA_BIN_DIR);
  process.env.NO_PROXY = env.NO_PROXY;
  process.env.no_proxy = env.no_proxy;
}

async function pickPort(start = 8791) {
  for (let p = start; p < start + 40; p += 1) {
    const free = await new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.once('listening', () => s.close(() => resolve(true)));
      s.listen(p, '127.0.0.1');
    });
    if (free) return p;
  }
  throw new Error('no free port in range');
}

/* ------------------------------------------------------------------ *
 * Splash window (the bootstrap gate)
 * ------------------------------------------------------------------ */
function createSplash() {
  splash = new BrowserWindow({
    width: 520,
    height: 400,
    show: false,
    frame: false,
    resizable: false,
    backgroundColor: '#14161a',
    webPreferences: {
      preload: path.join(__dirname, 'preload-splash.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  splash.loadFile(path.join(__dirname, 'splash.html'));
  splash.once('ready-to-show', () => splash.show());
  return splash;
}

const send = (payload) => {
  console.log('[boot]', payload.stage, '-', payload.message, payload.percent ?? '');
  if (splash && !splash.isDestroyed()) splash.webContents.send('boot:status', payload);
};

/* ------------------------------------------------------------------ *
 * Microphone permission
 * ------------------------------------------------------------------ */
async function ensureMicPermission() {
  // Windows has no programmatic prompt: Chromium raises the OS-level consent
  // dialog on the first getUserMedia call, and Settings → Privacy →
  // Microphone is the place to undo a "no". Nothing to ask for up front.
  if (!IS_WIN && process.platform !== 'darwin') return true;
  if (IS_WIN) return true;
  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'granted') return true;
  if (status === 'denied' || status === 'restricted') return false;
  try {
    return await systemPreferences.askForMediaAccess('microphone');
  } catch {
    return true;
  }
}

/* ------------------------------------------------------------------ *
 * Boot sequence
 * ------------------------------------------------------------------ */
async function boot() {
  if (booting) return;
  booting = true;
  try {
    repairPath();

    // 1. Models (download on first run)
    const dir = modelsDir(app.getPath('userData'));
    if (!modelsReady(dir)) {
      const totalMb = Math.round(MODEL_FILES.reduce((a, f) => a + f.bytes, 0) / 1e6);
      send({
        stage: 'models-intro',
        message: 'Downloading the language models',
        detail: `About ${totalMb} MB, one time. They stay on this Mac.`,
      });
      await ensureModels(dir, (p) => {
        send({
          stage: 'download',
          message: p.skipped
            ? `Using existing ${p.file}`
            : `Downloading model ${p.index} of ${p.total}`,
          detail: p.file,
          percent: p.percent,
        });
      });
    }
    const paths = modelPaths(dir);

    // 2. Two llama-server instances: audio (ASR + TTS) and text (translation).
    //    Started sequentially — each load allocates several GB, and starting
    //    both at once makes peak memory spike and the slower one time out.
    send({ stage: 'engine', message: 'Starting the speech engine…', detail: 'Loading audio model' });
    const urls = await startMany([
      {
        name: 'audio',
        binDir: LLAMA_BIN_DIR,
        modelPath: paths.audio.modelPath,
        mmprojPath: paths.audio.mmprojPath,
        port: 8793,
      },
      {
        name: 'text',
        binDir: LLAMA_BIN_DIR,
        modelPath: paths.text.modelPath,
        mmprojPath: null,
        port: 8795,
      },
    ], (name, line) => {
      if (/error|failed/i.test(line)) console.log(`[llama:${name}]`, line.trim());
    });

    // 3. Mic
    send({ stage: 'mic', message: 'Checking microphone access…' });
    const mic = await ensureMicPermission();
    if (!mic) {
      send({
        stage: 'error',
        message: 'Microphone access is off',
        detail: 'Open System Settings → Privacy & Security → Microphone and enable Parley.',
        retryable: false,
      });
      return;
    }

    // 4. The translator server, in-process, pointed at the engine
    send({ stage: 'server', message: 'Starting the translator…' });
    const port = await pickPort(Number(process.env.PORT || 8791));
    process.env.PORT = String(port);
    process.env.LFM_ENGINE = 'llamacpp';
    // Separate endpoints: the audio model is the accurate recogniser, the text
    // model does the translation. Collapsing them into Omni was withdrawn.
    process.env.LLAMACPP_URL = urls.audio;
    process.env.LLAMACPP_TEXT_URL = urls.text;
    process.env.LFM_MODEL = 'lfm3-audio';   // ASR + TTS — the accurate recogniser
    process.env.LFM_TEXT_MODEL = 'lfm3-omni'; // translation — measured better than 1.7B
    // Let the in-app Models panel inspect and repair what is on disk. Both are
    // optional: without them the server reports "not managed" and the panel
    // says so, rather than showing an empty list and looking broken.
    process.env.LFM_MODELS_DIR = dir;
    process.env.LFM_MODELS_MODULE = path.join(__dirname, 'models.mjs');
    // The server spawns ffmpeg by name; give it the bundled binary explicitly
    // so a machine with no ffmpeg on PATH still transcribes.
    if (fs.existsSync(FFMPEG_BIN)) process.env.FFMPEG_PATH = FFMPEG_BIN;
    process.env.NODE_NO_WARNINGS = '1';

    try {
      await import(pathToFileURL(path.join(APP_ROOT, 'server.mjs')).href);
    } catch (err) {
      send({
        stage: 'error',
        message: 'The translator failed to start',
        detail: String(err.message || err),
        retryable: true,
      });
      return;
    }

    serverUrl = `http://127.0.0.1:${port}`;

    // 5. Confirm it answers before showing it
    for (let i = 0; i < 60; i += 1) {
      try {
        const r = await fetch(`${serverUrl}/api/health`);
        const d = await r.json();
        if (r.ok && d.ok) break;
        if (i === 59) {
          send({
            stage: 'error',
            message: 'The translator is not responding',
            detail: d.detail || 'The speech engine did not come up.',
            retryable: true,
          });
          return;
        }
      } catch {
        /* keep waiting */
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    send({ stage: 'ready', message: 'Ready' });
    await new Promise((r) => setTimeout(r, 320));
    createMainWindow();
  } finally {
    booting = false;
  }
}

/** The supervisor owns the port; read it back after start. */

/* ------------------------------------------------------------------ *
 * Main window
 * ------------------------------------------------------------------ */
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: '#0f1115',
    // macOS insets the traffic lights into the page. Windows has no such
    // affordance, so it keeps a normal frame with the standard caption buttons.
    ...(IS_WIN
      ? { autoHideMenuBar: true }
      : { titleBarStyle: 'hiddenInset' }),
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(serverUrl);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (splash && !splash.isDestroyed()) splash.close();
    splash = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */
app.whenReady().then(async () => {
  const appMenu = [
    { role: 'about' },
    { type: 'separator' },
    {
      label: 'Reveal Models Folder',
      click: () => shell.openPath(modelsDir(app.getPath('userData'))),
    },
    { type: 'separator' },
    { role: 'quit' },
  ];

  // `hide`/`hideOthers` are macOS-only roles; on Windows they render as items
  // that do nothing. Windows also has no app menu convention, so the app menu
  // collapses to what is actually useful there.
  if (!IS_WIN) {
    appMenu.splice(4, 0, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' });
  }

  const template = [
    { label: app.name, submenu: appMenu },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  createSplash();

  /**
   * System-audio capture.
   *
   * Electron's typings say loopback audio is "currently only supported on
   * Windows". That comment is stale: on macOS 14+ this returns one audio track
   * labelled "System audio" with a virtual deviceId of 'loopback'. Verified on
   * this machine before building the feature around it.
   *
   * The video track is required by the API but discarded by the renderer — we
   * only want the sound. `useSystemPicker: false` keeps it silent: the system
   * picker would ask the user to choose a screen and share it visibly, which is
   * the wrong affordance for "translate what I'm hearing".
   */
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      if (!sources.length) return callback({});
      callback({ video: sources[0], audio: 'loopback' });
    } catch (err) {
      console.warn('[system-audio] could not start capture:', err.message);
      callback({});
    }
  }, { useSystemPicker: false });

  ipcMain.on('boot:retry', () => {
    boot().catch((err) =>
      send({ stage: 'error', message: 'Startup failed', detail: String(err.message || err), retryable: true }),
    );
  });
  ipcMain.on('boot:quit', () => app.quit());

  splash.webContents.once('did-finish-load', () => {
    boot().catch((err) => {
      send({
        stage: 'error',
        message: 'Startup failed',
        detail: String(err.message || err),
        retryable: true,
      });
      console.error('[boot] FATAL:', err);
    });
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null && serverUrl) createMainWindow();
});

// The engines are child processes; they must not outlive the app.
app.on('before-quit', () => {
  stopAll();
});

process.on('exit', () => stopAll());
process.on('SIGTERM', () => {
  stopAll();
  app.quit();
});
