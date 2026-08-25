# Deploy: Docker + Kubernetes

Everything needed to containerize and deploy Liclick 3D Texture to
Kubernetes lives under this directory:

```
deploy/
  Dockerfile                          multi-stage build, two targets: server, web
  Dockerfile.dockerignore             build-context excludes (BuildKit auto-picks this up)
  docker/nginx/default.conf.template  nginx conf for the web image (SPA + reverse proxy)
  k8s/base/                           Kustomize base: Deployments, Services, PVC, Ingress
  k8s/overlays/prod/                  example overlay: image tags, replicas, resources, host
```

Two images come out of one pnpm monorepo, mirroring the split
`scripts/setup-linux-a100.sh` already sets up with bare-metal nginx:
`li3d-server` (Node backend, Prisma + SQLite on a PVC) and `li3d-web`
(nginx serving the built SPA, reverse-proxying `/api` and `/workspace` to
the backend Service).

## 1. Build and push images

Build context is the **repo root**, not `deploy/` — the Dockerfile `COPY`s
`apps/`, `packages/`, etc. Always pass `-f`:

```bash
docker build -f deploy/Dockerfile --target server -t <registry>/li3d/server:0.1.3 .
docker build -f deploy/Dockerfile --target web    -t <registry>/li3d/web:0.1.3    .
docker push <registry>/li3d/server:0.1.3
docker push <registry>/li3d/web:0.1.3
```

## 2. Fill in secrets

```bash
cp deploy/k8s/base/secrets/server.env.example deploy/k8s/base/secrets/server.env
# edit deploy/k8s/base/secrets/server.env:
#   SESSION_SECRET                -> openssl rand -hex 32
#   FEISHU_OAUTH_CLIENT_ID/SECRET -> from your IDaaS/Feishu app registration
```

This file is gitignored — never commit it. `kubectl apply -k` reads it at
apply time via `secretGenerator`.

## 3. Review non-secret config

Edit [`k8s/base/server-config.env`](k8s/base/server-config.env) — at
minimum set `LICLICK_PUBLIC_WORKSPACE_URL` / `LICLICK_FRONTEND_URL` /
`LICLICK_ALLOWED_ORIGINS` / `FEISHU_OAUTH_REDIRECT_URL` to your real domain,
and `COMFYUI_BASE_URL` / `COMFYUI_INPAINT_BASE_URL` to your GPU inference
endpoints. Set the same host on [`k8s/base/ingress.yaml`](k8s/base/ingress.yaml)
(or override it in an overlay — see `k8s/overlays/prod`).

For a first smoke test without setting up OAuth, set `AUTH_MODE=dev-mock`
instead of `feishu-oauth`.

## 4. Deploy

```bash
# base only (edit image tags in deploy/k8s/base/kustomization.yaml first), or:
kubectl apply -k deploy/k8s/base

# a per-environment overlay with pinned image tags/replicas/resources:
kubectl apply -k deploy/k8s/overlays/prod
```

Verify:

```bash
kubectl -n li3d get pods
kubectl -n li3d logs deploy/liclick-server -c db-push   # schema push, once per pod start
kubectl -n li3d port-forward svc/liclick-server 4517:4517 &
curl -fsS http://127.0.0.1:4517/api/health
```

## Things worth knowing before you run this for real

- **SQLite ⇒ one backend replica.** `liclick-server` is pinned to
  `replicas: 1` with `strategy: Recreate` because the workspace database is
  a single SQLite file on a `ReadWriteOnce` PVC — do not scale it out or
  switch the volume to `ReadWriteMany`. `apps/server/src/db/migrations.md`
  notes Postgres as a future option if you need multi-replica; that would
  mean changing `datasource.provider` in `apps/server/prisma/schema.prisma`
  and pointing `DATABASE_URL` at a Postgres Service instead of the PVC.
- **Schema sync runs as an initContainer**, not on every container restart —
  `prisma db push` against the PVC, once per pod (re)start. It's
  additive-only by default; a destructive schema change needs a manual
  `kubectl exec` run with `--accept-data-loss`.
- **Atlas Skillhub CLI login is not available in-cluster** — it depends on
  host-installed tooling and a local token cache file (see
  `docs/27_LINUX_A100_DEPLOYMENT.md`). `LICLICK_ENABLE_ATLAS_LOCAL_LOGIN` is
  set to `false` here; use direct Feishu OAuth or the IDaaS SP flow instead.
- **The frontend calls same-origin `/api` and `/workspace`** (no backend URL
  baked into the JS bundle) — `li3d-web`'s nginx proxies those paths to the
  `liclick-server` Service, same as the existing nginx site config in
  `scripts/setup-linux-a100.sh`. If you rebuild the web image with a custom
  `VITE_LICLICK_WORKSPACE_API`, make sure it matches wherever the Ingress
  actually exposes the app.
- **Nothing here backs up the PVC.** `workspace/` holds the SQLite DB plus
  every user's projects/assets/generated images — put a volume snapshot or
  backup policy in front of it before treating this as production.
