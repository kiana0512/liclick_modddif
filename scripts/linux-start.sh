#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-liclick-3d-texture}"
SERVER_PORT="${SERVER_PORT:-4517}"
PUBLIC_PORT="${PUBLIC_PORT:-46777}"
PUBLIC_PATH="${PUBLIC_PATH:-/liclick/texture}"
PUBLIC_URL="${PUBLIC_URL:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run as root: sudo PUBLIC_URL=http://YOUR_SERVER_IP:${PUBLIC_PORT}${PUBLIC_PATH} bash scripts/linux-start.sh"
  exit 1
fi

echo "==> Deploying/updating ${APP_NAME}"
export APP_NAME SERVER_PORT PUBLIC_PORT PUBLIC_PATH PUBLIC_URL
bash "${SCRIPT_DIR}/setup-linux-a100.sh"

echo "==> Restarting ${APP_NAME}"
systemctl daemon-reload
systemctl restart "${APP_NAME}.service"

echo "==> Reloading nginx"
nginx -t
systemctl reload nginx

echo "==> Health checks"
curl -fsS "http://127.0.0.1:${SERVER_PORT}/api/health"
echo

if [[ -n "${PUBLIC_URL}" ]]; then
  curl -fsSI "${PUBLIC_URL}" || true
else
  curl -fsSI "http://127.0.0.1:${PUBLIC_PORT}${PUBLIC_PATH}/" || true
fi

echo
systemctl --no-pager --full status "${APP_NAME}.service" | sed -n '1,12p'

cat <<EOF_DONE

${APP_NAME} is running.

Frontend:       ${PUBLIC_URL:-http://127.0.0.1:${PUBLIC_PORT}${PUBLIC_PATH}}
Backend health: http://127.0.0.1:${SERVER_PORT}/api/health
Logs:           journalctl -u ${APP_NAME}.service -f
Stop:           sudo bash scripts/linux-stop.sh

EOF_DONE
