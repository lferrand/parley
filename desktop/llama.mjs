/**
 * llama-server supervisor.
 *
 * llama.cpp ships as a plain CLI binary, not a daemon, so the app owns its
 * lifecycle: pick a free port, spawn it with the right flags, wait until it
 * reports healthy, and make sure it dies with the app.
 *
 * One process per model. The pipeline needs two:
 *   audio  LFM3-Audio-2B + mmproj   ASR and TTS
 *   text   LFM3-1.7B                translation
 *
 * They are kept separate because the audio model is the accurate recogniser;
 * the single-model Omni experiment was withdrawn after it returned "7465분"
 * for "칠 시 사십오 분" (7:45) and invented "안녕하세요" for "포기하지 마세요".
 *
 * A registry, not a singleton: the earlier version assumed one model and
 * silently returned the first server for any later start call.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';

/** name -> { child, port, url } */
const servers = new Map();

const IS_WIN = process.platform === 'win32';

/** Windows executables carry the extension; POSIX does not. */
export const serverBinName = IS_WIN ? 'llama-server.exe' : 'llama-server';

function freePort(start) {
  return new Promise((resolve) => {
    const tryPort = (p) => {
      if (p > start + 40) return resolve(start);
      const s = net.createServer();
      s.once('error', () => tryPort(p + 1));
      s.once('listening', () => s.close(() => resolve(p)));
      s.listen(p, '127.0.0.1');
    };
    tryPort(start);
  });
}

/**
 * Native libraries sit next to the binary, and neither OS finds them by
 * accident.
 *
 * macOS: a Finder-launched app has no DYLD_LIBRARY_PATH, and dyld does not
 * search the executable's own directory.
 *
 * Windows: the loader *does* search the exe's directory, but only if the
 * process environment does not point elsewhere first. Adding binDir to the
 * front of PATH keeps the vendored DLLs authoritative even when the machine
 * has another llama.cpp or ffmpeg installed.
 */
export function runtimeEnv(binDir) {
  if (IS_WIN) {
    const parts = (process.env.PATH || '').split(';').filter(Boolean);
    return {
      ...process.env,
      PATH: [...new Set([binDir, ...parts])].join(';'),
      // Never route local model traffic through an HTTP proxy.
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    };
  }
  const prev = process.env.DYLD_LIBRARY_PATH || '';
  return {
    ...process.env,
    DYLD_LIBRARY_PATH: prev ? `${binDir}:${prev}` : binDir,
    // Never route local model traffic through an HTTP proxy.
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
}

/**
 * Start (or return) the server named `name`. Idempotent per name so a retry
 * after a failed boot does not leave a second copy of every model in RAM.
 */
export async function startLlamaServer({
  name,
  binDir,
  modelPath,
  mmprojPath,
  ctx = 8192,
  threads = 0,
  port: preferredPort = 8793,
  onLog,
}) {
  const existing = servers.get(name);
  if (existing) return existing.url;

  const bin = path.join(binDir, serverBinName);
  if (!fs.existsSync(bin)) throw new Error(`llama-server missing at ${bin}`);
  if (!fs.existsSync(modelPath)) throw new Error(`model missing at ${modelPath}`);

  /**
   * GPU first, CPU on retry.
   *
   * The Windows bundle is the Vulkan build: on a machine with a working driver
   * it puts every layer on the GPU and is several times faster. On a machine
   * without one (a VM, a locked-down corporate image, a stale driver) Vulkan
   * enumeration can fail hard rather than quietly falling back — the server
   * exits during device init and the app looks broken on first launch.
   *
   * So: try the GPU, and if the engine never answers, start again with `-ngl 0`
   * before reporting failure. Same binary, same DLLs, no second runtime to
   * ship, and the user gets a working translator instead of an error screen.
   */
  const attempts = [
    { gpu: true, label: 'GPU' },
    { gpu: false, label: 'CPU' },
  ];

  let lastErr = null;
  for (const attempt of attempts) {
    const port = await freePort(preferredPort);
    const args = [
      '-m', modelPath,
      '--port', String(port),
      '-c', String(ctx),
      '--jinja',
      '-ngl', attempt.gpu ? '99' : '0',
      '--host', '127.0.0.1',
    ];
    if (mmprojPath) args.push('--mmproj', mmprojPath);
    if (threads > 0) args.push('-t', String(threads));

    const child = spawn(bin, args, {
      cwd: binDir,
      env: runtimeEnv(binDir),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const url = `http://127.0.0.1:${port}`;
    const entry = { child, port, url };
    servers.set(name, entry);

    child.stdout.on('data', (d) => onLog?.(name, String(d)));
    child.stderr.on('data', (d) => onLog?.(name, String(d)));

    // A crash must not leave the app pointed at a dead port.
    child.on('exit', (code) => {
      onLog?.(name, `exited (${code})`);
      if (servers.get(name) === entry) servers.delete(name);
    });

    const ok = await waitHealthy(url, attempt.gpu ? 180_000 : 240_000, () => servers.get(name) === entry);
    if (ok) {
      if (!attempt.gpu) onLog?.(name, 'running on CPU (GPU init failed)');
      return url;
    }

    stopServer(name);
    lastErr = new Error(`${name} engine did not become healthy on ${attempt.label}`);
    onLog?.(name, `${attempt.label} start failed, trying next`);
  }

  throw new Error(
    `${lastErr?.message || name + ' engine failed'} (${modelPath.split(/[\\/]/).pop()})`,
  );
}

async function waitHealthy(url, timeoutMs, stillExpected = () => true) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!stillExpected()) return false;   // died or was torn down
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
      const d = await r.json().catch(() => ({}));
      if (r.ok && String(d.status || 'ok').toLowerCase() !== 'loading') return true;
    } catch {
      /* still starting */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

export async function startMany(specs, onLog) {
  // Sequential: each load allocates several GB, and starting both at once
  // makes peak memory spike and the slower one time out.
  const out = {};
  for (const spec of specs) {
    out[spec.name] = await startLlamaServer({ ...spec, onLog });
  }
  return out;
}

export function stopServer(name) {
  const entry = servers.get(name);
  if (!entry) return;
  servers.delete(name);
  try {
    entry.child.kill('SIGTERM');
    setTimeout(() => {
      try { entry.child.kill('SIGKILL'); } catch { /* already gone */ }
    }, 4000).unref?.();
  } catch {
    /* already exited */
  }
}

export function stopAll() {
  for (const name of [...servers.keys()]) stopServer(name);
}

export function serverUrl(name) {
  return servers.get(name)?.url || null;
}
