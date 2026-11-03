"""
LFM3 Live Translate — Modal deployment.

Exposes the *same* API as the local server (`/api/translate`, `/api/tts`,
`/api/health`) so `server.mjs` can point at it with one env var instead of
being rewritten.

Why module-level `@app.function` + `@modal.asgi_app()` and not `@app.cls`:
inside a Modal class the ASGI app publishes a different route, and the public
URL that works is the module-level one. Startup therefore cannot rely on
`@modal.enter()` (which only fires for classes), so the two llama-server
processes are started lazily on first request, behind a lock.

Two llama-server processes per container:
  :8080  LFM3-Audio-2B + mmproj   ASR via /v1/chat/completions
  :8081  LFM3-1.7B                translation

Speech generation is the exception: llama-server has no /v1/audio/speech route
(verified 404), so TTS shells out to llama-tts and reads ./output.wav.

Measured on 8 CPU / 16 GiB:
  ASR 0.72s | translate 0.94s (whitespace prefill) | TTS ~1.95s warm
Translation MUST allow >= 512 tokens, or the hidden reasoning block eats the
whole budget and returns an empty string.
"""

import base64
import json
import os
import re
import secrets
import subprocess
import threading
import time
from pathlib import Path

import modal

# --------------------------------------------------------------------------
# Guard rules are shared with the local server via guards.rules.json.
#
# They used to be duplicated here and in server.mjs, and the copies drifted: a
# CJK fix landed in the local server but not here, so Modal rejected every
# Japanese and Chinese translation as "obedience". One file, two loaders.
# --------------------------------------------------------------------------
def _find_rules() -> Path:
    """Locate guards.rules.json in each context this module runs in.

    - deploy/          when running from the deploy directory
    - project root     when `modal deploy` imports the module locally
    - /root/           inside the container, where the image bakes it in
    """
    here = Path(__file__).resolve().parent
    for candidate in (
        here / "guards.rules.json",
        here.parent / "guards.rules.json",
        Path("/root/guards.rules.json"),
    ):
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(
        "guards.rules.json not found next to the app, in the project root, or at /root"
    )


RULES = json.loads(_find_rules().read_text(encoding="utf-8"))

# b11960 (v0.8.0) is the release that made LFM3-Audio and LFM3-Omni usable
# together, and it is the exact build verified locally on this machine.
LLAMA_TAG = "b11960"
LLAMA_URL = (
    f"https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_TAG}/"
    f"llama-{LLAMA_TAG}-bin-ubuntu-x64.tar.gz"
)
AUDIO_REPO = "https://huggingface.co/LiquidAI/LFM3-Audio-2B-GGUF/resolve/main"
TEXT_REPO = "https://huggingface.co/LiquidAI/LFM3-Omni-2B-GGUF/resolve/main"

ASR_MODEL = "LFM3-Audio-2B-Q4_K_M.gguf"
MMPROJ = "mmproj-LFM3-Audio-2B-Q8_0.gguf"
# LFM3-Omni-2B, not LFM3-1.7B. Measured through the real product path on five
# number-bearing sentences, 1.7B translated 1-2 correctly: it rendered "meeting"
# as 매팅 (not 회의), "flight" as 기항선 (not 비행), and spent 16.6 s rambling
# before giving up on "It costs 150 dollars." Omni did all five on the fast path.
#
# Loaded without its mmproj: translation needs no audio encoder, which keeps
# the text server's memory down on a CPU-only container.
TEXT_MODEL = "LFM3-Omni-2B-Q4_K_M.gguf"

image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.8.0-runtime-ubuntu22.04", add_python="3.11"
    )
    .apt_install("curl", "ca-certificates", "libgomp1", "ffmpeg")
    .pip_install("fastapi[standard]", "httpx")
    .run_commands(
        f"mkdir -p /opt/llama && curl -fsSL {LLAMA_URL} "
        "| tar -xz -C /opt/llama --strip-components=1",
        "chmod +x /opt/llama/* 2>/dev/null || true",
        f"mkdir -p /models && curl -fsSL -o /models/{ASR_MODEL} {AUDIO_REPO}/{ASR_MODEL}",
        f"curl -fsSL -o /models/{MMPROJ} {AUDIO_REPO}/{MMPROJ}",
        f"curl -fsSL -o /models/{TEXT_MODEL} {TEXT_REPO}/{TEXT_MODEL}",
    )
    # Guard rules are shared with the local server. Baking the file into the
    # image keeps one source of truth instead of two drifting copies.
    .add_local_file("guards.rules.json", "/root/guards.rules.json", copy=True)
    .add_local_dir("public", "/root/public", copy=True)
)

app = modal.App("lfm3-live-translate")

# Bearer token for the public endpoint. Created once with:
#   modal secret create lfm3-auth --from-dotenv <file containing LFM_AUTH_TOKEN=...>
# Kept in a Modal secret so it never appears in this source file.
AUTH_SECRET = modal.Secret.from_name("lfm3-auth", required_keys=["LFM_AUTH_TOKEN"])

# --------------------------------------------------------------------------
# Language table — mirrors server.mjs so both paths name languages the same way
# --------------------------------------------------------------------------

LANGUAGES = {
    "ko": {"name": "Korean", "voice": "korean"},
    "en": {"name": "English", "voice": "american-english"},
    "en-GB": {"name": "English", "voice": "british-english"},
    "ja": {"name": "Japanese", "voice": "japanese"},
    "zh": {"name": "Chinese", "voice": "chinese"},
    "es": {"name": "Spanish", "voice": "spanish"},
    "fr": {"name": "French", "voice": "french"},
    "de": {"name": "German", "voice": "german"},
    "it": {"name": "Italian", "voice": "italian"},
    "pt": {"name": "Portuguese", "voice": "portuguese"},
    "nl": {"name": "Dutch", "voice": "dutch"},
    "pl": {"name": "Polish", "voice": "polish"},
    "sv": {"name": "Swedish", "voice": "swedish"},
    "da": {"name": "Danish", "voice": "danish"},
    "fi": {"name": "Finnish", "voice": "finnish"},
    "tr": {"name": "Turkish", "voice": "turkish"},
    "ar": {"name": "Arabic", "voice": "arabic"},
    "he": {"name": "Hebrew", "voice": "hebrew"},
    "el": {"name": "Greek", "voice": "greek"},
}
HANGUL = re.compile(r"[\uAC00-\uD7A3\u3130-\u318F]")
SCRIPTS = {
    "ja": re.compile(r"[\u3040-\u30FF]"),
    "zh": re.compile(r"[\u4E00-\u9FFF]"),
    "ar": re.compile(r"[\u0600-\u06FF]"),
    "he": re.compile(r"[\u0590-\u05FF]"),
    "el": re.compile(r"[\u0370-\u03FF]"),
}


