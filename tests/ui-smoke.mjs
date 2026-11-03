// Drive the running app in headless Chrome and screenshot a real translation.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const APP = 'http://127.0.0.1:8791/';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-proxy-server', '--no-sandbox',
  '--hide-scrollbars', '--window-size=1200,900',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=/tmp/chrome-cdp-lfm3`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWs() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('no CDP target');
}

const wsUrl = await getWs();
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
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
  const r = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.result?.description || ''));
  return r.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: APP });
await sleep(2500);

// Report what the client sees.
const health = await evalJs(`(async () => {
  const h = await fetch('/api/health').then(r => r.json());
  return { ok: h.ok, langs: h.languages.length, partner: document.getElementById('partner').value };
})()`);
console.log('health seen by page:', health);

// Ask for a real Korean line, exactly as typing it would.
await evalJs(`processText('오늘 회의는 오후 세 시에 시작합니다. 늦지 마세요.')`);
await sleep(6000);

const rendered = await evalJs(`(() => {
  const turns = [...document.querySelectorAll('.turn')].map(t => ({
    src: t.querySelector('.source')?.textContent?.trim() || '',
    out: t.querySelector('.translation')?.textContent?.trim() || '',
    err: t.querySelector('.err')?.textContent?.trim() || '',
    meta: t.querySelector('.turn-head')?.innerText?.replace(/\\n/g,' ').trim() || '',
  }));
  return { count: turns.length, turns, engine: document.getElementById('engine').textContent };
})()`);
console.log('rendered turns:', JSON.stringify(rendered, null, 2));

// Turn off auto-speak so the screenshot isn't mid-playback, then capture.
await evalJs(`document.getElementById('autoSpeak').checked = false; true`);
await sleep(300);
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('/tmp/lfm3_live.png', Buffer.from(shot.data, 'base64'));
console.log('screenshot written');

// Second line in the other direction to show both sides.
await evalJs(`processText('See you tomorrow at nine in the morning.')`);
await sleep(6000);
const both = await evalJs(`document.querySelectorAll('.turn').length`);
console.log('turns after second line:', both);
const shot2 = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('/tmp/lfm3_live2.png', Buffer.from(shot2.data, 'base64'));

ws.close();
chrome.kill('SIGKILL');
process.exit(0);
