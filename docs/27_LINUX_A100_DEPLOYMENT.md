# Linux A100 Deployment

This is the current A100 deployment path for the shared server version.

The recommended temporary public entry is the existing ComfyUI web server:

```text
http://10.3.2.59:46001/liclick/texture
```

Liclick 3D Texture still runs its own backend as a systemd service on `127.0.0.1:4517`. ComfyUI only mounts the frontend path and proxies `/api` and `/workspace` to that backend.

## Server Git Workflow

Use Git as the only source update path. Keep one Git working copy on the server, for example:

```text
/data/ai_art_comfyui/apps/Liclick 3D Texture
```

First clone, when the server does not have a Git copy yet:

```bash
cd /data/ai_art_comfyui/apps
git clone <YOUR_REPO_URL> "Liclick 3D Texture"
cd "Liclick 3D Texture"
```

Update an existing server copy:

```bash
cd "/data/ai_art_comfyui/apps/Liclick 3D Texture"
git status --short
git pull --ff-only origin main
sudo MOUNT_MODE=comfyui \
  PUBLIC_URL=http://10.3.2.59:46001/liclick/texture \
  ATLAS_LOGIN_MODE=service-token \
  bash scripts/linux-start.sh
```

Or let the startup script pull before deploying:

```bash
cd "/data/ai_art_comfyui/apps/Liclick 3D Texture"
sudo MOUNT_MODE=comfyui \
  UPDATE_FROM_GIT=1 \
  GIT_REMOTE=origin \
  GIT_REF=main \
  PUBLIC_URL=http://10.3.2.59:46001/liclick/texture \
  ATLAS_LOGIN_MODE=service-token \
  bash scripts/linux-start.sh
```

The script copies the Git working copy to `/opt/liclick-3d-texture` before building. Do not edit `/opt/liclick-3d-texture` by hand; it is a generated deployment copy.

## First Deploy Or Update

Run from the Git repo root on the server:

```bash
sudo MOUNT_MODE=comfyui \
  PUBLIC_URL=http://10.3.2.59:46001/liclick/texture \
  ATLAS_LOGIN_MODE=service-token \
  bash scripts/linux-start.sh
```

This command is idempotent. Use the same command for version updates after `git pull`.

It will:

- install Node.js, pnpm, build tools, nginx packages, and Atlas Skillhub
- install `lsof` and `psmisc` for deployment-time port cleanup
- copy source to `/opt/liclick-3d-texture`
- install dependencies and build frontend/backend
- write `/etc/liclick-3d-texture.env`
- create and enable `liclick-3d-texture.service`
- install a ComfyUI custom node mount into `/data/ai_art_comfyui/apps/ComfyUI/custom_nodes/liclick-3d-texture-mount`
- keep persistent data under `/var/lib/liclick-3d-texture/workspace`

## Port Cleanup Policy

The Linux deploy scripts now free required ports before starting services.

Default behavior:

- `LICLICK_AUTO_KILL_PORTS=1`
- stop `liclick-3d-texture.service`
- free `SERVER_PORT` with `SIGTERM`, then `SIGKILL` if needed
- in nginx mode, stop nginx and free `PUBLIC_PORT`
- if a port still cannot be freed, abort with the exact manual command:

```bash
sudo lsof -ti:PORT | xargs -r sudo kill -9
```

Disable automatic killing only when debugging a shared host:

```bash
sudo LICLICK_AUTO_KILL_PORTS=0 MOUNT_MODE=comfyui \
  PUBLIC_URL=http://10.3.2.59:46001/liclick/texture \
  bash scripts/linux-start.sh
```

In `MOUNT_MODE=comfyui`, the script frees the backend `SERVER_PORT` only. It does not kill ComfyUI's public listener because ComfyUI owns that process.

After first install, restart ComfyUI once so it loads the custom node:

```bash
# Use the server's existing ComfyUI restart method.
# If it is systemd-managed, for example:
sudo systemctl restart comfyui
```

If ComfyUI is not managed by systemd, use the server panel or its existing restart command.

## Health Checks

Backend:

```bash
curl -fsS http://127.0.0.1:4517/api/health
```

Performance and garbage audit:

```bash
node scripts/perf-audit.mjs
LICLICK_STRESS_BASE_URL=http://127.0.0.1:4517 \
LICLICK_STRESS_USERS=30 \
LICLICK_STRESS_SECONDS=30 \
node scripts/perf-audit.mjs --stress
```

A healthy run should keep `workspace/generation-jobs.json` below 50 MB, report no unexpected large runtime files, and complete the 30-user health stress with zero failed requests.

ComfyUI mount:

```bash
curl -fsS http://127.0.0.1:46001/liclick/texture/_liclick_mount_health
```

Frontend:

```bash
curl -I http://127.0.0.1:46001/liclick/texture/
curl -I http://10.3.2.59:46001/liclick/texture/
```

Browser URL:

```text
http://10.3.2.59:46001/liclick/texture/projects
```

## Auth Smoke Tests

Before pushing an update to users, run the local OAuth smoke test from the Git repo root:

