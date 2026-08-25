# Local Desktop Release And Code Audit

> Historical record only. The Electron launcher, ports 4617/5673, and the legacy
> Windows desktop installer described below were retired in August 2026. The
> supported product is now the persistent web service plus the standalone local
> texture component; do not use the commands in this document for current releases.

This note records the current Windows desktop release flow, the editor UX changes, and the code audit status for this build.

Updated: 2026-07-17

The current comprehensive test and security report is `docs/33_COMPREHENSIVE_CODE_AUDIT_2026-07-15.md`. This file keeps the accumulated desktop/editor release history.

## Windows Desktop Build

The Windows installer now starts a lightweight Electron desktop shell instead of a visible terminal.

- Installer script: `corepack pnpm package:windows`
- Output: `dist-installer/Liclick 3D Texture Setup.exe`
- Installer engine: Inno Setup 6
- Desktop shell: `apps/desktop/main.mjs`
- Electron runtime: copied from `node_modules/electron/dist` into `{app}\electron`
- Installed app ports: backend `4617`, frontend `5673`
- Development ports remain unchanged: backend `4517`, frontend `5173`
- Current desktop shell build: `2026.07.17.1452`

The launcher now uses the same bundled Noto Sans SC family as the web workspace for consistent Chinese/English rendering. Its home view scales continuously between compact, short-wide, tall-narrow, and large windows; the former height breakpoint that caused layout jumps and unused bottom space has been removed. Only the native title-bar app icon remains, avoiding duplicated branding in the sidebar/content header.

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
- Texture, normal, and segment workspaces now fit the camera directly to the selected model after refresh, model selection, or workspace entry. Scene/export mode still fits the complete scene. Each fresh fit resets the orbit up-axis, so an off-center scene placement or a previous pole-crossing rotation cannot leak into the single-model texture view.
- Reference images and layers are scoped to the selected object. Older unscoped project data remains visible for compatibility.
- Liclick image generation and Texture Map generation use separate prompts.
- The obsolete image-generation mode switches were removed from the user avatar menu. Normal texture generation uses Liclick, while the defined local-repaint workflow uses the configured ComfyUI path.
- ComfyUI Texture Map generation keeps the panel prompt as the user material intent. The server adds only projection/albedo guardrails around that user prompt instead of replacing it with a fixed material description.
- ComfyUI Texture Map generation exports only the runtime controls needed by the workflow: white render, object mask, depth, full view-space normal, and the selected material reference. The material reference remains the primary visual material constraint; depth and normal are geometry/projection constraints.
- ComfyUI runtime control export uses a square fit-object camera for 4096 x 4096 control images so the white render, mask, depth, normal, preview capture, and projected result share the same MVP framing instead of inheriting a wide browser viewport aspect ratio.
- Texture Map generation now has the same local stop affordance as normal generation. Stopping opens an in-app Liclick 3D Texture confirmation dialog, immediately unlocks the panel, marks the generation as cancelled, discards any late result, and asks the active backend to cancel or interrupt the job.
- Normal Liclick image generation keeps the preview `Add to references` shortcut. Texture Map generation hides that shortcut so generated texture outputs are accepted as projected layers instead of being recycled into the material-reference library.
- Liclick image generation has a stop button. Stopping marks the local job as cancelled, unlocks the UI, and tells the local server to stop tracking that job.
- The bottom paint dock separates normal texture painting, texture erasing, inpaint-region add, inpaint-region subtract, and the current local repaint submit action.
- The bottom dock is mode-aware: scene mode keeps selection/move/rotate/scale/undo/redo, while texture mode keeps selection/brush/eraser/local-repaint controls/undo/redo.
- Normal brush/eraser tools require an active projected layer. The editor warns the user and opens the Layers panel when painting is attempted without a valid target layer.
- Inpaint add/subtract tools edit only the inpaint selection mask. They do not erase projected-layer pixels.
- Surface painting works only on model meshes with UVs. Empty viewport space continues to use the normal orbit/camera behavior.
- Surface paint, eraser, and inpaint mask strokes are attached to model UV space and participate in the existing undo/redo flow one stroke at a time.
- Hidden perf URLs can inject synthetic 100-model and 100-layer editor scenes for repeatable runtime testing.
- Projected layer preview now separates loose coverage from strict quality. `Blend` chooses the best projected candidates without layer-order dependence; `Overlay` paints over the blended base in stack order.
- Projected layer preview and bake now reject projector-behind-camera samples before texture lookup, and projection-angle checks use world-space normals after object transforms. This reduces stray projection fragments and wrong-angle blending.
- Multi-view blend now uses winner-takes-dominant-quality behavior. Soft blending is kept only for near-tie projection candidates, avoiding muddy texture averaging across incompatible view angles.
- Layer rows expose distinct blend/overlay state, layer opacity, and projection strength. Opacity can be dragged down to 0, where the icon becomes an empty circle.
- Uncovered projected fragments fall back to the model/base material instead of showing black edges, white masks, or accidental checker diagnostics.
- The obsolete user-facing Auto UV bake switch was removed. The current projected-layer workflow keeps live projection available and uses the defined background/manual bake entry points without exposing a global mode toggle.
- Project thumbnails are captured from the real WebGL viewport after projection changes. Grid and paint/helper overlays are hidden during the thumbnail capture and restored immediately afterwards.
- The Projects page and bottom editor tools now use the shared Chinese / English string store instead of fixed English labels.
- Local repaint now follows the ModDiff-like three-button texture workflow. Button 1 paints the allowed repaint mask, generated texture-map output becomes the source projection, and button 3 brushes where the new generated texture should replace the old visible result.
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
- Local repaint button 3 keeps a single live projected layer per repaint source and updates its mask canvas in place while brushing. It no longer spawns a new projected layer per dab.
- Projected preview filters hidden layers before shader/material creation, so closing a layer eye actually removes that layer from the live projected stack.
- Projected-layer visibility now uses the device's reported WebGL sampler budget as a pre-commit guard. An over-budget eye stays closed and the user is asked to close another projection or merge the visible projections into a UV layer; no visible layer is silently dropped from an already accepted stack.

