# Local Desktop Release And Code Audit

This note records the current Windows desktop release flow, the editor UX changes, and the code audit status for this build.

Updated: 2026-06-30

## Windows Desktop Build

The Windows installer now starts a lightweight Electron desktop shell instead of a visible terminal.

- Installer script: `corepack pnpm package:windows`
- Output: `dist-installer/Liclick 3D Texture Setup.exe`
- Installer engine: Inno Setup 6
- Desktop shell: `apps/desktop/main.mjs`
- Electron runtime: copied from `node_modules/electron/dist` into `{app}\electron`
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

The Start Menu and desktop shortcuts point to `{app}\electron\Liclick 3D Texture.exe` with `apps\desktop\main.mjs` as the Electron entry. A `Liclick 3D Texture CLI` Start Menu shortcut remains available for support/debug sessions.

## First Run Behavior

The Electron shell starts the existing Node launcher with hidden child windows and keeps the service lifecycle attached to the tray app. On first run it may install dependencies and build the local services, then enables the workspace button for:

```text
http://127.0.0.1:5673
```

The shell shows frontend/backend health, the runtime/workspace paths, the launcher PID, and a live log view. Closing the window hides the shell to the system tray by default so services keep running. The tray menu exposes a full quit action; quitting completely stops the managed frontend/backend services.

The legacy CLI launcher still supports the old browser-opening behavior. Electron sets `LICLICK_OPEN_BROWSER=0` for the hidden service process and opens the workspace from the shell once frontend/backend health checks both pass.

## Current Editor UX

- The MVP capture frame is a transient viewport overlay. It appears while the camera is being moved and fades out after a short delay.
- Files can be dropped on the main viewport:
  - model files import as objects
  - image files import as reference images for the selected object
