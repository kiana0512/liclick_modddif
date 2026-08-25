# Deploy: Docker + Kubernetes

Everything needed to containerize and deploy Liclick 3D Texture to
Kubernetes lives under this directory:

```
deploy/
  Dockerfile                          multi-stage build, two targets: server, web
  Dockerfile.dockerignore             build-context excludes (BuildKit auto-picks this up)
  docker-compose.yml                  local build/run of both images, no k8s needed
  docker/nginx/default.conf.template  nginx conf for the web image (SPA + reverse proxy)
  k8s/base/                           Kustomize base: Deployments, Services, PVC, Ingress
  k8s/overlays/prod/                  generic example overlay
  k8s/overlays/zprod/                 the real overlay for the company zprod cluster
```

Two images come out of one pnpm monorepo, mirroring the split
`scripts/setup-linux-a100.sh` already sets up with bare-metal nginx:
`li3d-server` (Node backend, Prisma + SQLite on a PVC) and `li3d-web`
(nginx serving the built SPA, reverse-proxying `/api` and `/workspace` to
the backend Service).

There are two overlays:

- **`k8s/overlays/prod`** — a generic, illustrative example (placeholder
  `registry.example.com` / `example.com`). Copy this pattern for a new
  environment.
- **`k8s/overlays/zprod`** — the real overlay for the company `zprod`
  cluster (kubectl context `zprod`, cluster `kubernetes-h657hbh267`),
  namespace `li3d`, ingress host `li3d.lilithgames.com`, PVC pinned to
  the `zstack-csi-rbd` StorageClass (zprod has no default StorageClass —
  confirmed via `kubectl get storageclass`, none carry the
  `storageclass.kubernetes.io/is-default-class` annotation).

## 1. Build and push images (you run this — no Docker in this environment)

Build context is the **repo root**, not `deploy/` — the Dockerfile `COPY`s
`apps/`, `packages/`, etc. Always pass `-f`. `zprod` already runs other
internal services (`p4-account-service`, `swarm-event-gateway`, in the
`liycolith-svcs` namespace) out of this registry, so the zprod overlay
targets the same one:

```bash
TAG=0.1.3   # or a git short SHA, whatever you want to roll back to later
REGISTRY=tsh-devops-prod-all-0001-registry.cn-shanghai.cr.aliyuncs.com/devops

docker build -f deploy/Dockerfile --target server -t $REGISTRY/li3d-server:$TAG .
docker build -f deploy/Dockerfile --target web    -t $REGISTRY/li3d-web:$TAG    .
docker push $REGISTRY/li3d-server:$TAG
docker push $REGISTRY/li3d-web:$TAG
```

Then point the zprod overlay at the tag you just pushed:

```bash
cd deploy/k8s/overlays/zprod
kustomize edit set image \
  li3d-server=$REGISTRY/li3d-server:$TAG \
  li3d-web=$REGISTRY/li3d-web:$TAG
```

(or just edit the `REPLACE_ME` tags in
[`k8s/overlays/zprod/kustomization.yaml`](k8s/overlays/zprod/kustomization.yaml)
directly).

**Local build without any registry/cluster**, e.g. to sanity-check the
images build and boot before pushing anywhere:

```bash
docker compose -f deploy/docker-compose.yml build
docker compose -f deploy/docker-compose.yml up
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:4517/api/health
```

This runs `AUTH_MODE=dev-mock` (no real Feishu/IDaaS needed) with a named
Docker volume standing in for the PVC — it's a dev convenience, not how
`k8s/` actually deploys the app.

## 2. Fill in secrets

```bash
cp deploy/k8s/base/secrets/server.env.example deploy/k8s/base/secrets/server.env
```

Edit `deploy/k8s/base/secrets/server.env` **directly in an editor** (don't
paste the client secret into chat/tickets):

