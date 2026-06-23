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
MOUNT_MODE="${MOUNT_MODE:-nginx}"
if [[ "${MOUNT_MODE}" == "comfyui" ]]; then
  PUBLIC_PORT="${PUBLIC_PORT:-46001}"
else
  PUBLIC_PORT="${PUBLIC_PORT:-46777}"
fi
PUBLIC_PATH="${PUBLIC_PATH:-/liclick/texture}"
PUBLIC_HOST="${PUBLIC_HOST:-}"
NODE_MAJOR="${NODE_MAJOR:-22}"
PUBLIC_URL="${PUBLIC_URL:-}"
COMFYUI_CUSTOM_NODES_DIR="${COMFYUI_CUSTOM_NODES_DIR:-/data/ai_art_comfyui/apps/ComfyUI/custom_nodes}"
COMFYUI_RESTART_COMMAND="${COMFYUI_RESTART_COMMAND:-}"
SOURCE_DIR="${SOURCE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
GIT_REPO="${GIT_REPO:-}"
GIT_REF="${GIT_REF:-main}"
GIT_REMOTE="${GIT_REMOTE:-origin}"
UPDATE_FROM_GIT="${UPDATE_FROM_GIT:-0}"
INSTALL_ATLAS="${INSTALL_ATLAS:-1}"
ATLAS_NPM_REGISTRY="${ATLAS_NPM_REGISTRY:-https://registry-cnpm.lilithgame.com/}"
ATLAS_LOGIN_MODE="${ATLAS_LOGIN_MODE:-interactive}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run as root: sudo PUBLIC_URL=https://your-domain.example bash scripts/setup-linux-a100.sh"
  exit 1
fi

if [[ -z "${PUBLIC_URL}" ]]; then
  DETECTED_PUBLIC_HOST="$(hostname -I 2>/dev/null | awk '{print $1}')"
  PUBLIC_HOST="${PUBLIC_HOST:-${DETECTED_PUBLIC_HOST:-127.0.0.1}}"
  PUBLIC_URL="http://${PUBLIC_HOST}:${PUBLIC_PORT}${PUBLIC_PATH}"
fi

PUBLIC_HOST_FROM_URL="$(printf '%s' "${PUBLIC_URL}" | sed -E 's#^[a-zA-Z]+://([^/:]+).*$#\1#')"
if [[ -z "${PUBLIC_HOST}" ]]; then
  PUBLIC_HOST="${PUBLIC_HOST_FROM_URL}"
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
    if ! npm install -g @lilith/atlas-skillhub --registry="${ATLAS_NPM_REGISTRY}"; then
      echo "WARN: @lilith/atlas-skillhub install failed from ${ATLAS_NPM_REGISTRY}."
      echo "WARN: Deployment will continue. Configure ATLAS_SKILLHUB_PATH after installing the Atlas runtime manually."
    fi
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
    git -c safe.directory="${SOURCE_DIR}" -C "${SOURCE_DIR}" fetch --all --prune
    git -c safe.directory="${SOURCE_DIR}" -C "${SOURCE_DIR}" checkout "${GIT_REF}"
    git -c safe.directory="${SOURCE_DIR}" -C "${SOURCE_DIR}" pull --ff-only origin "${GIT_REF}" || true
  else
    echo "==> Cloning source from ${GIT_REPO}"
    rm -rf "${SOURCE_DIR}"
    git clone --branch "${GIT_REF}" "${GIT_REPO}" "${SOURCE_DIR}"
  fi
fi

if [[ "${UPDATE_FROM_GIT}" == "1" && -d "${SOURCE_DIR}/.git" ]]; then
  echo "==> Pulling latest source in ${SOURCE_DIR}"
  git -c safe.directory="${SOURCE_DIR}" -C "${SOURCE_DIR}" fetch "${GIT_REMOTE}" --prune
  CURRENT_BRANCH="$(git -c safe.directory="${SOURCE_DIR}" -C "${SOURCE_DIR}" rev-parse --abbrev-ref HEAD)"
  TARGET_REF="${GIT_REF:-${CURRENT_BRANCH}}"
  if [[ -n "${TARGET_REF}" && "${TARGET_REF}" != "${CURRENT_BRANCH}" ]]; then
    git -c safe.directory="${SOURCE_DIR}" -C "${SOURCE_DIR}" checkout "${TARGET_REF}"
  fi
  git -c safe.directory="${SOURCE_DIR}" -C "${SOURCE_DIR}" pull --ff-only "${GIT_REMOTE}" "${TARGET_REF}"