- Multiple models can be imported into one project. The editor keeps one active model in texture mode, selected from the Objects panel.
- Reference images and layers are scoped to the selected object. Older unscoped project data remains visible for compatibility.
- Liclick image generation and Texture Map generation use separate prompts.
- Normal Liclick image generation keeps the preview `Add to references` shortcut. Texture Map generation hides that shortcut so generated texture outputs are accepted as projected layers instead of being recycled into the material-reference library.
- Liclick image generation has a stop button. Stopping marks the local job as cancelled, unlocks the UI, and tells the local server to stop tracking that job.
- The bottom paint dock separates normal texture painting, texture erasing, inpaint-region add, inpaint-region subtract, and the current local repaint submit action.
- Normal brush/eraser tools require an active projected layer. The editor warns the user and opens the Layers panel when painting is attempted without a valid target layer.
- Inpaint add/subtract tools edit only the inpaint selection mask. They do not erase projected-layer pixels.
- Surface painting works only on model meshes with UVs. Empty viewport space continues to use the normal orbit/camera behavior.
- Surface paint, eraser, and inpaint mask strokes are attached to model UV space and participate in the existing undo/redo flow one stroke at a time.
- Hidden perf URLs can inject synthetic 100-model and 100-layer editor scenes for repeatable runtime testing.
- Projected layer preview now separates loose coverage from strict quality. `Blend` chooses the best projected candidates without layer-order dependence; `Overlay` paints over the blended base in stack order.
- Layer rows expose distinct blend/overlay state, layer opacity, and projection strength. Opacity can be dragged down to 0, where the icon becomes an empty circle.
- Uncovered projected fragments fall back to the model/base material instead of showing black edges, white masks, or accidental checker diagnostics.
- The global Auto UV bake setting gates every bake entry point. When it is off, double-click and manual bake actions do not bake; newly accepted projected layers stay as live projection previews.
- Project thumbnails are captured from the real WebGL viewport after projection changes. Grid and paint/helper overlays are hidden during the thumbnail capture and restored immediately afterwards.
- The Projects page and bottom editor tools now use the shared Chinese / English string store instead of fixed English labels.
- Local repaint now uses a focused current-view dialog. The brush paints continuous strokes instead of separated dabs, the editable mask is clipped to the visible model alpha, and the request reuses the same authenticated Atlas/Liclick gateway as normal image generation.
- Current-view local repaint captures and submits a full viewport frame plus a full-size mask. The returned image is treated as the same full-frame coordinate space and is not cropped into a small ROI before compositing.
- Current-view local repaint captures the source frame and selection mask at up to 2x viewport resolution, capped at 4096 px on the long side. This keeps the projected UV repair patch sharper without changing the visible camera framing.
- Local repaint persists the session id, task id, camera snapshot, full source frame, masks, status, and returned preview in local storage. Closing the dialog or pressing F5 restores an in-flight or completed task instead of losing the state.
- Local repaint has a stop button while submitting. It aborts the local wait path, asks the local server to stop tracking the edit job when possible, and keeps the UI available for a fresh generation.
- Local repaint mask export now records the logical white mask separately from the visible pink brush pattern and removes small isolated white specks from the auto-detected blank-area mask.
- Local repaint first attempts a LiClick-web-like `局部重绘_volcengine` ComfyUI payload through the Atlas JSON-RPC gateway. If the Atlas `generate_image` wrapper rejects that custom workflow, the server falls back to the supported `gpt-image-2` image edit path by uploading the base image and mask through `upload_asset`, passing them as `reference_images`, and protecting unmasked pixels again on the client composite. It does not require a separate browser token or API-key environment variable.
- Turntable WebM export now resyncs projected-layer object-matrix uniforms every frame while the model rotates, so projected/texture-map layers stay attached in the recorded video.
- UV preview now separates unbaked `uvOverlayTexture` from the baked/base material path. This prevents a fresh UV overlay from pretending to be the flattened BaseColor texture in the viewport.
- Projected and merged-UV layers now expose an `Edit image` action. The editor opens a compact Photoshop-style pixel workspace with brush, eraser, fill, rectangular selection, eyedropper, move, layer opacity/blend controls, color adjustment, transform actions, and Ctrl+Z/Ctrl+Y history.
- Projected-layer image editing preserves the original projection metadata. The mapped preview temporarily replaces only the edited layer image, keeps the full visible material/layer stack enabled, moves the viewport camera to the layer's projected MVP direction, and captures a high-resolution model-space preview for checking the real mapped result.
- Mapped-preview refreshes are treated as temporary render transactions. They are suppressed from project-layer synchronization and restore the layer stack and active layer after capture, so edits only become permanent after `Apply edit`.
- Merged-UV image editing is treated as UV-space pixel editing. The edited pixels are written back to the UV layer image without changing projection-camera metadata.
- Global editor undo/redo stores labeled object/layer snapshots per project in `sessionStorage`. Ctrl+Z/Ctrl+Y restores the snapshot, keeps the redo chain consistent, and shows a top-center toast with the action label, for example `删除图层：...` or `应用图像编辑：...`.
- The current editable object/layer snapshot is persisted after project/model restore finishes, so a browser refresh can recover local object/layer edits instead of relying only on the last server-saved project. Runtime-only canvas history remains in-memory because callback-based steps cannot be serialized safely.
- Current object/layer snapshot persistence is debounced during rapid UI edits such as slider drags. Undo/redo remains immediate, while continuous adjustment no longer writes the full snapshot on every pointer movement.

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
- Removed unused projection thumbnail renderer, UV bake stub, dead frontend mock generation service, unused mock layer/reference seed files, and the uncalled command registry/feature flag pair.
- Updated docs for projected layer blend/overlay behavior, thumbnail capture, global bake gating, and current offline fallback boundaries.
- Audited the local repaint chain file by file: frontend dialog, viewport capture, local repaint image/mask utilities, image-edit client, Liclick server route, and Liclick generation service. Removed the accidental direct web-token path and restored the existing Atlas/Liclick auth boundary.
- Added a direct Atlas JSON-RPC helper for large image-edit payloads so local repaint can submit base64 ComfyUI fields without command-line length limits.
- Added local repaint fallback handling for Atlas `generate_image` 400 responses, with explicit Chinese error reporting during status checks and polling.
- Removed the Texture Map preview `Add to references` action while keeping the normal Liclick image-generation shortcut.
- Updated projected-layer preview/export code so WebM turntable captures keep projection alignment during object rotation.
- Verified the packaging script excludes runtime workspace data, logs, secrets, `.git`, and `node_modules` from staging while keeping built server/web outputs and source files needed by the desktop launcher.
- Added the Electron desktop shell for Windows: single-instance window, tray menu, service restart, log directory shortcut, live launcher logs, workspace health checks, and close-to-tray versus full-quit confirmation.
- Updated Windows installer shortcuts to launch the Electron shell while keeping the command-line launcher as a support fallback.
- Kept the existing Node launcher as the service engine and added `LICLICK_OPEN_BROWSER=0` plus `LICLICK_WINDOWS_HIDE=1` so the GUI shell can start services without opening a console or browser automatically.
- Audited the local repaint full-frame path after the ROI alignment regression. The current path uploads the complete current-view frame and complete mask, then composites the full returned frame back into the protected source frame before baking a UV repair layer.
- Audited the projected-layer image editor path after preview-angle regressions. The current mapped preview no longer hides other visible texture layers, no longer lets OrbitControls reinterpret the saved camera, and captures from the layer's transformed projector MVP rather than the user's incidental current viewport.
- Fixed a projected-layer image editor commit leak where mapped-preview refreshes could temporarily write edited pixels into the global layer store and be mirrored into project state before `Apply edit`. Preview captures are now serialized, suppressed from project sync, and restored with the previous active layer.
- Cleaned the image editor default state so new sessions select the top edit layer instead of the locked/base image layer, matching Photoshop's expected "paint on the active editable layer" behavior.
- Audited editor history persistence after F5/undo regressions. Snapshot history is scoped by project, stores the current scene snapshot, persists object and layer changes, labels common actions, and avoids persisting temporary mapped-preview transactions.
- Debounced current snapshot persistence from the editor page so rapid layer/object changes are coalesced before writing to browser storage, reducing UI stutter during adjustment-heavy workflows.
- Fixed multi-select layer deletion from the layer context menu so `删除选中图层` deletes the selected set instead of only the menu anchor layer.
- Removed safe local garbage after audit: stale `apps/web/tsconfig.tsbuildinfo`, two empty workspace Vite dev logs, and the installer `dist-installer/staging` intermediate directory after the final setup executable was produced. User workspace assets, secrets, logs, and project data were left intact.
- The ModDiff-style natural-transition algorithm remains under evaluation and is not part of this package. This build keeps the current narrow mask feathering path and does not introduce the hard-replace/cropped-patch approach.

