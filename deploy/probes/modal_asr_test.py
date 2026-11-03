"""
Decisive test: can LFM3-Audio transcribe Korean on a Modal T4 via llama.cpp?

Probe 2 established that b11941 ships `--mmproj` and the LFM3 audio graph.
This runs one real Korean utterance through it and prints the transcript.

Cost: a T4 at $0.000164/sec. Model load plus a 2-second clip is well under a cent.
"""

import modal

LLAMA_TAG = "b11941"
LLAMA_URL = (
    f"https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_TAG}/"
    f"llama-{LLAMA_TAG}-bin-ubuntu-x64.tar.gz"
)
HF = "https://huggingface.co/LiquidAI/LFM3-Audio-2B-GGUF/resolve/main"
MODEL = "LFM3-Audio-2B-Q4_K_M.gguf"
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
        # Models are fetched at build time so the GPU container starts ready.
        f"mkdir -p /models && curl -fsSL -o /models/{MODEL} {HF}/{MODEL}",
        f"curl -fsSL -o /models/{MMPROJ} {HF}/{MMPROJ}",
    )
    .add_local_file(
        "/tmp/ko_test.wav", "/data/ko_test.wav", copy=True
    )
)

app = modal.App("lfm3-audio-asr-test")


@app.function(image=image, cpu=8, memory=16384, timeout=1800)
def transcribe(caption: str = "Perform ASR in Korean."):
    import subprocess, os, time, shutil

    env = dict(os.environ)
    env["LD_LIBRARY_PATH"] = "/opt/llama"

    print("=== GPU ===")
    if shutil.which("nvidia-smi"):
        gpu = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
            capture_output=True, text=True, env=env,
        )
        print(gpu.stdout.strip())
    else:
        print("none (CPU container)")

    print("\n=== model files ===")
    print(subprocess.run(
        "ls -lh /models/*.gguf", shell=True, capture_output=True, text=True, env=env
    ).stdout)

    print("=== audio ===")
    print(subprocess.run(
        "ffprobe -v error -show_entries format=duration -of csv=p=0 /data/ko_test.wav",
        shell=True, capture_output=True, text=True, env=env
    ).stdout.strip(), "seconds")

    # Try several prompt shapes: an empty -p drops into interactive mode, and
    # the caption in -p gets transcribed as if spoken. Find what works.
    variants = {
        "A: sys + space prompt": f'-sys "{caption}" --audio /data/ko_test.wav -p " "',
        "B: sys + newline prompt": f'-sys "{caption}" --audio /data/ko_test.wav -p "\n"',
        "C: sys, audio via stdin": f'-sys "{caption}" -p ""',
        "D: sys + period": f'-sys "{caption}" --audio /data/ko_test.wav -p "."',
    }
    for label, args in variants.items():
        cmd = (
            f"cd /opt/llama && ./llama-mtmd-cli -m /models/{MODEL} --mmproj /models/{MMPROJ} "
            f"{args} -n 96 --temp 0 -ngl 99 2>&1"
        )
        if label.startswith("C"):
            # chat mode: feed the audio path then quit
            cmd = (
                f"cd /opt/llama && printf '/audio /data/ko_test.wav\\n/exit\\n' | "
                f"./llama-mtmd-cli -m /models/{MODEL} --mmproj /models/{MMPROJ} "
                f'-sys "{caption}" -n 96 --temp 0 -ngl 99 2>&1'
            )
        print(f"\n{'='*60}\n{label}\n{cmd}\n{'-'*60}")
        t0 = time.time()
        p = subprocess.run(cmd, shell=True, capture_output=True, text=True, env=env)
        elapsed = time.time() - t0
        out = (p.stdout or "") + (p.stderr or "")
        # Show only the assistant output region
        tail = out[-1200:]
        print(tail)
        print(f"[elapsed {elapsed:.1f}s, exit {p.returncode}]")


@app.local_entrypoint()
def main():
    transcribe.remote()
