#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[linux-ci] Verifying package install flow..."
npm run verify:install

echo "[linux-ci] Installing dev build globally..."
npm run dev:install

echo "[linux-ci] Running isolated daemon lifecycle verification..."
npm run verify:env

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  echo "[linux-ci] Running systemd user-service verification..."
  npm run verify:env:service
else
  echo "[linux-ci] Skipping systemd user-service verification: systemctl --user unavailable on runner."
fi

echo "[linux-ci] Cleaning up install..."
npm run dev:uninstall || true

echo "[linux-ci] Done."
