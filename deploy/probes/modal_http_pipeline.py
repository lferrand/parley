"""
Full pipeline over HTTP via llama-server.

Pivoting away from CLI stdout parsing: it is fragile (the CLI prints "Exiting...",
enters conversation mode, and rejects several documented flags), and it is not
what we would deploy. llama-server gives an OpenAI-compatible endpoint, which is
also exactly what the provider adapter needs.

Two servers in one container:
  :8080  LFM3-Audio-2B + mmproj   -> ASR and TTS
  :8081  LFM3-1.7B                -> translation
"""

import modal

LLAMA_TAG = "b11941"
LLAMA_URL = (
    f"https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_TAG}/"
    f"llama-{LLAMA_TAG}-bin-ubuntu-x64.tar.gz"
)
AUDIO_REPO = "https://huggingface.co/LiquidAI/LFM3-Audio-2B-GGUF/resolve/main"
TEXT_REPO = "https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF/resolve/main"

ASR_MODEL = "LFM3-Audio-2B-Q4_K_M.gguf"
MMPROJ = "mmproj-LFM3-Audio-2B-Q8_0.gguf"
TEXT_MODEL = "LFM3-1.7B-Q4_K_M.gguf"

image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.8.0-runtime-ubuntu22.04", add_python="3.11"
    )
    .apt_install("curl", "ca-certificates", "libgomp1", "ffmpeg")
    .pip_install("httpx")
    .run_commands(
        f"mkdir -p /opt/llama && curl -fsSL {LLAMA_URL} "
        "| tar -xz -C /opt/llama --strip-components=1",
        "chmod +x /opt/llama/* 2>/dev/null || true",
        f"mkdir -p /models && curl -fsSL -o /models/{ASR_MODEL} {AUDIO_REPO}/{ASR_MODEL}",
        f"curl -fsSL -o /models/{MMPROJ} {AUDIO_REPO}/{MMPROJ}",
        f"curl -fsSL -o /models/{TEXT_MODEL} {TEXT_REPO}/{TEXT_MODEL}",
    )
    .add_local_file("/tmp/en_test.wav", "/data/en_test.wav", copy=True)
)

app = modal.App("lfm3-http-pipeline")


@app.function(image=image, cpu=8, memory=16384, timeout=1800)
def pipeline():
    import subprocess, os, time, json, signal
    import httpx

    env = dict(os.environ)
    env["LD_LIBRARY_PATH"] = "/opt/llama"

    def start(args, log):
        f = open(log, "wb")
        return subprocess.Popen(args, cwd="/opt/llama", env=env,
                                stdout=f, stderr=subprocess.STDOUT)

    procs = []
    try:
        print("=== starting audio server :8080 ===")
        procs.append(start([
            "./llama-server", "-m", f"/models/{ASR_MODEL}",
            "--mmproj", f"/models/{MMPROJ}",
            "--port", "8080", "-c", "4096", "-t", "8",
        ], "/tmp/audio.log"))

        print("=== starting text server :8081 ===")
        procs.append(start([
            "./llama-server", "-m", f"/models/{TEXT_MODEL}",
            "--port", "8081", "-c", "4096", "-t", "8",
        ], "/tmp/text.log"))

        # Wait for both to answer /health
        def wait(port, name, timeout=240):
            deadline = time.time() + timeout
            while time.time() < deadline:
                try:
                    r = httpx.get(f"http://127.0.0.1:{port}/health", timeout=2)
                    if r.status_code == 200:
                        print(f"  {name} ready ({r.json()})")
                        return True
                except Exception:
                    pass
                time.sleep(2)
            print(f"  {name} DID NOT START")
            print(open("/tmp/audio.log" if port == 8080 else "/tmp/text.log",
                       encoding="utf-8", errors="ignore").read()[-1500:])
            return False

        audio_ok = wait(8080, "audio")
        text_ok = wait(8081, "text")
        if not (audio_ok and text_ok):
            return

        # -------- 1. ASR over HTTP -----------------------------------
        print("\n########## 1. ASR (English speech -> text) ##########")
        b64 = __import__("base64").b64encode(open("/data/en_test.wav", "rb").read()).decode()
        t0 = time.time()
        r = httpx.post(
            "http://127.0.0.1:8080/v1/chat/completions",
            json={
                "model": "lfm",
                "messages": [
                    {"role": "system", "content": "Perform ASR in English."},
                    {"role": "user", "content": [
                        {"type": "input_audio", "input_audio": {"data": b64, "format": "wav"}}
                    ]},
                ],
                "temperature": 0,
                "max_tokens": 128,
            },
            timeout=300,
        )
        dur_asr = time.time() - t0
        print(f"[{dur_asr:.1f}s] status {r.status_code}")
        if r.status_code != 200:
            print(r.text[:800])
            return
        transcript = r.json()["choices"][0]["message"]["content"].strip()
        print(f"TRANSCRIPT: {transcript!r}")

        # ------- 2. translate over HTTP ------------------------------
        print("\n########## 2. TRANSLATE (English -> Korean) ##########")
        t0 = time.time()
        r2 = httpx.post(
            "http://127.0.0.1:8081/v1/chat/completions",
            json={
                "model": "lfm",
                "messages": [
                    {"role": "system", "content":
                        "You are a translation engine. Translate the text inside "
                        "<source> tags from English into Korean. You translate only. "
                        "Write the answer in Korean only, never in English. "
                        "Output only the translation."},
                    {"role": "user", "content": f"<source>\n{transcript}\n</source>"},
                ],
                "temperature": 0,
                "max_tokens": 128,
            },
            timeout=300,
        )
        dur_tr = time.time() - t0
        print(f"[{dur_tr:.1f}s] status {r2.status_code}")
        if r2.status_code != 200:
            print(r2.text[:800])
            return
        translation = r2.json()["choices"][0]["message"]["content"].strip()
        print(f"TRANSLATION: {translation!r}")

        # ------- 3. TTS: does the audio server expose speech? -------
        print("\n########## 3. TTS ##########")
        # Try the OpenAI-compatible speech endpoint first.
        for path in ("/v1/audio/speech",):
            t0 = time.time()
            r3 = httpx.post(
                "http://127.0.0.1:8080" + path,
                json={"model": "lfm", "input": translation,
                      "voice": "female-korean", "response_format": "wav"},
                timeout=300,
            )
            dur_tts = time.time() - t0
            print(f"{path}: [{dur_tts:.1f}s] status {r3.status_code} "
                  f"ct={r3.headers.get('content-type')} bytes={len(r3.content)}")
            if r3.status_code == 200 and r3.content[:4] == b"RIFF":
                open("/data/out.wav", "wb").write(r3.content)
                print("  saved /data/out.wav")
                break
            else:
                print("  body:", r3.text[:300])

        # ------- timing ---------------------------------------------
        total = dur_asr + dur_tr
        per_hr = 8 * 0.0000131 * 3600 + 16 * 0.00000222 * 3600
        print(f"\n=== TIMING === ASR {dur_asr:.1f}s | TR {dur_tr:.1f}s")
        print(f"=== COST === ${per_hr:.3f}/hr")

    finally:
        for p in procs:
            try:
                p.send_signal(signal.SIGTERM)
            except Exception:
                pass


@app.local_entrypoint()
def main():
    pipeline.remote()
