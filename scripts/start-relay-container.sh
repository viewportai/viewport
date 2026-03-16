#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELAY_DIR="$ROOT/services/relay"
IMAGE_TAG="${RELAY_IMAGE_TAG:-viewport-relay:local}"
CONTAINER_NAME="${RELAY_CONTAINER_NAME:-viewport-relay-local}"
HERD_CERT_DIR="${HERD_CERT_DIR:-$HOME/Library/Application Support/Herd/config/valet/Certificates}"
CONTAINER_NETWORK="${CONTAINER_NETWORK:-viewport-dev}"
REDIS_IMAGE_TAG="${REDIS_IMAGE_TAG:-docker.io/library/redis:7-alpine}"
REDIS_CONTAINER_NAME="${REDIS_CONTAINER_NAME:-viewport-redis-local}"

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
  echo "[start-relay-container] unable to resolve node binary" >&2
  exit 1
}

NODE_BIN="$(resolve_node)"

SERVER_URL="${SERVER_URL:-http://host.lima.internal:24780}"
RELAY_PORT="${RELAY_PORT:-7781}"
RELAY_BACKPLANE_MODE="${RELAY_BACKPLANE_MODE:-single}"
RELAY_TLS="${RELAY_TLS:-0}"
RELAY_TLS_HOST="${RELAY_TLS_HOST:-127.0.0.1}"
RELAY_ENABLE_ADMIN_HTTP="${RELAY_ENABLE_ADMIN_HTTP:-1}"
RELAY_ADMIN_TOKEN="${RELAY_ADMIN_TOKEN:-$($NODE_BIN -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))")}"
RELAY_ID="${RELAY_ID:-relay-local-container}"
RELAY_REDIS_URL="${RELAY_REDIS_URL:-}"
RELAY_REDIS_KEY_PREFIX="${RELAY_REDIS_KEY_PREFIX:-viewport:relay}"
RELAY_REDIS_PRESENCE_TTL_MS="${RELAY_REDIS_PRESENCE_TTL_MS:-45000}"
RELAY_REDIS_QUEUE_MAX="${RELAY_REDIS_QUEUE_MAX:-10000}"
RELAY_REDIS_CONNECT_TIMEOUT_MS="${RELAY_REDIS_CONNECT_TIMEOUT_MS:-5000}"
REBUILD=0
AUTO_REDIS=0
VERBOSE=0
LOG_FILE="${RELAY_LOG_FILE:-}"

for arg in "$@"; do
  case "$arg" in
    --rebuild) REBUILD=1 ;;
    --verbose) VERBOSE=1 ;;
    --log-file=*) LOG_FILE="${arg#*=}" ;;
    *)
      echo "[start-relay-container] unknown arg: $arg" >&2
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

if [[ "$RELAY_BACKPLANE_MODE" == "single" ]]; then
  RELAY_BUS_ENABLED="${RELAY_BUS_ENABLED:-0}"
  RELAY_CLIENT_REDIRECT_ENABLED="${RELAY_CLIENT_REDIRECT_ENABLED:-0}"
else
  RELAY_BUS_ENABLED="${RELAY_BUS_ENABLED:-1}"
  RELAY_CLIENT_REDIRECT_ENABLED="${RELAY_CLIENT_REDIRECT_ENABLED:-1}"
fi

RELAY_INTERNAL_KEY="${RELAY_INTERNAL_KEY:-}"
RELAY_BUS_HMAC_KEY="${RELAY_BUS_HMAC_KEY:-}"
if [[ "$RELAY_BACKPLANE_MODE" == "server" || "$RELAY_BACKPLANE_MODE" == "redis" ]]; then
  RELAY_INTERNAL_KEY="${RELAY_INTERNAL_KEY:-$($NODE_BIN -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))")}"
fi
if [[ "$RELAY_BUS_ENABLED" == "1" ]]; then
  RELAY_BUS_HMAC_KEY="${RELAY_BUS_HMAC_KEY:-$($NODE_BIN -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))")}"
fi

RELAY_TLS_CERT_PATH="${RELAY_TLS_CERT_PATH:-$HERD_CERT_DIR/${RELAY_TLS_HOST}.crt}"
RELAY_TLS_KEY_PATH="${RELAY_TLS_KEY_PATH:-$HERD_CERT_DIR/${RELAY_TLS_HOST}.key}"

if ! command -v colima >/dev/null 2>&1; then
  echo "[start-relay-container] colima is required" >&2
  exit 1
fi
if ! colima status >/dev/null 2>&1; then
  colima start --runtime containerd >/dev/null
fi
if [[ "$REBUILD" == "1" ]] || ! colima nerdctl -- image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
  colima nerdctl -- build -t "$IMAGE_TAG" "$RELAY_DIR" >/dev/null
