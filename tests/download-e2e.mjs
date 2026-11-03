// Verify the "Generate WAV / Download WAV" control: click it, catch the download,
// confirm the bytes are a real WAV the model produced.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9337;
const URL = 'http://127.0.0.1:8791/';
const OUTDIR = path.join(os.tmpdir(), 'lfm3-downloads');
fs.rmSync(OUTDIR, { recursive: true, force: true });
fs.mkdirSync(OUTDIR, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--window-size=1200,900', `--remote-debugging-port=${PORT}`,
  '--user-data-dir=/tmp/chrome-dl-test',
  '--use-fake-ui-for-media-stream',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWs() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      const p = list.find((t) => t.type === 'page');
      if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('no CDP target');
}

const ws = new WebSocket(await getWs());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
const errors = [];

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  }
};

function send(method, params = {}) {
  const myId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(myId, { resolve, reject });
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
}

const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: OUTDIR });
await send('Page.navigate', { url: URL });
await sleep(2500);

// Produce one translation to attach audio to. Auto-speak off so we control TTS.
await evalJs(`document.getElementById('autoSpeak').checked = false; true`);
await evalJs(`processText('The meeting starts at three in the afternoon.')`);

let ready = false;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  ready = await evalJs(`(() => {
    const t = document.querySelector('.turn');
    return !!t && !t.classList.contains('pending') && !!t.querySelector('.translation')?.textContent?.trim();
  })()`);
  if (ready) break;
}
console.log('turn settled:', ready);
console.log('translation:', await evalJs(`document.querySelector('.turn .translation')?.textContent?.trim()`));

const btn = await evalJs(`(() => {
  const b = document.querySelector('.turn-actions .dl');
  return b ? { text: b.textContent.trim(), title: b.title } : null;
})()`);
console.log('button present:', btn);

console.log('clicking Generate WAV…');
await evalJs(`document.querySelector('.turn-actions .dl').click(); true`);

// Wait for a file to land in the download directory.
let files = [];
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  files = fs.readdirSync(OUTDIR).filter((f) => !f.endsWith('.crdownload'));
  if (files.length) break;
}

console.log('downloaded files:', files);
for (const f of files) {
  const full = path.join(OUTDIR, f);
  const stat = fs.statSync(full);
  const head = fs.readFileSync(full).subarray(0, 12);
  const riff = head.subarray(0, 4).toString() === 'RIFF';
  const wave = head.subarray(8, 12).toString() === 'WAVE';
  console.log(`  ${f}`);
  console.log(`    ${stat.size} bytes · RIFF=${riff} WAVE=${wave} · valid=${riff && wave && stat.size > 10000}`);
}

console.log('button after:', await evalJs(`document.querySelector('.turn-actions .dl')?.textContent?.trim()`));
console.log('exceptions:', errors.length ? errors : '(none)');

const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('/tmp/lfm3_download.png', Buffer.from(shot.data, 'base64'));

ws.close();
chrome.kill('SIGKILL');
process.exit(files.length ? 0 : 1);