fi

echo "==> Copying repository to ${APP_DIR}"
rsync -a --delete \
  --exclude ".git" \
  --exclude "node_modules" \
  --exclude ".pnpm-store" \
  --exclude "/workspace" \
  --exclude "/logs" \
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
ATLAS_PATH="${ATLAS_SKILLHUB_PATH:-$(npm root -g 2>/dev/null)/@lilith/atlas-skillhub/dist/index.js}"

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
ATLAS_LOGIN_MODE=${ATLAS_LOGIN_MODE}
SESSION_COOKIE_NAME=liclick_3d_session
SESSION_SECRET=${SESSION_SECRET}
SESSION_MAX_AGE_DAYS=14
SESSION_COOKIE_SECURE=${SESSION_COOKIE_SECURE}
ATLAS_SKILLHUB_PATH=${ATLAS_PATH}
EOF_ENV
chmod 0640 "${ENV_FILE}"
chown root:"${APP_USER}" "${ENV_FILE}"

install_comfyui_mount() {
  local mount_dir="${COMFYUI_CUSTOM_NODES_DIR}/${APP_NAME}-mount"

  echo "==> Installing ComfyUI mount into ${mount_dir}"
  install -d "${mount_dir}"
  cat > "${mount_dir}/__init__.py" <<EOF_COMFYUI_MOUNT
from __future__ import annotations

from pathlib import Path
from urllib.parse import urlencode

from aiohttp import ClientSession, web

try:
    from server import PromptServer
except Exception as exc:
    print(f"[Liclick 3D Texture] Failed to import ComfyUI PromptServer: {exc}")
    WEB_DIRECTORY = "./web"
    NODE_CLASS_MAPPINGS = {}
    NODE_DISPLAY_NAME_MAPPINGS = {}
else:
    APP_DIR = Path("${APP_DIR}")
    WEB_DIST = APP_DIR / "apps" / "web" / "dist"
    PUBLIC_PATH = "${PUBLIC_PATH}".rstrip("/")
    BACKEND_URL = "http://127.0.0.1:${SERVER_PORT}"
    ROUTES = PromptServer.instance.routes

    HOP_BY_HOP_HEADERS = {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "content-length",
        "host",
    }

    def _safe_static_path(tail: str) -> Path | None:
        base = WEB_DIST.resolve()
        candidate = (WEB_DIST / tail.lstrip("/")).resolve()
        if candidate == base or base in candidate.parents:
            return candidate
        return None

    async def _index(_request: web.Request) -> web.StreamResponse:
        index_path = WEB_DIST / "index.html"
        if not index_path.exists():
            return web.Response(status=503, text="Liclick frontend has not been built.")
        return web.FileResponse(index_path)

    async def _mount_health(_request: web.Request) -> web.StreamResponse:
        return web.json_response({
            "ok": True,
            "mount": PUBLIC_PATH,
            "webDist": str(WEB_DIST),
            "backend": BACKEND_URL,
            "indexExists": (WEB_DIST / "index.html").exists(),
        })

    async def _static_or_index(request: web.Request) -> web.StreamResponse:
        tail = request.match_info.get("tail", "")
        static_path = _safe_static_path(tail)
        if static_path and static_path.is_file():
            return web.FileResponse(static_path)
        return await _index(request)

    async def _proxy(request: web.Request, prefix: str) -> web.StreamResponse:
        tail = request.match_info.get("tail", "")
        target = f"{BACKEND_URL}/{prefix}/{tail}".rstrip("/")
        if request.query:
            target = f"{target}?{urlencode(request.query, doseq=True)}"

        headers = {
            key: value
            for key, value in request.headers.items()
            if key.lower() not in HOP_BY_HOP_HEADERS
        }
        body = await request.read()

        async with ClientSession() as session:
            async with session.request(
                request.method,
                target,
                data=body if body else None,
                headers=headers,
                allow_redirects=False,
            ) as response:
                response_body = await response.read()
                response_headers = {
                    key: value
                    for key, value in response.headers.items()
                    if key.lower() not in HOP_BY_HOP_HEADERS
                }
                return web.Response(
                    status=response.status,
                    body=response_body,
                    headers=response_headers,
                )

    async def _api_proxy(request: web.Request) -> web.StreamResponse:
        return await _proxy(request, "api")

    async def _workspace_proxy(request: web.Request) -> web.StreamResponse:
        return await _proxy(request, "workspace")

    ROUTES.get(PUBLIC_PATH)(_index)
    ROUTES.get(f"{PUBLIC_PATH}/")(_index)
    ROUTES.get(f"{PUBLIC_PATH}/_liclick_mount_health")(_mount_health)
    ROUTES.route("*", f"{PUBLIC_PATH}/api/{{tail:.*}}")(_api_proxy)
    ROUTES.route("*", f"{PUBLIC_PATH}/workspace/{{tail:.*}}")(_workspace_proxy)
    ROUTES.get(f"{PUBLIC_PATH}/{{tail:.*}}")(_static_or_index)

    print(
        f"[Liclick 3D Texture] Mounted {PUBLIC_PATH} from {WEB_DIST} "
        f"and proxied API to {BACKEND_URL}"
    )

    WEB_DIRECTORY = "./web"
    NODE_CLASS_MAPPINGS = {}
    NODE_DISPLAY_NAME_MAPPINGS = {}
EOF_COMFYUI_MOUNT
}

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
Environment=HOME=/home/${APP_USER}
ExecStart=/usr/bin/node ${APP_DIR}/apps/server/dist/index.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF_SERVICE

