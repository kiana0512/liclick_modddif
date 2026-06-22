#!/usr/bin/env bash
set -euo pipefail

APP_NAME="liclick-3d-texture"
APP_USER="${APP_USER:-liclick}"
APP_DIR="${APP_DIR:-/opt/${APP_NAME}}"
WORKSPACE_DIR="${WORKSPACE_DIR:-/var/lib/${APP_NAME}/workspace}"
ENV_FILE="${ENV_FILE:-/etc/${APP_NAME}.env}"
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"
NGINX_SITE="/etc/nginx/sites-available/${APP_NAME}"
NGINX_LINK="/etc/nginx/sites-enabled/${APP_NAME}"
SERVER_PORT="${SERVER_PORT:-4517}"
PUBLIC_PORT="${PUBLIC_PORT:-46777}"
PUBLIC_PATH="${PUBLIC_PATH:-/liclick/texture}"
NODE_MAJOR="${NODE_MAJOR:-22}"
PUBLIC_URL="${PUBLIC_URL:-}"
SOURCE_DIR="${SOURCE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
GIT_REPO="${GIT_REPO:-}"
GIT_REF="${GIT_REF:-main}"
INSTALL_ATLAS="${INSTALL_ATLAS:-1}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run as root: sudo PUBLIC_URL=https://your-domain.example bash scripts/setup-linux-a100.sh"
  exit 1
fi

if [[ -z "${PUBLIC_URL}" ]]; then
  PUBLIC_HOST="$(hostname -I 2>/dev/null | awk '{print $1}')"
  PUBLIC_URL="http://${PUBLIC_HOST:-127.0.0.1}:${PUBLIC_PORT}${PUBLIC_PATH}"
fi

URL_PATH="$(printf '%s' "${PUBLIC_URL}" | sed -E 's#^[a-zA-Z]+://[^/]*##')"
if [[ -n "${URL_PATH}" && "${URL_PATH}" != "/" ]]; then
  PUBLIC_PATH="${URL_PATH%/}"
fi
PUBLIC_PATH="/$(printf '%s' "${PUBLIC_PATH}" | sed -E 's#^/+##; s#/+$##')"
if [[ "${PUBLIC_PATH}" == "/" ]]; then
  PUBLIC_PATH=""
fi

case "${PUBLIC_URL}" in
  https://*) SESSION_COOKIE_SECURE="true" ;;
  *) SESSION_COOKIE_SECURE="false" ;;
esac

echo "==> Installing OS packages"
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates \
  curl \
  gnupg \
  rsync \
  nginx \
  openssl \
  build-essential \
  git

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'Number(process.versions.node.split(`.`)[0])')" -lt 20 ]]; then
  echo "==> Installing Node.js ${NODE_MAJOR}.x"
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL "https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key" \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
fi

echo "==> Enabling pnpm through corepack"
corepack enable
corepack prepare pnpm@9.15.4 --activate

if [[ "${INSTALL_ATLAS}" == "1" ]]; then
  echo "==> Installing Atlas Skillhub runtime"
  ATLAS_EXISTING="$(npm root -g 2>/dev/null)/@lilith/atlas-skillhub/dist/index.js"
  if [[ -f "${ATLAS_EXISTING}" ]]; then
    echo "Atlas Skillhub already exists at ${ATLAS_EXISTING}"
  else
    npm install -g @lilith/atlas-skillhub
  fi
fi

echo "==> Creating runtime user and directories"
id -u "${APP_USER}" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "${APP_USER}"
install -d -o "${APP_USER}" -g "${APP_USER}" "${WORKSPACE_DIR}"
install -d "${APP_DIR}"

if [[ -n "${GIT_REPO}" ]]; then
  SOURCE_DIR="/tmp/${APP_NAME}-source"
  if [[ -d "${SOURCE_DIR}/.git" ]]; then
    echo "==> Updating source from ${GIT_REPO}"
    git -C "${SOURCE_DIR}" fetch --all --prune
    git -C "${SOURCE_DIR}" checkout "${GIT_REF}"
    git -C "${SOURCE_DIR}" pull --ff-only origin "${GIT_REF}" || true
  else
    echo "==> Cloning source from ${GIT_REPO}"
    rm -rf "${SOURCE_DIR}"
    git clone --branch "${GIT_REF}" "${GIT_REPO}" "${SOURCE_DIR}"
  fi
fi

echo "==> Copying repository to ${APP_DIR}"
rsync -a --delete \
  --exclude ".git" \
  --exclude "node_modules" \
  --exclude ".pnpm-store" \
  --exclude "workspace" \
  --exclude "logs" \
  --exclude "*.tsbuildinfo" \
  "${SOURCE_DIR}/" "${APP_DIR}/"

cd "${APP_DIR}"

echo "==> Installing workspace dependencies"
corepack pnpm install --frozen-lockfile