def detect_source(text: str, hint: str = "auto") -> str:
    """Script first; the hint only decides ambiguous Latin input."""
    if HANGUL.search(text):
        return "ko"
    for code, rx in SCRIPTS.items():
        if rx.search(text):
            return code
    if hint and hint not in ("auto", "ko") and hint in LANGUAGES:
        return hint
    return "en"



def fence_source(text: str) -> str:
    """Wrap the source in <source> tags, removing anything that could close the
    fence. Identical behaviour to the local server, so a transcript containing
    "</source>" cannot escape into a new turn."""
    cleaned = re.sub(
        r"</?\s*(source|system|assistant|user|instructions?|prompt)\s*>", " ", str(text or ""),
        flags=re.I,
    )
    return f"<source>\n{cleaned}\n</source>"


def strip_leading_affirmation(text: str, source: str) -> str:
    """A question translated by a small model often keeps a conversational
    opener ("Yes, could you say it again?"). A faithful translation has none.

    Only for questions, and never when the source itself opens with an
    affirmation — otherwise "Yes, please." would lose a real word.
    """
    src = str(source or "")
    if not re.search(r"[?？]", src):
        return text
    if re.match(RULES["affirmations"]["sourceOpens"]["latin"], src.strip(), re.I):
        return text
    if re.match(RULES["affirmations"]["sourceOpens"]["korean"], src.strip()):
        return text
    t = re.sub(
        r"^(?:" + "|".join(RULES["affirmations"]["latin"]) + r")[\s,，.!！]+",
        "", text, flags=re.I,
    )
    t = re.sub(r"^(?:" + "|".join(RULES["affirmations"]["korean"]) + r")[\s,，.!！]+", "", t)
    return t.strip()



QUESTION_ENDINGS = {
    k: re.compile(v) for k, v in RULES["questionEndings"].items() if not k.startswith("$")
}


def answered_a_question(source: str, out: str, target: str) -> bool:
    """A question must stay a question. When the model answers instead of
    translating, the interrogative form disappears: "Can you speak slower?"
    came back as "네, 좀 더 천천히 말씀드리겠습니다." — a reply, not a translation.
    """
    if not re.search(r"[?？]", str(source or "")):
        return False
    t = str(out or "").strip()
    # A reply opens by agreeing; a translated question does not.
    if re.match(r"^(?:yes|sure|of course|okay|certainly|absolutely)\b", t, re.I):
        return True
    if re.match(r"^(?:" + "|".join(RULES["affirmations"]["korean"]) + r")[\s,，.!！]", t):
        return True
    if re.search(r"[?？]", t):
        return False
    endings = QUESTION_ENDINGS.get(target)
    if endings and endings.search(t):
        return False
    return True



META_REFERENCES = list(RULES["metaReferences"]["patterns"])


def is_commentary(source: str, out: str) -> bool:
    """Commentary about the text is not a translation. Seen in testing:
    "Where is the station?" -> "この文章は「駅はどこですか？」という日本語の質問です。"
    The script check passed because the commentary was itself in Japanese.
    """
    t = str(out or "")
    if any(re.search(p, t, re.I) for p in META_REFERENCES):
        return True
    src = str(source or "").strip()
    if len(src) >= 8:
        if any(q in t for q in (f"「{src}」", f'"{src}"', f"'{src}'", f"“{src}”", f"『{src}』")):
            return True
    return False


def clean(text: str) -> str:
    t = (text or "").strip()
    t = re.sub(r"```[a-z]*\s*", "", t).replace("```", "").strip()
    # Strip leaked reasoning markers: the careful path can emit a closing
    #  tag in front of the actual translation.
    t = re.sub(r"<\|?\s*/?\s*think\s*\|?>", "", t, flags=re.I).strip()
    t = re.sub(r"<\|[a-z_]+\|>", "", t).strip()
    fenced = re.match(r"^\s*<source>([\s\S]*?)</source>\s*([\s\S]*)$", t, re.I)
    if fenced:
        rest = fenced.group(2).strip()
        t = (rest or fenced.group(1).strip()).strip()
    t = re.sub(r"</?\s*(source|system|assistant|user|translation)\s*>", "", t, flags=re.I).strip()
    # Labels are stripped per line, not only at the start of the string. Anchoring
    # to ^ alone let a "**Translation:**" heading on its own line survive, which
    # then reached the user verbatim (seen in German, Swedish, Danish, Turkish).
    # The prefix must contain no digit: "The train leaves at 7" is a legitimate
    # prefix ending in a colon, and a looser pattern ate real text.
    kept_lines = []
    for line in t.split("\n"):
        s = line.strip()
        if not s:
            continue
        if re.fullmatch(r"\**\s*(translation|übersetzung|traduction|traducción|vertaling|"
                        r"oversættelse|översättning|çeviri|翻译|翻訳|번역)\s*:?\s*\**",
                        s, flags=re.I):
            continue
        s = re.sub(r"^\**\s*(?=[^:\d]*:)(?![^:\d]*\d)[^:\d]{1,24}:\s*\**\s*", "", s)
        if s:
            kept_lines.append(s)
    t = "\n".join(kept_lines) if kept_lines else t
    return t.strip().strip('"\u201c\u201d')



# --------------------------------------------------------------------------
# Output validation
#
# The local server has had these guards since early on; the Modal port shipped
# without them, and a test caught it: "Where is the station?" produced a
# 15-second rambling paragraph instead of a translation. A 1.7B model cannot be
# trusted to obey "output only the translation", so every candidate is checked.
# --------------------------------------------------------------------------

LATIN_LANGS = set(RULES["latinLangs"]["codes"])
SCRIPT_TEST = {
    k: re.compile(v) for k, v in RULES["scriptTests"].items() if not k.startswith("$")
}
MONTHS = ["january", "february", "march", "april", "may", "june", "july",
          "august", "september", "october", "november", "december"]

ASSISTANT_TELLS = list(RULES["assistantTells"]["patterns"])
INJECTION_PATTERNS = list(RULES["injectionPatterns"]["patterns"])


