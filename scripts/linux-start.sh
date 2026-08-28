#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-liclick-3d-texture}"
SERVER_PORT="${SERVER_PORT:-4517}"
MOUNT_MODE="${MOUNT_MODE:-nginx}"
if [[ "${MOUNT_MODE}" == "comfyui" ]]; then
  PUBLIC_PORT="${PUBLIC_PORT:-46001}"
else
  PUBLIC_PORT="${PUBLIC_PORT:-46777}"
fi
PUBLIC_PATH="${PUBLIC_PATH:-/liclick/texture}"
PUBLIC_HOST="${PUBLIC_HOST:-}"
PUBLIC_URL="${PUBLIC_URL:-}"
COMFYUI_CUSTOM_NODES_DIR="${COMFYUI_CUSTOM_NODES_DIR:-/data/ai_art_comfyui/apps/ComfyUI/custom_nodes}"
COMFYUI_RESTART_COMMAND="${COMFYUI_RESTART_COMMAND:-}"
ATLAS_LOGIN_MODE="${ATLAS_LOGIN_MODE:-service-token}"
GIT_REF="${GIT_REF:-main}"
GIT_REMOTE="${GIT_REMOTE:-origin}"
UPDATE_FROM_GIT="${UPDATE_FROM_GIT:-0}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ATLAS_TOKEN_FILE="${ATLAS_TOKEN_FILE:-${SCRIPT_DIR}/../secrets/.atlas-ai-gateway-oauth.json}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run as root: sudo MOUNT_MODE=comfyui PUBLIC_URL=http://YOUR_SERVER_IP:${PUBLIC_PORT}${PUBLIC_PATH} bash scripts/linux-start.sh"
  exit 1
fi

echo "==> Deploying/updating ${APP_NAME}"
export APP_NAME SERVER_PORT PUBLIC_PORT PUBLIC_PATH PUBLIC_HOST PUBLIC_URL
export MOUNT_MODE COMFYUI_CUSTOM_NODES_DIR COMFYUI_RESTART_COMMAND
export ATLAS_LOGIN_MODE ATLAS_TOKEN_FILE
export GIT_REF GIT_REMOTE UPDATE_FROM_GIT
bash "${SCRIPT_DIR}/setup-linux-a100.sh"

echo "==> Restarting ${APP_NAME}"
systemctl daemon-reload
systemctl restart "${APP_NAME}.service"

echo "==> Reloading nginx"
if [[ "${MOUNT_MODE}" == "comfyui" ]]; then
  echo "Skipping nginx reload because MOUNT_MODE=comfyui uses the existing ComfyUI web server."
else
  nginx -t
  systemctl reload nginx
fi

echo "==> Health checks"
wait_for_url() {
  local url="$1"
  local label="$2"
  local attempt
  for attempt in $(seq 1 30); do
    if curl -fsS "${url}" >/dev/null 2>&1; then
      echo "${label}: ok"
      return 0
    fi
    sleep 1
  done
  echo "${label}: failed after 30s"
  curl -fsS "${url}"
}

wait_for_url "http://127.0.0.1:${SERVER_PORT}/api/health" "Backend health"

if [[ -n "${PUBLIC_URL}" ]]; then
  curl -fsSI "${PUBLIC_URL%/}/" || true
else
  curl -fsSI "http://127.0.0.1:${PUBLIC_PORT}${PUBLIC_PATH}/" || true
fi

echo
systemctl --no-pager --full status "${APP_NAME}.service" | sed -n '1,12p'

cat <<EOF_DONE

${APP_NAME} is running.

Frontend:       ${PUBLIC_URL:-http://127.0.0.1:${PUBLIC_PORT}${PUBLIC_PATH}}
Backend health: http://127.0.0.1:${SERVER_PORT}/api/health
Mount mode:     ${MOUNT_MODE}
Atlas login:    ${ATLAS_LOGIN_MODE}
Atlas token:    ${ATLAS_TOKEN_FILE}
Git update:     ${UPDATE_FROM_GIT}
Logs:           journalctl -u ${APP_NAME}.service -f
Stop:           sudo bash scripts/linux-stop.sh

EOF_DONE
