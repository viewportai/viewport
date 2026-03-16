#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

WITH_SERVICE=0
KEEP_SERVICE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service)
      WITH_SERVICE=1
      shift
      ;;
    --keep-service)
      KEEP_SERVICE=1
      shift
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: scripts/test-env.sh [--service] [--keep-service]"
      exit 1
      ;;
  esac
done

if ! command -v vpd >/dev/null 2>&1; then
  echo "Error: vpd is not installed on PATH."
  echo "Run: ./scripts/install-dev.sh --yes --no-service --no-prereqs --no-hooks"
  exit 1
fi

json_get() {
  local input="$1"
  local expr="$2"
  node -e "const data=JSON.parse(process.argv[1]); const out=($expr); if(out===undefined){process.exit(2)}; if(typeof out==='object') console.log(JSON.stringify(out)); else console.log(String(out));" "$input"
}

assert_json_expr() {
  local input="$1"
  local expr="$2"
  local message="$3"
  node -e "const data=JSON.parse(process.argv[1]); if(!($expr)){console.error(process.argv[2]); process.exit(1)}" "$input" "$message"
}

ORIG_VIEWPORT_HOME="${VIEWPORT_HOME-}"
ORIG_VPD_HOME="${VPD_HOME-}"
CREATED_HOME=0

if [[ -z "${VIEWPORT_HOME-}" && -z "${VPD_HOME-}" ]]; then
  export VIEWPORT_HOME="$(mktemp -d)"
  CREATED_HOME=1
fi

SMOKE_PORT="$(node -e "const net=require('node:net'); const s=net.createServer(); s.listen(0, '127.0.0.1', () => { const addr=s.address(); if (!addr || typeof addr === 'string') process.exit(1); console.log(addr.port); s.close(); });")"
LISTEN_TARGET="127.0.0.1:${SMOKE_PORT}"

cleanup_basic() {
  vpd stop --force --json >/dev/null 2>&1 || true
  if [[ "$CREATED_HOME" -eq 1 && -n "${VIEWPORT_HOME-}" ]]; then
    rm -rf "$VIEWPORT_HOME"
  fi
}

trap cleanup_basic EXIT

echo "[verify-env] Using VIEWPORT_HOME=${VIEWPORT_HOME:-${VPD_HOME:-$HOME/.viewport}}"
echo "[verify-env] Ensuring clean daemon state..."
vpd stop --force --json >/dev/null 2>&1 || true

echo "[verify-env] Running setup (no service/prereqs/hooks)..."
vpd setup --yes --no-service --no-prereqs --no-hooks >/dev/null

echo "[verify-env] Starting daemon on isolated TCP listen target: $LISTEN_TARGET"
START_JSON="$(vpd start --json --listen "$LISTEN_TARGET")"
assert_json_expr "$START_JSON" "data.ok === true" "start failed"

echo "[verify-env] Checking daemon status..."
STATUS_JSON=""
for _ in $(seq 1 30); do
  STATUS_JSON="$(vpd status --json --listen "$LISTEN_TARGET" || true)"
  if [[ -n "$STATUS_JSON" ]] && node -e "const data=JSON.parse(process.argv[1]); process.exit(data.status === 'running' ? 0 : 1)" "$STATUS_JSON" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
assert_json_expr "$STATUS_JSON" "data.status === 'running'" "daemon is not running"

LISTEN_VALUE="$(json_get "$STATUS_JSON" "data.listen")"
echo "[verify-env] Running at listen target: $LISTEN_VALUE"

echo "[verify-env] Stopping daemon..."
if ! vpd stop --json >/dev/null 2>&1; then
  vpd stop --force --json >/dev/null
fi

POST_STOP_JSON=""
for _ in $(seq 1 20); do
  POST_STOP_JSON="$(vpd status --json --listen "$LISTEN_TARGET" || true)"
  if [[ -n "$POST_STOP_JSON" ]] && node -e "const data=JSON.parse(process.argv[1]); process.exit(data.status === 'running' ? 1 : 0)" "$POST_STOP_JSON" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
if [[ -n "$POST_STOP_JSON" ]]; then
  assert_json_expr "$POST_STOP_JSON" "data.status !== 'running'" "daemon still running after stop"
fi

echo "[verify-env] Basic daemon lifecycle checks passed."

if [[ "$WITH_SERVICE" -eq 1 ]]; then
  echo "[verify-env] Running service checks (this uses default home, not temp VIEWPORT_HOME)..."

  trap - EXIT
  cleanup_basic

  if [[ -n "$ORIG_VIEWPORT_HOME" ]]; then export VIEWPORT_HOME="$ORIG_VIEWPORT_HOME"; else unset VIEWPORT_HOME; fi
  if [[ -n "$ORIG_VPD_HOME" ]]; then export VPD_HOME="$ORIG_VPD_HOME"; else unset VPD_HOME; fi

  vpd stop --force --json >/dev/null 2>&1 || true
  vpd service uninstall --json >/dev/null 2>&1 || true
  vpd service install --json >/dev/null
  sleep 2

  SERVICE_STATUS_JSON="$(vpd service status --json)"
  assert_json_expr "$SERVICE_STATUS_JSON" "data.active === true" "service is not active"

  RUNTIME_STATUS_JSON="$(vpd status --json)"
  assert_json_expr "$RUNTIME_STATUS_JSON" "data.status === 'running'" "daemon is not running under service"

  if [[ "$(uname -s)" == "Darwin" ]]; then
    launchctl print "gui/$(id -u)/ai.viewport.daemon" | grep -E "state = running|pid =|last exit code" >/dev/null || {
      echo "launchctl output did not include expected running markers"
      exit 1
    }
  fi

  if [[ "$KEEP_SERVICE" -eq 0 ]]; then
    vpd service uninstall --json >/dev/null || true
  fi

  echo "[verify-env] Service checks passed."
fi

echo "[verify-env] All requested checks passed."
