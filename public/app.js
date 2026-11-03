/* Parley — front end
 * Mic capture -> push-to-talk or auto VAD segmentation -> server /api/translate.
 */

const $ = (id) => document.getElementById(id);

const el = {
  partner: $('partner'),
  targetLang: $('targetLang'),
  pairingHint: $('pairingHint'),
  transcript: $('transcript'),
  empty: $('empty'),
  mic: $('mic'),
  micLabel: $('micLabel'),
  liveCaption: $('liveCaption'),
  liveTranslation: $('liveTranslation'),
  level: $('level'),
  status: $('status'),
  dot: $('dot'),
  statusText: $('statusText'),
  autoListen: $('autoListen'),
  audioSource: $('audioSource'),
  autoSpeak: $('autoSpeak'),
  showSource: $('showSource'),
  gender: $('gender'),
  pauseTolerance: $('pauseTolerance'),
  provider: $('provider'),
  copyAll: $('copyAll'),
  clear: $('clear'),
  engine: $('engine'),
  typed: $('typed'),
  sendTyped: $('sendTyped'),
  // model inspector
  modelsBtn: $('modelsBtn'),
  downloadApp: $('downloadApp'),
  downloadLabel: $('downloadLabel'),
  downloadWin: $('downloadWin'),
  downloadWinLabel: $('downloadWinLabel'),
  modelsModal: $('modelsModal'),
  modelsClose: $('modelsClose'),
  modelsDone: $('modelsDone'),
  modelsReveal: $('modelsReveal'),
  modelsDownload: $('modelsDownload'),
  modelsList: $('modelsList'),
  modelsSub: $('modelsSub'),
  modelsNote: $('modelsNote'),
  modelsBar: $('modelsBar'),
  modelsBarFill: $('modelsBarFill'),
};

const state = {
  // The language the speaker is expected to use. Only a hint: script detection
  // still wins, and everything is translated into Korean regardless.
  partner: 'en',
  // Language to translate into. Korean remains the default.
  target: 'ko',
  // Which backend serves requests: 'ollama' (this Mac) or 'modal' (cloud).
  provider: 'ollama',
  providers: { ollama: true, modal: false },
  languages: [],
  turns: [],
  listening: false,
  busy: false,
  speaking: false,
  // When system-audio capture is active, ignore input until this timestamp so
  // the app does not transcribe its own speech coming back off the speakers.
  speakTailUntil: 0,
  stream: null,
  audioCtx: null,
  analyser: null,
  recorder: null,
  chunks: [],
  vadTimer: null,
  ttsCtx: null,
  currentAudio: null,
  speakingSide: 'ko',
};

/* ------------------------------------------------------------------ *
 * Auth
 *
 * When this page is served from Modal, the API needs a token and a browser
 * cannot hold a secret in its own source. The token is pasted once and stored
 * server-side as an HttpOnly cookie, so it never sits in JavaScript or storage.
 * ------------------------------------------------------------------ */

let authPromise = null;

function askForToken() {
  // Only one prompt at a time, even if several calls 401 together.
  if (authPromise) return authPromise;

  authPromise = new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'auth-overlay';
    wrap.innerHTML = `
      <form class="auth-box">
        <h2>Access token required</h2>
        <p>This page is served from the cloud. Paste your access token to continue.
           It is stored as an HttpOnly cookie, not in the page.</p>
        <input type="password" id="authToken" placeholder="Access token"
               autocomplete="off" spellcheck="false" />
        <div class="auth-actions">
          <span class="auth-error" id="authError"></span>
          <button type="submit">Unlock</button>
        </div>
      </form>`;
    document.body.appendChild(wrap);
    const input = wrap.querySelector('#authToken');
    const error = wrap.querySelector('#authError');
    input.focus();

    wrap.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const token = input.value.trim();
      if (!token) return;
      error.textContent = '';
      try {
        const r = await fetch('/api/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        if (!r.ok) {
          error.textContent = 'That token was rejected.';
          return;
        }
        wrap.remove();
        authPromise = null;
        resolve(true);
      } catch (err) {
        error.textContent = String(err.message || err);
      }
    });
  });
  return authPromise;
}

/** fetch() that retries once after obtaining a token. */
async function apiFetch(url, options = {}) {
  let res = await fetch(url, options);
  if (res.status === 401) {
    await askForToken();
    res = await fetch(url, options);
  }
  return res;
}

/* ------------------------------------------------------------------ *
 * Bootstrap
 * ------------------------------------------------------------------ */

async function boot() {
  let health;
  try {
    health = await fetch('/api/health').then((r) => r.json());
  } catch (e) {
    setStatus('bad', 'server unreachable');
    return;
  }

  state.languages = health.languages || [];

  // Only offer the cloud engine when the server actually has a remote URL.
  const providers = health.providers || { ollama: true, modal: false };
  // The picker's local option is labelled "This Mac" and keyed 'ollama', but a
  // llama.cpp build runs locally too. Treat either local engine as "This Mac".
  providers.ollama = providers.ollama !== false || providers.llamacpp === true;

  // The page copy must match where the models actually run. Served from Modal
  // there is no local model behind it, so "on this Mac" and "nothing is
  // uploaded" would both be false.
  const localAvailable = providers.ollama !== false;
  const brandSub = document.getElementById('brandSub');
  const privacyNote = document.getElementById('privacyNote');
  if (brandSub) {
    // The tagline makes no claim about where the work happens, so it stays the
    // same in both modes. The honesty about *where* belongs on the privacy line
    // below, which is the sentence a reader actually checks.
    brandSub.textContent = 'Speak anything. Hear anything.';
  }
  if (privacyNote) {
    privacyNote.textContent = localAvailable
      ? 'Everything runs on this Mac — no cloud, nothing uploaded.'
      : 'Speech is sent to the cloud service for transcription and translation.';
  }
  state.providers = providers;
  if (el.provider) {
    // Disable whichever engine is not available. Previously only "modal" was
    // disabled, so a page served from Modal still offered "This Mac" as the
    // selected option — advertising a backend that does not exist.
    for (const opt of el.provider.options) {
      opt.disabled = !providers[opt.value];
    }

    // If the current selection became unavailable, move to one that works.
    if (!providers[el.provider.value]) {
      // select.options is an HTMLOptionsCollection, not an Array: it has no
      // .find(). Spreading first avoids the TypeError that broke boot().
      const fallback = [...el.provider.options].find((o) => !o.disabled);
      if (fallback) el.provider.value = fallback.value;
    }

    // With a single engine there is nothing to choose, so hide the control
    // rather than showing a dropdown with one live option.
    const usable = [...el.provider.options].filter((o) => !o.disabled);
    const wrap = el.provider.closest('.chip');
    if (wrap) wrap.style.display = usable.length <= 1 ? 'none' : '';

    state.provider = el.provider.value;
  }

  const optionText = (l) => (l.native && l.native !== l.label ? `${l.label} — ${l.native}` : l.label);
  const options = state.languages
    .map((l) => `<option value="${l.code}">${optionText(l)}</option>`)
    .join('');

  // Source language is a hint only; it cannot equal the target.
  el.partner.innerHTML = options;
  el.partner.value = 'en';
  state.partner = 'en';

  if (el.targetLang) {
    el.targetLang.innerHTML = options;
    el.targetLang.value = state.target;
    syncLangSelects();
  }
  if (health.ok) {
    setStatus('ok', `ready · ${health.model}`);
  } else {
    setStatus('bad', health.detail || 'model missing');
  }
  state.engineDetail = health.engine === 'llamacpp'
    ? `llama.cpp · ${health.model}`
    : `${health.model} · ${(health.ollama || '').replace(/^https?:\/\//, '')}`;

  updateEngineLabel();

  applyGenderAvailability();
  render();

  // Offer the desktop build only when the server actually publishes one.
  // The local app would otherwise advertise a download of itself.
  checkDownload();
}

