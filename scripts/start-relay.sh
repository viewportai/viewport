#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELAY_DIR="$ROOT/services/relay"

resolve_node() {
  if [[ -n "${NODE_BIN:-}" && -x "${NODE_BIN}" ]]; then
    printf '%s\n' "$NODE_BIN"
    return
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return
  fi
  if [[ -x "/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node" ]]; then
    printf '%s\n' "/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node"
    return
  fi
  echo "[start-relay] unable to resolve node binary" >&2
  exit 1
}

NODE_BIN="$(resolve_node)"
TSC_BIN="$ROOT/node_modules/typescript/bin/tsc"
if [[ ! -x "$TSC_BIN" ]]; then
  echo "[start-relay] missing TypeScript compiler at $TSC_BIN" >&2
  echo "[start-relay] run npm install in $ROOT first" >&2
  exit 1
fi

SERVER_URL="${SERVER_URL:-http://127.0.0.1:24780}"
RELAY_HOST="${RELAY_HOST:-127.0.0.1}"
RELAY_PORT="${RELAY_PORT:-7781}"
RELAY_TLS="${RELAY_TLS:-0}"
RELAY_TLS_HOST="${RELAY_TLS_HOST:-127.0.0.1}"
RELAY_BACKPLANE_MODE="${RELAY_BACKPLANE_MODE:-single}"
RELAY_ENABLE_ADMIN_HTTP="${RELAY_ENABLE_ADMIN_HTTP:-1}"
RELAY_ADMIN_TOKEN="${RELAY_ADMIN_TOKEN:-$("$NODE_BIN" -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))")}"
RELAY_PUBLIC_WS_BASE_URL="${RELAY_PUBLIC_WS_BASE_URL:-$([[ "$RELAY_TLS" == "1" ]] && echo "wss" || echo "ws")://$RELAY_TLS_HOST:$RELAY_PORT/ws}"
RELAY_ID="${RELAY_ID:-relay-local}"
RELAY_REDIS_URL="${RELAY_REDIS_URL:-}"
RELAY_REDIS_KEY_PREFIX="${RELAY_REDIS_KEY_PREFIX:-viewport:relay}"
RELAY_REDIS_PRESENCE_TTL_MS="${RELAY_REDIS_PRESENCE_TTL_MS:-45000}"
RELAY_REDIS_QUEUE_MAX="${RELAY_REDIS_QUEUE_MAX:-10000}"
RELAY_REDIS_CONNECT_TIMEOUT_MS="${RELAY_REDIS_CONNECT_TIMEOUT_MS:-5000}"
if [[ "$RELAY_BACKPLANE_MODE" == "single" ]]; then
  RELAY_BUS_ENABLED="${RELAY_BUS_ENABLED:-0}"
  RELAY_CLIENT_REDIRECT_ENABLED="${RELAY_CLIENT_REDIRECT_ENABLED:-0}"
else
  RELAY_BUS_ENABLED="${RELAY_BUS_ENABLED:-1}"
  RELAY_CLIENT_REDIRECT_ENABLED="${RELAY_CLIENT_REDIRECT_ENABLED:-1}"
fi
RELAY_BUS_POLL_INTERVAL_MS="${RELAY_BUS_POLL_INTERVAL_MS:-250}"
RELAY_BUS_PULL_LIMIT="${RELAY_BUS_PULL_LIMIT:-200}"
RELAY_BUS_PULL_WAIT_MS="${RELAY_BUS_PULL_WAIT_MS:-1000}"
RELAY_INTERNAL_KEY="${RELAY_INTERNAL_KEY:-}"
RELAY_BUS_HMAC_KEY="${RELAY_BUS_HMAC_KEY:-}"
VERBOSE=0
LOG_FILE="${RELAY_LOG_FILE:-}"

