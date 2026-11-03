# Parley

Local speech translation that runs entirely on your Mac. Speak anything,
hear anything. No cloud calls, no API keys, and audio never leaves the machine.

![stack](https://img.shields.io/badge/LFM3--Audio--2B-ASR%20%2B%20TTS-ff6b8a) ![stack](https://img.shields.io/badge/LFM3--Omni--2B-translation-5b8cff)

## Run it

```sh
./start.sh                      # or: node server.mjs
```

Open <http://127.0.0.1:8791>, pick a language, tap the microphone.

Requirements, web build only: `ffmpeg` and Ollama ≥ 0.40.12 with both models
pulled. The **desktop build needs neither** — it ships its own llama.cpp
runtime and downloads the models on first launch.

```sh
ollama pull lfm3-audio   # speech in / speech out
ollama pull lfm3         # text translation
```

## How it works

```
microphone → ffmpeg (16 kHz mono WAV)
           → LFM3-Audio-2B      ASR
           → LFM3-Omni-2B       translation
           → LFM3-Audio-2B      TTS (24 kHz)
           → speaker
```

Two models, and they are **not** interchangeable. Measured through the real
request path on number-bearing sentences:

| Model | Korean ASR (6 time phrases) | Translation (5 sentences) |
|---|---|---|
| `LFM3-Audio-2B` | **4 / 6** | — |
| `LFM3-Omni-2B` | 2 / 6 | **5 / 5 on the fast path** |
| `LFM3-1.7B` | — | 1 / 5 |

So recognition goes to Audio-2B and translation to Omni. Using Omni for
everything was tried and withdrawn: on real Korean speech it returned `7465분`
for `칠 시 사십오 분` (7:45) on 5 of 5 runs, and invented `안녕하세요` for
`포기하지 마세요`. The 1.7B translator rendered "meeting" as `매팅` (not `회의`)
and spent 16.6 s rambling before giving up on "It costs 150 dollars."

### Speaking direction

Any of the 18 supported languages can be the target. Korean is the default, not
a constraint — `target` is a per-request parameter and the UI has a selector.

The language selector is a hint for Latin-script input, which is shared by many
languages; script decides otherwise:

| Detected script | Source language |
|---|---|
| Hangul | Korean — echoed as-is when the target is Korean |
| Kana | Japanese |
| Han without kana | Chinese |
| Arabic / Hebrew / Greek | that language |
| Latin | the selected hint (default English) |

Arabic and Hebrew take a two-hop route through English. Direct translation of
those took 23-39 s and often landed on English anyway; two short hops take
2-6 s and are correct.

### Multi-target status

A sweep of all 18 targets × 3 number-bearing sentences: **54 of 54 clean**, zero
markup leaks. Run it yourself against a live server:

```sh
node tests/multi-target-sweep.mjs
```

Getting there required fixing a guard bug that made the app look worse than it
was. Before the fix, 11 of 18 targets misbehaved, and every case was triggered
by one input — a 12-hour clock time like "3 PM":

| Result | Targets |
|---|---|
| Clean | ja, zh, es, pl, fi, ko |
| Slow fallback | fr, it, pt, nl, he, el |
| Markup leaked | de, sv, da, tr |
| Rejected | ar |

Almost none of that was model failure. `keptNumbers()` compared **digits**, but
"3 PM", `15h`, `15 Uhr`, `15:00`, `오후 3시` and `الساعة 3 مساءً` all name the same
moment with no digit in common. A correct French translation was rejected, the
retry loop burned ~800 ms, and then it fell back anyway. German leaked
`**Translation:**` because the fallback path returned the model's scaffolding
verbatim.

The fix (`clock.mjs`) canonicalises every clock mention to **minutes since
midnight** on both sides and compares moments rather than glyphs. One scanner
produces both the parsed set and the span-blanked text, so detection and
stripping cannot disagree about which forms exist.

Two smaller false negatives fell out of the same pass:

- Arabic-Indic digits (`٣` = 3) were invisible to an ASCII-only comparison.
- Arabic's dual form packs the number into the word — `طفلان` **is** "two
  children". Same class as Korean `두 명`, same false rejection.

Still worth knowing: this sweep is three sentences per language, generated from
a controlled source. It proves the *guard* is no longer fighting correct output.
It does not prove translation quality on jargon, names, idioms or long speech —
that still needs real audio per language.

### Latency

The text model thinks in a hidden block before answering. That is accurate but
costs 2–8 s per line, which is far too slow to hold a conversation. A whitespace
assistant prefill skips the reasoning and answers in ~0.1 s.

Skipping it is not always safe, though — left unchecked the model sometimes
rambles into tables, or answers in the source language. So every fast answer is
validated before use: writing system must match the target, length must be
plausible, no markdown or multi-paragraph output, all numbers preserved, and no
invented AM/PM marker. Fail any check and the request falls back to the careful
thinking path.

Measured on an M-series Mac mini:

| Path | Typical |
|---|---|
| Typed text (fast path) | 0.1 s |
| Speech → text → speech | 0.7 s |
| Arabic / Hebrew (pivot) | 4–9 s |
| Careful fallback | up to 14 s |

## Trust boundary

The source text is untrusted. It arrives from a microphone in a room, or from
someone typing, and it may be a question, a command, or a deliberate attempt to
manipulate the model. Three layers keep it from being obeyed:

1. **Fencing.** The text is wrapped in `<source>` tags, and anything that could
   close the fence is stripped first, so the content cannot escape into a new
   turn. The system prompt states that everything inside is data to translate.
2. **Routing.** Instruction-shaped input ("ignore your instructions", "reveal
   your prompt", `<system>`, Korean equivalents) skips the fast path and goes
   to the careful path with an explicit anti-obedience rule.
3. **Output validation.** Every candidate translation must pass: target script
   matches, plausible length, no markdown, numbers preserved, no invented
   AM/PM, no assistant chatter ("here's the translation", "let me know if"),
   and no obedience signature — echoing a quoted token, collapsing a sentence
   to one word, or prefacing a translated question with "Yes".

A 1.7B model cannot be talked out of injection by prompt wording alone, so
these checks are deterministic code, not instructions.


## Running on Modal

The same app can use a cloud backend instead of local Ollama. Both speak the
same API, so the local server proxies rather than reimplementing it.

Start the server with a remote URL configured and both engines become
available; the **Engine** dropdown in the UI switches between them per request.

```sh
LFM_REMOTE_URL=https://<workspace>--lfm3-live-translate-api-useast.us-east.modal.run \
LFM_AUTH_TOKEN=<token> \
node server.mjs
```

| Setting | Effect |
|---|---|
| `LFM_PROVIDER` | Default engine: `ollama` (local) or `modal` |
| `LFM_REMOTE_URL` | Enables the "Cloud (Modal)" option in the UI |
| `LFM_AUTH_TOKEN` | Bearer token the proxy sends to the remote |

The choice is per request, so one server serves both. If `LFM_REMOTE_URL` is
unset, the cloud option is disabled in the dropdown rather than failing later.

Deploy the backend with `deploy/modal_app.py`:

```sh
modal deploy deploy/modal_app.py
```

The Modal endpoint accepts audio in any container ffmpeg can read (webm/opus,
mp4, wav) and transcodes to 16 kHz mono WAV itself, mirroring `toWav16k()` in
`server.mjs`. Before this it assumed WAV and answered `400` — surfaced to the
browser as an opaque `HTTP 500` — whenever it was called directly rather than
through the Node proxy. Undecodable audio now returns `400` with the ffmpeg
reason instead of a stack trace.

### Measured latency (Modal, 8 CPU / 16 GiB, no GPU)

| Step | Warm | Notes |
|---|---|---|
| text → Korean | 2.0s | translation only |
| audio → Korean text | 5.4s | ASR 1.5s + translate 2.1s |
| Korean text → speech | 5.4s | dominated by model load |
| **full loop** | **10.9s** | |
| cold start | 20–25s | first request per container |

### Why TTS is the bottleneck

`llama-tts` is a one-shot CLI: it reloads both models on every invocation.
Generation itself is only ~1.35s; the rest is load. Confirmed that it rejects
stdin and requires `-p` each call, so it cannot be kept resident.

`llama-server` cannot substitute. Its `/props` reports `modalities: {audio: true}`
but that describes **input**; there is no `/v1/audio/speech` route (verified 404)
and an `<|audio_start|>` prefill returns text, not audio.

Removing this would need either a patch to llama.cpp for server-side speech, or
a different runtime.

### Two behaviours worth knowing

- **Translation needs `max_tokens >= 512`.** At 128 the hidden reasoning block
  consumes the entire budget and the endpoint returns an empty string.
- **Whitespace assistant prefill is essential.** It skips reasoning: 0.94s vs
  8.6s, a 9x difference. Same trick as the local path.

### Cold starts

`scaledown_window=300` keeps a container warm for 5 minutes after the last
request. Raising it smooths conversation but bills continuously; lowering it
saves money but adds a ~25s wait to each session's first utterance.

## Desktop app

`desktop/` wraps the same UI and server in an Electron shell, so it launches
as a normal app instead of a terminal and a browser tab.

```sh
cd desktop
npm install
npm run start                # run from source
npm run dist                 # build dist/mac-arm64/Parley.app
npm run dist:win             # build dist/Parley-Setup-0.1.0-x64.exe
```

The built bundle is ~275 MB (unsigned, arm64, Electron 40) and needs no separate
Node install: the main process is Node, so it imports `server.mjs` directly
rather than spawning a second runtime.

### Windows

The Windows build is a cross-build: `npm run dist:win` on this Mac produces a
normal `.exe` installer, x64, ~158 MB. Nothing on the Windows side has to be
installed first — Node, `ffmpeg`, and the llama.cpp runtime are all inside.

```
Parley-Setup-0.1.0-x64.exe
└── Parley/
    ├── Parley.exe              Electron shell (x64)
    └── resources/
        ├── llama/              llama-server.exe + ggml/llama DLLs (Vulkan, 84 MB)
        ├── ffmpeg/ffmpeg.exe   decoder for the recorded webm/opus (130 MB)
        └── app/                server.mjs, public/, guards.rules.json
```

Three things differ from the macOS bundle, and none are cosmetic:

| Concern | macOS | Windows |
|---|---|---|
| GPU backend | Metal, one universal binary | **Vulkan**; retries the same binary with `-ngl 0` if device init fails (VMs, stale drivers) |
| Audio decode | Homebrew `ffmpeg` on `PATH` | bundled `ffmpeg.exe`, passed to the server as `FFMPEG_PATH` |
| Native lib lookup | `DYLD_LIBRARY_PATH` set to the vendor dir | vendor dir prepended to `PATH` before spawn |

The GPU retry is the part that earns its keep: a failed Vulkan enumeration
exits the server during device init rather than degrading, which on a fresh
install reads as "the app is broken". Trying CPU layers before reporting an
error turns that into a slower but working translator.

Models are not in the bundle. First launch downloads the same ~1.4 GB into
`%APPDATA%\Parley\models` and skips anything already there.

**Building on a Mac needs a native NSIS.** electron-builder ships an x86_64
`makensis`, which fails with `spawn Unknown system error -86` unless Rosetta is
installed. `desktop/vendor/nsis-native/` carries an arm64 copy and the build
uses it via `ELECTRON_BUILDER_NSIS_DIR` (already wired into `npm run dist:win`).

The installer is unsigned, so SmartScreen shows "Windows protected your PC" on
first run: More info → Run anyway. Real distribution needs an Authenticode
certificate.

#### Restoring the Windows build inputs

`desktop/vendor/llama-win/`, `ffmpeg-win/` and `nsis-native/` are gitignored —
they are ~220 MB of binaries, not source. A fresh clone needs them back before
`npm run dist:win` will work. All three are pinned:

```sh
cd desktop

# 1. llama.cpp — Vulkan build, tag b12069
curl -L -o /tmp/llama-win.zip \
  https://github.com/ggml-org/llama.cpp/releases/download/b12069/llama-b12069-bin-win-vulkan-x64.zip
mkdir -p vendor/llama-win && cd vendor/llama-win
unzip -j -o /tmp/llama-win.zip \
  'llama-server.exe' 'llama-server-impl.dll' 'llama.dll' 'llama-common.dll' \
  'mtmd.dll' 'ggml.dll' 'ggml-base.dll' 'ggml-vulkan.dll' 'libomp.dll' \
  'ggml-cpu-*.dll' 'LICENSE-LLVM-OpenMP'
cd ../..

# 2. ffmpeg — static win64, from BtbN's rolling "latest"
curl -L -o /tmp/ffmpeg-win.zip \
  https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip
mkdir -p vendor/ffmpeg-win
unzip -j -o /tmp/ffmpeg-win.zip '*/bin/ffmpeg.exe' -d vendor/ffmpeg-win

# 3. NSIS — only needed when building on Apple Silicon without Rosetta
#    Copy electron-builder's cached 3.0.4.1 bundle, then swap in the arm64
#    makensis from the Homebrew makensis 3.13 bottle.
cp -R ~/Library/Caches/electron-builder/nsis-3.0.4.1/nsis-3.0.4.1-*/ vendor/nsis-native
# ...and place the arm64 `makensis` at vendor/nsis-native/mac/makensis
```

`build-win.mjs` fails with a readable message naming the missing folder rather
than letting electron-builder die on an opaque spawn error.

What the shell handles that the browser version never had to:

| Problem | Fix |
|---|---|
| Finder gives the app a bare PATH, so `ffmpeg` is invisible | `repairPath()` adds Homebrew's bin dirs before importing the server |
| Port 8791 already taken by a dev instance | `pickPort()` scans upward for a free port |
| Ollama installed but not running | launches `/Applications/Ollama.app` and waits, instead of reporting failure |
| Models not pulled yet | streams `/api/pull` progress into the splash window |
| `getUserMedia` fails with no explanation | asks for mic access up front and names the Settings pane if denied |
| An `.app` icon implies a working pipeline | boot is gated — the window only appears once the server answers `/api/health` |

`desktop/main.mjs` carries these notes inline. The bundle is unsigned;
shipping it to anyone else needs a Developer ID identity and notarisation, or
they will have to right-click → Open past Gatekeeper.

## Files

| Path | Role |
|---|---|
| `server.mjs` | HTTP server, model calls, request queue |
| `public/index.html` | UI structure |
| `public/styles.css` | Dark UI |
| `public/app.js` | Mic capture, VAD, playback |
| `desktop/main.mjs` | Electron shell, preflight, boot gate |
| `desktop/splash.html` | Boot progress window |
| `desktop/vendor/llama-win/` | llama.cpp Vulkan build for Windows |
| `desktop/vendor/ffmpeg-win/` | static `ffmpeg.exe` for Windows |
| `desktop/vendor/nsis-native/` | arm64 `makensis` so the installer cross-builds without Rosetta |

Server-side only, no build step, no dependencies beyond Node built-ins. The
desktop shell is the one exception, and its `node_modules/` and `dist/` are
ignored.

## API

| Endpoint | Purpose |
|---|---|
| `POST /api/translate` | `{audio\|text, source?}` → transcript, Korean translation |
| `POST /api/tts` | `{text, lang, gender}` → `audio/wav` |
| `GET /api/health` | model availability + language list |

```sh
curl --noproxy '*' localhost:8791/api/translate \
  -H 'Content-Type: application/json' \
  -d '{"text":"The meeting starts at 3 PM.","source":"en"}'
```

```json
{
  "transcript": "오늘 회의는 오후 3시에 시작합니다.",
  "translation": "회의는 오후 3시에 시작합니다.",
  "sourceLang": "en", "targetLang": "ko", "mode": "fast",
  "timings": { "asrMs": 0, "translateMs": 110, "totalMs": 112 }
}
```

## Using it

- **Auto-listen** (default) cuts each utterance on ~0.9 s of silence. Turn it off
  for push-to-talk: tap, speak, tap again.
- **Speak translation** reads each result aloud in the target language. If TTS
  fails the browser voice takes over.
- **Space** toggles the microphone. Type in the box to translate without audio.
- Playback is muted into the recorder, so the app doesn't transcribe its own voice.

## Notes and limits

- **18 locales**, matching LFM3-Audio speech support: Korean, English (US/UK),
  Japanese, Chinese, Spanish, French, German, Italian, Portuguese, Dutch, Polish,
  Swedish, Danish, Finnish, Turkish, Arabic, Hebrew, Greek.
- **One request at a time.** The MLX runner stalls when two generations overlap,
  so the server queues. Fine for a conversation; not a multi-user server.
- **It is a 2B model.** Good for short conversational turns. It will not hold up
  on jargon, names, or long monologues — check the source line shown under each
  translation when the stakes matter.
- **Bound to 127.0.0.1.** No auth, no TLS. To use it from a phone on your LAN,
  change the listen address and put it behind something that authenticates.
- Models stay warm for 30 minutes after the last request (`LFM_KEEP_ALIVE`).

## Configuration

| Variable | Default |
|---|---|
| `PORT` | `8791` |
| `OLLAMA_URL` | `http://127.0.0.1:11434` |
| `LFM_MODEL` | `lfm3-audio` |
| `LFM_TEXT_MODEL` | `lfm3` |
| `LFM_KEEP_ALIVE` | `30m` |

## Engine: llama.cpp (no Ollama)

The desktop build runs **llama.cpp** directly. Ollama is not required and not
bundled — the runtime ships inside the `.app`, so a new machine needs nothing
installed but the app itself.

```sh
LFM_ENGINE=llamacpp node server.mjs     # local, via llama-server
LFM_ENGINE=ollama   node server.mjs     # the old path, still supported
```

| | Ollama | llama.cpp |
|---|---|---|
| Runtime shipped | 695 MB app, user-installed | **29 MB** inside the bundle |
| Models on disk | `lfm3-audio` + `lfm3` | `LFM3-Audio-2B` + `LFM3-Omni-2B` |
| Processes | 2 model loads | 2 |
| Text → Korean | ~110 ms | **~150 ms** |
| Warm TTS | 0.35 s | **0.35 s** |
| Speech → text → text | ~700 ms | **~400 ms** |

### Two models, and not the same one twice

Recognising speech and translating text want *different* models. Measured on
real Korean audio, not synthesised by LFM itself:

| Model | Korean time expressions | As a translator (5 number-bearing sentences) |
|---|---|---|
| `LFM3-Audio-2B` | **4 / 6** | — |
| `LFM3-Omni-2B` | 2 / 6 | **5 / 5 on the fast path** |
| `LFM3-1.7B` | — | 1 / 5 |

So the pipeline loads **Audio-2B for ASR and TTS, Omni for translation**. Omni
is loaded without its `mmproj`, since translation needs no audio encoder.

Why not Omni for everything (the obvious simplification): on real speech it
returned **`7465분`** for `칠 시 사십오 분` (7:45) on **5 of 5 runs**, and
invented **`안녕하세요`** for `포기하지 마세요` ("don't give up") on 5 of 5.
Deterministic, not noise — a wrong-answer generator with no failure signal.

Why not the 1.7B text model (the original design): through the real product
path it rendered "meeting" as `매팅` (not `회의`), "flight" as `기항선` (not
`비행`), and spent **16.6 s** rambling before giving up on "It costs 150
dollars." Omni does all three correctly in ~150 ms.

Worth knowing: `포기하지` → `후기하지` is an LFM-family limitation. Both models
made that error, so it is not evidence for or against Omni.

### The guard had a blindspot this exposed

`keptNumbers()` compared digits in source and translation. Korean renders
numbers as words — "2 children" becomes `두 명`, not `2명` — so every such
sentence read as a *lost* number. That rejected the ~200 ms fast path and sent
it down the 2–3 s careful retry loop. The fix normalises spoken Korean numerals
to digits before comparing.

### API differences that are not errors

Both engines speak HTTP, but not the same dialect. These three bit the port:

| | Ollama | llama-server |
|---|---|---|
| Audio input | `images: [base64]` on the message | `input_audio` content part |
| TTS route | `POST /v1/audio/speech` | `POST /tts` |
| TTS voice | `female-korean` | `female` + `lang: ko` |

Sending `images` to llama-server does not error. It returns a short unrelated
string ("You"), which reads like a bad transcript rather than a protocol
mistake. `audioMessages()` in `server.mjs` picks the right shape per engine.

### Models

Downloaded on first launch to
`~/Library/Application Support/Parley/models/`:

| File | Size |
|---|---|
| `LFM3-Omni-2B-Q4_K_M.gguf` | 1.10 GB |
| `mmproj-LFM3-Omni-2B-Q4_K_M.gguf` | 0.29 GB |

Resumable: an interrupted download continues from `.part` rather than restarting
1.4 GB.

### Licence

LFM Open License v1.0. Free for commercial use below $10M annual revenue;
redistribution must include the licence file (shipped as
`Resources/llama/LICENSE` for the runtime and noted for the weights).
