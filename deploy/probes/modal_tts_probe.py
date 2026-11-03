"""Which binary can generate speech, and with what flags?"""

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
        f"mkdir -p /models && curl -fsSL -o /models/{MODEL} {HF}/{MODEL}",
        f"curl -fsSL -o /models/{MMPROJ} {HF}/{MMPROJ}",
    )
)

app = modal.App("lfm3-tts-probe")


@app.function(image=image, cpu=4, memory=8192, timeout=1200)
def probe():
    import subprocess, os

    env = dict(os.environ)
    env["LD_LIBRARY_PATH"] = "/opt/llama"

    def run(cmd):
        p = subprocess.run(cmd, shell=True, capture_output=True, text=True, env=env, timeout=600)
        return (p.stdout or "") + (p.stderr or "")

    print("=== llama-mtmd-cli: EVERY flag mentioning audio/output/gen ===")
    out = run("/opt/llama/llama-mtmd-cli --help 2>&1")
    for line in out.splitlines():
        low = line.lower()
        if any(k in low for k in ("audio", "output", "speech", "gen", "wav", "tts", "--o")):
            print("  " + line.rstrip())
    print(f"  [help lines total: {len(out.splitlines())}]")

    print("\n=== llama-tts --help (first 40 non-empty lines) ===")
    tts = run("/opt/llama/llama-tts --help 2>&1")
    kept = [l for l in tts.splitlines() if l.strip()][:40]
    print("\n".join(kept))

    print("\n=== does llama-tts understand LFM3? ===")
    print(run(
        "/opt/llama/llama-tts --help 2>&1 | grep -iE 'lfm|audio|speaker|voice' | head -15"
    ) or "  none")


@app.local_entrypoint()
def main():
    probe.remote()