/**
 * Show the desktop download links the server actually publishes.
 *
 * Kept out of the critical path: a failure here must not disturb boot, and the
 * buttons simply stay hidden.
 *
 * Each platform renders independently. A Mac-only volume still shows one
 * button, and a button is never shown for a build that would 404 — the old
 * single-button version assumed macOS and would have offered "Get the Mac app"
 * to a Windows visitor.
 */
async function checkDownload() {
  const targets = {
    mac: { link: el.downloadApp, label: el.downloadLabel, fallback: 'Mac app', ext: 'Parley.dmg' },
    win: { link: el.downloadWin, label: el.downloadWinLabel, fallback: 'Windows app', ext: 'Parley-Setup.exe' },
  };

  /** Point one link at its release. */
  const apply = (kind, info) => {
    const target = targets[kind];
    if (!target?.link) return;

    const mb = Math.round(info.bytes / 1e6);
    target.link.href = info.url;
    target.link.setAttribute('download', info.filename || target.ext);
    // Say the size and the version up front: a 150 MB download that does not
    // announce itself is the kind of thing people abandon halfway.
    if (target.label) {
      target.label.textContent = `${info.label || target.fallback} · ${mb} MB`;
    }
    target.link.title = `Download Parley ${info.version} for ${info.platform}`;
    target.link.hidden = false;
  };

  /**
   * The platform this browser is on gets its button first, because that is the
   * download most visitors want. Order is cosmetic only; both stay clickable.
   */
  const ua = navigator.userAgent || '';
  const here = /Win(dows|64|32)/i.test(ua) ? 'win' : (/Mac OS X|Macintosh/i.test(ua) ? 'mac' : null);

  try {
    const info = await fetch('/api/download').then((r) => r.json());
    if (!info?.available) return;

    const list = Array.isArray(info.downloads) ? info.downloads : [];
    if (list.length) {
      const ordered = [...list].sort((a, b) => (a.kind === here ? -1 : b.kind === here ? 1 : 0));
      for (const entry of ordered) apply(entry.kind, entry);
      return;
    }

    // Older backend: no `downloads` array, just the flat macOS fields.
    apply('mac', {
      url: info.url,
      filename: info.filename,
      bytes: info.bytes,
      version: info.version,
      platform: info.platform,
      label: 'Mac app',
    });
  } catch {
    // No release, or the route does not exist on this build: stay hidden.
  }
}

/** Describe the selected engine in the footer. */
function updateEngineLabel() {
  if (!el.engine) return;
  if (state.provider === 'modal') {
    el.engine.textContent = 'cloud · Modal';
  } else {
    el.engine.textContent = state.engineDetail || 'local · llama.cpp';
  }
}

/**
 * The source hint and the target must differ. Disable the matching option in
 * each select rather than silently overriding the user's choice.
 */
function syncLangSelects() {
  if (!el.targetLang || !el.partner) return;
  const src = el.partner.value;
  const tgt = el.targetLang.value;

  for (const opt of el.partner.options) {
    opt.disabled = opt.value === tgt;
  }
  for (const opt of el.targetLang.options) {
    opt.disabled = opt.value === src;
  }

  // If the pair now collides, move the hint to whatever is still available.
  if (src === tgt) {
    const alt = state.languages.find((l) => l.code !== tgt);
    if (alt) {
      el.partner.value = alt.code;
      state.partner = alt.code;
    }
  }
}

