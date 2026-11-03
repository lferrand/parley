// End-to-end: real mic capture path driven by a WAV file as the fake device.
// Proves tap-mic -> VAD -> upload -> translate -> render, not just the HTTP API.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9335;
const URL = 'http://127.0.0.1:8791/';
const WAV = process.argv[2] || '/tmp/ko_test.wav';

if (!fs.existsSync(WAV)) throw new Error(`missing ${WAV}`);

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--window-size=1200,900', `--remote-debugging-port=${PORT}`,
  '--user-data-dir=/tmp/chrome-mic-e2e',
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  `--use-file-for-fake-audio-capture=${WAV}`,
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
const posts = [];
const errors = [];

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    return;
  }
  if (m.method === 'Network.requestWillBeSent' && m.params.request.url.includes('/api/')) {
    posts.push(`${m.params.request.method} ${m.params.request.url.split('/api/')[1]}`);
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
await send('Network.enable');
await send('Page.navigate', { url: URL });
await sleep(2500);

// Auto-speak off: a live TTS reply would be transcribed as input.
await evalJs(`document.getElementById('autoSpeak').checked = false; true`);
await evalJs(`document.getElementById('autoListen').checked = true; true`);

console.log('tapping mic…');
await evalJs(`document.getElementById('mic').click(); true`);
await sleep(1500);

console.log('after tap:', await evalJs(`({
  listening: state.listening,
  cls: document.getElementById('mic').className,
  label: document.getElementById('micLabel').textContent
})`));

// The fake device loops the file; the VAD should cut an utterance on silence.
console.log('waiting for VAD to cut an utterance…');
let turns = 0;
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  turns = await evalJs(`document.querySelectorAll('.turn').length`);
  if (turns > 0) break;
}

// A turn appears immediately but is pending until the API answers.
// Wait for it to settle, otherwise we screenshot empty text.
let settled = false;
for (let i = 0; i < 60; i++) {
  settled = await evalJs(`(() => {
    const t = document.querySelector('.turn');
    if (!t) return false;
    return !t.classList.contains('pending') && !!t.querySelector('.translation')?.textContent?.trim();
  })()`);
  if (settled) break;
  await sleep(1000);
}
console.log('turn settled:', settled);

console.log('\nnetwork calls:', posts.length ? posts.join(', ') : '(none)');

const result = await evalJs(`(() => {
  const t = document.querySelector('.turn');
  return {
    turns: document.querySelectorAll('.turn').length,
    src: t?.querySelector('.source')?.textContent?.trim() || '',
    out: t?.querySelector('.translation')?.textContent?.trim() || '',
    err: t?.querySelector('.err')?.textContent?.trim() || '',
    meta: t?.querySelector('.turn-head')?.innerText?.replace(/\\n/g,' ').trim() || ''
  };
})()`);

console.log('rendered:', JSON.stringify(result, null, 2));
console.log('exceptions:', errors.length ? errors : '(none)');

const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('/tmp/lfm3_mic_e2e.png', Buffer.from(shot.data, 'base64'));
console.log('screenshot: /tmp/lfm3_mic_e2e.png');

ws.close();
chrome.kill('SIGKILL');
process.exit(result.out && !result.err ? 0 : 1);