```bash
corepack pnpm smoke:auth
```

This starts a local OAuth-compatible mock provider, starts the Liclick backend with direct Web OAuth enabled, follows the authorize callback, verifies the `liclick_3d_session` cookie, and confirms `/api/auth/me` returns the logged-in user. This smoke test covers the generic OAuth fallback; the production path uses the company IDaaS SP flow.

Expected success marker:

```text
OAuth smoke test passed.
```

On A100, after deployment, verify that the server is using the Atlas gateway path:

```bash
curl -fsS http://127.0.0.1:4517/api/health
curl -fsS http://127.0.0.1:46001/liclick/texture/api/auth/provider-status
```

The provider status must include:

```json
{"feishuLoginProvider":"atlas-cli","atlasLoginMode":"interactive"}
```

Clicking `飞书登录` starts the Atlas gateway login flow. In the current interactive mode, Atlas expects a server-local callback at `localhost:20265`.

If Atlas reports that its local callback port is occupied, rerun deployment with service-token mode for shared server use:

```bash
sudo MOUNT_MODE=comfyui \
  PUBLIC_URL=http://10.3.2.59:46001/liclick/texture \
  ATLAS_LOGIN_MODE=service-token \
  bash scripts/linux-start.sh
```

## Logs

Backend service:

```bash
sudo systemctl status liclick-3d-texture.service
sudo journalctl -u liclick-3d-texture.service -f
```

ComfyUI mount logs are in the existing ComfyUI process logs. Search for:

```text
[Liclick 3D Texture] Mounted /liclick/texture
```

## Stop

Stop only the Liclick backend:

```bash
sudo MOUNT_MODE=comfyui bash scripts/linux-stop.sh
```

Remove the ComfyUI mount as well:

```bash
sudo MOUNT_MODE=comfyui REMOVE_COMFYUI_MOUNT=1 bash scripts/linux-stop.sh
```

Restart ComfyUI after removing the mount.

## User Login Model

The temporary A100 test path uses Atlas service-token mode. The server uses one real Atlas token cache installed for the Linux `liclick` service user. All browser testers share that Atlas / Liclick API credential so AI image generation uses the real account permissions.

Install or refresh the token cache after deployment:

```bash
cp /path/to/.atlas-ai-gateway-oauth.json secrets/.atlas-ai-gateway-oauth.json
sudo MOUNT_MODE=comfyui \
  PUBLIC_URL=http://10.3.2.59:46001/liclick/texture \
  ATLAS_LOGIN_MODE=service-token \
  bash scripts/linux-start.sh
```

The deployment script installs `secrets/.atlas-ai-gateway-oauth.json` into `/home/liclick/.atlas-ai-gateway-oauth.json` and verifies it with `atlas-skillhub gateway status`.

If the token file is on your local Windows machine, copy it separately from git into the server repo's ignored `secrets` folder:

```powershell
scp "$env:USERPROFILE\.atlas-ai-gateway-oauth.json" "<ssh-user>@10.3.2.59:/data/ai_art_comfyui/apps/Liclick 3D Texture/secrets/.atlas-ai-gateway-oauth.json"
```

Then deploy/update normally:

```bash
cd "/data/ai_art_comfyui/apps/Liclick 3D Texture"
sudo MOUNT_MODE=comfyui \
  PUBLIC_URL=http://10.3.2.59:46001/liclick/texture \
  ATLAS_LOGIN_MODE=service-token \
  bash scripts/linux-start.sh
```

To use a different token path, pass it explicitly:

```bash
sudo MOUNT_MODE=comfyui \
  PUBLIC_URL=http://10.3.2.59:46001/liclick/texture \
  ATLAS_LOGIN_MODE=service-token \
  ATLAS_TOKEN_FILE=/tmp/atlas-token.json \
  bash scripts/linux-start.sh
```

Do not commit the token file or paste it into chat/logs. Keep the ignored `secrets/.atlas-ai-gateway-oauth.json` on the server if you want future deploys to reinstall it automatically; delete temporary copies such as `/tmp/atlas-token.json`.

Local development remains normal interactive Atlas login. The service-token mode is only the A100 deployment default.

The later product-grade A100 solution should be server-side browser login: A100 starts Atlas, opens the Atlas/IDaaS URL in a browser running on A100, streams or remotes that browser to the user for scanning/confirmation, and lets IDaaS redirect to A100's own `localhost:20265`.

Start/update A100 with the Atlas gateway settings:

```bash
sudo MOUNT_MODE=comfyui \
  PUBLIC_URL=http://10.3.2.59:46001/liclick/texture \
  ATLAS_LOGIN_MODE=service-token \
  LICLICK_ENABLE_ATLAS_LOCAL_LOGIN=true \
  IDAAS_JWT_SSO_ENABLED=false \
  bash scripts/linux-start.sh
```

The direct `FEISHU_OAUTH_*` settings are only for smoke tests or a non-IDaaS OAuth provider. Do not set them for the Atlas gateway production path.

If a direct OAuth provider requires Basic auth for the token endpoint, add:

```bash
FEISHU_OAUTH_TOKEN_AUTH_METHOD=client_secret_basic
```

