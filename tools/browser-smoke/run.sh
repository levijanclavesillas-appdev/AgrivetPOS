#!/bin/bash
# The renderer, in a real browser, driven the way a cashier drives it.
#
# 07_TEST_PLAN.md §8 puts layout and focus in UAT because they need a machine with a
# screen. This is the part of that which can be automated: Chromium renders the real
# public/ against a real API on a throwaway database, and a cashier's whole first sale
# is played through it — sign in, open the shift, scan, park, resume, pay, receipt.
#
#   ./tools/browser-smoke/run.sh
#
# Not part of `npm test`. It needs Electron's Chromium and a display, neither of which
# the release gate may have, and a gate that silently skips a level is worse than one
# that does not claim it (07_TEST_PLAN.md §1). On a headless Linux box, xvfb-run
# supplies the display; on the store PC there is a real one.

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
cd "$ROOT"

ELECTRON="$ROOT/node_modules/electron/dist/electron"
[ -x "$ELECTRON" ] || { echo "Electron is not installed — run npm install first."; exit 2; }

LOG="$(mktemp)"
node "$HERE/server.js" > "$LOG" 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT

for _ in $(seq 1 60); do
  grep -q '^READY ' "$LOG" && break
  sleep 0.5
done
if ! grep -q '^READY ' "$LOG"; then
  echo "the API never came up:"; cat "$LOG"; exit 2
fi

READY=$(sed -n 's/^READY //p' "$LOG")
field() { node -e "console.log(JSON.parse(process.argv[1])[process.argv[2]])" "$READY" "$1"; }
TOKEN=$(field token)
PRODUCT=$(field productId)
CUSTOMER=$(field customerId)
SUPPLIER=$(field supplierId)

# A display if there is none. --no-sandbox is for a container running as root; it is a
# test harness on a throwaway database and never how the product is launched.
LAUNCH=("$ELECTRON" --no-sandbox "$HERE/main.js")
command -v xvfb-run >/dev/null && [ -z "${DISPLAY:-}" ] && LAUNCH=(xvfb-run -a "${LAUNCH[@]}")

UI_TOKEN="$TOKEN" UI_PRODUCT="$PRODUCT" UI_CUSTOMER="$CUSTOMER" UI_SUPPLIER="$SUPPLIER" "${LAUNCH[@]}" 2>&1 \
  | grep -vE "GPU|Fontconfig|dbus|libva|Vulkan|gbm|DevTools|MESA|glx|sandbox|Passthrough|EGL"
STATUS=${PIPESTATUS[0]}
exit "$STATUS"
