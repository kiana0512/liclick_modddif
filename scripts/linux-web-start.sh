#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -z "${PUBLIC_URL:-}" ]]; then
  echo "PUBLIC_URL is required, for example: https://li3d.example.com"
  exit 1
fi

case "${PUBLIC_URL}" in
  https://*) ;;
  http://127.0.0.1*|http://localhost*) ;;
  *)
    if [[ "${LICLICK_ALLOW_INSECURE_HTTP:-0}" != "1" ]]; then
      echo "Production Web deployment requires an HTTPS PUBLIC_URL."
      echo "Set LICLICK_ALLOW_INSECURE_HTTP=1 only for an internal test server."
      exit 1
    fi
    ;;
esac

export MOUNT_MODE="nginx"
export PUBLIC_PATH="${PUBLIC_PATH:-/}"
export LICLICK_SERVE_WEB="${LICLICK_SERVE_WEB:-true}"
export INSTALL_ATLAS="${INSTALL_ATLAS:-0}"
export LICLICK_ENABLE_ATLAS_LOCAL_LOGIN="${LICLICK_ENABLE_ATLAS_LOCAL_LOGIN:-false}"
export ATLAS_LOGIN_MODE="${ATLAS_LOGIN_MODE:-interactive}"

if [[ "${LICLICK_ENABLE_ATLAS_LOCAL_LOGIN}" != "true" ]]; then
  if [[ -z "${FEISHU_OAUTH_CLIENT_ID:-}" || -z "${FEISHU_OAUTH_CLIENT_SECRET:-}" ]]; then
    echo "WARN: Feishu App ID/Secret are missing. The site will deploy, but login remains unavailable."
  fi
fi

exec bash "${SCRIPT_DIR}/linux-start.sh"
