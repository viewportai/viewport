#!/usr/bin/env bash
set -euo pipefail

PKG="${VPD_NPM_PACKAGE:-@viewportai/daemon}"
REMOVE_SERVICE=0
PURGE_HOME=0

usage() {
  cat <<USAGE
Usage: scripts/uninstall.sh [--service] [--purge-home]

Options:
  --service      Uninstall launchd/systemd user service before removing package
  --purge-home   Remove daemon state directory (~/.viewport or VIEWPORT_HOME)
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service)
      REMOVE_SERVICE=1
      shift
      ;;
    --purge-home)
      PURGE_HOME=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

resolve_viewport_home() {
  if [[ -n "${VIEWPORT_HOME:-}" ]]; then
    echo "$VIEWPORT_HOME"
    return
  fi
  if [[ -n "${VPD_HOME:-}" ]]; then
    echo "$VPD_HOME"
    return
  fi
  echo "$HOME/.viewport"
}

echo "Viewport daemon uninstall"

if have_cmd vpd; then
  echo "Stopping daemon if running..."
  vpd stop --force --json >/dev/null 2>&1 || true

  if [[ "$REMOVE_SERVICE" -eq 1 ]]; then
    echo "Uninstalling service if present..."
    vpd service uninstall --json >/dev/null 2>&1 || true
  fi
fi

if have_cmd npm; then
  if npm ls -g --depth=0 "$PKG" >/dev/null 2>&1; then
    echo "Removing global package: $PKG"
    npm uninstall -g "$PKG"
  else
    echo "Global package not installed: $PKG"
  fi
else
  echo "npm not found; skipped global package uninstall."
fi

if [[ "$PURGE_HOME" -eq 1 ]]; then
  VP_HOME="$(resolve_viewport_home)"
  if [[ -d "$VP_HOME" ]]; then
    echo "Removing daemon home: $VP_HOME"
    rm -rf "$VP_HOME"
  else
    echo "Daemon home not found: $VP_HOME"
  fi
fi

echo "Done."
