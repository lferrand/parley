"""
llama-tts wrote /opt/llama/output.wav by default (no flag needed). Verify it is
real Korean speech, and capture the exact command that produced it.
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

app = modal.App("lfm3-tts-verify")


@app.function(image=image, cpu=8, memory=16384, timeout=1800)
def verify():
    import subprocess, os, time, base64

    env = dict(os.environ)
    env["LD_LIBRARY_PATH"] = "/opt/llama"

    def sh(cmd, timeout=900):
        t0 = time.time()
        p = subprocess.run(cmd, shell=True, capture_output=True, text=True,
                           env=env, timeout=timeout, cwd="/opt/llama")
        return (p.stdout or "") + (p.stderr or ""), time.time() - t0, p.returncode

    TTS_TEXT = "회의는 오후 세 시에 시작합니다."
    print(f"=== generating: {TTS_TEXT} ===")
    # Clear any stale file, then run the exact command that produced output.wav.
    sh("rm -f /opt/llama/output.wav")
    cmd = (
        "cd /opt/llama && ./llama-tts "
        f"-m /models/{MODEL} --mmproj /models/{MMPROJ} "
        "--tts-lang ko --tts-voice female "
        f"-p '{TTS_TEXT}'"
    )
    out, dur, rc = sh(cmd)
    print(f"exit {rc} in {dur:.1f}s")
    print(out[-900:])

    print("\n=== output.wav ===")
    print(sh("ls -la /opt/llama/output.wav 2>/dev/null || echo 'MISSING'")[0])
    info, _, _ = sh(
        "ffprobe -v error -show_entries format=duration,size "
        "-show_entries stream=codec_name,sample_rate,channels "
        "-of default=noprint_wrappers=1 /opt/llama/output.wav 2>&1"
    )
    print(info)

    # Round-trip: feed the generated speech back through ASR. If the transcript
    # matches the input text, the audio is genuinely intelligible Korean.
    print("\n=== round-trip: ASR the generated speech ===")
    asr_cmd = (
        "cd /opt/llama && ./llama-mtmd-cli "
        f"-m /models/{MODEL} --mmproj /models/{MMPROJ} "
        '-sys "Perform ASR in Korean." '
        "--audio /opt/llama/output.wav -p . -n 128 --temp 0 2>&1"
    )
    o2, d2, _ = sh(asr_cmd)
    print(f"({d2:.1f}s)")
    lines = [l.strip() for l in o2.splitlines() if l.strip()]
    keep = [l for l in lines if not l[:1].isdigit() and "im_start" not in l and "im_end" not in l]
    print("HEARD BACK:", keep[-2:] if keep else lines[-3:])

    print(f"\n=== TIMING ===\nTTS {dur:.1f}s | ASR {d2:.1f}s")
    print("\n=== audio as base64 (first 40 chars) ===")
    try:
        raw = open("/opt/llama/output.wav", "rb").read()
        print(base64.b64encode(raw[:30]).decode(), f"... total {len(raw)} bytes")
    except Exception as e:
        print("read failed:", e)


@app.local_entrypoint()
def main():
    verify.remote()
