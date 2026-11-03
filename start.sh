#!/bin/sh
# Start the LFM3 live translator. Ctrl-C to stop.
set -e
cd "$(dirname "$0")"

# Local Ollama must not be routed through a proxy.
export NO_PROXY="127.0.0.1,localhost"
export no_proxy="$NO_PROXY"

command -v ffmpeg >/dev/null 2>&1 || { echo "ffmpeg is required (brew install ffmpeg)"; exit 1; }

if ! curl -s --noproxy '*' --max-time 2 http://127.0.0.1:11434/api/tags >/dev/null; then
  echo "Ollama is not responding on 127.0.0.1:11434 — start the Ollama app first."
  exit 1
fi

# Already running? Say so instead of crashing on the busy port.
if curl -s --noproxy '*' --max-time 2 "http://127.0.0.1:${PORT:-8791}/api/health" >/dev/null; then
  echo "Already running at http://127.0.0.1:${PORT:-8791} — opening that instead of starting a second copy."
  exit 0
fi

exec node server.mjs