- `SESSION_SECRET` → `openssl rand -hex 32`
- `FEISHU_OAUTH_CLIENT_ID` / `FEISHU_OAUTH_CLIENT_SECRET` → from the
  IDaaS/Feishu app registration for `li3d.lilithgames.com`'s callback
  (`https://li3d.lilithgames.com/api/auth/feishu/callback`, already set in
  the zprod overlay's config override)

This file is gitignored — never commit it. `kubectl apply -k` reads it at
apply time via `secretGenerator`, shared by every overlay under `base/`.

Also set `FEISHU_OAUTH_AUTHORIZE_URL` / `FEISHU_OAUTH_TOKEN_URL` /
`FEISHU_OAUTH_USERINFO_URL` in
[`k8s/base/server-config.env`](k8s/base/server-config.env) (or a zprod
override) — they're blank placeholders in the base config and
`AUTH_MODE=feishu-oauth` won't come up healthy without them.

## 3. Review remaining config

`COMFYUI_BASE_URL` / `COMFYUI_INPAINT_BASE_URL` in
[`k8s/base/server-config.env`](k8s/base/server-config.env) still point at
placeholder hosts — set them to your real GPU inference endpoints before
deploying, or image generation will fail even though the app itself comes
up healthy.

## 4. Deploy

```bash
kubectl --context zprod apply -k deploy/k8s/overlays/zprod
```

Verify:

```bash
kubectl --context zprod -n li3d get pods
kubectl --context zprod -n li3d logs deploy/liclick-server -c db-push   # schema push, once per pod start
kubectl --context zprod -n li3d port-forward svc/liclick-server 4517:4517 &
curl -fsS http://127.0.0.1:4517/api/health
```

## 5. GitLab CI (`.gitlab-ci.yml`, repo root)

Modeled on the sibling `lipixel` project's pipeline. Only runs on the
`release` branch (created 2026-08-25 from the fixed `feat/ci` tip and pushed
to origin). The deploy stage additionally requires `[deploy]` in the commit
message (same
double-gate lipixel uses). It builds `build:server` and `build:web` via
Kaniko (one Dockerfile, two `--target`s), then `deploy:k8s` applies
`deploy/k8s/overlays/zprod` and updates both Deployments' images —
`liclick-server`'s `db-push` initContainer and `server` container always
move together, same tag.

**Runner**: no new runner — li3d's project Settings > CI/CD > Runners
showed lipixel's existing runner (`#3274`, unlocked, physically running in
the **ztest** cluster) as an assignable project runner, and it's now
assigned to li3d. That's why the tags below are `ztest, k8s` — a subset of
that runner's actual tags (`ztest, lipixel, k8s`), specific enough that no
other k8s-tagged runner in the group would match. Where the runner
physically runs doesn't matter for the deploy job: it authenticates to
zprod at runtime via `KUBE_CONFIG_B64`, the same way it already
authenticates to the ACR registry regardless of which cluster it builds in.

Required GitLab CI/CD variables (masked + protected, set on the li3d
project — Settings > CI/CD > Variables):

```text
KUBE_CONFIG_B64          base64-encoded kubeconfig for a scoped
                          ServiceAccount (li3d-ci-deployer, see
                          deploy/k8s/infra/ci-deployer/rbac.yaml — NOT
                          cluster-admin, confined to the resource kinds
                          deploy/k8s/overlays/zprod actually contains,
                          inside the li3d namespace)
LI3D_SESSION_SECRET       becomes SESSION_SECRET
LI3D_FEISHU_CLIENT_ID     becomes FEISHU_OAUTH_CLIENT_ID
LI3D_FEISHU_CLIENT_SECRET becomes FEISHU_OAUTH_CLIENT_SECRET
```

The deploy job writes those last three into
`deploy/k8s/base/secrets/server.env` right before `kubectl apply -k` (that
path is gitignored — kustomize's `secretGenerator` needs it to exist as a
real file, unlike lipixel's imperative `kubectl create secret`) and shreds
it immediately after. Optional: `KUBE_CONTEXT` if the kubeconfig has more
than one context (ours only has one, `zprod`, so this isn't needed).

`NODE_IMAGE` / `NGINX_IMAGE` point at ACR mirrors under `devops/` — pushed
there 2026-08-25 (`node:22-bookworm-slim` and
`nginxinc/nginx-unprivileged:1.27-alpine` specifically; neither is one of
lipixel's existing mirrored bases, which only covers `node:22-alpine`), so
Kaniko doesn't need outbound network access to Docker Hub.

**Before this runs for real, still need:** `KUBE_CONFIG_B64`,
`LI3D_SESSION_SECRET`, `LI3D_FEISHU_CLIENT_ID`, `LI3D_FEISHU_CLIENT_SECRET`
set as CI/CD variables on the li3d project (see above) — none of these can
be set from this environment.

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
