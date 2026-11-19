#!/usr/bin/env sh
set -eu

# agy-fast one-command installer for macOS / Linux
# Local usage:
#   ./install.sh
#   ./install.sh --project /path/to/repo
#   ./install.sh doctor
#   ./install.sh uninstall
# Remote usage:
#   curl -fsSL https://raw.githubusercontent.com/INK-Q/agy-fast/main/install.sh | sh

PLUGIN_NAME="agy-fast"
DEFAULT_REPO="https://github.com/INK-Q/agy-fast.git"
DEFAULT_TARGET="${HOME}/.gemini/config/plugins/${PLUGIN_NAME}"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js >= 20 is required. Install Node.js first: https://nodejs.org/" >&2
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "${NODE_MAJOR}" -lt 20 ]; then
  echo "Error: Node.js >= 20 is required (found $(node -v))." >&2
  exit 1
fi

HAS_SUBCMD=0
case "${1:-}" in
  install|uninstall|status|doctor|-h|--help)
    HAS_SUBCMD=1
    ;;
esac

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || pwd)"

if [ -f "${SCRIPT_DIR}/plugin.json" ] && [ -f "${SCRIPT_DIR}/scripts/install.mjs" ]; then
  if [ "${HAS_SUBCMD}" -eq 1 ]; then
    exec node "${SCRIPT_DIR}/scripts/install.mjs" "$@"
  else
    exec node "${SCRIPT_DIR}/scripts/install.mjs" install "$@"
  fi
fi

# Allow running doctor/status/uninstall directly against an existing install
if [ "${HAS_SUBCMD}" -eq 1 ] && [ "${1:-}" != "install" ] && [ -f "${DEFAULT_TARGET}/scripts/install.mjs" ]; then
  exec node "${DEFAULT_TARGET}/scripts/install.mjs" "$@"
fi

# Remote clone mode when executed via pipe (e.g. curl -fsSL ... | sh)
REPO_URL="${AGY_FAST_REPO:-${DEFAULT_REPO}}"

if ! command -v git >/dev/null 2>&1; then
  echo "Error: git is required for remote installation." >&2
  exit 1
fi

TMP_CLONE="$(mktemp -d "${TMPDIR:-/tmp}/agy-fast-install.XXXXXX")"
cleanup() {
  rm -rf "${TMP_CLONE}"
}
trap cleanup EXIT INT TERM

echo "Cloning agy-fast from ${REPO_URL}..."
git clone --depth 1 "${REPO_URL}" "${TMP_CLONE}"

if [ "${HAS_SUBCMD}" -eq 1 ]; then
  node "${TMP_CLONE}/scripts/install.mjs" "$@"
else
  node "${TMP_CLONE}/scripts/install.mjs" install "$@"
fi
