#!/usr/bin/env node
/**
 * Windows build entry point.
 *
 * Exists for one reason: electron-builder's bundled `makensis` is an x86_64
 * binary. On Apple Silicon it fails with `spawn Unknown system error -86`
 * (Bad CPU type) unless Rosetta happens to be installed — and on a machine
 * that has never run an Intel app it never is.
 *
 * `vendor/nsis-native/` carries an arm64 makensis from the Homebrew bottle.
 * NSIS needs to find its own stubs and plugins, so NSISDIR points at that
 * bundle's share directory; electron-builder is told about the whole thing
 * through ELECTRON_BUILDER_NSIS_DIR.
 *
 * Only on darwin. On Windows and Linux the stock toolset is native already,
 * and overriding it would be a regression.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NSIS_DIR = path.join(HERE, 'vendor', 'nsis-native');

const extraArgs = process.argv.slice(2);
const env = { ...process.env };

if (process.platform === 'darwin') {
  const makensis = path.join(NSIS_DIR, 'mac', 'makensis');
  if (!fs.existsSync(makensis)) {
    console.error(`
  No native makensis at ${makensis}

  Without it the installer cannot be built on this Mac: electron-builder's
  bundled compiler is x86_64 and macOS will not run it without Rosetta.

  Either install Rosetta (softwareupdate --install-rosetta) or restore the
  arm64 toolset into desktop/vendor/nsis-native (see README, Desktop app ->
  Windows).
`);
    process.exit(1);
  }
  env.ELECTRON_BUILDER_NSIS_DIR = NSIS_DIR;
  // NSIS resolves stubs/plugins relative to its install prefix, not to the
  // executable, so the compiler needs to be told where that prefix is. This
  // bundle is flat — Stubs, Plugins and Include sit at its root, not under
  // share/nsis the way a Linux install lays them out.
  env.NSISDIR = NSIS_DIR;
}

const bin = path.join(HERE, 'node_modules', '.bin', 'electron-builder');
const child = spawn(bin, ['--win', '--x64', ...extraArgs], {
  cwd: HERE,
  env,
  stdio: 'inherit',
});

child.on('exit', (code) => process.exit(code ?? 1));