function setStatus(kind, text) {
  el.dot.className = `dot ${kind === 'ok' ? 'ok' : kind === 'bad' ? 'bad' : ''}`;
  el.statusText.textContent = text;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function langLabel(code) {
  return state.languages.find((l) => l.code === code)?.label || code.toUpperCase();
}

function render() {
  if (!state.turns.length) {
    // Clear must actually remove the rendered turns. Returning early here left
    // the old innerHTML in the DOM, so the transcript stayed on screen and the
    // button looked broken — the state was empty, the view was not.
    //
    // The empty state lives INSIDE #transcript, so wiping innerHTML deletes the
    // node itself. It is re-appended afterwards, otherwise the "Tap the
    // microphone" prompt would vanish permanently after the first Clear.
    el.transcript.innerHTML = '';
    el.transcript.append(el.empty);
    el.empty.style.display = '';
    return;
  }
  el.empty.style.display = 'none';
  el.transcript.innerHTML = state.turns.map(turnHtml).join('');
  el.transcript.scrollTop = el.transcript.scrollHeight;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function turnHtml(t) {
  const alreadyKorean = t.sourceLang === 'ko';
  const head = `
    <div class="turn-head">
      <span class="pill ${alreadyKorean ? 'ko' : ''}">${esc(langLabel(t.sourceLang))}</span>
      <span class="arrow">→</span>
      <span class="pill out">${alreadyKorean ? 'as spoken' : esc(langLabel(t.targetLang))}</span>
      ${t.timings ? `<span class="ms">${t.timings.totalMs} ms</span>` : ''}
    </div>`;

  if (t.error) {
    return `<article class="turn ${alreadyKorean ? 'from-ko' : ''}" data-id="${t.id}">
      ${head}
      ${t.transcript ? `<div class="source">${esc(t.transcript)}</div>` : ''}
      <div class="err">⚠️ ${esc(t.error)}</div>
    </article>`;
  }

  if (t.pending) {
    return `<article class="turn pending ${alreadyKorean ? 'from-ko' : ''}" data-id="${t.id}">
      ${head}
      ${t.transcript ? `<div class="source">${esc(t.transcript)}</div>` : '<div class="source dots"></div>'}
      <div class="translation dots"></div>
    </article>`;
  }

  // For Korean input there is no second line to show.
  const showSource = !alreadyKorean && el.showSource.checked && t.transcript && t.transcript !== t.translation;
  const canDownload = !alreadyKorean && t.translation && !t.failed;
  const actions = [];
  if (canDownload) {
    actions.push(`<button class="mini dl" data-id="${t.id}" title="Download the spoken Korean as a WAV file">
        <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M12 3a1 1 0 0 1 1 1v9.59l3.3-3.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.42l3.3 3.3V4a1 1 0 0 1 1-1ZM5 19a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1Z"/></svg>
        <span>${t.audioBlob ? 'Download WAV' : 'Generate WAV'}</span>
      </button>`);
  }
  actions.push(`<button class="mini inspect" data-id="${t.id}" title="Show how this translation was produced">
      <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M12 5c-5 0-9 4.5-9 7s4 7 9 7 9-4.5 9-7-4-7-9-7Zm0 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"/></svg>
      <span>${t.showTrace ? 'Hide details' : 'Inspect'}</span>
    </button>`);

  return `<article class="turn ${alreadyKorean ? 'from-ko' : ''}" data-id="${t.id}">
    ${head}
    ${showSource ? `<div class="source" lang="${esc(t.sourceLang)}">${esc(t.transcript)}</div>` : ''}
    ${t.failed
      ? `<div class="note-failed">No translation passed checks — showing the original text.</div>`
      : ''}
    <div class="translation${t.failed ? ' untranslated' : ''}" lang="${esc(t.targetLang)}">${esc(t.translation)}</div>
    <div class="turn-actions">${actions.join('')}</div>
    ${t.showTrace ? traceHtml(t) : ''}
  </article>`;
}

/* ------------------------------------------------------------------ *
 * Inspect panel: how this exchange was produced
 * ------------------------------------------------------------------ */

function msLabel(ms) {
  if (!Number.isFinite(ms)) return '';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms} ms`;
}

function traceHtml(t) {
  const tr = t.trace || {};
  const rows = [];

  rows.push(`<div class="trace-row"><span class="k">engine</span><span class="v">${esc(tr.provider === 'modal' ? 'cloud · Modal' : 'local · Ollama')}</span></div>`);
  if (t.timings) {
    rows.push(`<div class="trace-row"><span class="k">total</span><span class="v">${msLabel(t.timings.totalMs)}</span></div>`);
    if (t.timings.asrMs) {
      rows.push(`<div class="trace-row"><span class="k">speech → text</span><span class="v">${msLabel(t.timings.asrMs)}</span></div>`);
    }
    if (t.timings.translateMs) {
      rows.push(`<div class="trace-row"><span class="k">translation</span><span class="v">${msLabel(t.timings.translateMs)}</span></div>`);
    }
  }
  rows.push(`<div class="trace-row"><span class="k">result</span><span class="v">${esc(t.mode || 'unknown')}</span></div>`);

  if (tr.notice) {
    rows.push(`<div class="trace-note">${esc(tr.notice)}</div>`);
  }

  const attempts = tr.attempts || [];
  const attemptsHtml = attempts.length
    ? attempts.map((a) => `
      <div class="trace-attempt ${a.ok ? 'ok' : 'bad'}">
        <div class="trace-attempt-head">
          <span class="stage">${esc(a.stage)}</span>
          <span class="ms">${msLabel(a.ms)}</span>
          <span class="badge">${a.ok ? 'accepted' : 'rejected'}</span>
        </div>
        ${a.preview ? `<div class="preview">${esc(a.preview)}${a.chars > a.preview.length ? '…' : ''}</div>` : ''}
        ${a.reasons && a.reasons.length
          ? `<ul class="reasons">${a.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`
          : ''}
      </div>`).join('')
    : `<div class="trace-empty">No model attempts recorded for this exchange.</div>`;

  return `<div class="trace">
    <div class="trace-title">How this was produced</div>
    <div class="trace-grid">
      <div class="trace-section">
        <div class="trace-sub">Input</div>
        <div class="trace-row"><span class="k">text</span><span class="v">${esc((t.transcript || '').slice(0, 200))}</span></div>
        <div class="trace-row"><span class="k">detected</span><span class="v">${esc(langLabel(t.sourceLang))} → ${esc(langLabel(t.targetLang))}</span></div>
      </div>
      <div class="trace-section">
        <div class="trace-sub">Steps</div>
        ${rows.join('')}
      </div>
    </div>
    <div class="trace-sub">Model attempts (${attempts.length})</div>
    ${attemptsHtml}
  </div>`;
}

function addTurn(turn) {
  state.turns.push(turn);
  if (state.turns.length > 200) state.turns.shift();
  render();
}

function updateTurn(id, patch) {
  const t = state.turns.find((x) => x.id === id);
  if (!t) return;
  Object.assign(t, patch);
  render();
}

/* ------------------------------------------------------------------ *
 * Audio pipeline
 * ------------------------------------------------------------------ */

function pickMime() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  return candidates.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || '';
}

/**
 * Microphone capture.
 *
 * Echo cancellation and noise suppression are right here: this is a person
 * talking into a laptop in a room, and those filters remove fan hum, keyboard
 * clicks and the app's own playback from the speakers.
 */
async function micStream() {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
}

/**
 * System-audio capture — translate what the Mac is playing.
 *
 * Two things make this work:
 *
 * 1. `getDisplayMedia` demands a video track. The desktop shell answers through
 *    `setDisplayMediaRequestHandler` (main.mjs) with loopback audio attached;
 *    we drop the video track immediately, since nothing is being recorded.
 *
 * 2. The loopback track arrives with echoCancellation, noiseSuppression and
 *    autoGainControl switched ON. That is actively harmful here: those filters
 *    are tuned for a close-talking mic and they mangle music, compress wide
 *    dynamics, and — worst — attempt to cancel our own TTS output coming back
 *    through the speakers. They are switched off explicitly.
 */
async function systemAudioStream() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('system audio needs the desktop app');
  }

  const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });

  // Nothing in this app records video.
  display.getVideoTracks().forEach((t) => t.stop());

  const [audio] = display.getAudioTracks();
  if (!audio) {
    throw new Error('no system audio track — is another app playing sound?');
  }

  try {
    await audio.applyConstraints({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    });
  } catch {
    // Some builds reject constraints on a loopback track. The capture still
    // works; it is just filtered, so this is not fatal.
  }

  return new MediaStream([audio]);
}

async function startListening() {
  if (state.listening || state.busy) return;

  const useSystem = el.audioSource?.value === 'system';

  try {
    state.stream = useSystem ? await systemAudioStream() : await micStream();
  } catch (e) {
    setStatus('bad', useSystem ? 'audio blocked' : 'mic blocked');
    flash(useSystem
      ? `Could not capture system audio: ${e.message || e}`
      : 'Microphone permission denied');
    return;
  }

  state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = state.audioCtx.createMediaStreamSource(state.stream);
  state.analyser = state.audioCtx.createAnalyser();
  state.analyser.fftSize = 1024;
  src.connect(state.analyser);

  state.listening = true;
  el.mic.classList.add('live');
  el.micLabel.textContent = el.autoListen.checked ? 'Listening — just talk' : 'Listening…';
  meterLoop();

  try {
    if (el.autoListen.checked) startSegmenter();
    else startRecorder(); // push-to-talk: record until tapped again
  } catch (e) {
    // A throw here used to leave a red mic that recorded nothing.
    console.error('failed to start capture', e);
    stopListening();
    setStatus('bad', 'capture failed');
    flash(`Could not start the microphone: ${e.message || e}`);
  }
}

function stopListening() {
  state.listening = false;
  el.mic.classList.remove('live');
  el.micLabel.textContent = 'Tap to speak';
  el.level.style.width = '0%';

  clearInterval(state.vadTimer);
  state.vadTimer = null;

  if (state.recorder && state.recorder.state !== 'inactive') {
    try { state.recorder.stop(); } catch {}
  }
  state.recorder = null;
  // Only defined while auto-listen is segmenting; optional-call it.
  state.stopSegmentRecorder?.();
  state.stopSegmentRecorder = null;

  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
  state.audioCtx?.close().catch(() => {});
  state.audioCtx = null;
  state.analyser = null;
}

function meterLoop() {
  if (!state.analyser) return;
  const buf = new Uint8Array(state.analyser.fftSize);
  const tick = () => {
    if (!state.analyser) return;
    state.analyser.getByteTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      peak = Math.max(peak, Math.abs(buf[i] - 128) / 128);
    }
    el.level.style.width = `${Math.min(100, Math.round(peak * 260))}%`;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* --- push-to-talk: one continuous recording per tap ----------------- */

function startRecorder() {
  const mime = pickMime();
  state.chunks = [];
  const rec = new MediaRecorder(state.stream, mime ? { mimeType: mime } : undefined);
  const type = rec.mimeType || 'audio/webm';
  state.recorder = rec;
  rec.ondataavailable = (e) => { if (e.data.size) state.chunks.push(e.data); };
  rec.onstop = async () => {
    const chunks = state.chunks;
    state.chunks = [];
    if (!chunks.length) return;
    const blob = new Blob(chunks, { type });
    if (blob.size > 2000) await processAudio(blob);
  };
  rec.start();
}

/* --- auto mode: VAD-segmented utterances --------------------------- */

const VAD = {
  minThreshold: 0.012,   // absolute floor, for very quiet rooms
  thresholdFactor: 2.2,  // how far above the room's noise floor counts as speech
  releaseFactor: 0.6,    // hysteresis: keep going while above threshold*this
  hangoverMs: 1400,      // pause tolerated mid-sentence before the turn ends
  minSpeechMs: 300,      // ignore clicks and pops
  maxUtteranceMs: 30000, // hard cap so one turn can't run forever
};

function startSegmenter() {
  const buf = new Uint8Array(state.analyser.fftSize);
  let segRec = null;
  let segChunks = [];
  let segmentStartedAt = 0;
  let lastVoiceAt = 0;
  let armed = false;
  let noiseFloor = 0.006;

  const rms = () => {
    state.analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / buf.length);
  };

  const openThreshold = () => Math.max(VAD.minThreshold, noiseFloor * VAD.thresholdFactor);

  const beginSegment = () => {
    const mime = pickMime();
    segChunks = [];
    const rec = new MediaRecorder(state.stream, mime ? { mimeType: mime } : undefined);
    const type = rec.mimeType || 'audio/webm';
    const startedAt = performance.now();
    segRec = rec;
    rec.ondataavailable = (e) => { if (e.data.size) segChunks.push(e.data); };
    rec.onstop = async () => {
      stopInterim();
      const chunks = segChunks;
      segChunks = [];
      const blob = new Blob(chunks, { type });
      const ms = performance.now() - startedAt;
      if (ms < VAD.minSpeechMs || blob.size < 2500) return;
      enqueueUtterance(blob);
    };
    rec.start(120);
    segmentStartedAt = startedAt;
    lastVoiceAt = startedAt;
    startInterim(type);
  };

  /**
   * Interim transcription: words while you are still speaking.
   *
   * A long utterance used to arrive as one paragraph when the pause finally
   * came, because nothing was transcribed until the segment closed. Polling the
   * accumulated chunks every INTERIM_MS fixes that: a half-written webm decodes
   * fine (verified), so the same audio can be re-read as it grows.
   *
   * Deliberately cheap and disposable:
   *   - ASR only, no translation, no guards
   *   - one request in flight at a time, or a slow model would queue dozens
   *   - skipped entirely while a real turn is processing, so the final
   *     transcript never waits behind speculative work
   *   - every failure is swallowed; interim text is a courtesy, not a result
   */
  let interimTimer = null;
  let interimBusy = false;

  const stopInterim = () => {
    clearInterval(interimTimer);
    interimTimer = null;
    interimBusy = false;
    if (el.liveCaption) {
      el.liveCaption.hidden = true;
      el.liveCaption.textContent = '';
    }
    if (el.liveTranslation) {
      el.liveTranslation.hidden = true;
      el.liveTranslation.textContent = '';
    }
  };

  /**
   * Translation cannot be streamed the way transcription can.
   *
   * Measured on a 21-word sentence: as the source grew, the Korean output was
   * recomputed rather than extended — 12 of 19 steps rewrote text that had
   * already been shown, and on average only 78% of the previous line survived.
   * A naive "translate the partial transcript every second" stream would
   * therefore flicker wrong Korean at the reader.
   *
   * But a *completed* sentence is stable: "The meeting starts at 3pm." returned
   * the identical Korean on 3 of 3 runs. So the unit of commitment is the
   * sentence, not the tick. Finished sentences are translated once and never
   * revised; the unfinished tail is left to the final pass.
   */
  const SENTENCE_END = /[.!?。！？]\s*$/;

  /**
   * How many trailing sentences stay eligible for revision.
   *
   * The first version of this froze every sentence the moment it completed, on
   * the theory that a reader should never see a finished line change. That was
   * wrong: the recogniser keeps refining what it heard as more audio arrives
   * ("The meeting starts at 3." became "...at 3pm. Please bring the quarterly
   * report." between polls), so a frozen sentence could pin a mishearing in
   * place permanently.
   *
   * A window of 3 keeps the recent context live, so a correction to the source
   * propagates into the translation, while everything older settles and stops
   * costing anything.
   */
  const REVISION_WINDOW = 3;

  /**
   * Split a transcript into finished sentences.
   *
   * The trailing fragment is dropped: it is still being spoken, and translating
   * it would produce a guess that the next poll has to throw away.
   */
  const splitSentences = (text) => {
    const parts = String(text || '').match(/[^.!?。！？]+[.!?。！？]+/g) || [];
    return parts.map((s) => s.trim()).filter((s) => s && SENTENCE_END.test(s));
  };

  const startInterim = (type) => {
    stopInterim();
    let lastShown = '';

    // Sentences that have fallen out of the window and will not change again.
    const settledSrc = [];
    const settledDst = [];

    // Last window translation, keyed by the source it was made from.
    const translateCache = { key: '', value: '' };

    const translate = async (text) => {
      // Reuse an identical request instead of spending a call on it. Interim
      // polls often return the same transcript twice in a row (a pause, a slow
      // syllable), and each poll would otherwise translate the same string
      // again. On the cloud backend that is the difference between staying
      // under the rate limit and being throttled mid-sentence.
      if (text === translateCache.key) return translateCache.value;

      const r = await apiFetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text, source: state.partner, target: state.target, provider: state.provider,
        }),
      });
      if (!r.ok) {
        // 429 is not a transient blip: the interim translation is now paused
        // until the window refills. Say so rather than silently freezing the
        // text, which looks like the app has stopped working.
        if (r.status === 429) {
          const retry = r.headers.get('retry-after') || 'a moment';
          if (el.liveTranslation && translateCache.value) {
            el.liveTranslation.textContent = `${translateCache.value} …`;
          }
          console.warn(`[interim] throttled, retry in ${retry}s`);
        }
        return '';
      }
      const d = await r.json();
      const value = String(d.translation || '').trim();
      translateCache.key = text;
      translateCache.value = value;
      return value;
    };

    // Poll cadence differs by backend. The cloud engine is rate limited per
    // client IP and each poll costs one translate call, so polling every 1.2s
    // would exhaust the budget mid-sentence. Local inference has no such limit
    // and benefits from the tighter cadence.
    const INTERIM_MS = state.provider === 'modal' ? 2400 : 1200;

    interimTimer = setInterval(async () => {
      if (!armed || interimBusy || state.busy) return;
      // A very short prefix is below what the model can recognise reliably and
      // it invents words: the first sampled poll returned "he did have better
      // time." for 900 ms of speech, then corrected itself. Waiting longer is
      // what stops the caption flickering through nonsense.
      if (performance.now() - segmentStartedAt < 1200) return;
      if (segChunks.reduce((n, c) => n + c.size, 0) < 20000) return;

      interimBusy = true;
      try {
        const partial = new Blob(segChunks.slice(), { type });
        const audio = await blobToBase64(partial);
        const res = await apiFetch('/api/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audio, source: state.partner, provider: state.provider }),
        });
        if (!res.ok) return;
        const data = await res.json();
        const text = String(data.transcript || '').trim();
        // Ignore a stale reply that landed after the segment closed.
        if (!armed) return;

        // Interim text may only grow. Each poll re-reads the whole segment, so
        // a shorter result means the model re-decoded and changed its mind —
        // showing that would make the caption jitter backwards. Once it has
        // said more, keep the more complete line.
        const grew = text.length > lastShown.length;
        if (text && grew && el.liveCaption) {
          lastShown = text;
          el.liveCaption.hidden = false;
          el.liveCaption.textContent = text;
        }

        const sentences = splitSentences(text);
        if (!sentences.length) return;

        // Everything before the window is final. Translate any newly settled
        // sentences in one batch — they are never revisited, so this happens at
        // most once per sentence for the whole utterance.
        const windowStart = Math.max(0, sentences.length - REVISION_WINDOW);

        // Guard against the recogniser RETRACTING text. A later poll can return
        // fewer sentences than an earlier one (a mishearing collapsing into a
        // shorter correct reading). Without this, settledSrc keeps describing
        // sentences that no longer exist and the displayed translation drifts
        // away from the transcript.
        if (settledSrc.length > windowStart) {
          settledSrc.length = windowStart;
          settledDst.length = windowStart;
        }

        const settledNow = windowStart - settledSrc.length;
        if (settledNow > 0) {
          const batch = sentences.slice(settledSrc.length, windowStart);
          const translated = await translate(batch.join(' '));
          if (!armed) return;
          if (translated) {
            settledSrc.push(...batch);
            settledDst.push(translated);
          }
        }

        // The window is re-translated as a block on every poll. Batching keeps
        // cross-sentence context (pronouns, connectives) instead of translating
        // sentences in isolation, and re-doing it is the whole point: a
        // correction to the source must reach the translation.
        const windowSentences = sentences.slice(windowStart);
        if (!windowSentences.length) return;

        const windowDst = await translate(windowSentences.join(' '));
        if (!armed || !windowDst) return;

        const shown = [...settledDst, windowDst].filter(Boolean).join(' ');
        if (!shown) return;

        if (el.liveTranslation) {
          el.liveTranslation.hidden = false;
          el.liveTranslation.textContent = shown;
        }
      } catch {
        // Interim is best-effort: a dropped frame must never surface as an error.
      } finally {
        interimBusy = false;
      }
    }, INTERIM_MS);
  };

  const endSegment = () => {
    armed = false;
    const rec = segRec;
    segRec = null;
    if (rec && rec.state !== 'inactive') {
      try { rec.stop(); } catch {}
    }
  };

  state.stopSegmentRecorder = endSegment;

  state.vadTimer = setInterval(() => {
    if (!state.listening || !state.analyser) return;

    // While our own translation is playing we must not record. Freeze the
    // timers instead of skipping the tick, or the silence clock runs on
    // during playback and the next turn gets cut off instantly.
    //
    // `speakTailUntil` extends that window past the end of playback. With
    // system audio the capture is a loopback of the speakers, so the last few
    // hundred milliseconds of our own speech are still arriving after
    // `state.speaking` goes false. Without the tail it transcribed itself.
    if (state.speaking || performance.now() < (state.speakTailUntil || 0)) {
      if (armed) lastVoiceAt = performance.now();
      return;
    }

    const level = rms();
    const now = performance.now();
    const open = openThreshold();

    // Track the room's quiet level only while nobody is talking.
    if (level < open) noiseFloor = noiseFloor * 0.95 + level * 0.05;

    if (!armed) {
      if (level > open) {
        armed = true;
        beginSegment();
      }
      return;
    }

    // Hysteresis: a softer sound still counts as speaking, so trailing
    // consonants and quiet syllables don't end the turn.
    if (level > open * VAD.releaseFactor) lastVoiceAt = now;

    if (now - lastVoiceAt > hangoverMs()) return endSegment();
    if (now - segmentStartedAt > VAD.maxUtteranceMs) return endSegment();
  }, 60);
}

/** The user's chosen pause tolerance, in ms. */
function hangoverMs() {
  const v = Number(el.pauseTolerance?.value);
  return Number.isFinite(v) && v > 0 ? v : VAD.hangoverMs;
}

/**
 * Utterances are queued, not dropped. The old code returned early when a
 * translation was already in flight, which silently discarded anything said
 * while the previous turn was still processing.
 */
const utteranceQueue = [];
let drainingQueue = false;

function enqueueUtterance(blob) {
  utteranceQueue.push(blob);
  if (!drainingQueue) drainUtterances();
}

async function drainUtterances() {
  drainingQueue = true;
  try {
    while (utteranceQueue.length) {
      const blob = utteranceQueue.shift();
      await processAudio(blob);
    }
  } finally {
    drainingQueue = false;
  }
}

/* --- upload + translate -------------------------------------------- */

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

async function processAudio(blob) {
  if (state.busy) return;
  state.busy = true;
  el.mic.classList.add('busy');

  const id = crypto.randomUUID();
  addTurn({ id, pending: true, sourceLang: state.partner, targetLang: state.target });
  setEngine('transcribing…');

  try {
    const audio = await blobToBase64(blob);
    await submit({ audio }, id);
  } catch (e) {
    updateTurn(id, { pending: false, error: String(e.message || e) });
  } finally {
    state.busy = false;
    el.mic.classList.remove('busy');
    setEngine('');
  }
}

async function processText(text) {
  if (!text || state.busy) return;
  state.busy = true;
  const id = crypto.randomUUID();
  // Hangul in the input means it is Korean regardless of the hint.
  const looksKorean = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7A3]/.test(text);
  addTurn({
    id,
    pending: true,
    sourceLang: looksKorean ? 'ko' : state.partner,
    targetLang: state.target,
  });
  try {
    await submit({ text }, id);
  } catch (e) {
    updateTurn(id, { pending: false, error: String(e.message || e) });
  } finally {
    state.busy = false;
  }
}

async function submit(payload, id) {
  const res = await apiFetch('/api/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // `source` is only a hint for ambiguous Latin-script input.
    body: JSON.stringify({ ...payload, source: state.partner, target: state.target, provider: state.provider }),
  });
  // The remote can answer with plain text (e.g. "Internal Server Error").
  // Parsing that as JSON produced "Unexpected token 'I'" instead of a real
  // message, so read the body as text and parse defensively.
  const raw = await res.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    const snippet = raw.trim().slice(0, 160).replace(/\s+/g, ' ');
    throw new Error(
      res.ok
        ? `unexpected reply from the server: ${snippet}`
        : `HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`,
    );
  }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  if (!data) throw new Error('empty reply from the server');

  // mode 'failed' means no candidate passed validation and the server sent the
  // source text back. Showing that as a translation would be a lie — flag it.
  const failed = data.mode === 'failed';

  updateTurn(id, {
    pending: false,
    transcript: data.transcript,
    translation: data.translation,
    sourceLang: data.sourceLang,
    targetLang: data.targetLang,
    timings: data.timings,
    mode: data.mode,
    failed,
    trace: data.trace || null,
    at: Date.now(),
  });

  // Korean input is echoed, not translated: nothing to speak.
  if (data.sourceLang === 'ko') return;

  // Don't speak untranslated text in the target voice.
  if (!failed && el.autoSpeak.checked && data.translation) {
    speak(data.translation, data.targetLang);
  }
  return data;
}

/* ------------------------------------------------------------------ *
 * Audio download
 * ------------------------------------------------------------------ */

/** Readable, filesystem-safe name built from the translation. */
function audioFilename(turn) {
  const text = (turn.translation || 'translation').replace(/\s+/g, ' ').trim();
  // Keep Hangul; drop characters a filesystem dislikes.
  const base = text.replace(/[\\/:*?"<>|]/g, '').slice(0, 60).trim() || 'translation';
  const stamp = new Date(turn.at || Date.now())
    .toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${base} (${stamp}).wav`;
}

/** Fetch the WAV for a turn, reusing it if we already have it. */
async function fetchTurnAudio(turn) {
  if (turn.audioBlob) return turn.audioBlob;
  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: turn.translation,
      lang: turn.targetLang,
      gender: el.gender.value,
      provider: state.provider,
    }),
  });
  if (!res.ok) throw new Error(`tts failed (${res.status})`);
  const blob = await res.blob();
  turn.audioBlob = blob;
  return blob;
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the download has had a chance to start.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function downloadTurnAudio(turn, button) {
  const label = button.querySelector('span');
  const original = label?.textContent || '';
  if (button.disabled) return;
  button.disabled = true;
  if (label) label.textContent = 'Generating…';

  try {
    const blob = await fetchTurnAudio(turn);
    saveBlob(blob, audioFilename(turn));
  } catch (e) {
    console.warn('download failed', e);
    flash(`Could not make the audio file: ${e.message || e}`);
  } finally {
    button.disabled = false;
    // Re-render so the label reflects the cached state.
    render();
  }
}

