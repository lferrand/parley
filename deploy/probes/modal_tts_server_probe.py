"""
Can llama-server generate speech, avoiding the one-shot llama-tts reload?

Warm TTS over HTTP measures 6-7s, while the same work inside one container took
1.95s of generation. The difference is llama-tts loading the model from scratch
on every invocation.

llama-mtmd-cli emitted <|audio_start|> in chat mode, so the audio-generation
graph exists. Test whether llama-server honours an assistant prefill of
<|audio_start|> and returns audio, which would let TTS run in the warm server.
"""

import modal

LLAMA_TAG = "b11941"
LLAMA_URL = (
    f"https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_TAG}/"
    f"llama-{LLAMA_TAG}-bin-ubuntu-x64.tar.gz"
)
AUDIO_REPO = "https://huggingface.co/LiquidAI/LFM3-Audio-2B-GGUF/resolve/main"
ASR_MODEL = "LFM3-Audio-2B-Q4_K_M.gguf"
MMPROJ = "mmproj-LFM3-Audio-2B-Q8_0.gguf"

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
    )
)

app = modal.App("lfm3-tts-server-probe")


@app.function(image=image, cpu=8, memory=16384, timeout=1800)
def probe():
    import subprocess, os, time, json
    import httpx

    env = {**os.environ, "LD_LIBRARY_PATH": "/opt/llama"}
    log = open("/tmp/s.log", "wb")
    p = subprocess.Popen(
        ["./llama-server", "-m", f"/models/{ASR_MODEL}", "--mmproj", f"/models/{MMPROJ}",
         "--port", "8080", "-c", "4096", "-t", "8"],
        cwd="/opt/llama", env=env, stdout=log, stderr=subprocess.STDOUT,
    )

    for _ in range(150):
        try:
            if httpx.get("http://127.0.0.1:8080/health", timeout=2).status_code == 200:
                break
        except Exception:
            pass
        time.sleep(2)

    print("=== audio server up ===")

    # Does /props advertise audio generation?
    try:
        props = httpx.get("http://127.0.0.1:8080/props", timeout=10).json()
        print("props keys:", sorted(props.keys()))
        for k in ("modalities", "audio", "has_audio", "mmproj", "chat_template"):
            if k in props:
                print(f"  {k}: {str(props[k])[:200]}")
    except Exception as e:
        print("props failed:", e)

    TEXT = "회의는 오후 3시에 시작합니다."

    # Attempt 1: assistant prefill of <|audio_start|>
    for label, prefill in (("audio_start prefill", "<|audio_start|>"),
                           ("no prefill", None)):
        msgs = [
            {"role": "system", "content": "Perform TTS in Korean using a female voice."},
            {"role": "user", "content": TEXT},
        ]
        if prefill:
            msgs.append({"role": "assistant", "content": prefill})
        t0 = time.time()
        try:
            r = httpx.post("http://127.0.0.1:8080/v1/chat/completions", json={
                "model": "lfm", "messages": msgs,
                "temperature": 0, "max_tokens": 512,
            }, timeout=600)
            dur = time.time() - t0
            print(f"\n{label}: [{dur:.1f}s] HTTP {r.status_code} "
                  f"ct={r.headers.get('content-type')} bytes={len(r.content)}")
            if r.status_code == 200:
                j = r.json()
                msg = j["choices"][0]["message"]
                print("  content:", repr((msg.get("content") or "")[:160]))
                # Any audio field?
                for key in msg:
                    if key != "content":
                        print(f"  extra field {key}: {str(msg[key])[:120]}")
                print("  usage:", j.get("usage"))
            else:
                print("  body:", r.text[:300])
        except Exception as e:
            print(f"\n{label}: ERROR {type(e).__name__}: {e}")

    # Baseline: how long does one llama-tts call take in this same container?
    print("\n=== llama-tts single call (includes model load) ===")
    for i in range(2):
        t0 = time.time()
        subprocess.run(
            f"./llama-tts -m /models/{ASR_MODEL} --mmproj /models/{MMPROJ} "
            f"--tts-lang ko --tts-voice female -p '{TEXT}'",
            shell=True, cwd="/opt/llama", env=env, capture_output=True, timeout=600,
        )
        print(f"  call {i+1}: {time.time()-t0:.2f}s")

    log.close()


@app.local_entrypoint()
def main():
    probe.remote()
