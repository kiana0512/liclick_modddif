# UV Bake MVP Notes

Phase 3 added a browser bake path. The current path supports one imported object, one UV channel, and a visible projected-layer stack composited into one BaseColor texture. Automatic stacked baking is GPU-first and falls back to the CPU rasterizer at the same selected resolution if the browser/GPU cannot allocate the requested render target.

## Key Files

- `apps/web/src/engine/bake/bakeProjectedLayerToTexture.ts`: orchestration entry.
- `apps/web/src/engine/bake/gpuUvBakeRenderer.ts`: GPU UV-space render target path for automatic visible-layer baking.
- `apps/web/src/engine/bake/uvRasterizer.ts`: triangle iteration and UV rasterization.
- `apps/web/src/engine/bake/barycentric.ts`: barycentric math helpers.
- `apps/web/src/engine/bake/imageSampler.ts`: projected image loading and sampling.
- `apps/web/src/engine/bake/dilation.ts`: simple seam padding.
- `apps/web/src/engine/bake/applyBakedTexture.ts`: applies basecolor texture to model materials.
- `apps/web/src/engine/bake/downloadTexture.ts`: downloads `liclick_basecolor_*.png`.
- `apps/web/src/components/panels/GeneratePanel.tsx`: automatic bake queue and progress UI.
- `apps/web/src/components/panels/LayerAdjustmentsPanel.tsx`: layer controls and baked-texture state.

## Algorithm

The GPU path draws the imported meshes into UV space on an offscreen WebGL render target. Its shader reconstructs world position and normal, projects them through the saved capture camera, applies the same frustum, mask, depth, backface, opacity, and HSL adjustment rules, and blends each visible projected layer into the output texture.

The CPU fallback maps mesh UV triangles into the output texture. For every covered texel it computes barycentric coordinates, interpolates world position and normal, projects the world position through the saved capture camera, samples the generated image, and writes the result into a basecolor canvas using layer opacity.

For automatic bake, the Generate panel queues the visible projected layers, renders or rasterizes each layer, composites them in layer order, fills transparent texels with the neutral clay color as opaque BaseColor, encodes a PNG, applies it immediately to the viewport, and persists it to `assets/baked/` for local-server projects.

Phase 8 visibility rules:

- reject texels outside the projector frustum;
- reject backfaces by default;
- reject mask pixels below threshold when a capture mask is stored;
- reject approximate depth mismatches when a capture depth image is stored;
- report in-frustum, mask rejected, depth rejected, backface rejected, and written texel counts.

Phase 4 object transforms are respected through the current mesh `matrixWorld`. If a user moves, rotates, scales, centers, or grounds the model after capture, the active projected layer may need a fresh capture or rebake.

## Dilation

The MVP dilation copies colors from neighboring covered pixels into uncovered pixels for a small number of iterations. Automatic bake currently uses 4 pixels of padding. This reduces visible UV seam gaps but is not a production-quality padding algorithm.

## Progress And Preview Stability

Automatic bake reports progress phases for asset loading, GPU/CPU UV rasterization, compositing, PNG encoding, applying, and persistence. The top progress bar is intentionally visible because 4K/8K bakes still include texture upload, render target readback, PNG encoding, and workspace persistence.

PBR preview avoids a white-model gap while baked assets are loading. It keeps using the projected preview or the in-memory baked texture until the persisted baked texture is available.

## Texture Orientation

The canvas writes output Y as `1 - uv.y`. The applied texture sets `texture.flipY = false` for the current renderer/material path. If a future GLB exporter rewrites image assets, re-test orientation against glTF texture conventions.

## Current Limits

- Visible projected layers are composited into one BaseColor output; shader preview still focuses on one active projected layer.
- One imported object.
- One UV channel named `uv`.
- Basecolor only.
- No UDIM.
- Depth occlusion is approximate because the capture depth is grayscale-packed for the browser MVP.
- GPU bake reports total and written texel coverage, but detailed mask/depth/backface rejection counters remain CPU-diagnostic only.
- No normal/roughness/metallic bake.
- 4096 and 8192 keep output quality. GPU bake avoids the main CPU raster loop; very large outputs can still be limited by GPU max texture size, readback, PNG encoding, and available browser memory.
- `project.liclick.json` workspace save materializes registered Blob URLs and data URLs into workspace assets where possible.

## Performance Notes

- Automatic visible-layer bake now tries the GPU UV render target first and uses the CPU rasterizer only as a same-resolution fallback.
- GPU bake runs UV-space rendering, seam dilation, and covered-texel sharpening on WebGL render targets before the final readback. This avoids the heaviest 4K/8K CPU image loops in the normal GPU path.
- GPU bake is guarded by a low-resolution CPU coverage validation pass; if the UV texels written by GPU diverge from CPU coverage, the result is discarded and the full-resolution CPU bake is used instead.
- Local-server projects persist capture, layer, and baked PNGs through a binary blob upload path. Browser-only projects keep data URLs so downloaded project JSON remains self-contained.
- Render-target captures and generated-image matte outputs now use asynchronous PNG Blob URLs rather than synchronous `toDataURL` in the hot path.
- The CPU rasterizer reuses sample vectors and computes projector NDC directly from the matrix to reduce garbage collection pressure during fallback 4K/8K bakes.
- Only one automatic bake runs at a time.
- The next quality-preserving optimization is moving PNG encoding and post-process sharpening off the main thread where browser APIs allow it.

## Manual Test

1. Import a UV-mapped GLB/GLTF.
2. Capture current view.
3. Generate image.
4. Add as Projected Layer.
5. Watch the automatic bake progress bar complete.
6. Toggle projected layer visibility off.
7. Switch to PBR or Flat.
8. Confirm baked basecolor remains visible without a white-model gap.
9. Click `Download BaseColor`.
10. Switch to Normal mode and confirm the UI says the colors visualize surface normals, not the final texture.