Build checks for this release:

```text
corepack pnpm --filter @liclick/web typecheck
corepack pnpm --filter @liclick/server typecheck
node --check apps/desktop/main.mjs
node --check apps/desktop/preload.cjs
node --check apps/desktop/renderer/renderer.js
node --check scripts/windows-desktop-launcher.mjs
corepack pnpm --filter @liclick/web lint
corepack pnpm --filter @liclick/server lint
corepack pnpm --filter @liclick/server build
corepack pnpm --filter @liclick/web build
corepack pnpm package:windows
```

Additional validation after the editor-history persistence patch:

```text
corepack pnpm --filter @liclick/web typecheck
corepack pnpm --filter @liclick/web lint
Browser QA: http://127.0.0.1:5173/projects -> 肉肉 project render smoke
```

Additional validation before the next installer package:

```text
node scripts/perf-audit.mjs
corepack pnpm --filter @liclick/web typecheck
corepack pnpm --filter @liclick/web lint
corepack pnpm --filter @liclick/server typecheck
corepack pnpm --filter @liclick/server lint
corepack pnpm --filter @liclick/web build
corepack pnpm --filter @liclick/server build
LICLICK_STRESS_BASE_URL=http://127.0.0.1:4517 LICLICK_STRESS_USERS=30 LICLICK_STRESS_SECONDS=15 node scripts/perf-audit.mjs --stress
Stress /api/health: users=30, seconds=15, requests=234755, failed=0, p95=3.1ms, statuses=200
```

The latest Windows installer produced by this pass is:

```text
dist-installer/Liclick 3D Texture Setup.exe
Size 104,920,688 bytes
SHA256 F4100ABDCCABA9B9799FD679D0BB6ABBA96713F09906D6E1C18BCE180153DAA9
```

Packaging notes for this build:

- `corepack enable` could not write to `C:\Program Files\nodejs\pnpm` under the current user permission, but the script continued with `corepack pnpm` and completed successfully.
- Inno Setup 6.7.2 emitted a non-blocking warning that the `x64` architecture identifier is deprecated and substituted with `x64os`. The installer still compiled successfully.
- Release cleanup removed regenerated output before verification: `.codex-tmp`, `apps/web/dist`, `apps/server/dist`, `apps/web/tsconfig.tsbuildinfo`, old `dist-installer/staging`, and the old installer executable. After packaging, the generated staging directory and regenerated TypeScript build-info file were removed again. The cached portable Node zip was intentionally kept for offline packaging.
- Vite still reports the known large-chunk warning for the editor bundle. The warning is non-blocking for this installer and remains tracked as a future code-splitting cleanup.

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
- Local repaint transition quality is still an active product tuning area. Do not replace the full-frame mapping path with ROI scaling/cropping; any future transition work should preserve full-frame coordinate alignment first.