## Code Audit Summary

Low-risk cleanup completed in this pass:

- Updated package versions to `0.1.2` for the Windows installer release.
- Switched UV baking to a GPU-first production path with CPU fallback. CPU rasterization remains the golden reference for diagnostics.
- Fixed GPU projected input sampling so projected color, mask, and depth images all use the Y-flipped sampling convention required to match CPU `ImageData`.
- Added the GPU `cpu-parity` bake mode. GPU now performs per-layer projected UV sampling, then reuses the CPU golden quality-blend compositor for candidate selection, soft blending, overlays, dilation, sharpening, and viewport fill.
- Kept legacy GPU `quality-depth`, `quality-alpha`, and `coverage-alpha` modes as debug-only comparison paths through `LiclickUvDebug.compare`.
- Added the browser console `LiclickUvDebug` API for temporary CPU/GPU overrides, GPU input flip diagnostics, CPU/GPU PNG comparison, and UV gradient render-target diagnostics.
- Bumped the UV bake cache protocol to v4 so old CPU/GPU bake cache entries are not reused after the GPU sampling/composition correction.
- Documented the GPU UV bake default and debug commands in `docs/32_GPU_UV_BAKE_DEFAULT.md`.
- Cached the paintable mesh list used by surface-paint raycasts so pointer movement no longer traverses the full model hierarchy every frame.
- Switched surface-paint raycasts to a non-recursive flat mesh list and kept paint overlay meshes out of the raycast/material processing path.
- Removed duplicate full-canvas mask alpha scans at stroke commit; inpaint add/subtract state now updates from the stroke history path.
- Deleted the unsafe UV-space fast projected-preview compositor. Ordinary direct projection is the visual source of truth; over-budget visibility requests are rejected before shader creation so the last valid material remains intact.
- Added `PerfScenarioLoader` for `100-models`, `100-layers`, and `100-layers-unbaked` browser runtime stress tests.
- Improved `scripts/perf-audit.mjs` stress output with status-code/error aggregation and first-failure details.
- Cleaned generated build and packaging output before release: `.codex-tmp`, `apps/web/dist`, `apps/server/dist`, and the old `dist-installer`.
- Shared generation upsert/failure handling in `GeneratePanel` to reduce duplicated state writes.
- Consolidated viewport drag payload detection so drag events scan file lists once.
- Kept texture mode rendering focused on the currently selected imported model instead of rendering every imported model.
- Replaced the old two-stage camera initialization that first framed the whole scene and then only translated toward the selected object. Single-model workspaces now recompute both target and distance from the selected model bounds, and restored camera requests rebuild controls from a deterministic world-up basis.
- Kept generated layers, reference images, and new empty layers object-scoped.
- Removed unused projection thumbnail renderer, UV bake stub, dead frontend mock generation service, unused mock layer/reference seed files, and the uncalled command registry/feature flag pair.
- Updated docs for projected layer blend/overlay behavior, thumbnail capture, global bake gating, and current offline fallback boundaries.
- Audited the local repaint chain file by file: frontend dialog, viewport capture, local repaint image/mask utilities, image-edit client, Liclick server route, and Liclick generation service. Removed the accidental direct web-token path and restored the existing Atlas/Liclick auth boundary.
- Added a direct Atlas JSON-RPC helper for large image-edit payloads so local repaint can submit base64 ComfyUI fields without command-line length limits.
- Added local repaint fallback handling for Atlas `generate_image` 400 responses, with explicit Chinese error reporting during status checks and polling.
- Removed the Texture Map preview `Add to references` action while keeping the normal Liclick image-generation shortcut.
- Added local ComfyUI Texture Map integration through `/api/comfyui`: status check, control-image upload, workflow patching, prompt queueing, history polling, output download, and project asset persistence.
- Patched the ComfyUI workflow bridge so UI prompt text, selected material reference, white render, mask, depth, and full normal-view inputs map to the intended workflow nodes. The normal-view control path is enabled as a second control stage after depth.
- Added ComfyUI cancellation support. The frontend aborts the pending request, marks the local generation as cancelled, and calls `/api/comfyui/cancel`; the server records cancelled job IDs to close the cancel-before-submit race and calls ComfyUI `/interrupt` best-effort.
- Replaced the browser-native cancel confirmation with an app-styled Liclick 3D Texture modal that explains the local discard semantics and backend interrupt behavior.
- Audited the ComfyUI cancellation path for late responses and stale confirmation dialogs. Late results are ignored after local cancellation, and a confirmation opened for a task that has already completed no longer marks that completed task as cancelled.
- Updated projected-layer preview/export code so WebM turntable captures keep projection alignment during object rotation.
- Verified the packaging script excludes runtime workspace data, logs, secrets, `.git`, and `node_modules` from staging while keeping built server/web outputs and source files needed by the desktop launcher.
- Added the Electron desktop shell for Windows: single-instance window, tray menu, service restart, log directory shortcut, live launcher logs, workspace health checks, and close-to-tray versus full-quit confirmation.
- Updated Windows installer shortcuts to launch the Electron shell while keeping the command-line launcher as a support fallback.
- Kept the existing Node launcher as the service engine and added `LICLICK_OPEN_BROWSER=0` plus `LICLICK_WINDOWS_HIDE=1` so the GUI shell can start services without opening a console or browser automatically.
- Audited the local repaint full-frame path after the ROI alignment regression. The current path uploads the complete current-view frame and complete mask, then composites the full returned frame back into the protected source frame before baking a UV repair layer.
- Audited the local repaint apply-mask boundary. Button 3 now loads the button-1 generation mask together with the returned image, converts the low-resolution mask to alpha once, rejects pointer starts outside it, clips every dirty brush rectangle before live projection, and clips restored masks before reuse. The pointer path performs no full-canvas readback.
- Kept the local repaint UV commit on the 512 px GPU-only path. One unconstrained padding pass supplies texture border pixels for UV-island bilinear sampling; weak low-alpha texels cannot seed padding, and new padding uses premultiplied feathered alpha so it cannot become a rainbow fringe or opaque sticker outline. CPU seam reconciliation and multi-pixel dilation remain disabled to avoid interaction stalls and cross-island color streaks.
- Persistent local repaint UV layers now participate in the normal material-lighting path. The transient projected preview remains captured display color, while the committed UV layer no longer renders as a pale flat veil.
- Model and BaseColor export now recognize live local-repaint canvas URLs and encode their canvas directly as PNG. Export no longer calls `fetch` on the runtime-only `liclick-live-projected-canvas:` scheme, which previously surfaced as `Failed to fetch` when the repaint merge layer was visible.
- Audited the projected-layer image editor path after preview-angle regressions. The current mapped preview no longer hides other visible texture layers, no longer lets OrbitControls reinterpret the saved camera, and captures from the layer's transformed projector MVP rather than the user's incidental current viewport.
- Fixed a projected-layer image editor commit leak where mapped-preview refreshes could temporarily write edited pixels into the global layer store and be mirrored into project state before `Apply edit`. Preview captures are now serialized, suppressed from project sync, and restored with the previous active layer.
- Cleaned the image editor default state so new sessions select the top edit layer instead of the locked/base image layer, matching Photoshop's expected "paint on the active editable layer" behavior.
- Audited editor history persistence after F5/undo regressions. Snapshot history is scoped by project, stores the current scene snapshot, persists object and layer changes, labels common actions, and avoids persisting temporary mapped-preview transactions.
- Debounced current snapshot persistence from the editor page so rapid layer/object changes are coalesced before writing to browser storage, reducing UI stutter during adjustment-heavy workflows.
- Removed the disabled automatic projected-stack preview-bake effect from `EditorPage`. The feature flag was permanently off, but the dead path still kept timers, refs, imports, and type-checked code alive.
- Removed an unused global viewport interaction listener that had remained after the disabled automatic preview-bake path was deleted.
- Fixed local repaint cursor preview and first-stroke mask overlay visibility by including button 3 in the brush-preview path and creating overlays with the current inpaint tool state.
- Updated desktop shell Build to `2026.07.08.1508` and package versions to `0.1.1`.
- Updated package versions to `0.1.2` for the GPU-first UV bake Windows installer.
- Fixed multi-select layer deletion from the layer context menu so `删除选中图层` deletes the selected set instead of only the menu anchor layer.
- Removed the production CPU coverage parity pass after successful GPU UV bake. The validation path is still available through `localStorage.liclick-debug-gpu-coverage-validation=1`, but normal auto-bake no longer pays for a second CPU rasterization pass.
- Fixed ordered baked-stack cache reuse so exact layer-order matches are accepted even when the bake is order-sensitive. This lets GPU stack bakes actually become the fast preview/export path.
- Coalesced Generate-panel auto-bake queue requests to the latest visible stack while a bake is running. Adding several projected layers no longer schedules several redundant full-stack bakes.
- Tightened projected-layer stack blending in both live shader preview and CPU UV merge so a clearly better camera projection wins instead of being averaged with weaker candidates.
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

