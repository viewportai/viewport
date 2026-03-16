#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TMP_NPM_CACHE=""
if [[ -z "${NPM_CONFIG_CACHE:-}" ]]; then
  TMP_NPM_CACHE="$(mktemp -d)"
  export NPM_CONFIG_CACHE="$TMP_NPM_CACHE"
  export npm_config_cache="$TMP_NPM_CACHE"
fi

MODE="pack"
if [[ "${1:-}" == "--link" ]]; then
  MODE="link"
  shift
fi

if [[ "$MODE" == "link" ]]; then
  echo "[dev-install] Building daemon..."
  npm run build

  echo "[dev-install] Linking local package globally (force overwrite if needed)..."
  npm link --force

  if ! command -v vpd >/dev/null 2>&1; then
    echo "Error: 'vpd' not found on PATH after npm link."
    exit 1
  fi

  echo "[dev-install] Running setup with linked binary..."
  vpd setup "$@"
  exit 0
fi

echo "[dev-install] Building daemon..."
npm run build

echo "[dev-install] Packing local npm tarball..."
TARBALL="$(
  npm pack 2>/dev/null | tail -n1 | tr -d '\r'
)"
if [[ -z "$TARBALL" ]]; then
  echo "Error: npm pack did not return a tarball filename."
  exit 1
fi
TARBALL_PATH="$ROOT_DIR/$TARBALL"

cleanup() {
  rm -f "$TARBALL_PATH"
  if [[ -n "$TMP_NPM_CACHE" ]]; then
    rm -rf "$TMP_NPM_CACHE"
  fi
}
trap cleanup EXIT

echo "[dev-install] Installing from local tarball via install.sh..."
VPD_NPM_PACKAGE="$TARBALL_PATH" "$ROOT_DIR/scripts/install.sh" "$@"