def looks_good(text: str, target: str, source: str) -> bool:
    t = (text or "").strip()
    if not t:
        return False
    if any(ch in t for ch in ("|", "→", "**", "<|")):
        return False
    if re.search(r"\n\s*\n", t):
        return False                                   # multi-paragraph rambling
    if len(t) > max(RULES["thresholds"]["minLengthFloor"], len(source) * RULES["thresholds"]["maxLengthRatio"]):
        return False
    wanted = SCRIPT_TEST.get(target)
    if wanted:
        return bool(wanted.search(t))
    if target in LATIN_LANGS:
        if HANGUL.search(t):
            return False
        if not re.search(r"[a-zA-Z]", t):
            return False
        korean = len(HANGUL.findall(t))
        latin = len(re.findall(r"[a-zA-Z]", t))
        return korean <= latin * 0.1
    return True


def kept_numbers(source: str, translated: str) -> bool:
    # Mirrors keptNumbers() in the local server, including the clock fix.
    #
    # Comparing digits alone rejected correct output: "3 PM", "15h",
    # "15 Uhr", "15:00", "오후 3시" and "الساعة 3 مساءً" all name the same
    # moment with no digit in common. That cost the fast path and pushed
    # good translations into the 2-3s retry loop.
    translated_norm = _normalize_digits(_normalize_korean_numbers(translated)).lower()

    src_times = _time_mentions(source)
    if src_times:
        dst_times = _time_mentions(translated_norm)
        if any(t not in dst_times for t in src_times):
            return False

    want = set(re.findall(r"\d+", _strip_times(_normalize_digits(source))))
    if not want:
        return True
    out = _strip_times(translated_norm)
    have = set(re.findall(r"\d+", out))
    for d in want:
        if d in have:
            continue
        if d.isdigit() and 1 <= int(d) <= 12 and MONTHS[int(d) - 1] in out:
            continue                                    # "10월" -> "October"
        # Arabic dual form: طفلان IS "two children" — the number lives in the
        # word, exactly like Korean 두 명.
        if d == "2" and re.search(r"[\u0600-\u06FF]", out) and re.search(r"(ان|ين)\b", out):
            continue
        return False
    return True


# --------------------------------------------------------------------------
# Clock-time canonicalisation — a Python port of clock.mjs.
#
# One scanner yields both the parsed moments and the text with those spans
# blanked, so detection and stripping cannot disagree about which forms exist.
# Kept in step with clock.mjs; if you add a form there, add it here.
# --------------------------------------------------------------------------

_MERIDIEM = {
    "오전": "am", "오후": "pm",
    "午前": "am", "午後": "pm",
    "上午": "am", "下午": "pm",
}

_CLOCK_PASSES = [
    # 오후 3시 30분 / 午後3時 / 下午3点
    (re.compile(r"(오전|오후|午前|午後|上午|下午)\s*(\d{1,2})(?:\s*[:.]\s*(\d{2}))?"
                r"\s*(?:시|時|点|點)(?:\s*(\d{1,2}))?\s*분?"),
     lambda m: (_to24(int(m.group(2)), _MERIDIEM.get(m.group(1), "am")) * 60
                 + int(m.group(3) or m.group(4) or 0))),
    # الساعة 3 مساءً
    (re.compile(r"(\d{1,2})(?:[:.](\d{2}))?\s*(مساءً|مساء|صباحاً|صباح|ظهراً|ظهر|ليلاً|ليلة)"),
     lambda m: (_to24(int(m.group(1)), "pm" if m.group(3)[:2] in ("مس", "ظم", "لي") else "am")
                 * 60 + int(m.group(2) or 0))),
    # 3 PM / 7:45 am
    (re.compile(r"(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])", re.I),
     lambda m: (_to24(int(m.group(1)), "pm" if m.group(3).lower().startswith("p") else "am")
                 * 60 + int(m.group(2) or 0))),
    # French 7h45, and must precede the bare "15h" pass or the minutes are lost
    (re.compile(r"(?<!\d)(\d{1,2})\s*h\s*(\d{2})(?!\d)", re.I),
     lambda m: (int(m.group(1)) % 24) * 60 + int(m.group(2))),
    # 15h / 15 Uhr / 15 uur
    (re.compile(r"(\d{1,2})(?:[:.](\d{2}))?\s*(?:h(?![a-z])|uhr\b|uur\b)", re.I),
     lambda m: (int(m.group(1)) % 24) * 60 + int(m.group(2) or 0)),
    # kl. 15 / kl 15.30
    (re.compile(r"\bkl\.?\s*(\d{1,2})(?:[:.](\d{2}))?", re.I),
     lambda m: (int(m.group(1)) % 24) * 60 + int(m.group(2) or 0)),
    # bare H:MM, last so "3:30 PM" is already gone
    (re.compile(r"(?<!\d)(\d{1,2}):(\d{2})(?!\d)"),
     lambda m: (int(m.group(1)) % 24) * 60 + int(m.group(2))),
]


def _to24(hour: int, meridiem: str) -> int:
    h = hour % 12
    return h + 12 if meridiem == "pm" else h


def _scan_times(text: str):
    """Returns (minutes:set[int], rest:str) — rest has clock spans blanked."""
    rest = str(text or "")
    minutes = set()
    for pattern, take in _CLOCK_PASSES:
        def _sub(m, take=take):
            try:
                value = take(m)
            except (TypeError, ValueError):
                return " " * len(m.group(0))
            if value is not None:
                minutes.add(value)
            return " " * len(m.group(0))
        rest = pattern.sub(_sub, rest)
    return minutes, rest


def _time_mentions(text: str) -> set:
    return _scan_times(text)[0]


def _strip_times(text: str) -> str:
    return _scan_times(text)[1]


def _normalize_digits(text: str) -> str:
    """Arabic-Indic ٣ and Persian ۳ are ordinary digits."""
    out = str(text or "")
    out = re.sub(r"[\u0660-\u0669]", lambda m: str(ord(m.group(0)) - 0x0660), out)
    out = re.sub(r"[\u06F0-\u06F9]", lambda m: str(ord(m.group(0)) - 0x06F0), out)
    return out


_SINO = {"한": "1", "일": "1", "두": "2", "이": "2", "세": "3", "삼": "3",
         "네": "4", "사": "4", "다섯": "5", "오": "5", "여섯": "6", "육": "6",
         "일곱": "7", "칠": "7", "여덟": "8", "팔": "8", "아홉": "9", "구": "9"}


