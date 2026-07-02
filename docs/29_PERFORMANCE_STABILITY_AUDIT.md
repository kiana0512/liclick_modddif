# Performance And Stability Audit

Updated: 2026-07-02

## Current Fixes

- 3D surface paint and inpaint-region masking now paint in UV texture space instead of spawning per-dab viewport marks. Brush strokes are continuous line segments on a 1024px canvas texture, so marks stay attached to the model when the camera or model moves.
- The surface-paint raycast path caches paintable UV meshes per active object and raycasts that flat mesh list without recursive traversal. This removes repeated full model tree walks from pointer-move painting.
- Paint and mask texture uploads are batched through `requestAnimationFrame`; repeated pointer events only mark canvas textures dirty and the GPU upload happens once per frame.
- Paint overlays are created lazily only for meshes that are actually hit by the brush. The scene material pass skips those overlay meshes, preventing the overlay from being reprocessed as normal model geometry.
- Inpaint subtract now erases the mask with `destination-out` and updates mask content state from the stroke history path, avoiding duplicate full-canvas alpha scans at mouse-up.
- Surface paint history is stroke-based: one drag gesture records one undo/redo runtime step with only the dirty rectangle image data needed for that stroke.
- Ordinary paint/eraser tools are guarded by the active projected layer. If no valid layer is selected, the editor opens the Layers panel and shows a warning instead of painting into an undefined target.
- Projected-layer live preview is capped to the first 16 visible layers when the full stack has not been baked yet. Full 100-layer stacks should use the baked texture cache; this avoids generating oversized per-layer shaders that can exceed GPU sampler/uniform limits.
- Generation job persistence is bounded. `workspace/generation-jobs.json` is treated as runtime cache and ignored by git. Persisted jobs are trimmed to recent sanitized metadata, without raw image payloads or base64 blobs.
- Texture Map image API settings are no longer forced to 4K. Reference-image generation can stay on `auto` for speed, while bake resolution is controlled separately by the viewport resolution selector.
- Texture Map projected previews keep image textures, masks, and depth maps with `flipY=false` so the preview matches the CPU UV bake sampling direction.
- Texture Map layers automatically start a UV bake after being added as projected layers only when the global Auto UV bake setting is enabled. The add-layer action returns immediately; the bake runs from an idle/background queue and applies the baked texture when it finishes.
- Turntable WebM export resyncs projected-layer matrix delta uniforms every frame while rotating the model, preventing view-generated textures from drifting during recording.
- Local repaint preflights the local workspace health and Atlas/Liclick status before submission, surfaces Chinese errors for auth/network/poll failures, and falls back to a supported image-edit path if the custom ComfyUI workflow is rejected by the Atlas wrapper.
- Only one automatic bake runs at a time from the Generate panel. This avoids piling up multiple 4K/8K CPU bakes and freezing the viewport.
- Automatic bake keeps the selected resolution instead of silently reducing quality. The UI now shows a top progress bar for loading, UV sampling, compositing, PNG encoding, applying, and workspace persistence.
- Automatic visible-layer bake is GPU-first. It renders meshes into UV space on an offscreen WebGL render target, applies projection/mask/depth/backface gates in shader, and falls back to the CPU rasterizer only at the same requested resolution.
- GPU bake coverage parity is now debug opt-in through `localStorage.liclick-debug-gpu-coverage-validation=1`. Production auto-bake no longer re-rasterizes every layer on CPU after a successful GPU bake, which removes a major reason GPU utilization appeared low while the UI was still waiting.
- GPU bake keeps seam dilation and covered-texel sharpening on WebGL render targets before readback, reducing the largest CPU image-processing loops for 4K/8K bakes.
- Projected-layer preview and GPU bake now reject points behind the projector camera before sampling, and shader normals are converted back to world space before projection-angle checks. This reduces incorrect backface/angle acceptance after model transforms.
- Multi-view projected-layer blending is more decisive: when the best candidate has clearly higher projection quality it wins outright, and soft blending is reserved for genuinely comparable candidates. This avoids muddy cross-view texture averaging on high-relief objects.
- Exact ordered baked stack textures are reusable even when the bake is order-sensitive. The cache only requires order-independent metadata for set-match reuse, preventing successful GPU stack bakes from being ignored by preview/export.
- Generate-panel auto-bake queue coalesces to the latest requested visible stack while a bake is already running. Adding several projected layers no longer schedules several redundant full-stack bakes.
- Local-server capture, layer, and baked texture persistence now uploads PNG blobs directly instead of wrapping large images in base64 JSON payloads.
- Render-target capture and masked projected-image output use asynchronous PNG Blob URLs in the browser hot path. The local-server save path registers those Blob URLs and writes them through the binary asset API.
- PBR preview avoids the post-bake white-model gap by keeping the projected preview or in-memory baked texture active until the persisted baked texture is loaded.
- The UV rasterizer now reuses per-sample vectors and computes projector NDC directly from matrix elements, reducing allocation pressure during high-resolution bakes.
- Autosave skips thumbnail refresh during routine saves and uses a longer debounce, reducing capture work while editing or moving the camera.
- The WebGL canvas caps DPR at 1.5 and attempts automatic context recovery before showing the manual viewport-recovery overlay.
- Linux startup scripts can automatically free required ports before launching services. If the port cannot be released, startup fails with the exact kill command to run manually.

