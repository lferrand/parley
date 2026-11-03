"""
Can llama-mtmd-cli produce speech? The audio pipeline (lfm3a_gen_audio_pipeline,
build_gen_wav) is linked in, but --help exposes no audio-output flag, so it must
surface through chat mode. Test that, and test llama-tts with the LFM3 model.
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
    .apt_install("curl", "ca-certificates", "libgomp1", "ffmpeg", "sox")
    .run_commands(
        f"mkdir -p /opt/llama && curl -fsSL {LLAMA_URL} "
        "| tar -xz -C /opt/llama --strip-components=1",
        "chmod +x /opt/llama/* 2>/dev/null || true",
        f"mkdir -p /models && curl -fsSL -o /models/{MODEL} {HF}/{MODEL}",
        f"curl -fsSL -o /models/{MMPROJ} {HF}/{MMPROJ}",
    )
)

app = modal.App("lfm3-gen-probe")


@app.function(image=image, cpu=8, memory=16384, timeout=1800)
def probe():
    import subprocess, os, time

    env = dict(os.environ)
    env["LD_LIBRARY_PATH"] = "/opt/llama"
    os.makedirs("/work", exist_ok=True)

    def run(cmd, stdin=None, timeout=900):
        t0 = time.time()
        p = subprocess.run(cmd, shell=True, capture_output=True, text=True,
                           env=env, input=stdin, timeout=timeout, cwd="/work")
        return (p.stdout or "") + (p.stderr or ""), time.time() - t0, p.returncode

    def listing():
        p = subprocess.run("ls -la /work", shell=True, capture_output=True,
                           text=True, env=env)
        return p.stdout.strip()

    print("=== A. chat mode: ask for speech, see if audio comes out ===")
    cmd = (
        "cd /opt/llama && printf '/audio /data/ko_test.wav\\n"
        "Perform TTS in Korean using a female voice. Say: 회의는 오후 세 시에 시작합니다.\\n"
        "/exit\\n' | "
        f"./llama-mtmd-cli -m /models/{MODEL} --mmproj /models/{MMPROJ} "
        "-n 300 --temp 0 2>&1"
    )
    out, dur, rc = run(cmd)
    print(f"exit {rc} in {dur:.1f}s")
    print(out[-1800:])
    print("\n--- files in /work ---")
    print(subprocess.run("ls -la /work", shell=True, capture_output=True,
                         text=True, env=env).stdout)

    print("\n=== B. llama-tts with the LFM3 weights ===")
    cmd2 = (
        "cd /opt/llama && ./llama-tts "
        f"-m /models/{MODEL} -p '회의는 오후 세 시에 시작합니다.' "
        "--tts-lang ko --tts-voice female --output /work/tts.wav 2>&1"
    )
    out2, dur2, rc2 = run(cmd2)
    print(f"exit {rc2} in {dur2:.1f}s")
    print(out2[-1200:])

    print("\n=== C. any wav anywhere? ===")
    print(subprocess.run(
        "find / -name '*.wav' -newermt '-10 minutes' -size +10k 2>/dev/null | head -10",
        shell=True, capture_output=True, text=True, env=env).stdout or "  none")


@app.local_entrypoint()
def main():
    probe.remote()
