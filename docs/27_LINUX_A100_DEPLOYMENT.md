# Linux A100 Deployment

This document describes how to deploy Liclick 3D Texture on an Ubuntu/Linux A100 server with systemd persistence.

## Scripts

- `scripts/linux-start.sh`
  - One command for first install, config update, version update, rebuild, service restart, nginx reload, and health checks.
- `scripts/linux-stop.sh`
  - Stops the Liclick workspace server. Nginx stays up by default.
- `scripts/setup-linux-a100.sh`
  - Lower-level idempotent setup script used by `linux-start.sh`.

## Recommended First Deploy

Run from the repo root on the Linux server. The default public shape is fixed to port `46777`:

```bash
sudo PUBLIC_URL=http://10.3.2.59:46777/liclick/texture bash scripts/linux-start.sh
```

If the server IP changes, keep the port and choose a path prefix:

```bash
sudo PUBLIC_URL=http://YOUR_SERVER_IP:46777/liclick/texture bash scripts/linux-start.sh
```

The script will:

- install OS packages, Node.js, pnpm, nginx, and build tools
- install `@lilith/atlas-skillhub`
- copy the repo to `/opt/liclick-3d-texture`
- install workspace dependencies
- build `@liclick/server`
- build `@liclick/web`
- write `/etc/liclick-3d-texture.env`
- write and enable `liclick-3d-texture.service`
- write and enable nginx routing on public port `46777`
- run backend and frontend smoke checks

## Updating A Version

Pull or copy the new repo version onto the server, then rerun:

```bash
sudo PUBLIC_URL=http://10.3.2.59:46777/liclick/texture bash scripts/linux-start.sh
```

This is safe to rerun. It preserves the existing `SESSION_SECRET` from `/etc/liclick-3d-texture.env`, rebuilds the app, reloads nginx, and restarts systemd.

## Stop

Stop only the app backend:

```bash
sudo bash scripts/linux-stop.sh
```

Stop both backend and nginx:

```bash
sudo STOP_NGINX=1 bash scripts/linux-stop.sh
```

## Service Commands

```bash
sudo systemctl status liclick-3d-texture.service
sudo systemctl restart liclick-3d-texture.service
sudo journalctl -u liclick-3d-texture.service -f
```

The service is enabled with systemd, so it starts again after server reboot.

## Important Paths

- App copy: `/opt/liclick-3d-texture`
- Workspace data: `/var/lib/liclick-3d-texture/workspace`
- Env file: `/etc/liclick-3d-texture.env`
- Systemd unit: `/etc/systemd/system/liclick-3d-texture.service`
- Nginx site: `/etc/nginx/sites-available/liclick-3d-texture`

## Config Variables

Common variables:

```bash
PUBLIC_URL=https://your-domain.example
PUBLIC_PORT=46777
PUBLIC_PATH=/liclick/texture
APP_USER=liclick
APP_DIR=/opt/liclick-3d-texture
WORKSPACE_DIR=/var/lib/liclick-3d-texture/workspace
SERVER_PORT=4517
NODE_MAJOR=22
INSTALL_ATLAS=1
```

Example:

```bash
sudo PUBLIC_URL=http://10.3.2.59:46777/liclick/texture SERVER_PORT=4517 bash scripts/linux-start.sh
```

## Atlas / Liclick Login

The backend calls Liclick through Atlas Skillhub. The systemd service runs as user `liclick`, so Atlas credentials must be available to that user.

For a headless server, copy a valid token file:

```bash
sudo cp ~/.atlas-ai-gateway-oauth.json /home/liclick/.atlas-ai-gateway-oauth.json
sudo chown liclick:liclick /home/liclick/.atlas-ai-gateway-oauth.json
sudo chmod 600 /home/liclick/.atlas-ai-gateway-oauth.json
sudo systemctl restart liclick-3d-texture.service
```

Check access:

```bash
curl http://127.0.0.1:4517/api/health
```

Browser login/session still depends on the app auth flow, but Atlas API execution depends on the service user's Atlas token.

## Nginx Routing

Nginx serves the frontend static build and proxies under the configured path prefix:

- `/liclick/texture/api/` to `http://127.0.0.1:4517`
- `/liclick/texture/workspace/` to `http://127.0.0.1:4517`
- `/liclick/texture/project/...` and other frontend paths to the SPA `index.html`

If adding HTTPS with a load balancer or certbot, rerun deployment with:

```bash
sudo PUBLIC_URL=https://texture.example.com/liclick/texture bash scripts/linux-start.sh
```

This makes cookies secure and builds the frontend with the correct backend URL.

## Health Checks

Backend:

```bash
curl -fsS http://127.0.0.1:4517/api/health
```

Frontend through nginx:

```bash
curl -fsSI http://127.0.0.1:46777/liclick/texture/
```

Logs:

```bash
sudo journalctl -u liclick-3d-texture.service -n 120 --no-pager
```

## Known Runtime Note

Generation requests are submitted through the local backend to Atlas/Liclick. The backend persists local generation job records in `workspace/generation-jobs.json` and stores the real Liclick `task_id` as soon as it is returned. The frontend locks generation per project and keeps polling by `task_id` until the result image arrives or the task fails.

Concurrent generation is intentionally blocked per user project. Different users and different projects can still work independently.

## Logs

```bash
sudo journalctl -u liclick-3d-texture.service -f
sudo journalctl -u nginx -f
```

## Optional Load Smoke

After the stability fixes are verified manually, run a lightweight public endpoint smoke:

```bash
BASE_URL=http://10.3.2.59:46777/liclick/texture CONCURRENCY=100 DURATION_SECONDS=60 node scripts/load-test-a100.mjs
```

This does not submit image generation jobs by default.
