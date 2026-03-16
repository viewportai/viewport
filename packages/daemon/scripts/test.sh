#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

is_true() {
  local value="${1:-}"
  [[ "$value" == "true" || "$value" == "1" || "$value" == "yes" ]]
}

RUN_VERIFY=0
RUN_E2E=0
RUN_FULLSTACK=0
RUN_ENV=0
RUN_SERVICE=0
RUN_REPO=0

if is_true "${npm_config_verify:-}"; then RUN_VERIFY=1; fi
if is_true "${npm_config_e2e:-}"; then RUN_E2E=1; fi
if is_true "${npm_config_fullstack:-}"; then RUN_FULLSTACK=1; fi
if is_true "${npm_config_env:-}"; then RUN_ENV=1; fi
if is_true "${npm_config_service:-}"; then RUN_SERVICE=1; RUN_ENV=1; fi
if is_true "${npm_config_repo:-}"; then RUN_REPO=1; fi

PASSTHROUGH=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --verify)
      RUN_VERIFY=1
      shift
      ;;
    --e2e)
      RUN_E2E=1
      shift
      ;;
    --fullstack)
      RUN_FULLSTACK=1
      shift
      ;;
    --env)
      RUN_ENV=1
      shift
      ;;
    --service)
      RUN_SERVICE=1
      RUN_ENV=1
      shift
      ;;
    --repo)
      RUN_REPO=1
      shift
      ;;
    --)
      shift
      while [[ $# -gt 0 ]]; do
        PASSTHROUGH+=("$1")
        shift
      done
      ;;
    *)
      PASSTHROUGH+=("$1")
      shift
      ;;
  esac
done

ANY_MODE=$((RUN_VERIFY + RUN_E2E + RUN_FULLSTACK + RUN_ENV + RUN_SERVICE + RUN_REPO))
if [[ "$ANY_MODE" -eq 0 ]]; then
  if [[ "${#PASSTHROUGH[@]}" -gt 0 ]]; then
    npm run test:unit -- "${PASSTHROUGH[@]}"
  else
    npm run test:unit
  fi
  exit 0
fi

if [[ "${#PASSTHROUGH[@]}" -gt 0 ]]; then
  echo "[test] Ignoring positional arguments when mode flags are used: ${PASSTHROUGH[*]}" >&2
fi

if [[ "$RUN_VERIFY" -eq 1 ]]; then
  npm run test:setup
fi

if [[ "$RUN_E2E" -eq 1 ]]; then
  npm run test:e2e
fi

if [[ "$RUN_FULLSTACK" -eq 1 ]]; then
  npm run test:e2e:fullstack
fi

if [[ "$RUN_ENV" -eq 1 ]]; then
  if [[ "$RUN_SERVICE" -eq 1 ]]; then
    npm run verify:env:service
  else
    npm run verify:env
  fi
fi

if [[ "$RUN_REPO" -eq 1 ]]; then
  npm run verify:repo
fi