If a direct OAuth provider needs extra authorize params, pass them as comma-separated `key=value` pairs:

```bash
FEISHU_OAUTH_EXTRA_AUTHORIZE_PARAMS='enterpriseId=lilith,prompt=login'
```

Do not configure the real app with local mock URLs such as `http://127.0.0.1:5199/authorize`. The backend blocks loopback OAuth providers unless `FEISHU_OAUTH_ALLOW_LOOPBACK_PROVIDER=true`, and that flag is only for `corepack pnpm smoke:auth`.

IDaaS SP mode remains available only if the IDaaS application has registered a stable Liclick Service URL. Leave `IDAAS_JWT_SSO_ENABLED=false` on A100 unless that registration exists.

Each browser user gets their own Liclick session cookie. User sessions and user metadata are stored in:

```text
/var/lib/liclick-3d-texture/workspace/auth.json
```

User projects, folders, imported models, references, generated images, layers, captures, and baked textures are stored per user under:

```text
/var/lib/liclick-3d-texture/workspace/users/<userId>/
```

Do not delete `/var/lib/liclick-3d-texture/workspace` during updates.

To verify the server is running the Web OAuth-capable backend:

```bash
curl -fsS http://127.0.0.1:4517/api/health
curl -fsS http://127.0.0.1:46001/liclick/texture/_liclick_mount_health
curl -i http://127.0.0.1:46001/liclick/texture/api/auth/provider-status
sudo journalctl -u liclick-3d-texture.service -n 120 --no-pager
```

`/api/auth/provider-status` should include:

```json
{"feishuLoginProvider":"atlas-cli","atlasLoginMode":"interactive"}
```

If login redirects to `localhost:20265` in the user's local browser, the callback cannot reach A100. Use a server-side browser login flow or an IDaaS/Atlas flow that supports a server callback/device code.

If the browser console shows `crypto.randomUUID is not a function`, the server is still serving an old frontend bundle. Run `git pull` and `scripts/linux-start.sh` again, then hard refresh the browser.

The health response from the new backend includes:

```json
{"features":{"webOAuthCookieSession":true,"atlasCliLogin":true,"browserHttpUuidFallback":true}}
```

## Runtime Paths

- Deployed app: `/opt/liclick-3d-texture`
- Persistent workspace data: `/var/lib/liclick-3d-texture/workspace`
- Env file: `/etc/liclick-3d-texture.env`
- Systemd unit: `/etc/systemd/system/liclick-3d-texture.service`
- ComfyUI mount: `/data/ai_art_comfyui/apps/ComfyUI/custom_nodes/liclick-3d-texture-mount`

## Update Safety

The update script uses `rsync --delete` into `/opt/liclick-3d-texture`, but excludes runtime workspace and logs. Durable user data lives in `/var/lib/liclick-3d-texture/workspace`, not inside `/opt`.

To update manually:

```bash
cd "/data/ai_art_comfyui/apps/Liclick 3D Texture"
git pull --ff-only origin main
sudo MOUNT_MODE=comfyui \
  PUBLIC_URL=http://10.3.2.59:46001/liclick/texture \
  ATLAS_LOGIN_MODE=service-token \
  bash scripts/linux-start.sh
```

Then restart ComfyUI only if the mount file changed or this is the first install.

To update with one deploy command:

```bash
cd "/data/ai_art_comfyui/apps/Liclick 3D Texture"
sudo MOUNT_MODE=comfyui \
  UPDATE_FROM_GIT=1 \
  GIT_REF=main \
  PUBLIC_URL=http://10.3.2.59:46001/liclick/texture \
  ATLAS_LOGIN_MODE=service-token \
  bash scripts/linux-start.sh
```

## Cleanup Audit

Safe cleanup targets:

```bash
cd "/data/ai_art_comfyui/apps/Liclick 3D Texture"
git clean -fdX
```

This removes ignored build caches such as `node_modules`, `.vite`, `dist`, logs, and `*.tsbuildinfo` from the Git working copy only. It does not touch tracked source files.

Never run cleanup against these runtime data directories unless you intentionally want to delete user data:

```text
/var/lib/liclick-3d-texture/workspace
/opt/liclick-3d-texture
/data/ai_art_comfyui/apps/ComfyUI/output
/data/ai_art_comfyui/apps/ComfyUI/input
```

## Generation Behavior

Image generation is locked per project. A project cannot submit a second Liclick task until the current task ID finishes or fails. The backend persists job records in:

```text
/var/lib/liclick-3d-texture/workspace/generation-jobs.json
```

If a browser refresh happens while a task is running, the frontend restores the running state from the saved generation record and keeps polling by task ID.

## Future Public Port Mode

When a dedicated public port or domain is available, `MOUNT_MODE=nginx` can be used again:

```bash
sudo MOUNT_MODE=nginx \
  PUBLIC_URL=http://10.3.2.59:46777/liclick/texture \
  bash scripts/linux-start.sh
```

For now, prefer `MOUNT_MODE=comfyui` because the server platform already exposes the ComfyUI port.
