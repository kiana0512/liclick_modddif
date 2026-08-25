# syntax=docker/dockerfile:1.7

# Liclick 3D Texture — multi-stage build.
#
# Build context is the repo root (this Dockerfile COPYs apps/, packages/,
# etc.), so always build with -f from the repo root:
#   docker build -f deploy/Dockerfile --target server -t li3d-server .
#   docker build -f deploy/Dockerfile --target web    -t li3d-web    .
# BuildKit picks up deploy/Dockerfile.dockerignore automatically (the
# `# syntax=` line above forces the BuildKit frontend).
#
# The "server" image runs the Node backend (apps/server, Prisma + SQLite).
# The "web" image is nginx serving the built SPA (apps/web) and reverse
# proxying /api and /workspace to the backend Service — the same split
# scripts/setup-linux-a100.sh sets up with a bare-metal nginx site.
#
# See deploy/README.md for the full build + Kubernetes deploy walkthrough.

ARG NODE_IMAGE=node:22-bookworm-slim
ARG PNPM_VERSION=9.15.4

########################################################################
# deps: install the full workspace (incl. devDependencies) once, cached
########################################################################
FROM ${NODE_IMAGE} AS deps
ARG PNPM_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate
WORKDIR /repo

# Copy only manifests first so `pnpm install` is cached across source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/connector-protocol/package.json packages/connector-protocol/package.json
RUN pnpm install --frozen-lockfile

########################################################################
# build: compile the backend and build the frontend
########################################################################
FROM deps AS build
COPY . .

# `prisma generate` only needs the schema to be well-formed, not a live DB,
# but it does read DATABASE_URL — give it a harmless placeholder.
ENV DATABASE_URL="file:./build-placeholder.db"
RUN pnpm --filter @liclick/server run db:generate
RUN pnpm --filter @liclick/server run build

# The frontend calls the workspace API on the same origin it was served
# from unless VITE_LICLICK_WORKSPACE_API is baked in (see workspaceApiBase.ts).
# Leave it unset for k8s: nginx proxies /api and /workspace same-origin.
ARG VITE_PUBLIC_PATH=
ARG VITE_LICLICK_WORKSPACE_API=
RUN VITE_PUBLIC_PATH="${VITE_PUBLIC_PATH}" VITE_LICLICK_WORKSPACE_API="${VITE_LICLICK_WORKSPACE_API}" \
    pnpm --filter @liclick/web run build

# Produce a self-contained node_modules for just @liclick/server (with
# devDependencies, so the `prisma` CLI is available for `db push` at
# deploy time). dist/ and prisma/ are copied explicitly in the final
# stage below rather than relied on from this output, since pnpm deploy's
# file-inclusion rules are independent of what actually needs to ship.
RUN pnpm deploy --filter=@liclick/server --prod=false /out/server

########################################################################
# server: runtime image for apps/server
########################################################################
FROM ${NODE_IMAGE} AS server
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 liclick \
    && useradd --uid 10001 --gid 10001 --home /app --shell /usr/sbin/nologin --system liclick

WORKDIR /app
COPY --from=build --chown=liclick:liclick /out/server/node_modules ./node_modules
COPY --from=build --chown=liclick:liclick /out/server/package.json ./package.json
COPY --from=build --chown=liclick:liclick /repo/apps/server/dist ./dist
COPY --from=build --chown=liclick:liclick /repo/apps/server/prisma ./prisma

RUN mkdir -p /data/workspace && chown -R liclick:liclick /data

ENV NODE_ENV=production \
    SERVER_HOST=0.0.0.0 \
    SERVER_PORT=4517 \
    LICLICK_WORKSPACE_DIR=/data/workspace \
    DATABASE_URL=file:/data/workspace/liclick.db

USER liclick:liclick
EXPOSE 4517
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD \
  node -e "fetch('http://127.0.0.1:'+process.env.SERVER_PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
# Schema sync (`prisma db push`) is run separately — see the k8s
# initContainer in deploy/k8s/base/server-deployment.yaml — so a plain
# restart of this container never re-runs it. For a one-off docker run,
# apply it manually first: `docker run --rm -e DATABASE_URL=... <image> node_modules/.bin/prisma db push --schema prisma/schema.prisma --skip-generate`
CMD ["node", "dist/index.js"]

########################################################################
# web: runtime image for apps/web (static SPA + reverse proxy to server)
########################################################################
FROM nginxinc/nginx-unprivileged:1.27-alpine AS web
COPY deploy/docker/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html

ENV BACKEND_HOST=liclick-server \
    BACKEND_PORT=4517

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD \
  wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