def _normalize_korean_numbers(text: str) -> str:
    """Korean writes numerals as words: 두 명 is "2 people", 세 시 is 3 o'clock."""
    t = str(text or "")
    t = re.sub(r"(한|두|세|네|다섯|여섯|일곱|여덟|아홉|열한|열두)\s*시"
               r"(?!간|작|험|도|민|장|설|청|내|인|절)",
               lambda m: f"{_SINO.get(m.group(1), m.group(1))}시", t)
    t = re.sub(r"(한|두|세|네|다섯|여섯|일곱|여덟|아홉)\s*(명|개|잔|권|번|대|층|마리|병|송이)",
               lambda m: f"{_SINO.get(m.group(1), m.group(1))}{m.group(2)}", t)
    return t


def invented_meridiem(source: str, translated: str) -> bool:
    src_has = bool(re.search(RULES["meridiem"]["sourceHas"], source.lower()))
    out_has = bool(re.search(RULES["meridiem"]["outputHas"], translated.lower()))
    return out_has and not src_has


def answered_instead_of_translating(out: str) -> bool:
    return any(re.search(p, out, re.I) for p in ASSISTANT_TELLS)


def looks_like_injection(text: str) -> bool:
    return any(re.search(p, text, re.I) for p in INJECTION_PATTERNS)


def quoted_tokens(text: str):
    found = set()
    for m in re.finditer(r"['\"“”「」『』]([^'\"“”「」『』]{1,40})['\"“”「」『』]", text):
        found.add(m.group(1).strip().upper())
    return found


def looks_like_obedience(source: str, out: str) -> bool:
    bare = out.strip().strip("\"'“”「」『』.!?。！？ ").upper()
    if not bare:
        return False
    for token in quoted_tokens(source):
        if bare == token:
            return True
    if re.search(r"[?？]", source) and re.match(
        r"^(?:yes|sure|of course|okay|certainly|absolutely)\b", out.strip(), re.I
    ):
        return True
    # "The model collapsed a sentence into a word or two" only makes sense for
    # space-delimited languages. Japanese and Chinese are written without spaces,
    # so a perfectly good sentence counts as ONE word and every CJK translation
    # was rejected as obedience. (E.g. "I'd like to go to Japan, but I'm very
    # tired and have no money." -> 13 source words vs 1 output "word".)
    out_text = out or ""
    if RULES["obedience"]["requireWhitespace"] and not re.search(r"\s", out_text.strip()):
        return False

    src_words = len(source.split())
    out_words = len(out_text.split())
    return (src_words >= RULES["obedience"]["minSourceWords"]
            and out_words <= RULES["obedience"]["maxOutputWords"])


def acceptable(out: str, target: str, source: str) -> bool:
    return (
        looks_good(out, target, source)
        and kept_numbers(source, out)
        and not invented_meridiem(source, out)
        and not answered_instead_of_translating(out)
        and not looks_like_obedience(source, out)
    )


def fix_wav(buf: bytes) -> bytes:
    """llama.cpp writes 0xFFFFFFFF placeholder sizes; patch in real lengths."""
    if len(buf) < 44 or buf[0:4] != b"RIFF" or buf[8:12] != b"WAVE":
        return buf
    out = bytearray(buf)
    out[4:8] = (len(buf) - 8).to_bytes(4, "little")
    offset = 12
    while offset + 8 <= len(out):
        cid = bytes(out[offset:offset + 4])
        size = int.from_bytes(out[offset + 4:offset + 8], "little")
        if cid == b"data":
            out[offset + 4:offset + 8] = (len(out) - (offset + 8)).to_bytes(4, "little")
            break
        if size == 0xFFFFFFFF or size > len(out):
            break
        offset += 8 + size + (size % 2)
    return bytes(out)


# --------------------------------------------------------------------------
# Model runtime
# --------------------------------------------------------------------------

def _looks_like_wav(data: bytes) -> bool:
    return len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WAVE"


def _to_wav16k(data: bytes) -> bytes:
    """Any container ffmpeg can read -> 16 kHz mono PCM WAV.

    Mirrors toWav16k() in server.mjs so the remote accepts the same audio the
    local proxy does. ffmpeg is installed in the image.
    """
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error",
         "-i", "pipe:0", "-ar", "16000", "-ac", "1", "-f", "wav", "pipe:1"],
        input=data, capture_output=True, timeout=120,
    )
    if proc.returncode != 0 or not proc.stdout:
        detail = (proc.stderr or b"").decode("utf-8", "replace")[-300:]
        raise RuntimeError(f"could not decode the audio (ffmpeg): {detail}")
    return proc.stdout


