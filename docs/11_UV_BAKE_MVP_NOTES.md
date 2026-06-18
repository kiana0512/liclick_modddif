# UV Bake MVP Notes

Phase 3 adds a browser CPU bake path for one imported object, one UV channel, and one active projected layer.

## Key Files

- `apps/web/src/engine/bake/bakeProjectedLayerToTexture.ts`: orchestration entry.
- `apps/web/src/engine/bake/uvRasterizer.ts`: triangle iteration and UV rasterization.
- `apps/web/src/engine/bake/barycentric.ts`: barycentric math helpers.
- `apps/web/src/engine/bake/imageSampler.ts`: projected image loading and sampling.
- `apps/web/src/engine/bake/dilation.ts`: simple seam padding.
- `apps/web/src/engine/bake/applyBakedTexture.ts`: applies basecolor texture to model materials.
- `apps/web/src/engine/bake/downloadTexture.ts`: downloads `liclick_basecolor_*.png`.
- `apps/web/src/components/panels/LayerAdjustmentsPanel.tsx`: bake controls.

## Algorithm

The rasterizer maps mesh UV triangles into the output texture. For every covered texel it computes barycentric coordinates, interpolates world position and normal, projects the world position through the saved capture camera, samples the active generated image, and writes the result into a basecolor canvas using layer opacity.

Phase 4 object transforms are respected through the current mesh `matrixWorld`. If a user moves, rotates, scales, centers, or grounds the model after capture, the active projected layer may need a fresh capture or rebake.

## Dilation

The MVP dilation copies colors from neighboring covered pixels into uncovered pixels for a small number of iterations. Default padding is 8 pixels. This reduces visible UV seam gaps but is not a production-quality padding algorithm.

## Texture Orientation

The canvas writes output Y as `1 - uv.y`. The applied texture sets `texture.flipY = false` for the current renderer/material path. If a future GLB exporter rewrites image assets, re-test orientation against glTF texture conventions.

## Current Limits

- One active projected layer.
- One imported object.
- One UV channel named `uv`.
- Basecolor only.
- No UDIM.
- No strict depth occlusion.
- No multi-layer compositing.
- No normal/roughness/metallic bake.
- 4096 is experimental and may be slow.
- `project.liclick.json` workspace save can materialize baked data URLs into `assets/baked/`.

## Manual Test

1. Import a UV-mapped GLB/GLTF.
2. Capture current view.
3. Generate image.
4. Add as Projected Layer.
5. Click `Bake Active Layer`.
6. Toggle projected layer visibility off.
7. Switch to PBR or Flat.
8. Confirm baked basecolor remains visible.
9. Click `Download BaseColor`.
10. Switch to Normal mode and confirm the UI says the colors visualize surface normals, not the final texture.
