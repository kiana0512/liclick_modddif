#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-liclick-3d-texture}"
APP_USER="${APP_USER:-liclick}"
ENV_FILE="${ENV_FILE:-/etc/${APP_NAME}.env}"
SOURCE_TOKEN_FILE="${1:-}"
TEMP_TOKEN_FILE=""

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run as root: sudo bash scripts/linux-install-atlas-token.sh /path/to/.atlas-ai-gateway-oauth.json"
  exit 1
fi

if [[ -z "${SOURCE_TOKEN_FILE}" ]]; then
  echo "Usage: sudo bash scripts/linux-install-atlas-token.sh /path/to/.atlas-ai-gateway-oauth.json"
  echo "   or: cat .atlas-ai-gateway-oauth.json | sudo bash scripts/linux-install-atlas-token.sh -"
  exit 1
fi

if [[ "${SOURCE_TOKEN_FILE}" == "-" ]]; then
  TEMP_TOKEN_FILE="$(mktemp)"
  cat > "${TEMP_TOKEN_FILE}"
  SOURCE_TOKEN_FILE="${TEMP_TOKEN_FILE}"
fi

cleanup() {
  if [[ -n "${TEMP_TOKEN_FILE}" && -f "${TEMP_TOKEN_FILE}" ]]; then
    rm -f "${TEMP_TOKEN_FILE}"
  fi
}
trap cleanup EXIT

if [[ ! -f "${SOURCE_TOKEN_FILE}" ]]; then
  echo "Token file not found: ${SOURCE_TOKEN_FILE}"
  exit 1
fi

if ! id -u "${APP_USER}" >/dev/null 2>&1; then
  echo "User ${APP_USER} does not exist. Deploy Liclick first."
  exit 1
fi

if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  set -a
  source "${ENV_FILE}"
  set +a
fi

APP_HOME="$(getent passwd "${APP_USER}" | cut -d: -f6)"
APP_HOME="${APP_HOME:-/home/${APP_USER}}"
TOKEN_TARGET="${APP_HOME}/.atlas-ai-gateway-oauth.json"
ATLAS_PATH="${ATLAS_SKILLHUB_PATH:-$(npm root -g 2>/dev/null)/@lilith/atlas-skillhub/dist/index.js}"

if [[ ! -f "${ATLAS_PATH}" ]]; then
  echo "Atlas Skillhub runtime not found at ${ATLAS_PATH}."
  echo "Install @lilith/atlas-skillhub or set ATLAS_SKILLHUB_PATH in ${ENV_FILE}."
  exit 1
fi

install -d -o "${APP_USER}" -g "${APP_USER}" -m 0700 "${APP_HOME}"
install -o "${APP_USER}" -g "${APP_USER}" -m 0600 "${SOURCE_TOKEN_FILE}" "${TOKEN_TARGET}"

echo "Installed Atlas token cache to ${TOKEN_TARGET}"
echo "Verifying token as ${APP_USER}..."

sudo -u "${APP_USER}" \
  env HOME="${APP_HOME}" USERPROFILE="${APP_HOME}" \
  XDG_CONFIG_HOME="${APP_HOME}/.config" \
  XDG_CACHE_HOME="${APP_HOME}/.cache" \
  XDG_DATA_HOME="${APP_HOME}/.local/share" \
  node "${ATLAS_PATH}" gateway status

echo
echo "If valid=true above, restart Liclick:"
echo "  sudo systemctl restart ${APP_NAME}.service"