/**
 * Turns are re-rendered wholesale, so per-button listeners would be lost.
 * Delegate from the transcript container instead.
 */
el.transcript.addEventListener('click', (e) => {
  const dl = e.target.closest('.dl');
  if (dl) {
    const turn = state.turns.find((t) => t.id === dl.dataset.id);
    if (turn) downloadTurnAudio(turn, dl);
    return;
  }

  const inspect = e.target.closest('.inspect');
  if (inspect) {
    const turn = state.turns.find((t) => t.id === inspect.dataset.id);
    if (!turn) return;
    turn.showTrace = !turn.showTrace;
    render();
  }
});

/* ------------------------------------------------------------------ *
 * Speech output
 * ------------------------------------------------------------------ */

function getAudioCtx() {
  if (!state.ttsCtx) state.ttsCtx = new (window.AudioContext || window.webkitAudioContext)();
  return state.ttsCtx;
}

async function speak(text, lang) {
  try {
    // Two phases, shown differently: generating (network + model, can take
    // seconds on the cloud engine) and playing. Before this, the label said
    // "Speaking translation…" during the download, so a slow TTS looked stuck.
    state.speaking = true;
    el.mic.classList.add('loading');
    el.micLabel.textContent = 'Generating speech…';

    const res = await apiFetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, lang, gender: el.gender.value, provider: state.provider }),
    });

    if (!res.ok) {
      // graceful fallback to the browser voice (still counts as playing)
      el.mic.classList.remove('loading');
      el.mic.classList.add('speaking');
      el.micLabel.textContent = 'Speaking translation…';
      browserSpeak(text, lang);
      return;
    }

    const buf = await (await res.blob()).arrayBuffer();
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') await ctx.resume();
    const audioBuffer = await ctx.decodeAudioData(buf.slice(0));

    // Audio is decoded and about to play: swap the spinner for the play state.
    el.mic.classList.remove('loading');
    el.mic.classList.add('speaking');
    el.micLabel.textContent = 'Speaking translation…';

    await new Promise((resolve) => {
      const src = ctx.createBufferSource();
      src.buffer = audioBuffer;
      src.connect(ctx.destination);
      state.currentAudio = src;
      src.onended = () => {
        state.currentAudio = null;
        resolve();
      };
      src.start();
    });
  } catch (e) {
    console.warn('tts failed', e);
    browserSpeak(text, lang);
  } finally {
    state.speaking = false;
    // Let the loopback settle before listening again: our own audio is still
    // in flight through the speakers and back into the capture device. A short
    // tail stops the app from transcribing itself.
    if (el.audioSource?.value === 'system') {
      state.speakTailUntil = performance.now() + 450;
    }
    el.mic.classList.remove('speaking', 'loading');
    el.micLabel.textContent = state.listening
      ? (el.autoListen.checked ? 'Listening — just talk' : 'Listening…')
      : 'Tap to speak';
  }
}