if [[ "${MOUNT_MODE}" == "comfyui" ]]; then
  install_comfyui_mount
else
  echo "==> Writing nginx site"
  NGINX_LISTEN_OPTIONS=""
  if ! grep -R "listen[[:space:]]\+${PUBLIC_PORT}[^;]*default_server" /etc/nginx/sites-enabled /etc/nginx/conf.d >/dev/null 2>&1; then
    NGINX_LISTEN_OPTIONS=" default_server"
  fi
  cat > "${NGINX_SITE}" <<EOF_NGINX
server {
    listen ${PUBLIC_PORT}${NGINX_LISTEN_OPTIONS};
    server_name ${PUBLIC_HOST} 127.0.0.1 localhost _;

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
  if [[ "${NGINX_REMOVE_DEFAULT:-0}" == "1" ]]; then
    rm -f /etc/nginx/sites-enabled/default
  fi
fi

echo "==> Fixing ownership"
chown -R root:root "${APP_DIR}"
chown -R "${APP_USER}:${APP_USER}" "${WORKSPACE_DIR}"

echo "==> Starting services"
systemctl daemon-reload
systemctl enable --now "${APP_NAME}.service"
if [[ "${MOUNT_MODE}" == "comfyui" ]]; then
  if [[ -n "${COMFYUI_RESTART_COMMAND}" ]]; then
    echo "==> Restarting ComfyUI through COMFYUI_RESTART_COMMAND"
    bash -lc "${COMFYUI_RESTART_COMMAND}"
  else
    echo "==> ComfyUI mount installed. Restart ComfyUI once so it loads ${PUBLIC_PATH}."
  fi
else
  nginx -t
  systemctl enable --now nginx
  systemctl reload nginx
fi

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

echo "==> Smoke checking backend"
wait_for_url "http://127.0.0.1:${SERVER_PORT}/api/health" "Backend health"

echo "==> Smoke checking frontend"
curl -fsSI "http://127.0.0.1:${PUBLIC_PORT}${PUBLIC_PATH}/" || true

cat <<EOF_DONE

Liclick 3D Texture is deployed.

Frontend: ${PUBLIC_URL}
Backend:  http://127.0.0.1:${SERVER_PORT}
Public port: ${PUBLIC_PORT}
Public path: ${PUBLIC_PATH}
Mount mode: ${MOUNT_MODE}
Service:  systemctl status ${APP_NAME}.service
Logs:     journalctl -u ${APP_NAME}.service -f

Important:
1. ATLAS_LOGIN_MODE=${ATLAS_LOGIN_MODE}. In interactive mode, each browser user authorizes Feishu/IDaaS separately.
2. If MOUNT_MODE=comfyui, restart ComfyUI after deployment if this script did not do it.
3. Persistent user data is under ${WORKSPACE_DIR}; do not delete it during updates.
4. If you put HTTPS in front of nginx later, rerun with PUBLIC_URL=https://your-domain.

EOF_DONE
