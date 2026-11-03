"""
Two leads from the previous run:
  1. chat mode emitted <|audio_start|>, so speech generation is reachable there.
  2. llama-tts said "no mmproj provided, use --mmproj" — a concrete instruction.

This run mounts the test audio properly, tries llama-tts WITH --mmproj, and
captures stdout as WAV (that is how llama.cpp's tts tool writes audio).
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
        f"mkdir -p /models && curl -fsSL -o /models/{MODEL} {HF}/{MODEL}",
        f"curl -fsSL -o /models/{MMPROJ} {HF}/{MMPROJ}",
    )
    .add_local_file("/tmp/ko_test.wav", "/data/ko_test.wav", copy=True)
)

app = modal.App("lfm3-gen-probe2")


@app.function(image=image, cpu=8, memory=16384, timeout=1800)
def probe():
    import subprocess, os, time

    env = dict(os.environ)
    env["LD_LIBRARY_PATH"] = "/opt/llama"
    os.makedirs("/work", exist_ok=True)

    def sh(cmd, timeout=900):
        t0 = time.time()
        p = subprocess.run(cmd, shell=True, capture_output=True, text=True,
                           env=env, timeout=timeout, cwd="/work")
        return (p.stdout or "") + (p.stderr or ""), time.time() - t0, p.returncode

    print("=== audio present? ===")
    print(sh("ls -lh /data/ko_test.wav")[0].strip())

    print("\n=== llama-tts --help (its own flags) ===")
    h, _, _ = sh("/opt/llama/llama-tts --help 2>&1")
    for l in h.splitlines():
        if any(k in l.lower() for k in ("mmproj", "output", "tts-", "--o", "usage")):
            print("  " + l.rstrip())

    print("\n=== A. llama-tts WITH --mmproj, stdout -> wav ===")
    cmd = (
        "cd /opt/llama && ./llama-tts "
        f"-m /models/{MODEL} --mmproj /models/{MMPROJ} "
        "--tts-lang ko --tts-voice female "
        "-p '회의는 오후 세 시에 시작합니다.' "
        "> /work/tts_stdout.wav 2>/work/tts_err.log"
    )
    out, dur, rc = sh(cmd)
    print(f"exit {rc} in {dur:.1f}s")
    print("--- stderr ---")
    print(sh("tail -25 /work/tts_err.log")[0])
    print("--- produced ---")
    print(sh("ls -la /work/*.wav 2>/dev/null; "
             "ffprobe -v error -show_entries format=duration "
             "-of csv=p=0 /work/tts_stdout.wav 2>&1 | head -3")[0])

    print("\n=== B. chat mode with real audio: does it write a wav? ===")
    chat = (
        "cd /opt/llama && printf '/audio /data/ko_test.wav\\n"
        "Perform TTS in Korean using a female voice. Say: 회의는 오후 세 시에 시작합니다.\\n"
        "/exit\\n' | "
        f"./llama-mtmd-cli -m /models/{MODEL} --mmproj /models/{MMPROJ} "
        "-n 400 --temp 0 2>&1"
    )
    o2, d2, rc2 = sh(chat)
    print(f"exit {rc2} in {d2:.1f}s")
    print(o2[-1500:])
    print("--- files ---")
    print(sh("ls -la /work /tmp/*.wav 2>/dev/null | head -20")[0])

    print("\n=== C. any fresh wav on disk ===")
    print(sh("find / -name '*.wav' -newermt '-15 minutes' -size +5k 2>/dev/null | head")[0] or "  none")


@app.local_entrypoint()
def main():
    probe.remote()