function browserSpeak(text, lang) {
  if (!('speechSynthesis' in window)) return;
  const code = state.languages.find((l) => l.code === lang)?.bcp47 || lang;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = code;
  u.rate = 0.98;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}

function stopSpeaking() {
  state.currentAudio?.stop?.();
  state.currentAudio = null;
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}

/* ------------------------------------------------------------------ *
 * UI wiring
 * ------------------------------------------------------------------ */

function flash(msg) {
  if (!msg) return;
  el.empty.style.display = 'none';
  const node = document.createElement('div');
  node.className = 'turn';
  node.style.borderLeftColor = 'var(--warn)';
  node.innerHTML = `<div class="source" style="margin:0">${esc(msg)}</div>`;
  el.transcript.appendChild(node);
  el.transcript.scrollTop = el.transcript.scrollHeight;
  setTimeout(() => node.remove(), 4200);
}

function setEngine(text) {
  el.engine.textContent = text;
}

function applyGenderAvailability() {
  // both voices exist for every supported locale in LFM3-Audio
  el.gender.disabled = false;
}

el.mic.addEventListener('click', () => {
  if (state.speaking) { stopSpeaking(); return; }
  if (state.listening) stopListening();
  else startListening();
});

el.partner.addEventListener('change', () => {
  state.partner = el.partner.value;
  syncLangSelects();
  updatePairingHint();
});

