// Speak through the real mic path (webm/opus) with the Cloud engine selected.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9345;
const URL = 'http://127.0.0.1:8791/';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--window-size=1200,900', `--remote-debugging-port=${PORT}`,
  '--user-data-dir=/tmp/chrome-mic-modal2',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--use-file-for-fake-audio-capture=/tmp/en_test.wav', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 50; i++) {
    try {
      const l = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      const p = l.find((t) => t.type === 'page');
      if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('no target');
}

const ws = new WebSocket(await wsUrl());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
const errs = [];
const reqs = [];

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  }
  if (m.method === 'Network.requestWillBeSent' &&
      m.params.request.url.includes('/api/translate')) {
    reqs.push(m.params.request.postData || '');
  }
};

const send = (method, params = {}) => {
  const i = ++id;
  return new Promise((resolve, reject) => {
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
};

const ev = async (expr) => {
  const r = await send('Runtime.evaluate', {
    expression: expr, awaitPromise: true, returnByValue: true,
  });
  if (r.exceptionDetails) {
    return { __error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  }
  return r.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Page.navigate', { url: URL });
await sleep(2500);

await ev(`document.getElementById('autoSpeak').checked = false;
          document.getElementById('provider').value = 'modal';
          document.getElementById('provider').dispatchEvent(new Event('change'));
          true`);
await sleep(300);
console.log('engine:', await ev(`document.getElementById('engine').textContent.trim()`));

console.log('tapping mic…');
await ev(`document.getElementById('mic').click(); true`);

let settled = false;
for (let i = 0; i < 90; i++) {
  await sleep(1000);
  settled = await ev(`(() => {
    const t = document.querySelector('.turn');
    return !!t && !t.classList.contains('pending')
      && !!t.querySelector('.translation')?.textContent?.trim();
  })()`);
  if (settled) break;
}
console.log('settled:', settled);

// Read the turn in separate, simple evaluations so no regex is needed.
console.log('translation:', await ev(
  `document.querySelector('.turn .translation')?.textContent?.trim() || ''`));
console.log('error text :', await ev(
  `document.querySelector('.turn .err')?.textContent?.trim() || ''`));
console.log('failed note:', await ev(
  `!!document.querySelector('.turn .note-failed')`));
console.log('head       :', await ev(
  `(document.querySelector('.turn .turn-head')?.textContent || '').replace(/[\\s]+/g,' ').trim()`));

console.log('exceptions :', errs.length ? errs.slice(0, 3) : '(none)');
const body = reqs[reqs.length - 1] || '';
console.log('provider sent:', /"provider":"(\w+)"/.exec(body)?.[1] || '?');

const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('/tmp/mic_modal.png', Buffer.from(shot.data, 'base64'));
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
