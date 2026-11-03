"""
Why is /tts 2.8s in the deployed app but 1.1s in isolation?

The deployed container runs two llama-server processes on 8 cores:
  audio  -t 4
  text   -t 10
That is 14 threads on 8 cores — oversubscribed. Speech generation does conv /
vocoder work (unlike LLM token decoding, which is memory-bandwidth bound), so it
may be the part that actually suffers.

Measure /tts latency under several thread splits with both servers running.
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
TEXT_MODEL = "LFM3-1.7B-Q8_0.gguf"

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
)

app = modal.App("lfm3-thread-split-probe")


@app.function(image=image, cpu=8, memory=16384, timeout=1800)
def probe():
    import subprocess, os, time, signal
    import httpx

    env = {**os.environ, "LD_LIBRARY_PATH": "/opt/llama"}
    TEXT = "회의는 오후 3시에 시작합니다."

    def run_split(audio_t, text_t):
        logs = []
        procs = []
        for name, threads, args in (
            ("audio", audio_t, ["./llama-server", "-m", f"/models/{ASR_MODEL}",
                                "--mmproj", f"/models/{MMPROJ}", "--port", "8080",
                                "-c", "4096", "-t", str(audio_t)]),
            ("text", text_t, ["./llama-server", "-m", f"/models/{TEXT_MODEL}",
                              "--port", "8081", "-c", "4096", "-t", str(text_t)]),
        ):
            fh = open(f"/tmp/{name}.log", "wb")
            logs.append(fh)
            procs.append(subprocess.Popen(args, cwd="/opt/llama", env=env,
                                          stdout=fh, stderr=subprocess.STDOUT))

        ok = True
        for port in (8080, 8081):
            ready = False
            for _ in range(180):
                try:
                    if httpx.get(f"http://127.0.0.1:{port}/health", timeout=2).status_code == 200:
                        ready = True
                        break
                except Exception:
                    pass
                time.sleep(1.5)
            if not ready:
                ok = False

        if not ok:
            for p in procs:
                p.send_signal(signal.SIGTERM)
            return None

        # Warm the speech path once.
        try:
            httpx.post("http://127.0.0.1:8080/tts",
                       json={"input": "준비", "voice": "female-korean", "language": "ko"},
                       timeout=300)
        except Exception:
            pass

        times = []
        for _ in range(3):
            t0 = time.time()
            r = httpx.post("http://127.0.0.1:8080/tts",
                           json={"input": TEXT, "voice": "female-korean", "language": "ko"},
                           timeout=300)
            if r.status_code == 200 and r.content[:4] == b"RIFF":
                times.append(time.time() - t0)

        # And a translation, so we can see the cost to the other server.
        t0 = time.time()
        try:
            httpx.post("http://127.0.0.1:8081/v1/chat/completions", json={
                "model": "lfm",
"messages": [
                    {"role": "system", "content": "Translate to Korean. Output only the translation."},
                    {"role": "user", "content": "The meeting starts at three."},
                    {"role": "assistant", "content": "\n\n"},
                ],
                "temperature": 0, "max_tokens": 256,
            }, timeout=300)
        except Exception:
            pass
        tr = time.time() - t0

        for p in procs:
            p.send_signal(signal.SIGTERM)
        for fh in logs:
            fh.close()
        time.sleep(3)
        return times, tr

    for audio_t, text_t in ((4, 10), (6, 6), (8, 4), (4, 4)):
        res = run_split(audio_t, text_t)
        if not res:
            print(f"audio={audio_t} text={text_t}: FAILED TO START")
            continue
        times, tr = res
        if times:
            avg = sum(times) / len(times)
            print(f"  audio=-t{audio_t:<2d} text=-t{text_t:<2d} | "
                  f"tts {min(times):.2f}-{max(times):.2f}s avg {avg:.2f}s | "
                  f"translate {tr:.2f}s")
        else:
            print(f"  audio=-t{audio_t} text=-t{text_t}: no audio produced")


@app.local_entrypoint()
def main():
    probe.remote()
