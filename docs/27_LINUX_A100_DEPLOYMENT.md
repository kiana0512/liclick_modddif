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
  ATLAS_LOGIN_MODE=interactive \
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
  ATLAS_LOGIN_MODE=interactive \
  bash scripts/linux-start.sh
```

The script copies the Git working copy to `/opt/liclick-3d-texture` before building. Do not edit `/opt/liclick-3d-texture` by hand; it is a generated deployment copy.

## First Deploy Or Update

Run from the Git repo root on the server:

```bash
sudo MOUNT_MODE=comfyui \
  PUBLIC_URL=http://10.3.2.59:46001/liclick/texture \
  ATLAS_LOGIN_MODE=interactive \
  bash scripts/linux-start.sh
```

This command is idempotent. Use the same command for version updates after `git pull`.

It will:

- install Node.js, pnpm, build tools, nginx packages, and Atlas Skillhub
- copy source to `/opt/liclick-3d-texture`
- install dependencies and build frontend/backend
- write `/etc/liclick-3d-texture.env`
- create and enable `liclick-3d-texture.service`
- install a ComfyUI custom node mount into `/data/ai_art_comfyui/apps/ComfyUI/custom_nodes/liclick-3d-texture-mount`
- keep persistent data under `/var/lib/liclick-3d-texture/workspace`

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

Use:

```bash
ATLAS_LOGIN_MODE=interactive
```

Each browser user clicks Feishu Login and completes IDaaS/Feishu authorization in their own browser. The server creates an isolated Atlas home directory for that user under:

```text
/var/lib/liclick-3d-texture/workspace/atlas-homes/
```

User sessions and user metadata are stored in:

```text
/var/lib/liclick-3d-texture/workspace/auth.json
```

User projects, folders, imported models, references, generated images, layers, captures, and baked textures are stored per user under:

```text
/var/lib/liclick-3d-texture/workspace/users/<userId>/
```

Do not delete `/var/lib/liclick-3d-texture/workspace` during updates.

The Atlas CLI prints a localhost callback URL during interactive login. On A100 this localhost belongs to the server, not the user's browser, so Liclick rewrites that callback through the public app path:

```text
http://10.3.2.59:46001/liclick/texture/api/auth/atlas-callback/<loginId>/callback
```

The backend then forwards the callback to the server-local Atlas listener. If login fails, the page should show the failure reason instead of silently doing nothing.

To verify the server is running the new callback-capable backend:

```bash
curl -fsS http://127.0.0.1:4517/api/health
curl -fsS http://127.0.0.1:46001/liclick/texture/_liclick_mount_health
curl -i http://127.0.0.1:46001/liclick/texture/api/auth/provider-status
sudo journalctl -u liclick-3d-texture.service -n 120 --no-pager
```

If the browser console shows `crypto.randomUUID is not a function`, the server is still serving an old frontend bundle. Run `git pull` and `scripts/linux-start.sh` again, then hard refresh the browser.

The health response from the new backend includes:

```json
{"features":{"atlasRemoteCallback":true,"browserHttpUuidFallback":true}}
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
  ATLAS_LOGIN_MODE=interactive \
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
  ATLAS_LOGIN_MODE=interactive \
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
