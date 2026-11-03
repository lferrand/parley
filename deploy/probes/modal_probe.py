"""
Probe 2: locate the llama.cpp binaries correctly and dump their real interface.

Probe 1 found the binaries but ran them from the wrong directory, so every
--help call missed. This version discovers the actual layout first, sets
LD_LIBRARY_PATH, and prints the audio-relevant flags verbatim.
"""

import modal

LLAMA_TAG = "b11941"
LLAMA_URL = (
    f"https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_TAG}/"
    f"llama-{LLAMA_TAG}-bin-ubuntu-x64.tar.gz"
)

image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.8.0-runtime-ubuntu22.04", add_python="3.11"
    )
    .apt_install("curl", "ca-certificates", "libgomp1", "ffmpeg", "file")
    .run_commands(
        f"mkdir -p /opt/llama && curl -fsSL {LLAMA_URL} "
        "| tar -xz -C /opt/llama --strip-components=1",
        "chmod +x /opt/llama/* 2>/dev/null || true",
    )
)

app = modal.App("lfm3-audio-probe2")


@app.function(image=image, timeout=900)
def inspect():
    import subprocess, os, shutil

    def run(cmd, env_extra=None):
        env = dict(os.environ)
        if env_extra:
            env.update(env_extra)
        p = subprocess.run(cmd, shell=True, capture_output=True, text=True, env=env)
        return (p.stdout or "") + (p.stderr or "")

    print("=== where are the binaries? ===")
    for name in ("llama-mtmd-cli", "llama-server", "llama-tts"):
        print(f"  {name}: {shutil.which(name) or run(f'find /opt/llama -name {name} -type f | head -1').strip() or 'NOT FOUND'}")

    print("\n=== /opt/llama top level ===")
    print(run("ls -1 /opt/llama | head -30"))

    libdir = "/opt/llama"
    bindir = "/opt/llama"

    print("\n=== can llama-mtmd-cli run at all? ===")
    print(run(f"LD_LIBRARY_PATH={libdir} /opt/llama/llama-mtmd-cli --version 2>&1 | head -5"))

    print("\n=== llama-mtmd-cli --help (audio lines) ===")
    print(run(
        f"LD_LIBRARY_PATH={libdir} /opt/llama/llama-mtmd-cli --help 2>&1 "
        "| grep -iE 'audio|mmproj|image|speech|wav|tts' | head -30"
    ) or "  (no audio flags found)")

    print("\n=== llama-mtmd-cli --help (usage header) ===")
    print(run(
        f"LD_LIBRARY_PATH={libdir} /opt/llama/llama-mtmd-cli --help 2>&1 | head -25"
    ))

    print("\n=== llama-server --help (mmproj / audio) ===")
    print(run(
        f"LD_LIBRARY_PATH={libdir} /opt/llama/llama-server --help 2>&1 "
        "| grep -iE 'mmproj|audio|speech|tts|multimodal' -A1 | head -30"
    ) or "  (none)")

    print("\n=== ffmpeg present? ===")
    print(run("ffmpeg -version 2>&1 | head -1"))

    print("\n=== nvidia-smi (this is a CPU container) ===")
    print(run("nvidia-smi 2>&1 | head -3") or "  no GPU here, expected")


@app.local_entrypoint()
def main():
    inspect.remote()
