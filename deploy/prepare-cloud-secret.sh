#!/bin/sh
# Called by CI after creating the existing session/Feishu secret file.
# Qwen is separately configured by the efficiency team; never print secret values.
set -eu
set +x
umask 077
: "${LICLICK_CLOUD_DATABASE_URL:?LICLICK_CLOUD_DATABASE_URL is required}"
: "${LICLICK_OBJECT_STORAGE_ENDPOINT:?LICLICK_OBJECT_STORAGE_ENDPOINT is required}"
: "${LICLICK_OBJECT_STORAGE_BUCKET:?LICLICK_OBJECT_STORAGE_BUCKET is required}"
: "${LICLICK_OBJECT_STORAGE_ACCESS_KEY_ID:?LICLICK_OBJECT_STORAGE_ACCESS_KEY_ID is required}"
: "${LICLICK_OBJECT_STORAGE_SECRET_ACCESS_KEY:?LICLICK_OBJECT_STORAGE_SECRET_ACCESS_KEY is required}"
case "$LICLICK_CLOUD_DATABASE_URL" in postgres://*|postgresql://*) ;; *) echo 'Cloud database must use PostgreSQL' >&2; exit 1;; esac
case "$LICLICK_OBJECT_STORAGE_ENDPOINT" in https://*) ;; *) echo 'Object storage must use HTTPS' >&2; exit 1;; esac
append_env() {
  # kustomize env files are one key/value per line; reject newline injection.
  case "$2" in *"
"*|*"$(printf '\r')"*) echo "Invalid multiline value for $1" >&2; exit 1;; esac
  printf '%s=%s\n' "$1" "$2" >> deploy/k8s/base/secrets/server.env
}
append_env LICLICK_CLOUD_DATABASE_URL "$LICLICK_CLOUD_DATABASE_URL"
append_env LICLICK_OBJECT_STORAGE_ENDPOINT "$LICLICK_OBJECT_STORAGE_ENDPOINT"
append_env LICLICK_OBJECT_STORAGE_BUCKET "$LICLICK_OBJECT_STORAGE_BUCKET"
append_env LICLICK_OBJECT_STORAGE_ACCESS_KEY_ID "$LICLICK_OBJECT_STORAGE_ACCESS_KEY_ID"
append_env LICLICK_OBJECT_STORAGE_SECRET_ACCESS_KEY "$LICLICK_OBJECT_STORAGE_SECRET_ACCESS_KEY"
append_env LICLICK_OBJECT_STORAGE_REGION "${LICLICK_OBJECT_STORAGE_REGION:-auto}"
if [ -n "${LICLICK_OBJECT_STORAGE_SESSION_TOKEN:-}" ]; then
  append_env LICLICK_OBJECT_STORAGE_SESSION_TOKEN "$LICLICK_OBJECT_STORAGE_SESSION_TOKEN"
fi
