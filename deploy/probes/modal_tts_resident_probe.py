"""
Can llama-tts stay resident across prompts?

Warm TTS over HTTP costs ~6s, while generation itself is ~1.95s. The gap is the
CLI loading both models on every invocation. llama-mtmd-cli has a chat mode that
keeps the model loaded; if llama-tts has something equivalent, a persistent
process removes ~3s per utterance.

Test: run llama-tts once, pipe several prompts to stdin, time each.
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
    .run_commands(
        f"mkdir -p /opt/llama && curl -fsSL {LLAMA_URL} "
        "| tar -xz -C /opt/llama --strip-components=1",
        "chmod +x /opt/llama/* 2>/dev/null || true",
        f"mkdir -p /models && curl -fsSL -o /models/{ASR_MODEL} {AUDIO_REPO}/{ASR_MODEL}",
        f"curl -fsSL -o /models/{MMPROJ} {AUDIO_REPO}/{MMPROJ}",
    )
)

app = modal.App("lfm3-tts-resident-probe")


@app.function(image=image, cpu=8, memory=16384, timeout=1800)
def probe():
    import subprocess, os, time, tempfile

    env = {**os.environ, "LD_LIBRARY_PATH": "/opt/llama"}
    BASE = (f"/opt/llama/llama-tts -m /models/{ASR_MODEL} "
            f"--mmproj /models/{MMPROJ} --tts-lang ko --tts-voice female")

    print("=== A. does llama-tts accept multiple prompts on stdin? ===")
    t0 = time.time()
    p = subprocess.run(
        f"printf '첫 번째 문장입니다.\\n두 번째 문장입니다.\\n' | {BASE} -t 8",
        shell=True, cwd="/opt/llama", env=env, capture_output=True,
        text=True, timeout=900,
    )
    total = time.time() - t0
    out = (p.stdout or "") + (p.stderr or "")
    print(f"wall {total:.1f}s exit {p.returncode}")
    # Did it produce one wav or several?
    print(subprocess.run("ls -la /opt/llama/*.wav 2>/dev/null",
                         shell=True, capture_output=True, text=True,
                         env=env).stdout or "  no wav")
    for line in out.splitlines():
        if any(k in line for k in ("wrote", "WAV audio", "timings:", "error", "prompt")):
            print("  " + line.strip()[:150])

    print("\n=== B. cost of two separate cold invocations (current behaviour) ===")
    for i in range(2):
        t0 = time.time()
        subprocess.run(
            f"{BASE} -t 8 -p '문장 {i}입니다.'",
            shell=True, cwd="/opt/llama", env=env,
            capture_output=True, timeout=900,
        )
        print(f"  call {i+1}: {time.time()-t0:.2f}s")

    print("\n=== C. what dominates: load or generate? ===")
    out = subprocess.run(
        f"{BASE} -t 8 -p '짧은 문장.'",
        shell=True, cwd="/opt/llama", env=env, capture_output=True,
        text=True, timeout=900,
    )
    txt = (out.stdout or "") + (out.stderr or "")
    for line in txt.splitlines():
        low = line.lower()
        if "load" in low or "timings" in low or "wav audio" in low:
            print("  " + line.strip()[:160])


@app.local_entrypoint()
def main():
    probe.remote()
