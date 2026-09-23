#!/bin/sh
# Called by CI after creating the existing session/Feishu secret file.
# Only handles values that must come from CI/CD variables. Object storage
# is NOT here: its endpoint/bucket are plain config in
# deploy/k8s/base/server-config.env, and its AK/SK live in the
# `li3d-object-storage` Secret created once directly in the cluster (see
# deploy/k8s/infra/object-storage-ingress/README.md) so the keys never pass
# through git or CI. Never print secret values.
set -eu
set +x
umask 077
: "${LICLICK_CLOUD_DATABASE_URL:?LICLICK_CLOUD_DATABASE_URL is required}"
case "$LICLICK_CLOUD_DATABASE_URL" in postgres://*|postgresql://*) ;; *) echo 'Cloud database must use PostgreSQL' >&2; exit 1;; esac
append_env() {
  # kustomize env files are one key/value per line; reject newline injection.
  case "$2" in *"
"*|*"$(printf '\r')"*) echo "Invalid multiline value for $1" >&2; exit 1;; esac
  printf '%s=%s\n' "$1" "$2" >> deploy/k8s/base/secrets/server.env
}
append_env LICLICK_CLOUD_DATABASE_URL "$LICLICK_CLOUD_DATABASE_URL"
# Optional, unlike the var above: config.ts reads this with `?? ''` and
# only disables the local-repaint auto-analysis feature when it's empty,
# it does not fail server startup — so a missing key here should not block
# an otherwise-unrelated deploy. See deploy/QWEN_HANDOFF.md.
if [ -n "${QWEN3_VL_PLUS_API_KEY:-}" ]; then
  append_env QWEN3_VL_PLUS_API_KEY "$QWEN3_VL_PLUS_API_KEY"
fi
