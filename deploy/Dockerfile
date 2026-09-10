# syntax=docker/dockerfile:1
# M15 / CLOUD-DEPLOYMENT v1.0.0. Build from the repository root.
ARG NODE_IMAGE=node:22-bookworm-slim
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.27-alpine
FROM ${NODE_IMAGE} AS deps
WORKDIR /repo
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/connector-protocol/package.json packages/connector-protocol/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
ARG RELEASE_ID
ARG GIT_SHA
ARG RELEASE_VERSION
ARG BUILD_TIME
ENV LICLICK_RELEASE_ID=${RELEASE_ID} VITE_LICLICK_RELEASE_ID=${RELEASE_ID} \
    LICLICK_GIT_SHA=${GIT_SHA} VITE_LICLICK_GIT_SHA=${GIT_SHA} \
    LICLICK_RELEASE_VERSION=${RELEASE_VERSION} VITE_LICLICK_RELEASE_VERSION=${RELEASE_VERSION} \
    LICLICK_BUILD_TIME=${BUILD_TIME} VITE_LICLICK_BUILD_TIME=${BUILD_TIME} \
    LICLICK_RUNTIME_MODE=cloud VITE_LICLICK_RUNTIME_MODE=cloud
# The zprod ingress is at the domain root. No credentials are build arguments.
ENV VITE_PUBLIC_PATH="" VITE_LICLICK_PERFORMANCE_LAB_ENABLED=true
RUN pnpm run build:release && pnpm run check:cloud-artifact && pnpm run check:web-bundle-budget
RUN pnpm deploy --filter=@liclick/server --prod /out/server

FROM ${NODE_IMAGE} AS server
ARG RELEASE_ID
ARG GIT_SHA
ARG RELEASE_VERSION
ARG BUILD_TIME
ARG ATLAS_NPM_REGISTRY=https://registry-cnpm.lilithgame.com/
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 liclick \
    && useradd --uid 10001 --gid 10001 --home /data/workspace --shell /usr/sbin/nologin --system liclick
# Server-managed runtime, pinned to the existing secure login contract.
RUN npm install --global @lilith/atlas-skillhub@2.9.1 --registry="${ATLAS_NPM_REGISTRY}"
WORKDIR /app
COPY --from=build --chown=liclick:liclick /repo/package.json ./package.json
COPY --from=build --chown=liclick:liclick /out/server/ ./apps/server/
COPY --from=build --chown=liclick:liclick /repo/apps/server/dist/ ./apps/server/dist/
COPY --from=build --chown=liclick:liclick /repo/apps/server/sql/ ./apps/server/sql/
COPY --from=build --chown=liclick:liclick /repo/apps/server/scripts/migrate-cloud-projects.mjs ./apps/server/scripts/migrate-cloud-projects.mjs
COPY --chown=liclick:liclick deploy/validate-runtime-env.mjs ./deploy/validate-runtime-env.mjs
RUN mkdir -p /data/workspace && chown -R liclick:liclick /data
ENV NODE_ENV=production SERVER_HOST=0.0.0.0 SERVER_PORT=4517 \
    HOME=/data/workspace LICLICK_WORKSPACE_DIR=/data/workspace \
    LICLICK_RUNTIME_MODE=cloud LICLICK_PROJECT_REPOSITORY=postgres LICLICK_SERVE_WEB=false \
    ATLAS_SKILLHUB_PATH=/usr/local/lib/node_modules/@lilith/atlas-skillhub/dist/index.js \
    LICLICK_RELEASE_ID=${RELEASE_ID} LICLICK_GIT_SHA=${GIT_SHA} \
    LICLICK_RELEASE_VERSION=${RELEASE_VERSION} LICLICK_BUILD_TIME=${BUILD_TIME}
USER liclick:liclick
EXPOSE 4517
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD \
  node -e "fetch('http://127.0.0.1:4517/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "node deploy/validate-runtime-env.mjs && exec node apps/server/dist/index.js"]

FROM ${NGINX_IMAGE} AS web
# The base image ships `worker_processes auto`, and nginx resolves "auto" from
# the HOST's CPU count — it does not read the cgroup quota. On these 64-core
# nodes that started 64 worker processes to share the pod's 1-CPU limit
# (verified in-pod 2026-09-10: nproc=64, 64 workers, cpu.max 50000 100000).
# Pin it to 8. This has to happen here rather than in default.conf.template:
# worker_processes is a main-context directive, and the entrypoint's envsubst
# only renders templates into conf.d, which is included inside `http {}`.
# The grep is the point of the `&&` — if a future base image renames or drops
# the directive the sed would silently no-op, so fail the build instead.
# Not using NGINX_ENTRYPOINT_WORKER_PROCESSES_AUTOTUNE: it derives the count
# from the CPU quota, which would give 1, not 8.
RUN sed -i 's/^worker_processes .*/worker_processes 8;/' /etc/nginx/nginx.conf && grep -qx 'worker_processes 8;' /etc/nginx/nginx.conf
COPY deploy/docker/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
ENV BACKEND_HOST=liclick-server BACKEND_PORT=4517
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD \
  wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
