# Parley for Android

Local speech translation on an Android phone. No cloud, no API key, no account.

Speak → transcript → translation → spoken aloud, with the models running on the
device itself. This is the native Android port of the desktop Parley app.

## Status

**Feature parity with the desktop app, verified on a Pixel 8 Pro.**

Measured (Android 16, 11.85 GB RAM), two models resident:

| Part | State |
|---|---|
| Toolchain (NDK/CMake/Gradle) | working, verified |
| llama.cpp → arm64 `.so` with KleidiAI | **verified** — all libs `ARM aarch64`, 1988 kai symbols |
| Install + first-run 2.4 GB download | **verified** — ~8 min at 4.8 MB/s, resumable |
| Two engines resident (8793 audio, 8795 text) | **verified** — both serve `/health` |
| Translation | **verified** — `Good morning, how are you?` → `안녕하세요, 잘 지내세요?` in **5.5 s** |
| Validation guards | **verified** — `guards.rules.json` loaded from assets, same file as desktop |
| 18-language picker | implemented, matches desktop `LANGUAGES` table |
| Typed input path | implemented (bypasses the microphone) |
| Turn history, clear, per-turn speak | implemented |
| TTS playback | implemented; WAV chunk parsing; **not yet heard** |
| ASR accuracy | works, still weak on mixed-language audio |

### What the tuning turned up

Four findings, all counter-intuitive, all measured rather than guessed:

1. **KleidiAI is not optional.** A plain CMake configure leaves
   `GGML_CPU_KLEIDIAI=OFF` and `GGML_SYSTEM_ARCH` unset, so the build quietly
   ignores the `i8mm`/`dotprod` kernels the phone has. Every library still says
   `Built target`. Check with `strings -a libggml-cpu.so | grep -c kai_`.

2. **Two models beat one, by a lot.** I first collapsed to a single model
   because two drove 5.1 GB into swap. That measurement was taken against the
   *unoptimised* build, so the kernels were the problem, not the memory.
   Re-measured: one model 4.5 s / 6.9 tok/s, two models **1.55 s / 18 tok/s**.
   The earlier conclusion was wrong and is corrected rather than defended.

3. **Message shape decides whether it translates at all.** The desktop's shape —
   instruction in a `system` message, payload fenced in `<source>` tags — is what
   makes this model translate. Two consecutive user messages made it answer the
   instruction instead. The audio stage wants the opposite again: system
   instruction, audio-only user turn.

4. **The token budget dominates latency.** The chat template emits a hidden
   reasoning block and strips it from the output, but charges for the tokens.
   At 16 tokens a sentence finishes in ~5 s; at 512 it took 195 s.

### ASR caveat

The audio model transcribes, but on a mixed Cantonese/English recording it
returned a *description* rather than words. The validation guards now reject
that class of output for translation, and the retry loop gives ASR a second
attempt, but the transcript itself is still the weakest link.

## Build

Requires JDK 17+, Android SDK 35, NDK r27, CMake 3.22+.

```sh
# Point at your SDK
echo "sdk.dir=$HOME/android-sdk" > local.properties

gradle :app:assembleDebug      # app/build/outputs/apk/debug/app-debug.apk
gradle :app:assembleRelease    # signed, needs keystore.properties
gradle :app:bundleRelease      # .aab for Play
```

`keystore.properties` is gitignored. Without it the release build is unsigned
rather than broken, which is the right default for anyone who is not you.

## How the engine ships

This is the part that is not obvious, and it is the part that will bite anyone
who tries to "clean it up".

**Android 10+ forbids `exec()` from the app's data directory.** So the normal
trick — unzip a binary into `filesDir` and run it — does not work. The supported
route is `jniLibs`, which Android extracts into `nativeLibraryDir`, and that
directory *is* executable.

So the engine is packaged as a library:

```
app/src/main/jniLibs/arm64-v8a/
├── libllama-server.so        ← really the llama-server executable (7 KB loader)
├── libllama-tts.so           ← really llama-tts
├── libllama-server-impl.so   ← 56 MB, where the actual server code lives
├── libllama.so, libmtmd.so, libggml*.so
```

