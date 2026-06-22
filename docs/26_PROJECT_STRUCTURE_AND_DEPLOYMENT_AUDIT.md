# Project Structure And Deployment Audit

## Repository Shape

- `apps/web`: React/Vite frontend for Projects and the Web3D editor.
- `apps/server`: Node workspace server for auth, local project APIs, asset serving, export routes, and Liclick API status checks.
- `packages/core`: shared engine/domain helpers.
- `packages/shared`: shared schemas and utilities.
- `packages/connector-protocol`: future DCC connector message contracts.
- `docs`: product, architecture, workflow, auth, and deployment notes.
- `scripts`: root-level development and local startup helpers.

## Runtime State

These paths are runtime output and must stay out of Git:

- `workspace/auth.json`
- `workspace/*.db`
- `workspace/users/`
- `workspace/projects/`
- `workspace/trash/`
- `workspace/folders.json`
- `workspace/recent-projects.json`
- `workspace/settings.json`
- `logs/`
- `*.log`
- `*.tsbuildinfo`
- `apps/*/dist`

Local cleanup should not delete real user data under `workspace/users/`, `workspace/auth.json`, or `workspace/*.db` unless explicitly requested.

## Local Windows Development

Use:

```bash
corepack pnpm dev
```

`apps/server/scripts/dev-server.mjs` now performs an initial TypeScript build before starting `node --watch dist/index.js`. This prevents the server from crashing when `dist/` was cleaned before startup.

For a detached local workspace server:

```bash
corepack pnpm workspace:up
```

## Production / Linux / A100 Deployment

Do not run the dev watcher in production. Build first, then run the compiled server with a process manager.

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm build
SERVER_HOST=0.0.0.0 \
SERVER_PORT=4517 \
LICLICK_WORKSPACE_DIR=/data/liclick/workspace \
LICLICK_PUBLIC_WORKSPACE_URL=https://your-api-domain.example \
LICLICK_FRONTEND_URL=https://your-web-domain.example \
LICLICK_ALLOWED_ORIGINS=https://your-web-domain.example \
SESSION_SECRET=replace-with-a-long-random-secret \
SESSION_COOKIE_SECURE=true \
AUTH_MODE=feishu-oauth \
node apps/server/dist/index.js
```

Recommended process managers:

- `systemd` for a single Linux host.
- Docker with a restart policy such as `unless-stopped`.
- `nohup` only for temporary smoke deployment, not long-running production.

The web frontend should be built with the deployed API base:

```bash
VITE_LICLICK_WORKSPACE_API=https://your-api-domain.example corepack pnpm --filter @liclick/web build
```

Then serve `apps/web/dist` through Nginx, Caddy, a CDN, or the final app host.

## Health And Stability Checks

- Server health: `GET /api/health`
- Auth status: `GET /api/auth/provider-status`
- Logged-in user: `GET /api/auth/me`
- Liclick API access: `GET /api/liclick/status`
- Liclick image generation smoke test: `POST /api/liclick/generate-image`

Production should monitor `/api/health` and restart the server process on failure. `/api/liclick/status` is user/session dependent and should be used as an auth/API smoke test, not as the general process liveness check.

## Auth Boundary

The real login path uses the local Liclick / Atlas gateway runtime. The route name `/api/auth/feishu/start` is kept for frontend compatibility, but the server does not create Feishu Open Platform OAuth URLs and does not need Feishu app credentials.

Image generation now has an extra identity guard. The server reads the current Atlas identity and compares its email with the current browser session user before calling Liclick generation. A mismatch returns `403` so one user's browser session cannot silently consume another user's Atlas/Liclick account.

For a shared Linux/A100 deployment, do not rely on a single machine-global Atlas login unless the product intentionally uses a service account. A multi-user deployment needs one of these approaches:

- A per-user Atlas credential/session boundary that the server can select for each request.
- A dedicated Liclick service account with clear billing/permission ownership.
- A server-side token exchange flow that never exposes Atlas or Feishu tokens to the web client.

## Project Isolation And Persistence

Editor state is project-scoped. When a project route loads or switches, the web app must reset these stores from that project's document:

- scene objects
- projected layers
- generations
- reference images

The Generate panel's model, ratio, image size, count, prompt, mode, and upscale strength are stored under `project.settings.imageGeneration`, not in component-only state. Reference image selection is stored through `ReferenceImage.isPrimary`.

Autosave snapshots include objects, layers, generations, captures, baked textures, references, and thumbnails. Data/blob assets are persisted through the workspace asset API before the project JSON is saved. Liclick-hosted `ai-assets.lilithgames.com` generation URLs are also downloaded server-side into the authenticated user's current project directory, then rewritten to relative workspace asset paths. This is required so leaving the editor, returning to Projects, and reopening the same project preserves imported references and generated layers without leaking them into another project.

## Verified Smoke Tests

Latest local verification covered:

- `corepack pnpm --filter @liclick/web typecheck`
- `corepack pnpm --filter @liclick/server typecheck`
- `corepack pnpm --filter @liclick/web lint`
- `corepack pnpm --filter @liclick/server lint`
- `corepack pnpm --filter @liclick/web build`
- `corepack pnpm --filter @liclick/server build`
- Real Atlas/Liclick `generate_image` request with `gpt-image-2`
- Server route `POST /api/liclick/generate-image` returning a real `ai-assets.lilithgames.com` PNG URL
- Server auth/status smoke on `SERVER_PORT=4520`: health OK, current Atlas user `任田 <kianaren@lilith.com>`, Liclick API OK with 8 parsed tools
- Browser route smoke: opening `/project/project-c56d50e8-82ab-4c20-99a4-069da44343f9` and refreshing stays on that project route, keeps the editor mounted, and keeps the project name visible.

The web build still emits a Vite large chunk warning because the editor bundles Three.js-heavy code. Treat that as a performance optimization item, not a failing stability check.

Known non-blocking browser warning: Three.js `FBXLoader` reports unsupported embedded FBX image type `fbm/modddif_image_0_png` for one imported model. The model route and editor stay functional, but texture extraction from that FBX package should be handled in a later importer pass if those embedded images are required.
