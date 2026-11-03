// Verify the Inspect panel: click it on a successful exchange and confirm the
// trace renders, including per-attempt reasons when validation rejects output.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9347;
const URL = 'http://127.0.0.1:8791/';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--window-size=1280,1100', `--remote-debugging-port=${PORT}`,
  '--user-data-dir=/tmp/chrome-inspect', 'about:blank',
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
await send('Page.navigate', { url: URL });
await sleep(2500);

// Local engine, one normal translation.
await ev(`document.getElementById('autoSpeak').checked = false;
          document.getElementById('provider').value='ollama';
          document.getElementById('provider').dispatchEvent(new Event('change')); true`);
await ev(`processText('The meeting starts at three in the afternoon.')`);

let settled = false;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  settled = await ev(`(() => {
    const t = document.querySelector('.turn');
    return !!t && !t.classList.contains('pending')
      && !!t.querySelector('.translation')?.textContent?.trim();
  })()`);
  if (settled) break;
}
console.log('turn settled:', settled);
console.log('translation  :', await ev(`document.querySelector('.turn .translation')?.textContent?.trim()`));

console.log('\n=== inspect button present? ===');
console.log(await ev(`(() => {
  const b = document.querySelector('.turn .inspect');
  return b ? { label: b.textContent.trim(), title: b.title } : 'MISSING';
})()`));

console.log('\n=== clicking inspect ===');
await ev(`document.querySelector('.turn .inspect').click(); true`);
await sleep(600);

console.log('panel rendered:', await ev(`!!document.querySelector('.turn .trace')`));
console.log('title         :', await ev(`document.querySelector('.trace-title')?.textContent?.trim()`));
console.log('button now    :', await ev(`document.querySelector('.turn .inspect span')?.textContent?.trim()`));
console.log('rows          :', await ev(`[...document.querySelectorAll('.trace-row')].map(r =>
  (r.querySelector('.k')?.textContent||'')+' = '+(r.querySelector('.v')?.textContent||''))`));
console.log('attempts      :', await ev(`[...document.querySelectorAll('.trace-attempt')].map(a => ({
  stage: a.querySelector('.stage')?.textContent?.trim(),
  ms: a.querySelector('.ms')?.textContent?.trim(),
  badge: a.querySelector('.badge')?.textContent?.trim(),
  preview: (a.querySelector('.preview')?.textContent||'').slice(0,60),
  reasons: [...a.querySelectorAll('.reasons li')].map(li => li.textContent.trim()),
}))`));

const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('/tmp/inspect_panel.png', Buffer.from(shot.data, 'base64'));

// Toggle off
await ev(`document.querySelector('.turn .inspect').click(); true`);
await sleep(300);
console.log('\npanel after toggle off:', await ev(`!!document.querySelector('.turn .trace')`));
console.log('exceptions:', errs.length ? errs.slice(0,3) : '(none)');

ws.close();
chrome.kill('SIGKILL');
process.exit(0);
