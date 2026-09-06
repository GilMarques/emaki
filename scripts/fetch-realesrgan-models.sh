#!/usr/bin/env bash
#
# Fetch and verify Real-ESRGAN ONNX weights for the Tauri desktop backend.
#
# The published ONNX uses external-data weights (a separate .data file). This
# script downloads the archive, INLINES the weights into a single self-contained
# .onnx (requires python 'onnx'), verifies its SHA-256 against the pinned value,
# and drops it into src-tauri/resources/models/.
#
# It refuses to proceed if a checksum is not pinned (prevents silent supply-chain
# swaps) and prints the ONNX input/output shapes so you can see whether the model
# needs fixed-size tiling.
#
# Usage:
#   scripts/fetch-realesrgan-models.sh                 # fetch + verify + inline
#   scripts/fetch-realesrgan-models.sh --only real_esrgan_x4plus
#   scripts/fetch-realesrgan-models.sh --compute       # print checksum + shapes to pin
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MANIFEST="$SCRIPT_DIR/models.manifest.json"
TARGET_DIR="$REPO_ROOT/src-tauri/resources/models"
MODE="fetch"
ONLY=""

usage() { echo "Usage: $0 [--compute] [--only <id>]"; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --compute) MODE="compute"; shift ;;
    --only)    ONLY="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown arg: $1" >&2; usage ;;
  esac
done

for bin in jq curl unzip; do
  command -v "$bin" >/dev/null 2>&1 || { echo "ERROR: '$bin' is required" >&2; exit 1; }
done

mkdir -p "$TARGET_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

inline() {  # $1 = source .onnx (next to its .data), $2 = output inlined .onnx
  if ! python3 -c "import onnx" >/dev/null 2>&1; then
    echo "ERROR: python 'onnx' is required to inline external weights (pip install onnx)" >&2
    exit 1
  fi
  python3 - "$1" "$2" <<'PY'
import sys, onnx
m = onnx.load(sys.argv[1])
onnx.save_model(m, sys.argv[2], save_as_external_data=False)
PY
}

count="$(jq '.models | length' "$MANIFEST")"
for i in $(seq 0 $((count - 1))); do
  id="$(jq -r ".models[$i].id" "$MANIFEST")"
  url="$(jq -r ".models[$i].url" "$MANIFEST")"
  file="$(jq -r ".models[$i].file" "$MANIFEST")"
  expected="$(jq -r ".models[$i].sha256" "$MANIFEST")"

  [[ -n "$ONLY" && "$ONLY" != "$id" ]] && continue

  echo "==> $id"

  if [[ "$expected" == "REPLACE_WITH_PINNED_CHECKSUM" || -z "$expected" ]]; then
    if [[ "$MODE" != "compute" ]]; then
      echo "ERROR: sha256 not pinned for '$id'. Run with --compute to print it, then paste into the manifest." >&2
      exit 1
    fi
  fi

  zip="$TMP/$id.zip"
  echo "    downloading $url"
  curl -fL --retry 3 -o "$zip" "$url"

  ext="$TMP/ext"
  rm -rf "$ext"; mkdir -p "$ext"
  unzip -o -q "$zip" -d "$ext"

  onnx_src="$(cd "$ext" && find . -type f -name '*.onnx' | head -n1)"
  if [[ -z "$onnx_src" ]]; then
    echo "ERROR: no .onnx found in archive for '$id'" >&2
    exit 1
  fi

  model_file="$TMP/$file"
  inline "$ext/$onnx_src" "$model_file"

  actual="$(sha256sum "$model_file" | awk '{print $1}')"

  if [[ "$MODE" == "compute" ]]; then
    echo "    sha256($file) = $actual"
    if python3 -c "import onnx" >/dev/null 2>&1; then
      echo "    shapes:"
      python3 - "$model_file" <<'PY'
import sys, onnx
m = onnx.load(sys.argv[1])
def shape(t): return [d.dim_value if d.dim_value > 0 else d.dim_param for d in t.type.tensor_type.shape.dim]
for t in list(m.graph.input) + list(m.graph.output):
    print(f"      {t.name}: {shape(t)}")
PY
    fi
    continue
  fi

  if [[ "$actual" != "$expected" ]]; then
    echo "ERROR: checksum mismatch for '$id'" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    exit 1
  fi

  cp "$model_file" "$TARGET_DIR/$file"
  echo "    OK -> $TARGET_DIR/$file"

  if python3 -c "import onnx" >/dev/null 2>&1; then
    echo "    ONNX shapes:"
    python3 - "$TARGET_DIR/$file" <<'PY'
import sys, onnx
m = onnx.load(sys.argv[1])
def shape(t): return [d.dim_value if d.dim_value > 0 else d.dim_param for d in t.type.tensor_type.shape.dim]
for t in list(m.graph.input) + list(m.graph.output):
    print(f"      {t.name}: {shape(t)}")
PY
  else
    echo "    (install python 'onnx' to auto-check input shape)"
  fi
done

echo "done."
