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
# Kept strict: the object storage endpoint reaches the browser as a
# presigned URL, so it must be HTTPS or browser uploads break on mixed
# content. zprod's RGW is plain HTTP internally, but it's fronted by the
# HTTPS ingress in deploy/k8s/infra/object-storage-ingress/ — point this
# at that hostname, not at the RGW address directly.
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
# Optional, unlike the vars above: config.ts reads this with `?? ''` and
# only disables the local-repaint auto-analysis feature when it's empty,
# it does not fail server startup — so a missing key here should not block
# an otherwise-unrelated deploy. See deploy/QWEN_HANDOFF.md.
if [ -n "${QWEN3_VL_PLUS_API_KEY:-}" ]; then
  append_env QWEN3_VL_PLUS_API_KEY "$QWEN3_VL_PLUS_API_KEY"
fi
