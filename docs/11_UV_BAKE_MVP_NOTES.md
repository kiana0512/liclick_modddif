# UV Bake MVP Notes

Phase 3 added a browser CPU bake path. The current path supports one imported object, one UV channel, and a visible projected-layer stack composited into one BaseColor texture.

## Key Files

- `apps/web/src/engine/bake/bakeProjectedLayerToTexture.ts`: orchestration entry.
- `apps/web/src/engine/bake/uvRasterizer.ts`: triangle iteration and UV rasterization.
- `apps/web/src/engine/bake/barycentric.ts`: barycentric math helpers.
- `apps/web/src/engine/bake/imageSampler.ts`: projected image loading and sampling.
- `apps/web/src/engine/bake/dilation.ts`: simple seam padding.
- `apps/web/src/engine/bake/applyBakedTexture.ts`: applies basecolor texture to model materials.
- `apps/web/src/engine/bake/downloadTexture.ts`: downloads `liclick_basecolor_*.png`.
- `apps/web/src/components/panels/GeneratePanel.tsx`: automatic bake queue and progress UI.
- `apps/web/src/components/panels/LayerAdjustmentsPanel.tsx`: layer controls and baked-texture state.

## Algorithm

The rasterizer maps mesh UV triangles into the output texture. For every covered texel it computes barycentric coordinates, interpolates world position and normal, projects the world position through the saved capture camera, applies the same projection visibility rules as the preview, samples the generated image, and writes the result into a basecolor canvas using layer opacity.

For automatic bake, the Generate panel queues the visible projected layers, rasterizes each layer, composites them in layer order, fills transparent texels with the neutral clay color as opaque BaseColor, encodes a PNG, applies it immediately to the viewport, and persists it to `assets/baked/` for local-server projects.

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

Automatic bake reports progress phases for asset loading, UV rasterization, compositing, PNG encoding, applying, and persistence. The top progress bar is intentionally visible because 4K/8K CPU rasterization can take noticeable time.

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
- No normal/roughness/metallic bake.
- 4096 and 8192 keep output quality but may be slow because rasterization still runs on the browser main thread.
- `project.liclick.json` workspace save can materialize baked data URLs into `assets/baked/`.

## Performance Notes

- The rasterizer reuses sample vectors and computes projector NDC directly from the matrix to reduce garbage collection pressure during 4K/8K bakes.
- Only one automatic bake runs at a time.
- The next quality-preserving optimization is moving rasterization and sharpening to a Web Worker or GPU path.

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