fi

if [[ "$RELAY_BACKPLANE_MODE" == "redis" ]]; then
  if ! colima nerdctl -- network inspect "$CONTAINER_NETWORK" >/dev/null 2>&1; then
    colima nerdctl -- network create "$CONTAINER_NETWORK" >/dev/null
  fi
  if [[ -z "$RELAY_REDIS_URL" ]]; then
    AUTO_REDIS=1
    RELAY_REDIS_URL="redis://${REDIS_CONTAINER_NAME}:6379"
    colima nerdctl -- rm -f "$REDIS_CONTAINER_NAME" >/dev/null 2>&1 || true
    colima nerdctl -- run -d --name "$REDIS_CONTAINER_NAME" --network "$CONTAINER_NETWORK" "$REDIS_IMAGE_TAG" redis-server --save '' --appendonly no >/dev/null
  fi
fi

colima nerdctl -- rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
RELAY_PUBLIC_WS_BASE_URL="${RELAY_PUBLIC_WS_BASE_URL:-$([[ "$RELAY_TLS" == "1" ]] && echo "wss" || echo "ws")://$RELAY_TLS_HOST:$RELAY_PORT/ws}"
RUN_ARGS=(
  --add-host host.docker.internal:host-gateway
  -p "127.0.0.1:${RELAY_PORT}:7781"
  -e HOST=0.0.0.0
  -e PORT=7781
  -e SERVER_URL="$SERVER_URL"
  -e RELAY_TLS="$RELAY_TLS"
  -e RELAY_TLS_HOST="$RELAY_TLS_HOST"
  -e RELAY_BACKPLANE_MODE="$RELAY_BACKPLANE_MODE"
  -e RELAY_ENABLE_ADMIN_HTTP="$RELAY_ENABLE_ADMIN_HTTP"
  -e RELAY_ADMIN_TOKEN="$RELAY_ADMIN_TOKEN"
  -e RELAY_INTERNAL_KEY="$RELAY_INTERNAL_KEY"
  -e RELAY_BUS_HMAC_KEY="$RELAY_BUS_HMAC_KEY"
  -e RELAY_REDIS_URL="$RELAY_REDIS_URL"
  -e RELAY_REDIS_KEY_PREFIX="$RELAY_REDIS_KEY_PREFIX"
  -e RELAY_REDIS_PRESENCE_TTL_MS="$RELAY_REDIS_PRESENCE_TTL_MS"
  -e RELAY_REDIS_QUEUE_MAX="$RELAY_REDIS_QUEUE_MAX"
  -e RELAY_REDIS_CONNECT_TIMEOUT_MS="$RELAY_REDIS_CONNECT_TIMEOUT_MS"
  -e RELAY_PUBLIC_WS_BASE_URL="$RELAY_PUBLIC_WS_BASE_URL"
  -e RELAY_ID="$RELAY_ID"
  -e RELAY_BUS_ENABLED="$RELAY_BUS_ENABLED"
  -e RELAY_CLIENT_REDIRECT_ENABLED="$RELAY_CLIENT_REDIRECT_ENABLED"
)
if [[ "$RELAY_BACKPLANE_MODE" == "redis" ]]; then
  RUN_ARGS+=(--network "$CONTAINER_NETWORK")
fi
if [[ "$RELAY_TLS" == "1" ]]; then
  RUN_ARGS+=(
    -v "$RELAY_TLS_CERT_PATH:/certs/relay.crt:ro"
    -v "$RELAY_TLS_KEY_PATH:/certs/relay.key:ro"
    -e RELAY_TLS_CERT_PATH=/certs/relay.crt
    -e RELAY_TLS_KEY_PATH=/certs/relay.key
  )
fi

cleanup() {
  if [[ "$AUTO_REDIS" == "1" ]]; then
    colima nerdctl -- rm -f "$REDIS_CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

if [[ "$VERBOSE" == "1" ]]; then
  colima nerdctl -- run --rm --name "$CONTAINER_NAME" "${RUN_ARGS[@]}" "$IMAGE_TAG" 2>&1 | if [[ -n "$LOG_FILE" ]]; then tee -a "$LOG_FILE"; else cat; fi
else
  if [[ -n "$LOG_FILE" ]]; then
    exec colima nerdctl -- run --rm --name "$CONTAINER_NAME" "${RUN_ARGS[@]}" "$IMAGE_TAG" >>"$LOG_FILE" 2>&1
  fi
  exec colima nerdctl -- run --rm --name "$CONTAINER_NAME" "${RUN_ARGS[@]}" "$IMAGE_TAG"
fi
