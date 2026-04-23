#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELAY_DIR="$ROOT/services/relay"

load_env_file() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  set -a
  # shellcheck disable=SC1090
  source "$file"
  set +a
}

load_env_file "$ROOT/.env.local"
load_env_file "$ROOT/.env.relay.local"

detect_cert_dir() {
  local host="$1"
  local candidates=(
    "${RELAY_TLS_CERT_DIR:-}"
    "${VIEWPORT_TLS_CERT_DIR:-}"
    "$HOME/.viewport/relay-certs"
    "$HOME/.config/valet/Certificates"
    "$HOME/Library/Application Support/Herd/config/valet/Certificates"
  )
  local dir=""
  for dir in "${candidates[@]}"; do
    [[ -n "$dir" ]] || continue
    if [[ -f "$dir/$host.crt" && -f "$dir/$host.key" ]]; then
      printf '%s\n' "$dir"
      return 0
    fi
  done
  return 1
}

SERVER_URL="${SERVER_URL:-https://getviewport.test}"
RELAY_HOST="${RELAY_HOST:-127.0.0.1}"
RELAY_PORT="${RELAY_PORT:-7781}"
RELAY_MODE="${RELAY_MODE:-dev}"
RELAY_TLS_HOST="${RELAY_TLS_HOST:-getviewport.test}"
RELAY_BACKPLANE_MODE="${RELAY_BACKPLANE_MODE:-single}"
RELAY_ENABLE_ADMIN_HTTP="${RELAY_ENABLE_ADMIN_HTTP:-1}"
RELAY_ADMIN_TOKEN="${RELAY_ADMIN_TOKEN:-dev-relay-admin-token}"

if [[ -z "${RELAY_TLS:-}" ]]; then
  if RELAY_TLS_CERT_DIR="$(detect_cert_dir "$RELAY_TLS_HOST")"; then
    export RELAY_TLS_CERT_DIR
    RELAY_TLS="1"
  else
    RELAY_TLS="0"
  fi
fi

SCHEME="ws"
if [[ "$RELAY_TLS" == "1" ]]; then
  SCHEME="wss"
fi

RELAY_PUBLIC_WS_BASE_URL="${RELAY_PUBLIC_WS_BASE_URL:-${SCHEME}://${RELAY_TLS_HOST}:${RELAY_PORT}/ws}"

cd "$RELAY_DIR"
exec env \
  HOST="$RELAY_HOST" \
  PORT="$RELAY_PORT" \
  SERVER_URL="$SERVER_URL" \
  RELAY_MODE="$RELAY_MODE" \
  RELAY_TLS="$RELAY_TLS" \
  RELAY_TLS_HOST="$RELAY_TLS_HOST" \
  RELAY_TLS_CERT_DIR="${RELAY_TLS_CERT_DIR:-}" \
  RELAY_PUBLIC_WS_BASE_URL="$RELAY_PUBLIC_WS_BASE_URL" \
  RELAY_BACKPLANE_MODE="$RELAY_BACKPLANE_MODE" \
  RELAY_ENABLE_ADMIN_HTTP="$RELAY_ENABLE_ADMIN_HTTP" \
  RELAY_ADMIN_TOKEN="$RELAY_ADMIN_TOKEN" \
  npm run dev