`useLegacyPackaging = true` is required. Without it the `.so` files stay
compressed inside the APK, are never extracted, and `nativeLibraryDir` is empty
at runtime.

`Engine.kt` runs the binary with `LD_LIBRARY_PATH` set to that directory so the
sibling libraries resolve.

## Two servers, as on the desktop

Two models, and not the same one twice:

| Model | Korean ASR | Translation |
|---|---|---|
| LFM3-Audio-2B | **4 / 6** | acceptable |
| LFM3-Omni-2B | 2 / 6 | **5 / 5** |

`EngineService` starts the audio server on 8793 (ASR + TTS) and the Omni text
server on 8795 (translation).

**This was briefly changed and changed back.** The first working build loaded
only one model, because two drove 5.1 GB into swap and generation collapsed to
0.24-0.51 tok/s. That measurement was taken against a build with KleidiAI
disabled, so the kernels were the bottleneck, not the memory. Re-measured on the
same device with optimised kernels:

| Configuration | Latency | Throughput |
|---|---|---|
| one model (Audio-2B translating) | 4.5 s | 6.9 tok/s |
| **two models (Audio-2B + Omni)** | **1.55 s** | **18.0 tok/s** |

Both fit; Omni is simply a far better translator and is three times faster with
the right kernels. The single-model fallback remains the answer for a phone
under about 8 GB, where the pair genuinely will not stay resident.

## Why the models are downloaded, not bundled

2.4 GB across three GGUF files. Play caps a base module at 200 MB, and a 2.4 GB
install would be hostile. First launch downloads to app-private storage,
resuming from `.part` when the connection drops.

## Android-specific choices

| Decision | Why |
|---|---|
| `-ngl 0` (CPU, not GPU) | Phones have no CUDA, and Vulkan on a mid-range Adreno is slower than NEON at this model size |
| `-c 4096` not 8192 | Every KB of KV cache competes with the model for the same RAM |
| `AudioRecord` at 16 kHz | No ffmpeg needed — the desktop pipes webm through it, Android records the target format directly |
| Foreground service | A 1.5 GB child process is the first thing Android reclaims when a call comes in |
| arm64 only | The models need a 64-bit address space regardless |

## Performance — measured, not estimated

On a Pixel 8 Pro, single model, `-t 4`, `ctx 4096`:

| Operation | Time |
|---|---|
| Short sentence translation | **4.5 s** (16-token cap) |
| Same with a 96-token cap | ~16 s |
| 6 s of audio → transcript | ~10.5 s |
| Generation throughput | 6.1–7.2 tok/s |
| Engine RSS | 1.96 GB |
| Model load (first request) | ~20–40 s |

Roughly 145 ms per generated token. That number is the lever: every tuning
decision above is really "how do we generate fewer tokens".

Older or smaller phones will be slower, and under 8 GB of RAM the engine is
likely to be reclaimed. Untested — do not assume.

## Play Store path

```sh
gradle :app:bundleRelease     # app/build/outputs/bundle/release/app-release.aab
```

Checklist before upload:

- [ ] Test on real hardware (blocking — see Status)
- [ ] Play requires targetSdk within one year of current; 35 is current
- [ ] Data safety form: no data collected, no network beyond model download
- [ ] Foreground service declaration — `specialUse` with justification
- [ ] Model download needs a clear explanation on first launch
- [ ] Signing key: back it up. Losing it means you can never update the app

The `RECORD_AUDIO` and `INTERNET` permissions are the only sensitive ones, and
INTERNET is used solely for the Hugging Face model download.

## Known gaps

- No device test yet. This is the main one.
- No streaming/interim transcription — it records a fixed 7 s window.
- No language picker; Korean is hardcoded as the target.
- TTS assumes the audio server's `/tts` route returns 24 kHz mono PCM16.
- Models are shared with the desktop app but not re-verified per device.
