/**
 * Build the macOS icon set from icon-src/icon.html.
 *
 * Each size is rendered at its true pixel dimensions rather than downscaled
 * from 1024, so the 16 and 32 px tiles get their own stroke weight (the SMALL
 * branch in icon.html). A bilinear shrink of the large tile turns two 9.5-unit
 * strands into grey mush at Dock size.
 *
 * One persistent window, resized per size. Creating and destroying a window per
 * size intermittently failed with ERR_FAILED on the second load — a transparent
 * offscreen WebContents being torn down while the next one was still
 * negotiating its surface.
 */

import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Resolve from this file's location, not a hardcoded home directory: the icon
// builder is shipped source, and an absolute path only works on the machine
// that wrote it. This file lives at desktop/icon-src/, so `HERE` is desktop/.
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(HERE, 'icon-src', 'icon.html');
const OUT = path.join(HERE, 'icon-src', 'build');
const ICONSET = path.join(OUT, 'LiveTranslate.iconset');

// pixel size -> files in the .iconset that need that exact bitmap
const PLAN = {
  16: ['icon_16x16.png'],
  32: ['icon_16x32.png', 'icon_16x16@2x.png', 'icon_32x32.png'],
  64: ['icon_32x32@2x.png'],
  128: ['icon_128x128.png'],
  256: ['icon_128x128@2x.png', 'icon_256x256.png'],
  512: ['icon_256x256@2x.png', 'icon_512x512.png'],
  1024: ['icon_512x512@2x.png'],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function capture(win, size, attempt = 1) {
  win.setContentSize(size, size);
  await win.loadFile(SRC, { search: `size=${size}` });
  await sleep(300);

  let img = await win.webContents.capturePage();
  const got = img.getSize();
  if (!got.width) throw new Error('empty capture');

  // Retina capture may hand back 2x pixels; normalise to the exact size.
  if (got.width !== size) {
    img = img.resize({ width: size, height: size, quality: 'best' });
  }

  // Guard against the known failure mode: a transparent frame that has not
  // painted yet returns fully transparent pixels. Retry rather than ship it.
  const buf = img.toPNG();
  if (buf.length < 120 && attempt < 4) {
    await sleep(400);
    return capture(win, size, attempt + 1);
  }
  return buf;
}

app.whenReady().then(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(ICONSET, { recursive: true });

  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    useContentSize: true,
    webPreferences: { contextIsolation: true, backgroundThrottling: false },
  });

  for (const [size, names] of Object.entries(PLAN)) {
    const px = Number(size);
    const png = await capture(win, px);
    fs.writeFileSync(path.join(OUT, `icon-${px}.png`), png);
    for (const name of names) fs.writeFileSync(path.join(ICONSET, name), png);
    console.log(`  ${String(px).padStart(4)}px  ${(png.length / 1024).toFixed(1)} KB  -> ${names.join(', ')}`);
  }

  win.destroy();

  try {
    execFileSync('iconutil', ['-c', 'icns', ICONSET, '-o', path.join(OUT, 'LiveTranslate.icns')]);
    const f = path.join(OUT, 'LiveTranslate.icns');
    console.log('ICNS OK', `${(fs.statSync(f).size / 1024).toFixed(0)} KB`);
  } catch (err) {
    console.error('iconutil failed:', String(err.message || err));
  }

  app.exit(0);
});
