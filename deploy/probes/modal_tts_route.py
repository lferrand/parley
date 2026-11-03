"""
Can llama-server generate speech via its /tts route?

If yes, TTS stops shelling out to llama-tts, which reloads both models on every
call (~3-5s warm). A warm server would make speech generation ~1s.

Schema hints found in the binary:
  - "input" must be a non-empty string
  - response_format must be text or json_object (for /v1 text endpoints)
  - server_task_result_tts, mtmd_helper_gen_audio_get_output exist
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

app = modal.App("lfm3-tts-route-probe")


@app.function(image=image, cpu=8, memory=16384, timeout=1200)
def probe():
    import subprocess, os, time, signal
    import httpx

    env = {**os.environ, "LD_LIBRARY_PATH": "/opt/llama"}
    log = open("/tmp/s.log", "wb")
    p = subprocess.Popen(
        ["./llama-server", "-m", f"/models/{ASR_MODEL}", "--mmproj", f"/models/{MMPROJ}",
         "--port", "8080", "-c", "4096", "-t", "8"],
        cwd="/opt/llama", env=env, stdout=log, stderr=subprocess.STDOUT,
    )
    for _ in range(180):
        try:
            if httpx.get("http://127.0.0.1:8080/health", timeout=2).status_code == 200:
                break
        except Exception:
            pass
        time.sleep(2)
    print("server up")

    TEXT = "회의는 오후 3시에 시작합니다."

    # Try the shapes a /tts endpoint might accept.
    attempts = [
        ("input+voice", {"input": TEXT, "voice": "female-korean"}),
        ("input only", {"input": TEXT}),
        ("input+lang", {"input": TEXT, "language": "ko"}),
        ("input+voice+lang", {"input": TEXT, "voice": "female", "language": "ko"}),
        ("prompt+voice", {"prompt": TEXT, "voice": "female-korean"}),
    ]

    for label, body in attempts:
        t0 = time.time()
        try:
            r = httpx.post("http://127.0.0.1:8080/tts", json=body, timeout=300)
            dur = time.time() - t0
            ct = r.headers.get("content-type", "")
            riff = r.content[:4] == b"RIFF"
            print(f"  {label:20s} [{dur:5.2f}s] HTTP {r.status_code} ct={ct} bytes={len(r.content)} RIFF={riff}")
            if r.status_code != 200:
                print(f"      {r.text[:160]}")
            elif riff:
                open(f"/tmp/tts_{label.replace('+','_')}.wav", "wb").write(r.content)
                d = subprocess.run(
                    f"ffprobe -v error -show_entries format=duration -of csv=p=0 /tmp/tts_{label.replace('+','_')}.wav",
                    shell=True, capture_output=True, text=True,
                ).stdout.strip()
                print(f"      VALID WAV, {d}s")
        except Exception as e:
            print(f"  {label:20s} ERROR {type(e).__name__}: {str(e)[:60]}")

    # Baseline: llama-tts cold invocation, for comparison.
    print("\n=== llama-tts CLI baseline ===")
    for i in range(2):
        t0 = time.time()
        subprocess.run(
            f"./llama-tts -m /models/{ASR_MODEL} --mmproj /models/{MMPROJ} "
            f"--tts-lang ko --tts-voice female -p '{TEXT}'",
            shell=True, cwd="/opt/llama", env=env, capture_output=True, timeout=600,
        )
        print(f"  cli call {i+1}: {time.time()-t0:.2f}s")

    p.send_signal(signal.SIGTERM)


@app.local_entrypoint()
def main():
    probe.remote()