class _Runtime:
    """Owns the two llama-server processes and the speech CLI."""

    def __init__(self):
        self.env = {**os.environ, "LD_LIBRARY_PATH": "/opt/llama"}
        self.procs = []
        # Keep log handles referenced: if they are collected, the child's stdout
        # closes and llama-server dies on SIGPIPE.
        self._logs = []
        self.work = Path("/tmp/lfm-work")
        self.work.mkdir(parents=True, exist_ok=True)

    def _spawn(self, args, log):
        fh = open(log, "wb")
        self._logs.append(fh)
        return subprocess.Popen(
            args, cwd="/opt/llama", env=self.env, stdout=fh, stderr=subprocess.STDOUT
        )

    def _alive(self, port):
        import httpx
        try:
            return httpx.get(f"http://127.0.0.1:{port}/health", timeout=3).status_code == 200
        except Exception:
            return False

    def _wait(self, port, timeout=300):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self._alive(port):
                return True
            time.sleep(1.5)
        return False

    def _start_audio(self):
        self.procs = [p for p in self.procs if p.poll() is None]
        self.procs.append(self._spawn([
            "./llama-server", "-m", f"/models/{ASR_MODEL}",
            "--mmproj", f"/models/{MMPROJ}",
            "--port", "8080", "-c", "4096", "-t", "6",
        ], "/tmp/audio.log"))
        if not self._wait(8080):
            raise RuntimeError("audio server won't start: "
                               + Path("/tmp/audio.log").read_text()[-900:])

    def _start_text(self):
        self.procs = [p for p in self.procs if p.poll() is None]
        self.procs.append(self._spawn([
            "./llama-server", "-m", f"/models/{TEXT_MODEL}",
            "--port", "8081", "-c", "4096", "-t", "6",
        ], "/tmp/text.log"))
        if not self._wait(8081):
            raise RuntimeError("text server won't start: "
                               + Path("/tmp/text.log").read_text()[-900:])

    def boot(self):
        self._start_audio()
        self._start_text()
        # Warm the speech path so the first real request isn't paying model load.
        subprocess.run(
            f"./llama-tts -m /models/{ASR_MODEL} --mmproj /models/{MMPROJ} "
            "--tts-lang ko --tts-voice female -p '\uc900\ube44'",
            shell=True, cwd="/opt/llama", env=self.env,
            capture_output=True, timeout=600,
        )

    def ensure(self):
        if not self._alive(8080):
            self._start_audio()
        if not self._alive(8081):
            self._start_text()

    # ---- ASR ----------------------------------------------------------
    def asr(self, audio: bytes, hint: str) -> str:
        import httpx
        # The browser records webm/opus (or mp4 on Safari) and the local
        # server converts before forwarding. A direct call to this endpoint
        # (or any client that skips the Node proxy) sends the raw container;
        # llama-server only accepts real WAV and answers 400, which surfaced
        # here as a bare HTTP 500. Sniff the header and transcode.
        if not _looks_like_wav(audio):
            audio = _to_wav16k(audio)
        b64 = base64.b64encode(audio).decode()
        caption = (
            f"Perform ASR in {LANGUAGES[hint]['name']}."
            if hint in LANGUAGES else "Perform ASR."
        )
        r = httpx.post(
            "http://127.0.0.1:8080/v1/chat/completions",
            json={
                "model": "lfm",
                "messages": [
                    {"role": "system", "content": caption},
                    {"role": "user", "content": [
                        {"type": "input_audio",
                         "input_audio": {"data": b64, "format": "wav"}}
                    ]},
                ],
                "temperature": 0,
                "max_tokens": 256,
            },
            timeout=300,
        )
        r.raise_for_status()
        return clean(r.json()["choices"][0]["message"]["content"])

    # ---- translate ----------------------------------------------------
    def translate(self, text: str, src: str, dst: str):
        import httpx
        src_name = LANGUAGES[src]["name"]
        dst_name = LANGUAGES[dst]["name"]

        # Three phrasings, same as the local server. A single prompt is not enough:
        # question-shaped input makes a 1.7B model answer or ramble, and a different
        # wording often recovers it.
        # Templates come from guards.rules.json so the local and Modal backends
        # cannot drift. They used to be written twice and quietly diverged.
        variants = [
            t.replace("{src}", src_name).replace("{dst}", dst_name)
            for t in RULES["prompts"]["variants"]
        ]
        # Whitespace assistant prefill skips the hidden reasoning block:
        # 0.94s instead of ~8.6s. Validated output is still required — the fast
        # path sometimes rambles for 15s instead of translating.
        def attempt(prefill: bool, variant: int = 0) -> str:
            msgs = [
                {"role": "system", "content": variants[min(variant, len(variants) - 1)]},
                {"role": "user", "content": fence_source(text)},
            ]
            if prefill:
                msgs.append({"role": "assistant", "content": "\n\n"})
            r = httpx.post(
                "http://127.0.0.1:8081/v1/chat/completions",
                json={
                    "model": "lfm",
                    "messages": msgs,
                    "temperature": 0,
                    # Measured with LFM3-1.7B on a request that triggers heavy
                    # reasoning: the model needed 1618 tokens before answering.
                    # At 512 and 1024 it hit the cap and returned nothing; at
                    # 2048 it finished in 13.1s. 4096 gave the identical result,
                    # so 2048 is the smallest sufficient budget — generous enough
                    # to let it finish, without paying for tokens it never uses.
                    "max_tokens": 384 if prefill else 2048,
                },
                timeout=12 if prefill else 45,
            )
            r.raise_for_status()
            body = r.json()
            choice = body["choices"][0]
            content = clean(choice["message"]["content"] or "")
            finish = choice.get("finish_reason")
            used = (body.get("usage") or {}).get("completion_tokens")

            # An empty answer with finish_reason="length" means the reasoning
            # block ate the entire budget. Report that precisely instead of a
            # bare "empty output" — it tells you to raise the budget, not the
            # prompt.
            if not content and finish == "length":
                raise RuntimeError(
                    f"reasoning used the whole budget ({used} tokens, finish=length)"
                )

            return strip_leading_affirmation(content, text)

        # Instruction-shaped input skips the fast path: that is where the model
        # is most likely to obey rather than translate.
        suspicious = looks_like_injection(text)
        best = ""

        def verdict(out: str):
            """Which guard rejected this candidate, for the inspect panel."""
            reasons = []
            t = (out or "").strip()
            if not t:
                reasons.append("empty output")
            else:
                if not looks_good(t, dst, text):
                    wanted = SCRIPT_TEST.get(dst)
                    if any(ch in t for ch in ("|", "→", "**", "<|")):
                        reasons.append("output contains markup or tables")
                    elif re.search(r"\n\s*\n", t):
                        reasons.append("output was several paragraphs (model explained instead of translating)")
                    elif len(t) > max(RULES["thresholds"]["minLengthFloor"], len(text) * RULES["thresholds"]["maxLengthRatio"]):
                        reasons.append(f"output too long for the source ({len(t)} chars)")
                    elif wanted and not wanted.search(t):
                        reasons.append(f"output was not in the target script ({dst})")
                    else:
                        reasons.append("output did not look like a translation")
                if not kept_numbers(text, t):
                    reasons.append("a number or time from the source was lost or changed")
                if invented_meridiem(text, t):
                    reasons.append("output invented an AM/PM marker the source did not have")
                if answered_instead_of_translating(t):
                    reasons.append("model replied to the text instead of translating it")
                if looks_like_obedience(text, t):
                    reasons.append("model followed an instruction in the text instead of translating it")
                if answered_a_question(text, t, dst):
                    reasons.append("source was a question but the output was an answer, not a question")
                if is_commentary(text, t):
                    reasons.append("output described or quoted the text instead of translating it")
            return reasons

        attempts = []

        def record(stage: str, out: str, started: float):
            attempts.append({
                "stage": stage,
                "ms": int((time.time() - started) * 1000),
                "chars": len(out or ""),
                "preview": (out or "")[:240],
                "ok": not verdict(out),
                "reasons": verdict(out),
            })

        if suspicious:
            attempts.append({
                "stage": "routing", "ms": 0, "chars": 0, "preview": "",
                "ok": False,
                "reasons": ["input looked like an instruction, so the fast path was skipped"],
            })
        else:
            t0 = time.time()
            try:
                quick = attempt(prefill=True)
                record("fast (reasoning skipped)", quick, t0)
                if not verdict(quick):
                    return quick, "fast", {"attempts": attempts, "provider": "modal"}
                if quick:
                    best = quick
            except Exception as err:
                attempts.append({
                    "stage": "fast (reasoning skipped)", "ms": int((time.time() - t0) * 1000),
                    "chars": 0, "preview": "", "ok": False, "reasons": [str(err)],
                })

        # Careful path: allow the reasoning block, trying at most two phrasings
        # inside a fixed budget. Three variants at 18s each was pushing single
        # requests past 90s, which is unusable in conversation.
        # One full careful attempt costs ~21s on Modal (1618 tokens at ~76 tok/s),
        # so a 45s deadline allowed TWO attempts and produced 57s requests that
        # still failed. Budget for one complete attempt plus margin.
        deadline = time.time() + 32
        order = (RULES["prompts"]["orderSuspicious"] if suspicious
                 else RULES["prompts"]["orderNormal"])
        for variant in order[: RULES["prompts"]["maxAttempts"]]:
            if time.time() > deadline:
                attempts.append({
                    "stage": "budget", "ms": 0, "chars": 0, "preview": "", "ok": False,
                    "reasons": ["stopped retrying after the time budget was spent"],
                })
                break
            t0 = time.time()
            try:
                careful = attempt(prefill=False, variant=variant)
            except Exception as err:
                msg = str(err)
                attempts.append({
                    "stage": f"careful, wording #{variant + 1}",
                    "ms": int((time.time() - t0) * 1000),
                    "chars": 0, "preview": "", "ok": False, "reasons": [msg],
                })
                # Burning the whole budget is deterministic for this input:
                # retrying with the same limit just wastes another ~10-20s.
                if "whole budget" in msg:
                    attempts.append({
                        "stage": "budget", "ms": 0, "chars": 0, "preview": "",
                        "ok": False,
                        "reasons": ["retry skipped: the model would think for the same length again"],
                    })
                    break
                continue
            record(f"careful, wording #{variant + 1}", careful, t0)
            if not verdict(careful):
                return careful, "careful", {"attempts": attempts, "provider": "modal"}
            if careful and (not best or len(careful) < len(best)):
                best = careful

            # A slow attempt that still failed validation will be just as slow
            # and probably fail the same way. One retry only helps when the
            # model answered quickly and a different wording might recover it.
            elapsed = (time.time() - t0) * 1000
            if elapsed > 12000:
                attempts.append({
                    "stage": "budget", "ms": 0, "chars": 0, "preview": "",
                    "ok": False,
                    "reasons": ["retry skipped: the first attempt already used most "
                                "of the time budget"],
                })
                break

        # Nothing passed. Returning a wrong-language answer (a Chinese sentence
        # for a Korean target) is worse than returning the source and saying so,
        # so the caller can show the original text instead of a false translation.
        trace = {"attempts": attempts, "provider": "modal"}
        if best and not verdict(best):
            return best, "fallback", trace
        return text, "failed", trace

    # ---- TTS ----------------------------------------------------------
    def tts(self, text: str, lang: str, gender: str) -> bytes:
        """Generate speech through the warm audio server's /tts route.

        This used to shell out to llama-tts, which reloaded both models on every
        call (~2.6s warm, more under load). The server already holds the model,
        so the same request takes ~1.1s — measured on 8 cores.

        Falls back to the CLI if the route is unavailable, so an older
        llama.cpp build still works.
        """
        import httpx

        voice = f"{gender}-{LANGUAGES.get(lang, LANGUAGES['ko'])['voice']}"
        safe = (text or "").replace("\n", " ")[:1200]
        if not safe.strip():
            raise RuntimeError("tts called with empty text")

        try:
            r = httpx.post(
                "http://127.0.0.1:8080/tts",
                json={"input": safe, "voice": voice, "language": lang},
                timeout=300,
            )
            if r.status_code == 200 and r.content[:4] == b"RIFF":
                return fix_wav(r.content)
            raise RuntimeError(f"/tts returned {r.status_code}: {r.text[:200]}")
        except Exception as err:
            # Keep the app working on builds without the route.
            return self._tts_cli(safe, lang, voice, reason=str(err))

    def _tts_cli(self, text: str, lang: str, voice: str, reason: str = "") -> bytes:
        """Pre-route fallback: one-shot llama-tts, which reloads the model."""
        outdir = self.work / str(int(time.time() * 1000))
        outdir.mkdir(parents=True, exist_ok=True)
        safe = text.replace("'", " ").replace('"', " ")
        proc = subprocess.run(
            f"/opt/llama/llama-tts -m /models/{ASR_MODEL} --mmproj /models/{MMPROJ} "
            f"--tts-lang {lang} --tts-voice {voice} -t 10 -p '{safe}'",
            shell=True, cwd=str(outdir), env=self.env,
            capture_output=True, timeout=600,
        )
        wav = outdir / "output.wav"
        if not wav.exists():
            log = ((proc.stdout or b"") + (proc.stderr or b"")).decode("utf-8", "ignore")
            raise RuntimeError(
                f"tts produced no output.wav (route failed: {reason}; "
                f"cli exit {proc.returncode}): {log[-400:]}"
            )
        data = wav.read_bytes()
        wav.unlink(missing_ok=True)
        try:
            outdir.rmdir()
        except OSError:
            pass
        return fix_wav(data)


