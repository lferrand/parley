// Verify the target-language selector: options render, changing it re-targets
// translations, and source/target cannot collide.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9351;
const URL = 'http://127.0.0.1:8791/';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--window-size=1280,1100', `--remote-debugging-port=${PORT}`,
  '--user-data-dir=/tmp/chrome-target-lang', 'about:blank',
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
const bodies = [];

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
    bodies.push(m.params.request.postData || '');
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
await sleep(2800);

console.log('=== selector present ===');
console.log(await ev(`(() => {
  const s = document.getElementById('targetLang');
  if (!s) return 'MISSING';
  return { current: s.value, count: s.options.length,
           sample: [...s.options].slice(0,5).map(o => o.value + ':' + o.text) };
})()`));

await ev(`document.getElementById('autoSpeak').checked = false; true`);

async function translate(text) {
  await ev(`processText(${JSON.stringify(text)})`);
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    const done = await ev(`(() => {
      const ts=[...document.querySelectorAll('.turn')]; const t=ts[ts.length-1];
      return !!t && !t.classList.contains('pending')
        && !!t.querySelector('.translation')?.textContent?.trim();
    })()`);
    if (done) break;
  }
  return ev(`(() => {
    const ts=[...document.querySelectorAll('.turn')]; const t=ts[ts.length-1];
    return { out: t?.querySelector('.translation')?.textContent?.trim() || '',
             head: (t?.querySelector('.turn-head')?.textContent||'').replace(/[\\s]+/g,' ').trim() };
  })()`);
}

for (const [code, label] of [['ko','Korean'],['ja','Japanese'],['fr','French']]) {
  await ev(`document.getElementById('targetLang').value='${code}';
            document.getElementById('targetLang').dispatchEvent(new Event('change')); true`);
  await sleep(300);
  const r = await translate('Where is the station?');
  console.log(`\n${label}: ${JSON.stringify(r.out)}   [${r.head}]`);
}

console.log('\nhint:', await ev(`document.getElementById('pairingHint').textContent.trim()`));
console.log('collision check:', await ev(`(() => {
  const src=document.getElementById('partner').value;
  const tgt=document.getElementById('targetLang').value;
  const srcOpt=[...document.getElementById('partner').options].find(o=>o.value===tgt);
  return { src, tgt, tgtDisabledInSource: srcOpt ? srcOpt.disabled : null };
})()`));

const body = bodies[bodies.length - 1] || '';
console.log('request target:', /"target":"([\w-]+)"/.exec(body)?.[1] || '?');
console.log('exceptions:', errs.length ? errs.slice(0,3) : '(none)');

const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('/tmp/target_lang.png', Buffer.from(shot.data, 'base64'));

ws.close();
chrome.kill('SIGKILL');
process.exit(0);