el.targetLang?.addEventListener('change', () => {
  state.target = el.targetLang.value;
  syncLangSelects();
  updatePairingHint();
  // Cached audio and pending panels belong to the previous target language.
  for (const t of state.turns) delete t.audioBlob;
  render();
});

function updatePairingHint() {
  el.pairingHint.textContent =
    `Translating ${langLabel(state.partner)} into ${langLabel(state.target)}. ` +
    'Text already in that language is shown as-is.';
}

el.showSource.addEventListener('change', render);

el.autoListen.addEventListener('change', () => {
  if (!state.listening) return;
  stopListening();
  startListening();
});

// Switching input while listening has to restart capture: a microphone stream
// and a loopback stream are different devices, and MediaRecorder cannot be
// re-pointed at a new one.
el.audioSource.addEventListener('change', () => {
  if (!state.listening) {
    flash(el.audioSource.value === 'system'
      ? 'System audio selected — press the microphone to start listening.'
      : 'Microphone selected.');
    return;
  }
  stopListening();
  startListening();
});

el.clear.addEventListener('click', () => {
  state.turns = [];
  render();
});

/* ------------------------------------------------------------------ *
 * Model inspector
 *
 * The splash explains the first download and then disappears forever. If a
 * model is later moved, deleted, or left half-written by an interrupted
 * download, the only symptom is that boot fails — with nothing to look at.
 * This panel is that look.
 * ------------------------------------------------------------------ */