_RUNTIME = None
_LOCK = threading.Lock()


def get_runtime() -> _Runtime:
    """Start the servers on first use; revive them if they died."""
    global _RUNTIME
    with _LOCK:
        if _RUNTIME is None:
            rt = _Runtime()
            rt.boot()
            _RUNTIME = rt
        else:
            _RUNTIME.ensure()
    return _RUNTIME


# --------------------------------------------------------------------------
# HTTP API (same shape as server.mjs)
# --------------------------------------------------------------------------

# --------------------------------------------------------------------------
# Release artefacts (macOS app)
#
# A 141 MB installer does not belong in the image: it would be re-uploaded on
# every deploy and re-downloaded on every cold start. It lives in a Volume and
# is mounted read-only, so the container can stream it on request and nothing
# else pays for it.
#
# The file is pushed manually when a build is finished:
#   modal volume put parley-releases desktop/dist/Parley-X.Y.Z-arm64.dmg \
#       /Parley-X.Y.Z-arm64.dmg
# --------------------------------------------------------------------------
RELEASES = modal.Volume.from_name("parley-releases", create_if_missing=True)


@app.function(
    image=image,
    secrets=[AUTH_SECRET],
    cpu=8,
    memory=16384,
    timeout=900,
    volumes={"/releases": RELEASES},
    # Default region (us-east / Virginia), chosen deliberately.
    #
    # Asia-Pacific was tested: Singapore cut the network round-trip from ~0.78s
    # to ~0.39s (measured on /api/health, which does no model work), but its
    # containers ran inference ~1.7x slower, so the full loop went 3.18s -> 3.73s.
    # Narrow regions also bill at 1.75x the base rate. us-east is both faster
    # end-to-end and cheaper, so no region= override here.
    #
    # routing_region can only be set at a Function's FIRST deployment, so this
    # is a new function name (api_useast) rather than an edit of api_sg.
    # By default Modal runs on preemptible capacity and can reclaim the container
    # mid-request, which surfaces to the client as
    #   "modal-http: internal error: function was terminated by signal"
    # Preemption is cheap for batch work but not for a request someone is
    # waiting on, so pay the non-preemptible rate here.
    nonpreemptible=True,
    # Keep the container warm briefly so a conversation doesn't pay model load
    # between turns. Raise for smoother UX, at continuous cost.
    scaledown_window=300,
)
@modal.asgi_app()
def api_useast():
    from fastapi import FastAPI, Request
    from fastapi.responses import FileResponse, JSONResponse, Response

    web = FastAPI()

    # ------------------------------------------------------------------
    # Open access, rate limited.
    #
    # This is a prototype meant to be shared by link, so there is no token.
    # But every call can spin up model containers, so an unthrottled public
    # endpoint is a money risk rather than a security one. A small in-memory
    # token bucket per client keeps casual sharing usable while stopping a
    # loop from running up the bill.
    #
    # Scope: one container. Modal may run several, and each keeps its own
    # counters, so the effective limit scales with replica count. Enough for
    # abuse protection, not a substitute for real quotas.
    # ------------------------------------------------------------------
    RATE = {
        # Requests per window, per client IP.
        #
        # /api/translate was 30/min, which the interim caption alone exceeds:
        # it polls once per utterance slice and translates the window each time,
        # so a speaker needs up to 50 calls a minute. The limit was hit ~36s
        # into any long utterance and the streaming text silently froze. 60/min
        # still bounds a loop, while leaving room for one speaker plus their
        # final turns.
        "/api/translate": (60, 60),
        "/api/transcribe": (90, 60),  # interim captions poll ~2.4s per speaker
        "/api/tts": (30, 60),
    }
    _hits: dict[tuple[str, str], list[float]] = {}

    @web.middleware("http")
    async def rate_limit(request: Request, call_next):
        rule = RATE.get(request.url.path)
        if rule is None:
            return await call_next(request)

        limit, window = rule
        # Modal terminates TLS upstream, so the real client is forwarded.
        fwd = request.headers.get("x-forwarded-for", "")
        client = fwd.split(",")[0].strip() or (request.client.host if request.client else "unknown")
        key = (client, request.url.path)

        now = time.time()
        hits = [t for t in _hits.get(key, []) if now - t < window]
        if len(hits) >= limit:
            retry = int(window - (now - hits[0])) + 1
            return JSONResponse(
                {"error": "rate limited", "retryAfter": retry},
                status_code=429,
                headers={"Retry-After": str(retry)},
            )
        hits.append(now)
        _hits[key] = hits
        return await call_next(request)

    @web.get("/api/health")
    def health():
        return {
            "ok": True,
            "model": ASR_MODEL,
            "textModel": TEXT_MODEL,
            "provider": "modal",
            # Served from Modal: there is no local model behind this page, so
            # the UI must not offer "This Mac".
            "providers": {"ollama": False, "modal": True},
            "languages": [
                {"code": c, "label": v["name"], "native": v["name"]}
                for c, v in LANGUAGES.items()
            ],
        }

    # ---- desktop releases ---------------------------------------------
    #
    # The web build is the natural place to hand out the desktop build: people
    # arrive here first and are told to try it, and the app is the version that
    # runs without a server at all.
    #
    # One extension per platform, discovered by listing the volume rather than
    # by a manifest: pushing a file is the whole publish step, and there is no
    # second thing to forget to update.

    RELEASE_KINDS = {
        "mac": {
            "ext": ".dmg",
            "media_type": "application/x-apple-diskimage",
            "platform": "macOS 14+, Apple Silicon (arm64)",
            "label": "Mac",
        },
        "win": {
            "ext": ".exe",
            "media_type": "application/vnd.microsoft.portable-executable",
            "platform": "Windows 10 and 11, 64-bit",
            "label": "Windows",
        },
        # Unpacked equivalent of the installer, zipped. Nothing to run: unzip
        # and double-click Parley.exe.
        #
        # It exists for two situations the installer cannot serve. Where a
        # corporate policy forbids running unsigned setup binaries, and where
        # antivirus refuses an installer specifically — a flag on a 165 MB NSIS
        # self-extractor says little about the application inside it. Having
        # both lets someone separate "the installer is blocked" from "the app is
        # blocked", which are different problems with different fixes.
        "win-portable": {
            "ext": ".zip",
            "media_type": "application/zip",
            "platform": "Windows 10 and 11, 64-bit (portable, no install)",
            "label": "Windows portable",
        },
    }

    def _latest_release(kind: str = "mac"):
        """Newest installer of one kind in the mounted volume, or None."""
        import os
        import re

        spec = RELEASE_KINDS.get(kind)
        if spec is None:
            return None

        try:
            names = [n for n in os.listdir("/releases") if n.endswith(spec["ext"])]
        except OSError:
            return None

        def version(name):
            m = re.search(r"(\d+)\.(\d+)\.(\d+)", name)
            return tuple(int(x) for x in m.groups()) if m else (0, 0, 0)

        if not names:
            return None
        names.sort(key=version, reverse=True)
        name = names[0]
        path = f"/releases/{name}"
        try:
            size = os.path.getsize(path)
        except OSError:
            return None
        m = re.search(r"(\d+\.\d+\.\d+)", name)
        return {
            "name": name,
            "path": path,
            "bytes": size,
            "version": m.group(1) if m else "unknown",
            "kind": kind,
            "platform": spec["platform"],
            "label": spec["label"],
            "url": f"/api/download/app/{kind}",
        }

    @web.get("/api/download")
    def download_info():
        """What the UI needs to render the buttons, without sending the files."""
        releases = []
        for kind in RELEASE_KINDS:
            rel = _latest_release(kind)
            if rel:
                releases.append({
                    "kind": rel["kind"],
                    "label": rel["label"],
                    "platform": rel["platform"],
                    "version": rel["version"],
                    "bytes": rel["bytes"],
                    "filename": rel["name"],
                    "url": rel["url"],
                })

        if not releases:
            return {"available": False, "downloads": []}

        # `downloads` is the real shape. The flat keys stay for the old single
        # -button UI, which reads available/url/filename/bytes/platform — a
        # cached page must keep working against a redeployed backend.
        mac = next((r for r in releases if r["kind"] == "mac"), releases[0])
        return {
            "available": True,
            "downloads": releases,
            "version": mac["version"],
            "bytes": mac["bytes"],
            "filename": mac["filename"],
            "url": mac["url"],
            "platform": mac["platform"],
        }

    def _stream_release(kind: str):
        """Stream one platform's installer, or a 404 explaining the gap."""
        rel = _latest_release(kind)
        if not rel:
            return JSONResponse(
                {"error": f"no {kind} release has been published yet"},
                status_code=404,
            )
        # FileResponse, not read-into-memory: these are 141-158 MB files, and
        # Starlette streams them in chunks with a Content-Length so the browser
        # shows real progress and can resume. `filename=` sets the
        # Content-Disposition the browser needs to save it under its own name.
        return FileResponse(
            rel["path"],
            media_type=RELEASE_KINDS[kind]["media_type"],
            filename=rel["name"],
        )

    @web.get("/api/download/app")
    def download_app():
        """Legacy route: the macOS installer under its original URL."""
        return _stream_release("mac")

    @web.get("/api/download/app/{kind}")
    def download_app_kind(kind: str):
        """Stream a specific platform's installer."""
        if kind not in RELEASE_KINDS:
            return JSONResponse(
                {"error": f"unknown platform '{kind}'",
                 "known": sorted(RELEASE_KINDS)},
                status_code=404,
            )
        return _stream_release(kind)

    @web.post("/api/translate")
    async def translate(request: Request):
        t0 = time.time()
        body = await request.json()
        hint = body.get("source") or "auto"
        rt = get_runtime()

        if body.get("text"):
            transcript = str(body["text"]).strip()
            asr_ms = 0
        else:
            raw = body.get("audio") or ""
            if "," in raw:
                raw = raw.split(",", 1)[1]
            t_asr = time.time()
            try:
                transcript = rt.asr(base64.b64decode(raw), hint)
            except RuntimeError as exc:
                # Undecodable audio is the client's fault, not a server crash.
                return JSONResponse({"error": str(exc)[:300]}, status_code=400)
            asr_ms = int((time.time() - t_asr) * 1000)

        src = detect_source(transcript, hint)
        # Target is selectable; Korean remains the default.
        tgt = body.get("target") if body.get("target") in LANGUAGES else "ko"

        if src == tgt:
            return {
                "transcript": transcript,
                "translation": transcript,
                "sourceLang": src,
                "targetLang": tgt,
                "mode": "none",
                "trace": {"attempts": [], "provider": "modal",
                          "notice": f"input was already {LANGUAGES[tgt]['name']}, "
                                    "so nothing was translated"},
                "timings": {"asrMs": asr_ms, "translateMs": 0,
                            "totalMs": int((time.time() - t0) * 1000)},
                "provider": "modal",
            }

        t_tr = time.time()
        translation, mode, trace = rt.translate(transcript, src, tgt)
        return {
            "transcript": transcript,
            "translation": translation,
            "sourceLang": src,
            "targetLang": tgt,
            "mode": mode,
            "trace": trace,
            "timings": {"asrMs": asr_ms,
                        "translateMs": int((time.time() - t_tr) * 1000),
                        "totalMs": int((time.time() - t0) * 1000)},
            "provider": "modal",
        }

    @web.post("/api/transcribe")
    async def transcribe(request: Request):
        """Speech to text only — the interim-caption feed.

        The browser polls this while the user is still talking, so it must be
        cheap and must never fail loudly: a half-written webm is normal input
        here, not an error.

        Rate limit is deliberately looser than /api/translate. One utterance
        produces a poll every ~1.2s, so a 30-per-minute ceiling would throttle
        the caption almost immediately and the feature would look broken on the
        web build while working locally. 90/min leaves room for a few speakers
        behind one IP without unbounding the bill.
        """
        body = await request.json()
        hint = body.get("source") or "auto"
        raw = body.get("audio") or ""
        if not raw:
            return JSONResponse({"error": "missing audio"}, status_code=400)
        if "," in raw:
            raw = raw.split(",", 1)[1]

        rt = get_runtime()
        t0 = time.time()
        try:
            transcript = rt.asr(base64.b64decode(raw), hint)
        except Exception as exc:                      # noqa: BLE001
            # Partial audio frequently fails to decode. Answering 200 with an
            # empty line keeps the caller's previous caption on screen instead
            # of surfacing an error for something that is expected.
            return {"transcript": "", "ms": int((time.time() - t0) * 1000),
                    "error": str(exc)[:200]}

        return {"transcript": transcript or "",
                "ms": int((time.time() - t0) * 1000)}

    @web.post("/api/tts")
    async def tts(request: Request):
        body = await request.json()
        text = str(body.get("text", "")).strip()
        if not text:
            return JSONResponse({"error": "empty text"}, status_code=400)
        rt = get_runtime()
        data = rt.tts(text, body.get("lang", "ko"), body.get("gender", "female"))
        return Response(content=data, media_type="audio/wav",
                        headers={"Cache-Control": "no-store"})

    # Mounted after the API routes so /api/* keeps precedence.
    if Path("/root/public/index.html").is_file():
        from fastapi.staticfiles import StaticFiles
        web.mount("/", StaticFiles(directory="/root/public", html=True), name="static")

    return web
