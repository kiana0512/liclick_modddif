#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-liclick-3d-texture}"
STOP_NGINX="${STOP_NGINX:-0}"
MOUNT_MODE="${MOUNT_MODE:-nginx}"
REMOVE_COMFYUI_MOUNT="${REMOVE_COMFYUI_MOUNT:-0}"
COMFYUI_CUSTOM_NODES_DIR="${COMFYUI_CUSTOM_NODES_DIR:-/data/ai_art_comfyui/apps/ComfyUI/custom_nodes}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run as root: sudo bash scripts/linux-stop.sh"
  exit 1
fi

echo "==> Stopping ${APP_NAME}"
systemctl stop "${APP_NAME}.service" 2>/dev/null || true

if [[ "${MOUNT_MODE}" == "comfyui" ]]; then
  echo "==> Keeping ComfyUI running because MOUNT_MODE=comfyui."
  if [[ "${REMOVE_COMFYUI_MOUNT}" == "1" ]]; then
    echo "==> Removing ComfyUI mount. Restart ComfyUI afterwards."
    rm -rf "${COMFYUI_CUSTOM_NODES_DIR}/${APP_NAME}-mount"
  fi
elif [[ "${STOP_NGINX}" == "1" ]]; then
  echo "==> Stopping nginx"
  systemctl stop nginx 2>/dev/null || true
else
  echo "==> Keeping nginx running. Set STOP_NGINX=1 to stop nginx too."
fi

echo "==> Current service state"
systemctl --no-pager --full status "${APP_NAME}.service" | sed -n '1,10p' || true

cat <<EOF_DONE

${APP_NAME} is stopped.

Start/update again:
  sudo MOUNT_MODE=comfyui PUBLIC_URL=http://YOUR_SERVER_IP:46001/liclick/texture bash scripts/linux-start.sh

EOF_DONE
