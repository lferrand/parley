/**
 * Model provisioning.
 *
 * The models are ~1.4 GB; they cannot ride in the bundle. Two ways to get them
 * onto the machine:
 *
 *   1. ship them next to the app (dev, or an offline installer)
 *   2. download from Hugging Face on first run
 *
 * This module does both and reports progress, because a first-run screen that
 * sits silently for four minutes is indistinguishable from a hang.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HF = 'https://huggingface.co';

/**
 * Two models, from two repositories — and deliberately not the same one twice.
 *
 * Recognising and translating turn out to want different models:
 *
 *   ASR  LFM3-Audio-2B   On six Korean time expressions it got 4 right,
 *                        against 2 for Omni. Omni returned "7465분" for
 *                        "칠 시 사십오 분" on 5 of 5 runs and invented
 *                        "안녕하세요" for "포기하지 마세요".
 *
 *   MT   LFM3-Omni-2B    Through the real product path it translated 5 of 5
 *                        number-bearing sentences correctly on the fast path
 *                        (~150ms). The 1.7B text model managed 1 of 5: it
 *                        rendered "meeting" as 매팅 (not 회의), "flight" as
 *                        기항선 (not 비행), and spent 16.6s rambling before
 *                        giving up on "It costs 150 dollars."
 *
 * So Omni is a weak recogniser and a strong translator. It is loaded WITHOUT
 * its mmproj here, because translation needs no audio encoder — that saves
 * 0.29 GB and a little load time.
 */
export const MODEL_FILES = [
  {
    name: 'LFM3-Audio-2B-Q4_K_M.gguf',
    repo: 'LiquidAI/LFM3-Audio-2B-GGUF',
    bytes: 1_099_626_016,
    role: 'audio',
  },
  {
    name: 'mmproj-LFM3-Audio-2B-Q4_K_M.gguf',
    repo: 'LiquidAI/LFM3-Audio-2B-GGUF',
    bytes: 172_418_048,
    role: 'audio',
  },
  {
    name: 'LFM3-Omni-2B-Q4_K_M.gguf',
    repo: 'LiquidAI/LFM3-Omni-2B-GGUF',
    bytes: 1_099_630_080,
    role: 'text',
  },
];

/** Where downloaded models live: ~/Library/Application Support/Parley/models */
export function modelsDir(appDataDir) {
  return path.join(appDataDir, 'models');
}

export function modelPaths(dir) {
  return {
    audio: {
      modelPath: path.join(dir, 'LFM3-Audio-2B-Q4_K_M.gguf'),
      mmprojPath: path.join(dir, 'mmproj-LFM3-Audio-2B-Q4_K_M.gguf'),
    },
    text: {
      modelPath: path.join(dir, 'LFM3-Omni-2B-Q4_K_M.gguf'),
      mmprojPath: null,
    },
  };
}

function sizeOf(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return -1;
  }
}

/** True when every model file is present and not a truncated partial. */
export function modelsReady(dir) {
  return MODEL_FILES.every((f) => sizeOf(path.join(dir, f.name)) >= f.bytes * 0.98);
}

/**
 * Describe what is actually on disk, so the UI can show it.
 *
 * Four states, because "missing" alone is not actionable:
 *   ready      full file present
 *   partial    a `.part` is sitting there from an interrupted download
 *   truncated  file exists but is short and there is no `.part` to resume
 *   missing    neither
 *
 * The distinction matters: `partial` resumes where it stopped, `truncated`
 * starts over. Telling someone to "download it again" when a resume would do
 * is the kind of detail that makes an app feel careless.
 */
export function modelReport(dir) {
  const models = MODEL_FILES.map((f) => {
    const dest = path.join(dir, f.name);
    const have = sizeOf(dest);
    const partBytes = sizeOf(`${dest}.part`);
    let state = 'missing';
    if (have >= f.bytes * 0.98) state = 'ready';
    else if (partBytes >= 0) state = 'partial';
    else if (have >= 0) state = 'truncated';

    // A paused download has no completed file, so measuring progress from
    // `have` reports 0% while 400 MB sit on disk. The bytes that matter are
    // whichever of the two files actually holds data.
    const bytesPresent = Math.max(have >= 0 ? have : 0, partBytes >= 0 ? partBytes : 0);

    return {
      name: f.name,
      role: f.role,
      bytes: f.bytes,
      onDisk: bytesPresent,
      partialBytes: partBytes >= 0 ? partBytes : 0,
      state,
      percent: Math.min(100, Math.floor((bytesPresent / f.bytes) * 100)),
    };
  });

  const onDisk = models.reduce((a, m) => a + m.onDisk, 0);
  const expected = models.reduce((a, m) => a + m.bytes, 0);

  return {
    dir,
    models,
    expectedBytes: expected,
    onDiskBytes: onDisk,
    ready: models.every((m) => m.state === 'ready'),
  };
}