const MB = (bytes) => `${(bytes / 1e6).toFixed(0)} MB`;

function modelStateLabel(m) {
  switch (m.state) {
    case 'ready': return 'ready';
    case 'partial': return `paused at ${m.percent}%`;
    case 'truncated': return 'incomplete';
    default: return 'missing';
  }
}

function renderModels(report) {
  el.modelsList.innerHTML = '';

  for (const m of report.models) {
    const li = document.createElement('li');
    li.className = 'mrow';

    const top = document.createElement('div');
    top.className = 'mrow-top';

    const name = document.createElement('span');
    name.className = 'mname';
    name.textContent = m.name;
    name.title = m.name;

    const role = document.createElement('span');
    role.className = 'mrole';
    role.textContent = m.role;

    const state = document.createElement('span');
    state.className = `mstate ${m.state}`;
    state.textContent = modelStateLabel(m);
    state.title = m.onDisk ? `${MB(m.onDisk)} of ${MB(m.bytes)}` : MB(m.bytes);

    top.append(name, role, state);

    const track = document.createElement('div');
    track.className = 'mtrack';
    const fill = document.createElement('i');
    fill.style.width = m.state === 'ready' ? '100%' : (m.state === 'missing' ? '0%' : `${m.percent}%`);
    track.append(fill);

    li.append(top, track);
    el.modelsList.append(li);
  }

  const missing = report.models.filter((m) => m.state !== 'ready');
  el.modelsSub.textContent = report.ready
    ? `${MB(report.expectedBytes)} on disk, all models ready`
    : `${MB(report.onDiskBytes)} of ${MB(report.expectedBytes)} present`;

  // Say what the next click will actually do, rather than a generic "fix".
  if (!missing.length) {
    el.modelsNote.textContent = `Stored in ${report.dir}`;
    el.modelsDownload.hidden = true;
  } else {
    const resumable = missing.filter((m) => m.state === 'partial');
    el.modelsNote.textContent = resumable.length
      ? `Downloading resumes the ${resumable.length} interrupted file(s) where they stopped.`
      : `About ${MB(missing.reduce((a, m) => a + m.bytes, 0))} to download, one time.`;
    el.modelsDownload.hidden = false;
    el.modelsDownload.textContent = resumable.length ? 'Resume download' : 'Download';
    el.modelsDownload.disabled = false;
  }
}