Additional validation after the 2026-07-02 projection/bake patch:

```text
corepack pnpm --filter @liclick/web typecheck
corepack pnpm --filter @liclick/web lint
corepack pnpm --filter @liclick/web build
corepack pnpm --filter @liclick/server typecheck
corepack pnpm --filter @liclick/server lint
corepack pnpm --filter @liclick/server build
node scripts/perf-audit.mjs
node --check apps/desktop/main.mjs
node --check apps/desktop/preload.cjs
node --check apps/desktop/renderer/renderer.js
corepack pnpm package:windows
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

Additional validation after the 2026-07-03 ComfyUI texture-map integration and cancellation pass:

```text
corepack pnpm --filter @liclick/web typecheck
corepack pnpm --filter @liclick/server typecheck
corepack pnpm --filter @liclick/server build
corepack pnpm --filter @liclick/server lint
corepack pnpm --filter @liclick/web lint
```

The latest Windows installer produced by this pass is:

```text
dist-installer/Liclick 3D Texture Setup.exe
Size 134,343,596 bytes
SHA256 CB072366C39B274765F07792F37F5F0AF10D4C908A0B55D90D5DC88004CEDDB8
```

Packaging notes for this build:

- `corepack enable` could not write to `C:\Program Files\nodejs\yarnpkg` under the current user permission, but the script continued with `corepack pnpm` and completed successfully.
- `corepack pnpm install --frozen-lockfile` reused the current workspace dependency state and completed successfully after the package-manager prompt.
- Inno Setup 6.7.2 emitted a non-blocking warning that the `x64` architecture identifier is deprecated and substituted with `x64os`. The installer still compiled successfully.
- Release cleanup removed old `dist-installer/staging`, the previous installer executable, regenerated `apps/web/tsconfig.tsbuildinfo`, package `tsconfig.tsbuildinfo` files, and the post-package staging directory. The cached portable Node zip and Node MSI were intentionally kept for offline packaging.
- Windows packaging now excludes root-level Li3D model-download helper scripts and the debug contact sheet from installer staging, in addition to logs, build info, secrets, workspace data, `.git`, and dependency directories.
- Vite still reports the known large-chunk warning for the editor bundle. The warning is non-blocking for this installer and remains tracked as a future code-splitting cleanup.

The 2026-06-26 local backend stress pass reached:

- 225,295 health requests at 30 users over 15 seconds, 0 failed, p95 3.4 ms.
- 408,781 health requests at 80 users over 30 seconds, 0 failed, p95 10.1 ms.

The 2026-06-26 browser runtime stress pass reached:

- 100 models: 59.95 FPS average over 240 warm sampled frames, p95 frame time 16.80 ms, `fallbackTicks=0`, no console warnings/errors.
- 100 projected layers with baked stack cache: 59.95 FPS average over 240 warm sampled frames, p95 frame time 16.80 ms, `fallbackTicks=0`, no console warnings/errors.
- 100 projected layers without baked stack, stressing projected-preview shader pressure: 59.95 FPS average over 240 warm sampled frames, p95 frame time 16.80 ms, `fallbackTicks=0`, no console warnings/errors.

## Known Risk Areas

- `GeneratePanel` and `EditorPage` are still large orchestration components. Future cleanup should split generation job state, reference import, project restore, and bake orchestration into smaller hooks or services.
- Projected-layer preview and UV bake remain the most performance-sensitive path. Avoid adding React state updates inside per-frame or per-fragment logic.
- The stop button cancels local tracking immediately. If a Liclick task has already been submitted to Atlas, the remote task may still finish server-side, but the local UI no longer waits for it or applies it.
- The ComfyUI stop path sends a best-effort `/interrupt` to the local ComfyUI instance. If ComfyUI is blocked inside a custom node, interruption may not be immediate, but the Liclick UI unlocks immediately and ignores the late result.
- The ComfyUI workflow file is intentionally patched at submission time. Keep node IDs stable for the current texture workflow: prompt `44`, depth control `46`, normal-view control `47`, sampler `51`, final RGB save `64`.
- Legacy unscoped references/layers remain visible for compatibility. New project data should always write `objectId`.
- Large Vite chunk warnings are currently known and non-blocking, but code splitting should be considered after the texture workflow stabilizes.
- Local repaint transition quality is still an active product tuning area. Do not replace the full-frame mapping path with ROI scaling/cropping; any future transition work should preserve full-frame coordinate alignment first.
- Projected-layer live preview cannot open another eye when its image/mask/depth sampler cost would exceed the device limit. The warning directs the user to close a projected layer or merge the visible stack to UV; the rationale and future acceptance gate are documented in `docs/31_WEBGL_SHADER_SAMPLER_LIMIT.md`.