## Runtime Cleanup

Run the local audit:

```bash
pnpm perf:audit
```

The audit reports:

- files larger than 50 MB outside ignored dependency/build folders
- the current `workspace/generation-jobs.json` size
- total local workspace payload size

Runtime files that should stay out of git:

- `workspace/generation-jobs.json`
- `*.tmp`
- generated atlas login homes
- dependency folders and build outputs

Cleanup performed for the 2026-06-26 Windows package pass:

- removed `.codex-tmp`
- removed `apps/web/dist`
- removed `apps/server/dist`
- removed old `dist-installer`
- kept `node_modules`, `.pnpm-store`, `workspace`, and user project payloads intact

Verification after cleanup:

```text
corepack pnpm -r typecheck
corepack pnpm -r lint
corepack pnpm perf:audit
LICLICK_STRESS_BASE_URL=http://127.0.0.1:4791 LICLICK_STRESS_USERS=30 LICLICK_STRESS_SECONDS=15 pnpm perf:stress
LICLICK_STRESS_BASE_URL=http://127.0.0.1:4792 LICLICK_STRESS_USERS=80 LICLICK_STRESS_SECONDS=30 pnpm perf:stress
```

Current audit result: `generation-jobs.json` is 0.18 MB and there are no files >= 50 MB outside ignored dependency/build folders.

2026-06-26 stress results against a local built server:

- 30 users for 15 seconds: 225,295 `/api/health` requests, 0 failed, p95 3.4 ms, status `200=225295`.
- 80 users for 30 seconds: 408,781 `/api/health` requests, 0 failed, p95 10.1 ms, status `200=408781`.
- The stress tool now prints status-code/error summaries and the first failed sample, so network failures are distinguishable from non-2xx server responses.

## Frontend Runtime Stress

Use the hidden perf scenarios on the editor route:

```text
http://127.0.0.1:5173/project/project-orchid-speaker?perfScenario=100-models
http://127.0.0.1:5173/project/project-orchid-speaker?perfScenario=100-layers
http://127.0.0.1:5173/project/project-orchid-speaker?perfScenario=100-layers-unbaked
```

The scenarios inject synthetic runtime data only when the `perfScenario` query parameter is present.

- `100-models`: one project with 100 UV box models.
- `100-layers`: one model with 100 projected layers and an exact baked stack texture.
- `100-layers-unbaked`: one model with 100 projected layers, no baked stack, exercising the 16-layer live-preview guard.

Browser frame-sampling result on 2026-06-26:

- `100-models`: 240 sampled frames after warm-up, average 16.68 ms, p95 16.80 ms, max 17.10 ms, 59.95 FPS, `fallbackTicks=0`, no console warnings/errors.
- `100-layers`: 240 sampled frames after warm-up, average 16.68 ms, p95 16.80 ms, max 17.10 ms, 59.95 FPS, `fallbackTicks=0`, no console warnings/errors.
- `100-layers-unbaked`: 240 sampled frames after warm-up, average 16.68 ms, p95 16.80 ms, max 16.80 ms, 59.95 FPS, `fallbackTicks=0`, no console warnings/errors.

## Stress Test

Run a 30-user HTTP stress pass against a running backend:

```bash
LICLICK_STRESS_BASE_URL=http://127.0.0.1:4517 LICLICK_STRESS_USERS=30 LICLICK_STRESS_SECONDS=30 pnpm perf:stress
```

Pass criteria for the current backend-only stress pass:

- zero failed requests
- p95 latency under 250 ms for `/api/health`
- no growth of `workspace/generation-jobs.json` from image payloads

## Single-User Bake Budget

Target workflow:

- adding a Texture Map projected layer should be immediate
- automatic bake should run in the background
- a new bake should not start while one is already running
- 30 projected layers should remain inspectable without generation jobs or thumbnails blocking the viewport

Known next step for heavier 4K/8K work:

- replace browser PNG encoding/readback with a server-side or GPU-adjacent export path for A100 deployments where possible
- add GPU timing/readback telemetry so slow machines can distinguish shader time, readback time, PNG encoding, and project-save time
- add a browser-driven 30-layer WebGL scenario that measures frame responsiveness while auto-bake is queued
- move transparent-output UV merge onto a GPU path or worker path. It still uses CPU rasterization because the current GPU bake path intentionally emits opaque viewport-ready BaseColor textures.
