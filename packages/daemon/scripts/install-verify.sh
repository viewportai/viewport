#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Error: node and npm are required."
  exit 1
fi

TMP_PREFIX="$(mktemp -d)"
TMP_HOME="$(mktemp -d)"
TARBALL_PATH=""
TMP_NPM_CACHE=""
if [[ -z "${NPM_CONFIG_CACHE:-}" ]]; then
  TMP_NPM_CACHE="$(mktemp -d)"
  export NPM_CONFIG_CACHE="$TMP_NPM_CACHE"
  export npm_config_cache="$TMP_NPM_CACHE"
fi

cleanup() {
  if [[ -n "$TARBALL_PATH" ]]; then
    rm -f "$TARBALL_PATH"
  fi
  rm -rf "$TMP_PREFIX" "$TMP_HOME"
  if [[ -n "$TMP_NPM_CACHE" ]]; then
    rm -rf "$TMP_NPM_CACHE"
  fi
}
trap cleanup EXIT

echo "[install-verify] Building daemon..."
npm run build >/dev/null

echo "[install-verify] Creating local tarball..."
TARBALL="$(
  npm pack 2>/dev/null | tail -n1 | tr -d '\r'
)"
if [[ -z "$TARBALL" ]]; then
  echo "Error: npm pack did not return a tarball filename."
  exit 1
fi
TARBALL_PATH="$ROOT_DIR/$TARBALL"

echo "[install-verify] Installing tarball to isolated npm prefix..."
npm install -g --prefix "$TMP_PREFIX" "$TARBALL_PATH" >/dev/null

VPD_BIN="$TMP_PREFIX/bin/vpd"
if [[ ! -x "$VPD_BIN" ]]; then
  echo "Error: vpd binary not found at $VPD_BIN"
  exit 1
fi

PORT="$(node -e "const net=require('node:net'); const s=net.createServer(); s.listen(0, '127.0.0.1', () => { const addr=s.address(); if (!addr || typeof addr === 'string') process.exit(1); console.log(addr.port); s.close(); });")"
LISTEN="127.0.0.1:${PORT}"

export VIEWPORT_HOME="$TMP_HOME"

echo "[install-verify] Running setup..."
"$VPD_BIN" setup --yes --no-service --no-prereqs --no-hooks >/dev/null

echo "[install-verify] Starting daemon at $LISTEN..."
"$VPD_BIN" start --json --listen "$LISTEN" >/dev/null

STATUS_JSON="$("$VPD_BIN" status --json --listen "$LISTEN")"
node -e "const data=JSON.parse(process.argv[1]); if (data.status !== 'running') { console.error('daemon not running'); process.exit(1); }" "$STATUS_JSON"

echo "[install-verify] Stopping daemon..."
"$VPD_BIN" stop --force --json >/dev/null || true

echo "[install-verify] Passed."
