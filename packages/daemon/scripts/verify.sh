#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

RUN_FULLSTACK=0
RUN_ENV=0
RUN_SERVICE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fullstack)
      RUN_FULLSTACK=1
      shift
      ;;
    --env)
      RUN_ENV=1
      shift
      ;;
    --service)
      RUN_ENV=1
      RUN_SERVICE=1
      shift
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: scripts/verify.sh [--fullstack] [--env] [--service]"
      exit 1
      ;;
  esac
done

echo "[verify] Running repository quality gate..."
npm run check

echo "[verify] Running setup/service focused tests..."
npm run test:setup

if [[ "$RUN_FULLSTACK" -eq 1 ]]; then
  echo "[verify] Running fullstack network e2e..."
  npm run test:e2e:fullstack
fi

if [[ "$RUN_ENV" -eq 1 ]]; then
  echo "[verify] Running local environment verification checks..."
  if [[ "$RUN_SERVICE" -eq 1 ]]; then
    "$ROOT_DIR/scripts/test-env.sh" --service
  else
    "$ROOT_DIR/scripts/test-env.sh"
  fi
fi

echo "[verify] Done."
