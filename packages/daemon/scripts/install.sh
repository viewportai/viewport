#!/usr/bin/env bash
set -euo pipefail

PKG="${VPD_NPM_PACKAGE:-@viewportai/daemon}"

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

detect_platform() {
  case "$(uname -s)" in
    Darwin) echo "darwin" ;;
    Linux) echo "linux" ;;
    *) echo "other" ;;
  esac
}

version_ge() {
  # Compare dotted semver-ish versions: version_ge "20.1.0" "20.0.0"
  local a="${1#v}" b="${2#v}"
  local IFS=.
  local -a av=($a) bv=($b)
  local i
  for i in 0 1 2; do
    local ai="${av[$i]:-0}" bi="${bv[$i]:-0}"
    if ((ai > bi)); then return 0; fi
    if ((ai < bi)); then return 1; fi
  done
  return 0
}

print_linux_service_notes() {
  if ! have_cmd systemctl; then
    echo "Note: systemctl not found. User service install requires systemd."
    return
  fi

  if ! systemctl --user show-environment >/dev/null 2>&1; then
    echo "Note: systemd user manager is unavailable in this shell."
    echo "      Service install may fail unless user services are enabled."
    return
  fi

  if have_cmd loginctl; then
    local install_user="${SUDO_USER:-${USER:-}}"
    if [[ -n "$install_user" ]]; then
      local linger
      linger="$(loginctl show-user "$install_user" -p Linger --value 2>/dev/null || true)"
      if [[ "$linger" != "yes" ]]; then
        echo "Tip: for VPS reboot persistence, enable linger:"
        echo "     sudo loginctl enable-linger $install_user"
      fi
    fi
  fi
}

echo "Viewport daemon bootstrap"

if ! have_cmd node; then
  echo "Error: Node.js is required (>=20)."
  exit 1
fi

if ! have_cmd npm; then
  echo "Error: npm is required."
  exit 1
fi

NODE_VERSION="$(node -v)"
if ! version_ge "$NODE_VERSION" "20.0.0"; then
  echo "Error: Node.js >=20 is required. Found: $NODE_VERSION"
  exit 1
fi

echo "Installing ${PKG} globally..."
npm install -g "${PKG}"

VPD_BIN="$(command -v vpd || true)"
if [[ -z "$VPD_BIN" ]]; then
  NPM_PREFIX="$(npm prefix -g)"
  CANDIDATE_BIN="${NPM_PREFIX}/bin/vpd"
  if [[ -x "$CANDIDATE_BIN" ]]; then
    VPD_BIN="$CANDIDATE_BIN"
    echo "Note: npm global bin is not on PATH. Using: ${VPD_BIN}"
    echo "Add this to PATH for future shells: ${NPM_PREFIX}/bin"
  else
    echo "Error: installed package but could not resolve 'vpd' binary."
    exit 1
  fi
fi

echo "Running first-time setup wizard..."
"$VPD_BIN" setup "$@"

if [[ "$(detect_platform)" == "linux" ]]; then
  echo
  print_linux_service_notes
fi

echo
echo "Done. You can verify with:"
echo "  vpd service status"
echo "  vpd status"
