"""Show the mtmd-specific flags (tail of --help) and try audio generation."""

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

app = modal.App("lfm3-mtmd-help")


@app.function(image=image, cpu=4, memory=8192, timeout=1200)
def probe():
    import subprocess, os

    env = dict(os.environ)
    env["LD_LIBRARY_PATH"] = "/opt/llama"

    def run(cmd, stdin=None):
        p = subprocess.run(cmd, shell=True, capture_output=True, text=True,
                           env=env, timeout=900, input=stdin)
        return (p.stdout or "") + (p.stderr or "")

    out = run("/opt/llama/llama-mtmd-cli --help 2>&1")
    lines = out.splitlines()

    print("=== the 'mtmd params' section (this is where audio lives) ===")
    # find the mtmd section
    start = None
    for i, l in enumerate(lines):
        if "mtmd" in l.lower() and ("param" in l.lower() or "-----" in l):
            start = i
            break
    if start is None:
        print("\n".join(lines[-45:]))
    else:
        print("\n".join(lines[start:start + 45]))

    print("\n=== any line mentioning 'gen' or 'wav' or 'output' ===")
    for l in lines:
        if any(k in l.lower() for k in ("gen ", "gen,", "wav", "--o", "output")):
            print("  " + l.rstrip())


@app.local_entrypoint()
def main():
    probe.remote()
