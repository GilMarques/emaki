#!/usr/bin/env bash
# Pull Emaki's debug log off a connected Android device.
#
# Usage: npm run logs:pull -- [output-file]
#   output-file      where to write, default emaki.log
#   EMAKI_APP_ID     override the app id (default io.ionic.starter)
#
# Requires a debuggable build and adb; run-as reads the app-private data dir
# without root. Rotated lines are written first, then the current file.

set -euo pipefail

APP_ID="${EMAKI_APP_ID:-io.ionic.starter}"
OUT="${1:-emaki.log}"

if ! adb get-state >/dev/null 2>&1; then
  echo "No Android device connected (adb get-state failed)." >&2
  exit 1
fi

if ! adb shell run-as "$APP_ID" true >/dev/null 2>&1; then
  echo "Cannot read $APP_ID with run-as." >&2
  echo "Is the app installed as a debug build?" >&2
  exit 1
fi

{
  adb exec-out run-as "$APP_ID" cat files/emaki-logs/emaki.log.1 2>/dev/null | grep '^{' || true
  adb exec-out run-as "$APP_ID" cat files/emaki-logs/emaki.log 2>/dev/null | grep '^{' || true
} >"$OUT"

LINES="$(grep -c '^{' "$OUT" || true)"
if [ "$LINES" = "0" ]; then
  echo "No log lines found under files/emaki-logs/ for $APP_ID." >&2
  echo "Has the app logged anything yet?" >&2
  rm -f "$OUT"
  exit 1
fi

echo "Wrote $LINES lines to $OUT"