/**
 * Download one file, resuming from a `.part` if a previous run was interrupted.
 * Resuming matters: 1.1 GB over a home connection often gets cut once, and
 * starting over is a bad first impression.
 */

// A connection can die without an error: reader.read() simply never settles.
// Nothing times out on its own, so the first-run screen sits at "Downloading…
// 20%" forever and the app looks frozen. That is what happened on 2026-11-01.
const STALL_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 6;

const hfUrl = (file) => `${HF}/${file.repo}/resolve/main/${encodeURIComponent(file.name)}?download=true`;

/** One attempt. Resolves only when a complete file is on disk. */
async function downloadAttempt(file, dir, onProgress) {
  const dest = path.join(dir, file.name);
  const part = `${dest}.part`;

  let have = sizeOf(part);
  if (have < 0) have = 0;
  // Junk beyond the expected size cannot be resumed from — start clean.
  if (have >= file.bytes) {
    await fsp.rm(part, { force: true });
    have = 0;
  }

  const ac = new AbortController();
  let lastActivity = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastActivity > STALL_TIMEOUT_MS) ac.abort();
  }, 5000);
  watchdog.unref?.();

  let out = null;
  try {
    const headers = have > 0 ? { Range: `bytes=${have}-` } : {};
    const res = await fetch(hfUrl(file), { headers, signal: ac.signal });
    if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);

    // Range ignored: the server sent the whole file, so restart rather than
    // appending a second copy onto the existing bytes.
    let written = have;
    if (have > 0 && res.status === 200) {
      written = 0;
      await fsp.rm(part, { force: true });
    }

    out = fs.createWriteStream(part, { flags: written > 0 ? 'a' : 'w' });
    const reader = res.body.getReader();
    let lastPct = -1;

    // One error listener for the whole stream. Attaching `once('error')` inside
    // the drain wait added a listener per chunk and tripped MaxListenersExceeded
    // (11 handlers on a 1.1 GB file) — a real leak, not just a warning.
    let streamError = null;
    out.on('error', (err) => { streamError = err; });

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (streamError) throw streamError;
      lastActivity = Date.now();
      written += value.length;
      if (!out.write(Buffer.from(value))) {
        // Backpressure: wait for the kernel buffer to drain. Racing the error
        // is the point — a full disk must reject here, not spin forever.
        await Promise.race([
          new Promise((resolve) => out.once('drain', resolve)),
          new Promise((_, reject) => {
            const tick = setInterval(() => {
              if (streamError) { clearInterval(tick); reject(streamError); }
            }, 100);
            tick.unref?.();
            out.once('close', () => clearInterval(tick));
          }),
        ]);
      }
      const pct = Math.min(100, Math.floor((written / file.bytes) * 100));
      // Report on whole percentages only: one IPC message per 11 MB chunk
      // would flood the splash window for no visible gain.
      if (pct !== lastPct) {
        lastPct = pct;
        onProgress?.(file.name, pct, written, file.bytes);
      }
    }

    if (streamError) throw streamError;

    await new Promise((resolve, reject) => {
      out.end((err) => (err ? reject(err) : resolve()));
    });
    out = null;

    // A connection that closes early looks exactly like success. Promote only
    // a complete file — otherwise a truncated model is renamed to its final
    // name, reported as present, and fails to load with no explanation.
    const finalSize = sizeOf(part);
    if (finalSize < file.bytes * 0.98) {
      throw new Error(`short read: ${finalSize} of ${file.bytes} bytes`);
    }

    await fsp.rename(part, dest);
    onProgress?.(file.name, 100, file.bytes, file.bytes);
  } catch (err) {
    if (out) {
      try { out.destroy(); } catch { /* already gone */ }
    }
    throw err;
  } finally {
    clearInterval(watchdog);
  }
}

async function download(file, dir, onProgress) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await downloadAttempt(file, dir, onProgress);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_ATTEMPTS) break;
      // Keep whatever landed (the next attempt resumes from it) and back off,
      // so a server that is genuinely down is not hit six times in two seconds.
      await new Promise((r) => setTimeout(r, Math.min(8000, 750 * 2 ** (attempt - 1))));
    }
  }
  throw new Error(`could not download ${file.name}: ${String(lastErr?.message || lastErr)}`);
}

export async function ensureModels(dir, onProgress) {
  await fsp.mkdir(dir, { recursive: true });
  let index = 0;
  for (const file of MODEL_FILES) {
    index += 1;
    const dest = path.join(dir, file.name);
    if (sizeOf(dest) >= file.bytes * 0.98) {
      onProgress?.({ file: file.name, percent: 100, index, total: MODEL_FILES.length, skipped: true });
      continue;
    }
    await download(file, dir, (name, pct) => {
      onProgress?.({ file: name, percent: pct, index, total: MODEL_FILES.length });
    });
  }
  return modelPaths(dir);
}
