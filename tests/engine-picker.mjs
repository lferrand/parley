// Verify the Engine selector: switching it must change which backend serves
// requests, and the UI must reflect that.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9339;
const URL = 'http://127.0.0.1:8791/';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--window-size=1200,900', `--remote-debugging-port=${PORT}`,
  '--user-data-dir=/tmp/chrome-engine-picker',
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
const bodies = [];
const errors = [];

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    return;
  }
  if (m.method === 'Network.requestWillBeSent') {
    const r = m.params.request;
    if (r.url.includes('/api/')) {
      bodies.push({ path: r.url.split('/api/')[1], body: r.postData || '' });
    }
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
await sleep(3000);

console.log('=== selector present? ===');
console.log(await evalJs(`(() => {
  const s = document.getElementById('provider');
  if (!s) return 'MISSING';
  return {
    options: [...s.options].map(o => ({ v: o.value, label: o.text, disabled: o.disabled })),
    current: s.value,
    footer: document.getElementById('engine')?.textContent?.trim(),
  };
})()`));

// 1. local engine
await evalJs(`document.getElementById('autoSpeak').checked = false;
              document.getElementById('provider').value='ollama';
              document.getElementById('provider').dispatchEvent(new Event('change')); true`);
await sleep(300);
console.log('\nlocal selected ->', await evalJs(`document.getElementById('engine').textContent.trim()`));
await evalJs(`processText('The meeting starts at three in the afternoon.')`);
await sleep(8000);
console.log('local result:', await evalJs(`(() => {
  const t = document.querySelector('.turn');
  return { out: t?.querySelector('.translation')?.textContent?.trim() || '',
           meta: t?.querySelector('.turn-head')?.innerText?.replace(/\\n/g,' ').trim() || '' };
})()`));

// 2. cloud engine
await evalJs(`document.getElementById('provider').value='modal';
              document.getElementById('provider').dispatchEvent(new Event('change')); true`);
await sleep(300);
console.log('\ncloud selected ->', await evalJs(`document.getElementById('engine').textContent.trim()`));
await evalJs(`processText('Please bring me some water.')`);
await sleep(45000);
console.log('cloud result:', await evalJs(`(() => {
  const ts = [...document.querySelectorAll('.turn')];
  const t = ts[ts.length-1];
  return { out: t?.querySelector('.translation')?.textContent?.trim() || '',
           err: t?.querySelector('.err')?.textContent?.trim() || '',
           meta: t?.querySelector('.turn-head')?.innerText?.replace(/\\n/g,' ').trim() || '' };
})()`));

console.log('\n=== request bodies seen ===');
for (const b of bodies.slice(-4)) {
  const prov = /"provider":"(\w+)"/.exec(b.body)?.[1] || '(none)';
  console.log(`  ${b.path} provider=${prov}`);
}
console.log('exceptions:', errors.length ? errors : '(none)');

const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('/tmp/engine_picker.png', Buffer.from(shot.data, 'base64'));
console.log('screenshot: /tmp/engine_picker.png');

ws.close();
chrome.kill('SIGKILL');
process.exit(0);
