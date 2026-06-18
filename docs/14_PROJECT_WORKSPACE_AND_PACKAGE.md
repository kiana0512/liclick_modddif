# Project Workspace And Package

Phase 6 introduces a local workspace server so Liclick behaves more like a project-based creative tool than a browser demo.

## Local Workspace Server

The server lives in `apps/server` and uses Node.js built-in HTTP and filesystem modules. It does not require Express or other runtime dependencies.

The normal local startup command is:

```text
corepack pnpm dev
```

The root `dev` script starts both the web app and the local workspace server. Use `corepack pnpm dev:web` or `corepack pnpm dev:server` only when debugging one side in isolation.

If a workspace server is already healthy on the configured port, starting another server process keeps the dev script alive instead of crashing with `EADDRINUSE`. This prevents `corepack pnpm dev` from failing when a previous local session is already using the workspace server.

For longer Windows sessions, a detached local server can be started with:

```text
corepack pnpm workspace:up
```

This is a convenience for local work. Production deployment should run the server through a real process manager.

Default workspace path:

```text
workspace/
```

The path can be overridden with:

```text
LICLICK_WORKSPACE_DIR
```

Server default port:

```text
4517
```

The port can be overridden with:

```text
LICLICK_WORKSPACE_PORT
```

## Workspace Layout

```text
workspace/
  projects/
  folders.json
  recent-projects.json
  settings.json
```

Each project is stored as:

```text
workspace/projects/<projectSlug>/
  project.liclick.json
  assets/
    models/
    references/
    captures/
    generations/
    layers/
    baked/
  exports/
  thumbnails/
  autosave/
```

## project.liclick.json

The project document stores project metadata, object records, references, captures, generations, layers, baked textures, settings, current workspace mode, active object/layer ids, and `workspaceVersion`.

Asset paths should be project-relative:

```text
assets/models/chair.fbx
assets/captures/capture-001-color.png
assets/baked/basecolor-001.png
```

The web app resolves these paths through:

```text
http://127.0.0.1:<port>/workspace/projects/<projectSlug>/...
```

## Autosave

When a local-server project is dirty, the web app debounces for 1.5 seconds and sends the latest project snapshot to the server. The server writes:

- `project.liclick.json`
- a rolling autosave copy under `autosave/`

The server keeps the newest five autosave files.

## .liclick3d Package

`.liclick3d` is the planned portable package format. It will be a zip containing:

- `project.liclick.json`
- `assets/models`
- `assets/references`
- `assets/captures`
- `assets/generations`
- `assets/layers`
- `assets/baked`
- `thumbnails`

Phase 6 exposes an Export Project Package API stub. The zip writer is not implemented yet.

## Browser Fallback

The older File System Access / JSON download path remains as a fallback for mock or offline use. The intended primary flow is the local workspace server.

## Workspace Home UX

The project home sidebar routes to Projects, Folders, Assets, and Settings sections. Settings owns the Chinese / English language switch and the local startup command reminder.

New Folder uses an in-app modal rather than `window.prompt`, so folder creation stays visually consistent with the Liclick workspace style.

When the local workspace server is offline, the mock starter projects remain visible. This keeps the first-run experience usable and visually rich instead of showing an empty error state.

Project cards use the saved project thumbnail when available. The editor captures a viewport thumbnail during project saves so imported-model projects can be identified visually on the home page.

Workspace health checks intentionally use a short timeout. When the server is not running, the UI should return to the offline state quickly instead of making the project page feel delayed.

## Concurrent Local Writes

Folder creation is queued inside the local server because it reads and rewrites `folders.json`. JSON writes use a temporary file followed by rename, reducing the chance of partial reads while the workspace is being written.

This is suitable for local MVP use and light team testing. A production multi-user deployment should move shared workspace metadata to a database or another transactional storage layer.

## Model Restore

Imported model files are saved under `assets/models/` for local-server projects. When a project is loaded through the workspace server, relative model paths are resolved into `http://127.0.0.1:<port>/workspace/...` URLs. The web editor then reloads the saved FBX / GLB / GLTF / OBJ into Three.js and reapplies the stored object id and transform.
