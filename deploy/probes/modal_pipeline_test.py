"""
Full-pipeline test on Modal CPU: ASR + TTS for LFM3-Audio.

Establishes whether the whole translate loop can run serverless without a GPU
(and therefore without a payment method), plus real timing for cost maths.

Findings so far:
  - ASR needs the caption in -sys and a non-empty -p ("."), otherwise the CLI
    either treats the caption as an utterance or drops into chat mode.
  - Q4_K_M main model + Q8_0 mmproj produce clean Hangul output.
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

app = modal.App("lfm3-pipeline-test")

BASE = f"cd /opt/llama && ./llama-mtmd-cli -m /models/{MODEL} --mmproj /models/{MMPROJ}"


@app.function(image=image, cpu=8, memory=16384, timeout=1800)
def pipeline():
    import subprocess, os, time, re, shutil

    env = dict(os.environ)
    env["LD_LIBRARY_PATH"] = "/opt/llama"

    def run(cmd, stdin=None):
        t0 = time.time()
        p = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, env=env,
            input=stdin, timeout=900,
        )
        return (p.stdout or "") + (p.stderr or ""), time.time() - t0, p.returncode

    print("=== cores ===", os.cpu_count())

    # ---- ASR, timed ------------------------------------------------
    print("\n########## ASR ##########")
    asr_cmd = (
        f'{BASE} -sys "Perform ASR in Korean." '
        "--audio /data/ko_test.wav -p . -n 128 --temp 0 2>&1"
    )
    out, dur, rc = run(asr_cmd)
    print(f"wall: {dur:.2f}s  exit {rc}")
    # Pull the answer: the last non-log, non-empty line block
    lines = [l.strip() for l in out.splitlines() if l.strip()]
    answer = [l for l in lines if not re.match(r"^[\d.]+ [IWED] ", l)]
    print("ANSWER LINES:", answer[-4:])

    # ---- TTS: find which flag writes a WAV --------------------------
    print("\n########## TTS ##########")
    tts_text = "회의는 오후 3시에 시작합니다."
    attempts = {
        "output-file": f'--output-file /data/a.wav',
        "output": "'--output /data/b.wav'",
    }
    for label, outflag in attempts.items():
        cmd = (
            f'{BASE} -sys "Perform TTS in Korean using a female voice." '
            f'-p "{tts_text}" -n 512 --temp 0 {outflag} 2>&1'
        )
        print(f"\n--- {label} ---\n{cmd}")
        o, d, rc = run(cmd)
        print(f"exit {rc} in {d:.2f}s")
        print(o[-500:])

    print("\n=== audio produced? ===")
    chk, _, _ = run(
        "for f in /data/a.wav /data/b.wav; do "
        "[ -f $f ] && echo \"$f: $(stat -c%s $f) bytes, $(ffprobe -v error "
        "-show_entries format=duration -of csv=p=0 $f 2>/dev/null)s\"; done; echo done"
    )
    print(chk)

    # ---- timing summary -------------------------------------------
    print(f"\n=== TIMING ===\nASR {dur:.2f}s")


@app.local_entrypoint()
def main():
    pipeline.remote()
