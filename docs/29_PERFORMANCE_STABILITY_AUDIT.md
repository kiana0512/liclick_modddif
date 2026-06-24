# Performance And Stability Audit

Updated: 2026-06-24

## Current Fixes

- Generation job persistence is bounded. `workspace/generation-jobs.json` is treated as runtime cache and ignored by git. Persisted jobs are trimmed to recent sanitized metadata, without raw image payloads or base64 blobs.
- Texture Map image API settings are no longer forced to 4K. Reference-image generation can stay on `auto` for speed, while bake resolution is controlled separately by the viewport resolution selector.
- Texture Map projected previews keep image textures, masks, and depth maps with `flipY=false` so the preview matches the CPU UV bake sampling direction.
- Texture Map layers automatically start a UV bake after being added as projected layers. The add-layer action returns immediately; the bake runs from an idle/background queue and applies the baked texture when it finishes.
- Only one automatic bake runs at a time from the Generate panel. This avoids piling up multiple 4K/8K CPU bakes and freezing the viewport.
- Automatic bake keeps the selected resolution instead of silently reducing quality. The UI now shows a top progress bar for loading, UV sampling, compositing, PNG encoding, applying, and workspace persistence.
- Automatic visible-layer bake is GPU-first. It renders meshes into UV space on an offscreen WebGL render target, applies projection/mask/depth/backface gates in shader, and falls back to the CPU rasterizer only at the same requested resolution.
- GPU bake now runs a low-resolution CPU coverage parity check before applying the texture. Obvious GPU/CPU projection divergence is rejected instead of being shown as a baked result.
- GPU bake keeps seam dilation and covered-texel sharpening on WebGL render targets before readback, reducing the largest CPU image-processing loops for 4K/8K bakes.
- Local-server baked texture persistence now uploads PNG blobs directly instead of wrapping large baked textures in base64 JSON payloads.
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

- move PNG encoding, workspace persistence, and CPU-only post-processing into a Web Worker where browser APIs allow it
- move PNG encoding off the browser main thread, or replace browser PNG encoding with a server-side/GPU-adjacent export path for A100 deployments
- add GPU timing/readback telemetry so slow machines can distinguish shader time, readback time, PNG encoding, and project-save time
- add a browser-driven 30-layer WebGL scenario that measures frame responsiveness while auto-bake is queued
