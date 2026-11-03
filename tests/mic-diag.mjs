// Diagnose the mic button: click it, capture console errors and UI state.
import { spawn } from 'node:child_process';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9334;
const URL = process.argv[2] || 'http://127.0.0.1:8791/';
const FAKE = process.argv[3] !== 'no-fake';

const args = [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--window-size=1200,900', `--remote-debugging-port=${PORT}`,
  '--user-data-dir=/tmp/chrome-mic-diag',
];
if (FAKE) {
  args.push('--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream');
}
args.push('about:blank');

const chrome = spawn(CHROME, args, { stdio: 'ignore' });
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
const logs = [];

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    return;
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    logs.push(`[console.${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    logs.push(`[exception] ${d.text} ${d.exception?.description || ''}`);
  }
  if (m.method === 'Log.entryAdded') {
    logs.push(`[log.${m.params.entry.level}] ${m.params.entry.text}`);
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
await send('Log.enable');
await send('Page.navigate', { url: URL });
await sleep(2500);

console.log('URL:', URL);
console.log('\n--- environment the page sees ---');
console.log(await evalJs(`({
  origin: location.origin,
  isSecureContext: window.isSecureContext,
  hasMediaDevices: !!navigator.mediaDevices,
  hasGetUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
  hasMediaRecorder: typeof MediaRecorder !== 'undefined',
  hasAudioCtx: !!(window.AudioContext || window.webkitAudioContext),
  micButtonExists: !!document.getElementById('mic'),
  micListenersAttached: typeof startListening === 'function'
})`));

console.log('\n--- state before click ---');
console.log(await evalJs(`({
  listening: state.listening, busy: state.busy,
  cls: document.getElementById('mic').className,
  label: document.getElementById('micLabel').textContent,
  status: document.getElementById('statusText').textContent
})`));

// Click the actual button.
console.log('\n--- clicking mic ---');
await evalJs(`document.getElementById('mic').click(); true`);
await sleep(2500);

console.log(await evalJs(`({
  listening: state.listening, busy: state.busy,
  cls: document.getElementById('mic').className,
  label: document.getElementById('micLabel').textContent,
  status: document.getElementById('statusText').textContent,
  stream: state.stream ? state.stream.getAudioTracks().map(t => t.readyState) : null
})`));

console.log('\n--- console output ---');
console.log(logs.length ? logs.join('\n') : '(none)');

ws.close();
chrome.kill('SIGKILL');
process.exit(0);
