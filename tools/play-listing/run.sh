#!/bin/bash
# The Google Play listing's images, made again: ./tools/play-listing/run.sh
#
# A throwaway POS with an invented pharmacy (server.js), and Electron's Chromium capturing
# the real screens at phone size (main.js). Writes into android/play-listing/.
# Not part of `npm test`: it needs a display, which xvfb-run supplies on a server.

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${OUT_DIR:-$ROOT/android/play-listing}"
cd "$ROOT"

ELECTRON="$ROOT/node_modules/electron/dist/electron"
[ -x "$ELECTRON" ] || { echo "Electron is not installed — run npm install first."; exit 2; }
node --check "$HERE/main.js" || exit 2

LOG="$(mktemp)"
node "$HERE/server.js" > "$LOG" 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null; rm -f "$LOG"' EXIT
for _ in $(seq 1 120); do grep -q '^READY ' "$LOG" && break; sleep 0.5; done
grep -q '^READY ' "$LOG" || { echo "the demo POS never came up:"; cat "$LOG"; exit 2; }
READY=$(sed -n 's/^READY //p' "$LOG")
field() { node -e "console.log(JSON.parse(process.argv[1])[process.argv[2]])" "$READY" "$1"; }

# Roboto, as Android draws system-ui, for this process only (fonts.conf).
FONT_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/chachi-play-listing/fonts"
mkdir -p "$FONT_DIR"
[ -s "$FONT_DIR/Roboto.ttf" ] || curl -fsSL -o "$FONT_DIR/Roboto.ttf" \
  "https://github.com/google/fonts/raw/main/ofl/roboto/Roboto%5Bwdth,wght%5D.ttf" || { echo "could not fetch Roboto"; exit 2; }
sed "s#FONT_DIR#$FONT_DIR#g" "$HERE/fonts.conf" > "$FONT_DIR/fonts.conf"
export FONTCONFIG_FILE="$FONT_DIR/fonts.conf"

LAUNCH=("$ELECTRON" --no-sandbox "$HERE/main.js")
command -v xvfb-run >/dev/null && [ -z "${DISPLAY:-}" ] && LAUNCH=(xvfb-run -a -s "-screen 0 3840x2160x24" "${LAUNCH[@]}")

mkdir -p "$OUT"
UI_PORT="$(field port)" UI_USER="$(field user)" UI_PASSWORD="$(field password)" UI_CUSTOMER="$(field customerId)" \
OUT_DIR="$OUT" "${LAUNCH[@]}" 2>&1 \
  | grep --line-buffered -vE "GPU|Fontconfig|dbus|libva|Vulkan|gbm|DevTools|MESA|glx|sandbox|Passthrough|EGL"
exit "${PIPESTATUS[0]}"
