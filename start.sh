#!/usr/bin/env bash
# ===========================================================================
#  TONGTOU 4K launcher (macOS / Linux)
#
#  A browser refuses to run the game from a file:// path (it blocks ES modules
#  on a null origin), so this starts a small local server and opens the page.
# ===========================================================================
set -euo pipefail
cd "$(dirname "$0")"

PORT="${1:-8080}"
URL="http://127.0.0.1:${PORT}/"

open_url() {
  if command -v open >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
  else echo "  请手动打开 $URL"
  fi
}

if command -v node >/dev/null 2>&1; then
  echo "  Node.js found — starting serve.mjs"
  ( sleep 1; open_url ) &
  exec node serve.mjs "$PORT"
fi

for PY in python3 python; do
  if command -v "$PY" >/dev/null 2>&1; then
    echo "  Node.js not found — using $PY"
    ( sleep 1; open_url ) &
    exec "$PY" -m http.server "$PORT"
  fi
done

echo "  Neither Node.js nor Python was found."
echo "  Install one, or serve this folder with any static web server, e.g.:"
echo "      node serve.mjs"
echo "      python3 -m http.server ${PORT}"
exit 1