echo "==> Building backend"
corepack pnpm --filter @liclick/server build

echo "==> Building frontend for ${PUBLIC_URL}"
VITE_PUBLIC_PATH="${PUBLIC_PATH}" VITE_LICLICK_WORKSPACE_API="${PUBLIC_URL}" corepack pnpm --filter @liclick/web build

env_value() {
  local key="$1"
  if [[ -f "${ENV_FILE}" ]]; then
    grep -E "^${key}=" "${ENV_FILE}" | tail -n 1 | cut -d= -f2- || true
  fi
}

SESSION_SECRET="${SESSION_SECRET:-$(env_value SESSION_SECRET)}"
SESSION_SECRET="${SESSION_SECRET:-$(openssl rand -hex 32)}"
ATLAS_PATH="$(npm root -g 2>/dev/null)/@lilith/atlas-skillhub/dist/index.js"

echo "==> Writing ${ENV_FILE}"
cat > "${ENV_FILE}" <<EOF_ENV
SERVER_PORT=${SERVER_PORT}
SERVER_HOST=127.0.0.1
LICLICK_WORKSPACE_DIR=${WORKSPACE_DIR}
LICLICK_PUBLIC_WORKSPACE_URL=${PUBLIC_URL}
LICLICK_PUBLIC_PATH=${PUBLIC_PATH}
LICLICK_FRONTEND_URL=${PUBLIC_URL}
LICLICK_ALLOWED_ORIGINS=${PUBLIC_URL},http://127.0.0.1,http://localhost
AUTH_MODE=feishu-oauth
SESSION_COOKIE_NAME=liclick_3d_session
SESSION_SECRET=${SESSION_SECRET}
SESSION_MAX_AGE_DAYS=14
SESSION_COOKIE_SECURE=${SESSION_COOKIE_SECURE}
ATLAS_SKILLHUB_PATH=${ATLAS_PATH}
EOF_ENV
chmod 0640 "${ENV_FILE}"
chown root:"${APP_USER}" "${ENV_FILE}"

echo "==> Writing systemd service"
cat > "${SERVICE_FILE}" <<EOF_SERVICE
[Unit]
Description=Liclick 3D Texture workspace server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/node ${APP_DIR}/apps/server/dist/index.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF_SERVICE

echo "==> Writing nginx site"
cat > "${NGINX_SITE}" <<EOF_NGINX
server {
    listen ${PUBLIC_PORT};
    server_name _;

    client_max_body_size 256m;

    root ${APP_DIR}/apps/web/dist;
    index index.html;

    location = ${PUBLIC_PATH} {
        return 302 ${PUBLIC_PATH}/;
    }

    location ^~ ${PUBLIC_PATH}/api/ {
        proxy_pass http://127.0.0.1:${SERVER_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }

    location ^~ ${PUBLIC_PATH}/workspace/ {
        proxy_pass http://127.0.0.1:${SERVER_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 600s;
    }

    location = ${PUBLIC_PATH}/index.html {
        alias ${APP_DIR}/apps/web/dist/index.html;
    }

    location ^~ ${PUBLIC_PATH}/ {
        alias ${APP_DIR}/apps/web/dist/;
        try_files \$uri \$uri/ ${PUBLIC_PATH}/index.html;
    }
}
EOF_NGINX

ln -sfn "${NGINX_SITE}" "${NGINX_LINK}"
rm -f /etc/nginx/sites-enabled/default

echo "==> Fixing ownership"
chown -R root:root "${APP_DIR}"
chown -R "${APP_USER}:${APP_USER}" "${WORKSPACE_DIR}"

echo "==> Starting services"
systemctl daemon-reload
systemctl enable --now "${APP_NAME}.service"
nginx -t
systemctl enable --now nginx
systemctl reload nginx

echo "==> Smoke checking backend"
curl -fsS "http://127.0.0.1:${SERVER_PORT}/api/health" >/dev/null

echo "==> Smoke checking frontend"
curl -fsS "http://127.0.0.1:${PUBLIC_PORT}${PUBLIC_PATH}/" >/dev/null || true

cat <<EOF_DONE

Liclick 3D Texture is deployed.

Frontend: ${PUBLIC_URL}
Backend:  http://127.0.0.1:${SERVER_PORT}
Public port: ${PUBLIC_PORT}
Public path: ${PUBLIC_PATH}
Service:  systemctl status ${APP_NAME}.service
Logs:     journalctl -u ${APP_NAME}.service -f

Important:
1. Atlas/Liclick login must exist for the service user (${APP_USER}).
2. If the server is headless, copy a valid ~/.atlas-ai-gateway-oauth.json into /home/${APP_USER}/
   and run: chown ${APP_USER}:${APP_USER} /home/${APP_USER}/.atlas-ai-gateway-oauth.json
3. If you put HTTPS in front of nginx later, rerun with PUBLIC_URL=https://your-domain.

EOF_DONE
