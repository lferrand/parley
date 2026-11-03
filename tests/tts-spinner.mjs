// Verify the TTS loading indicator: the mic button should show a spinner while
// speech is being generated, then switch to the playing state.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9353;
const URL = process.argv[2] || 'http://127.0.0.1:8791/';
const PROVIDER = process.argv[3] || 'ollama';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--window-size=1280,1000', `--remote-debugging-port=${PORT}`,
  '--user-data-dir=/tmp/chrome-tts-spinner',
  '--autoplay-policy=no-user-gesture-required',
  'about:blank',
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
await sleep(2800);

await ev(`state.provider = ${JSON.stringify(PROVIDER)}; true`);
console.log(`provider: ${PROVIDER}`);

// Start speech generation, then sample the button state as fast as we can.
await ev(`window.__samples = [];
          window.__s0 = Date.now();
          window.__probe = setInterval(() => {
            const mic = document.getElementById('mic');
            const label = document.getElementById('micLabel');
            window.__samples.push({
              t: Date.now() - window.__s0,
              cls: mic.className,
              label: label.textContent.trim(),
              ringOpacity: getComputedStyle(mic.querySelector('.mic-ring')).opacity,
              ringAnim: getComputedStyle(mic.querySelector('.mic-ring')).animationName,
            });
          }, 40);
          speak('회의는 오후 3시에 시작합니다.', 'ko'); true`);

// Wait for the speak() promise to settle by watching state.speaking.
for (let i = 0; i < 100; i++) {
  await sleep(200);
  const done = await ev(`!state.speaking`);
  if (done) break;
}
await sleep(200);
await ev(`clearInterval(window.__probe); true`);

const samples = await ev(`window.__samples`);
console.log(`\nsamples: ${samples.length}`);

// Collapse consecutive identical states into a timeline.
const timeline = [];
for (const s of samples) {
  const last = timeline[timeline.length - 1];
  if (!last || last.cls !== s.cls || last.label !== s.label) {
    timeline.push({ first: s.t, cls: s.cls, label: s.label, anim: s.ringAnim, opacity: s.ringOpacity });
  }
}
console.log('\nstate timeline:');
for (const t of timeline) {
  console.log(`  +${String(t.first).padStart(4)}ms  cls="${t.cls}"  label="${t.label}"  ring=${t.anim}/${t.opacity}`);
}

const sawLoading = samples.some((s) => s.cls.includes('loading'));
const sawSpinning = samples.some((s) => s.ringAnim === 'spin');
const sawSpeaking = samples.some((s) => s.cls.includes('speaking'));
const endedClean = (await ev(`document.getElementById('mic').className`)) === 'mic';

console.log('\nchecks:');
console.log(`  loading state shown : ${sawLoading}`);
console.log(`  spinner animating   : ${sawSpinning}`);
console.log(`  playing state shown : ${sawSpeaking}`);
console.log(`  reset at end        : ${endedClean}`);
console.log(`  exceptions          : ${errs.length ? errs.slice(0,2) : '(none)'}`);

ws.close();
chrome.kill('SIGKILL');
process.exit(0);
