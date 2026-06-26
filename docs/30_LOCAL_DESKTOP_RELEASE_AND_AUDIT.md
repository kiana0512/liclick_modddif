# Local Desktop Release And Code Audit

This note records the current Windows desktop release flow, the editor UX changes, and the code audit status for this build.

Updated: 2026-06-26

## Windows Desktop Build

The Windows installer keeps the browser as the main UI and starts the app through a visible terminal.

- Installer script: `corepack pnpm package:windows`
- Output: `dist-installer/Liclick 3D Texture Setup.exe`
- Installer engine: Inno Setup 6
- Installed app ports: backend `4617`, frontend `5673`
- Development ports remain unchanged: backend `4517`, frontend `5173`

Runtime data is kept under:

```text
%LocalAppData%\Liclick 3D Texture\
  runtime\
  workspace\
  logs\
```

The installed launcher copies runtime files into `%LocalAppData%` before installing dependencies or building. This avoids writing package dependencies into `Program Files` during daily use.

## First Run Behavior

The desktop launcher prints full logs in the visible terminal. On first run it may install dependencies and build the app, then opens:

```text
http://127.0.0.1:5673
```

Users should keep the terminal open while using the app. Closing the terminal stops the local backend and frontend services.

## Current Editor UX

- The MVP capture frame is a transient viewport overlay. It appears while the camera is being moved and fades out after a short delay.
- Files can be dropped on the main viewport:
  - model files import as objects
  - image files import as reference images for the selected object
- Multiple models can be imported into one project. The editor keeps one active model in texture mode, selected from the Objects panel.
- Reference images and layers are scoped to the selected object. Older unscoped project data remains visible for compatibility.
- Liclick image generation and Texture Map generation use separate prompts.
- Liclick image generation has a stop button. Stopping marks the local job as cancelled, unlocks the UI, and tells the local server to stop tracking that job.
- The bottom paint dock separates normal texture painting, texture erasing, inpaint-region add, inpaint-region subtract, and the future inpaint API action.
- Normal brush/eraser tools require an active projected layer. The editor warns the user and opens the Layers panel when painting is attempted without a valid target layer.
- Inpaint add/subtract tools edit only the inpaint selection mask. They do not erase projected-layer pixels.
- Surface painting works only on model meshes with UVs. Empty viewport space continues to use the normal orbit/camera behavior.
- Surface paint, eraser, and inpaint mask strokes are attached to model UV space and participate in the existing undo/redo flow one stroke at a time.
- Hidden perf URLs can inject synthetic 100-model and 100-layer editor scenes for repeatable runtime testing.

## Code Audit Summary

Low-risk cleanup completed in this pass:

- Cached the paintable mesh list used by surface-paint raycasts so pointer movement no longer traverses the full model hierarchy every frame.
- Switched surface-paint raycasts to a non-recursive flat mesh list and kept paint overlay meshes out of the raycast/material processing path.
- Removed duplicate full-canvas mask alpha scans at stroke commit; inpaint add/subtract state now updates from the stroke history path.
- Capped unbaked projected-layer live preview to 16 visible layers. A baked stack texture remains the intended fast path for full 100-layer projects.
- Added `PerfScenarioLoader` for `100-models`, `100-layers`, and `100-layers-unbaked` browser runtime stress tests.
- Improved `scripts/perf-audit.mjs` stress output with status-code/error aggregation and first-failure details.
- Cleaned generated build and packaging output before release: `.codex-tmp`, `apps/web/dist`, `apps/server/dist`, and the old `dist-installer`.
- Shared generation upsert/failure handling in `GeneratePanel` to reduce duplicated state writes.
- Consolidated viewport drag payload detection so drag events scan file lists once.
- Kept texture mode rendering focused on the currently selected imported model instead of rendering every imported model.
- Kept generated layers, reference images, and new empty layers object-scoped.

Build checks for this release should run:

```text
corepack pnpm -r typecheck
corepack pnpm -r lint
corepack pnpm -r build
corepack pnpm perf:audit
corepack pnpm package:windows
```

The 2026-06-26 local backend stress pass reached:

- 225,295 health requests at 30 users over 15 seconds, 0 failed, p95 3.4 ms.
- 408,781 health requests at 80 users over 30 seconds, 0 failed, p95 10.1 ms.

The 2026-06-26 browser runtime stress pass reached:

- 100 models: 59.95 FPS average over 240 warm sampled frames, p95 frame time 16.80 ms, `fallbackTicks=0`, no console warnings/errors.
- 100 projected layers with baked stack cache: 59.95 FPS average over 240 warm sampled frames, p95 frame time 16.80 ms, `fallbackTicks=0`, no console warnings/errors.
- 100 projected layers without baked stack, using the 16-layer live-preview guard: 59.95 FPS average over 240 warm sampled frames, p95 frame time 16.80 ms, `fallbackTicks=0`, no console warnings/errors.

## Known Risk Areas

- `GeneratePanel` and `EditorPage` are still large orchestration components. Future cleanup should split generation job state, reference import, project restore, and bake orchestration into smaller hooks or services.
- Projected-layer preview and UV bake remain the most performance-sensitive path. Avoid adding React state updates inside per-frame or per-fragment logic.
- The stop button cancels local tracking immediately. If a Liclick task has already been submitted to Atlas, the remote task may still finish server-side, but the local UI no longer waits for it or applies it.
- Legacy unscoped references/layers remain visible for compatibility. New project data should always write `objectId`.
- Large Vite chunk warnings are currently known and non-blocking, but code splitting should be considered after the texture workflow stabilizes.