for arg in "$@"; do
  case "$arg" in
    --verbose) VERBOSE=1 ;;
    --log-file=*) LOG_FILE="${arg#*=}" ;;
    *)
      echo "[start-relay] unknown arg: $arg" >&2
      exit 1
      ;;
  esac
done

if [[ -n "$LOG_FILE" && "$LOG_FILE" == "~/"* ]]; then
  LOG_FILE="$HOME/${LOG_FILE:2}"
fi
if [[ -n "$LOG_FILE" ]]; then
  mkdir -p "$(dirname "$LOG_FILE")"
fi

if [[ "$RELAY_BACKPLANE_MODE" == "server" || "$RELAY_BACKPLANE_MODE" == "redis" ]]; then
  RELAY_INTERNAL_KEY="${RELAY_INTERNAL_KEY:-$("$NODE_BIN" -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))")}"
fi
if [[ "$RELAY_BUS_ENABLED" == "1" ]]; then
  RELAY_BUS_HMAC_KEY="${RELAY_BUS_HMAC_KEY:-$("$NODE_BIN" -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))")}"
fi

if [[ "$RELAY_BACKPLANE_MODE" == "redis" && -z "$RELAY_REDIS_URL" ]]; then
  echo "[start-relay] RELAY_REDIS_URL is required when RELAY_BACKPLANE_MODE=redis" >&2
  exit 1
fi

cd "$RELAY_DIR"
"$NODE_BIN" "$TSC_BIN" -p tsconfig.json >/dev/null

run_cmd=(env
  HOST="$RELAY_HOST"
  PORT="$RELAY_PORT"
  SERVER_URL="$SERVER_URL"
  RELAY_TLS="$RELAY_TLS"
  RELAY_TLS_HOST="$RELAY_TLS_HOST"
  RELAY_BACKPLANE_MODE="$RELAY_BACKPLANE_MODE"
  RELAY_ENABLE_ADMIN_HTTP="$RELAY_ENABLE_ADMIN_HTTP"
  RELAY_ADMIN_TOKEN="$RELAY_ADMIN_TOKEN"
  RELAY_INTERNAL_KEY="$RELAY_INTERNAL_KEY"
  RELAY_BUS_HMAC_KEY="$RELAY_BUS_HMAC_KEY"
  RELAY_REDIS_URL="$RELAY_REDIS_URL"
  RELAY_REDIS_KEY_PREFIX="$RELAY_REDIS_KEY_PREFIX"
  RELAY_REDIS_PRESENCE_TTL_MS="$RELAY_REDIS_PRESENCE_TTL_MS"
  RELAY_REDIS_QUEUE_MAX="$RELAY_REDIS_QUEUE_MAX"
  RELAY_REDIS_CONNECT_TIMEOUT_MS="$RELAY_REDIS_CONNECT_TIMEOUT_MS"
  RELAY_PUBLIC_WS_BASE_URL="$RELAY_PUBLIC_WS_BASE_URL"
  RELAY_ID="$RELAY_ID"
  RELAY_BUS_ENABLED="$RELAY_BUS_ENABLED"
  RELAY_BUS_POLL_INTERVAL_MS="$RELAY_BUS_POLL_INTERVAL_MS"
  RELAY_BUS_PULL_LIMIT="$RELAY_BUS_PULL_LIMIT"
  RELAY_BUS_PULL_WAIT_MS="$RELAY_BUS_PULL_WAIT_MS"
  RELAY_CLIENT_REDIRECT_ENABLED="$RELAY_CLIENT_REDIRECT_ENABLED"
  "$NODE_BIN" dist/index.js)

if [[ "$VERBOSE" == "1" ]]; then
  if [[ -n "$LOG_FILE" ]]; then
    exec "${run_cmd[@]}" 2>&1 | tee -a "$LOG_FILE"
  fi
  exec "${run_cmd[@]}"
fi

if [[ -n "$LOG_FILE" ]]; then
  exec "${run_cmd[@]}" >>"$LOG_FILE" 2>&1
fi
exec "${run_cmd[@]}"