async function refreshModels() {
  try {
    const report = await fetch('/api/models').then((r) => r.json());
    if (!report.managed) {
      el.modelsSub.textContent = 'Not managed by this server';
      el.modelsList.innerHTML = '';
      el.modelsNote.textContent = report.reason || '';
      el.modelsDownload.hidden = true;
      return;
    }
    renderModels(report);
  } catch (err) {
    el.modelsSub.textContent = 'Could not read model state';
    el.modelsNote.textContent = String(err.message || err);
  }
}

function openModels() {
  el.modelsModal.hidden = false;
  refreshModels();
}

function closeModels() {
  el.modelsModal.hidden = true;
}

el.modelsBtn.addEventListener('click', openModels);
el.modelsClose.addEventListener('click', closeModels);
el.modelsDone.addEventListener('click', closeModels);

// Click the backdrop (but not the card) to dismiss.
el.modelsModal.addEventListener('click', (e) => {
  if (e.target === el.modelsModal) closeModels();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.modelsModal.hidden) closeModels();
});

el.modelsReveal.addEventListener('click', async () => {
  try {
    const r = await fetch('/api/models/reveal', { method: 'POST' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch {
    flash('Open the folder from the app menu: Menu → Reveal Models Folder.');
  }
});

/**
 * Stream the download as newline-delimited JSON.
 *
 * A 2.4 GB fetch that returns one object at the end gives the user no evidence
 * that anything is happening, which is the same experience as a hang.
 */
el.modelsDownload.addEventListener('click', async () => {
  el.modelsDownload.disabled = true;
  el.modelsDownload.textContent = 'Downloading…';
  el.modelsBar.hidden = false;
  el.modelsBarFill.style.width = '0%';
  el.modelsNote.textContent = 'Starting…';

  try {
    const res = await fetch('/api/models/download', { method: 'POST' });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail.error || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';

      for (const raw of lines) {
        if (!raw.trim()) continue;
        let evt;
        try { evt = JSON.parse(raw); } catch { continue; }

        if (evt.event === 'progress') {
          el.modelsBarFill.style.width = `${evt.percent}%`;
          el.modelsNote.textContent = evt.skipped
            ? `Using existing ${evt.file}`
            : `${evt.file} — ${evt.percent}% (file ${evt.index} of ${evt.total})`;
        } else if (evt.event === 'done') {
          el.modelsBarFill.style.width = '100%';
          renderModels(evt.report);
          flash('Models ready.');
        } else if (evt.event === 'error') {
          throw new Error(evt.message);
        }
      }
    }
  } catch (err) {
    el.modelsNote.textContent = `Download failed: ${String(err.message || err)}`;
    el.modelsDownload.disabled = false;
    el.modelsDownload.textContent = 'Try again';
    return;
  }

  setTimeout(() => { el.modelsBar.hidden = true; }, 800);
  el.modelsDownload.disabled = false;
  el.modelsDownload.textContent = 'Download';
  refreshModels();
});

el.copyAll.addEventListener('click', async () => {
  const text = state.turns
    .filter((t) => !t.pending && !t.error)
    .map((t) => `[${langLabel(t.sourceLang)}] ${t.transcript}\n[${langLabel(t.targetLang)}] ${t.translation}`)
    .join('\n\n');
  if (!text) return flash('Nothing to copy yet.');
  try {
    await navigator.clipboard.writeText(text);
    flash('Transcript copied to clipboard.');
  } catch {
    flash('Clipboard blocked — select the text manually.');
  }
});

el.sendTyped.addEventListener('click', async () => {
  const text = el.typed.value.trim();
  if (!text) return;
  el.typed.value = '';
  await processText(text);
});

el.typed.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const text = el.typed.value.trim();
    if (!text) return;
    el.typed.value = '';
    await processText(text);
  }
});

el.provider?.addEventListener('change', () => {
  state.provider = el.provider.value;
  updateEngineLabel();
  if (state.provider === 'modal') {
    // Cloud containers cold-start (~20-25s). Say so instead of seeming hung.
    flash('Switched to the cloud engine. The first request may take ~20s while it starts.');
  } else {
    flash('Switched to the local engine.');
  }
  // Cached audio came from the previous backend; drop it so downloads match.
  for (const t of state.turns) delete t.audioBlob;
  render();
});

el.gender.addEventListener('change', () => {
  if (state.currentAudio) stopSpeaking();
});

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
    e.preventDefault();
    el.mic.click();
  }
});

window.addEventListener('beforeunload', () => {
  stopListening();
  stopSpeaking();
});

boot();
