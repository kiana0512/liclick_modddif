# WebGL Shader Sampler Limit Incident

Updated: 2026-07-17

This document explains the projected-layer WebGL failure observed during local repaint testing, why it happens, why the app cannot simply increase the limit, and what the correct engineering direction should be.

## Summary

During local repaint button 3 testing, the viewport could turn black or lose the model render after adding or activating a local repaint projected layer. Browser logs showed a WebGL program validation failure:

```text
FRAGMENT shader texture image units count exceeds MAX_TEXTURE_IMAGE_UNITS(16)
```

This means the generated fragment shader declared more `sampler2D` textures than the current WebGL device/browser allows in one fragment shader program. The visible symptom looked like a broken render or WebGL crash, but the immediate trigger was shader validation failure before the shader could be used.

The retired implementation also tried a tiled UV-space "fast composition" fallback. It was not safe for general FBX/OBJ/GLTF content because submeshes and mirrored parts can share or overlap UV space. The fallback could therefore produce black diagnostic stripes, white untextured surfaces, or projections written onto the wrong part of the model even though the ordinary screen-space projection was correct.

That fallback has now been deleted. The shipped rule is deliberately strict: only the ordinary, exact projected material is allowed. Before a layer eye is opened, the app calculates the actual sampler cost of all visible projected images, masks, depth maps, and the UV overlay. If the next state exceeds `MAX_TEXTURE_IMAGE_UNITS`, the eye remains closed and the user is told to close another projected layer or merge the visible projections into a UV layer first.

## Why It Fails

The live projected preview shader is built in `apps/web/src/engine/projection/ProjectedLayerMaterial.ts`.

For a single projected layer, the shader can use these texture samplers:

- `projectedMap`: the generated/projected image.
- `maskMap`: optional projection/local repaint mask.
- `depthMap`: optional depth gate.
- `baseMap`: source/base material texture.
- `uvOverlayMap`: optional unbaked UV overlay.

For a projected stack, the shader emits per-layer sampler uniforms:

```text
projectedMap0
maskMap0
depthMap0
projectedMap1
maskMap1
depthMap1
...
```

So the rough sampler cost is:

```text
baseMap + uvOverlayMap + sum(each visible projected layer image + optional mask + optional depth)
```

In the problematic local repaint case, the scene already had multiple projected texture-map layers. Adding local repaint created another projected layer with at least an image and a mask, and often depth metadata. That pushed the generated shader beyond the device's fragment texture unit limit.

Example budget on a device reporting `MAX_TEXTURE_IMAGE_UNITS = 16`:

```text
baseMap                       1
uvOverlayMap                  1
5 projected layers x 3 each  15
total                        17 -> shader validation can fail
```

The exact number depends on which layers have masks/depth and whether base/UV overlay textures are active. A layer with only `imageUrl` costs less than a layer with `imageUrl + maskUrl + depthUrl`.

## Why We Cannot Just Raise It

`MAX_TEXTURE_IMAGE_UNITS` is not an app configuration value. It is reported by the WebGL implementation from the browser, GPU, driver, and graphics backend.

The app can query it:

```js
const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);
```

But the app cannot set it higher. If the fragment shader declares more samplers than the reported limit, WebGL rejects the program. Three.js then cannot use that material, and the viewport can fall back to a blank/black/broken render state.

Even powerful GPUs can expose conservative WebGL limits because WebGL is a browser portability API. Native DirectX/Vulkan/Metal capabilities do not map directly to unlimited WebGL fragment samplers.

## Why WebGL Feels Fragile Here

WebGL is strict because shaders must be validated before use. The renderer cannot partially run a fragment shader that asks for too many texture units.

The fragile part in our current architecture is not WebGL itself. The fragile part is that live projected preview currently tries to represent the whole layer stack in one material/shader. That design scales poorly with layer count because each visible projected layer adds sampler uniforms to the same fragment program.

When validation fails:

- The shader program is not linked/validated.
- The material cannot render correctly.
- Three.js may continue rendering the scene, but affected meshes have no valid material program.
- The user sees the model disappear, turn black, or recover only after deleting the offending layer/material path.

## Current Shipped Behavior

Current app behavior:

- The ordinary projected material remains the visual source of truth.
- A visibility guard runs before `toggleLayer`, multi-layer visibility changes, visibility drag, and keyboard visibility toggles commit state.
- A newly generated projected layer is added with its eye closed when opening it would exceed the device budget.
- When blocked, the existing correct material remains unchanged; no partial layer set and no UV-flattened approximation is applied.
- The warning reports required/available texture units and explicitly asks the user to close a projected layer or merge visible projections into a UV layer.
- Closing an existing projected layer immediately frees its image/mask/depth sampler cost, after which another eye can be opened.
- Legacy projects that already contain an over-budget visible stack are not silently rewritten. Rendering keeps the last valid material and shows the same corrective warning.

## Possible Future Solutions (Not Shipped)

### 1. Batched Projected Preview Composition

Render projected layers in batches that fit within the device sampler limit, then composite each batch into an intermediate render target.

Concept:

```text
visible projected layers
  -> split into safe batches
  -> render batch 1 to offscreen texture
  -> render batch 2 over/offscreen texture
  -> ...
  -> final composed preview texture used by the model material
```

Benefits:

- All visible layers can contribute.
- Fragment shader sampler count stays bounded.
- The final model material only needs a small fixed number of textures.

Tradeoffs:

- More render passes.
- Needs careful invalidation when layer image, mask, depth, opacity, visibility, object transform, or camera metadata changes.
- Needs good caching to avoid recompositing every pointer move.

This remains a possible direction only after it can be proven visually equivalent on multi-mesh, overlapping-UV, mirrored-UV, masked, and depth-gated fixtures. It must not replace the current hard guard while it is approximate.

### 2. Projected Stack Cache / UV Bake Fast Path

Use the existing GPU/CPU UV bake pipeline to flatten projected layers into a baked UV/base texture when the user is idle or explicitly bakes.

Benefits:

- Very cheap viewport rendering after bake.
- Good for large stable layer stacks.
- Avoids sampler pressure in the normal preview path.

Tradeoffs:

- Bake output is UV-space, so it depends on the current UV bake quality and alignment.
- Not ideal for local repaint while brushing because the user needs immediate old/new comparison and undoable live strokes.

This remains useful only as an explicit user operation (for example, "merge visible projected layers to UV"), not as an invisible live-preview fallback.

### 3. Texture Atlas Or Packed Layer Inputs

Pack multiple projected images/masks/depth maps into fewer atlas textures.

Benefits:

- Reduces sampler count.
- Can keep a single shader pass in some cases.

Tradeoffs:

- Atlas packing is complex with mixed resolutions.
- Large atlases hit maximum texture size and memory limits.
- Mask/depth/source images have different sampling and color-space rules.
- Updating one layer can require atlas repacking or partial texture uploads.

This is possible, but less straightforward than batched composition.

### 4. WebGL2 Texture Arrays

Use `sampler2DArray` so many layer images can be stored in one array texture.

Benefits:

- One sampler can address many slices.

Tradeoffs:

- Requires WebGL2.
- All slices in an array need compatible dimensions/formats.
- Separate arrays are still needed for color, mask, and depth.
- Existing Three.js material integration becomes more custom.

This can be considered later, but it is not the safest immediate path.

## Acceptance Gate For Any Replacement

Any future high-capacity replacement must pass all of these before it can be user-visible:

1. Pixel-level comparison against the ordinary projected material for the same camera, lighting, opacity, strength, HSV adjustment, mask, depth gate, and layer order.
2. Multi-mesh FBX fixtures with overlapping UV islands and reused 0-1 UV ranges.
3. Mirrored UVs, missing UVs, multiple material groups, negative scales, and transformed child meshes.
4. No black diagnostic stripes, white fallback surfaces, missing parts, or active-layer ordering differences.
5. The existing eye-limit guard remains enabled until the replacement succeeds; failure must keep the last valid material rather than exposing a partial result.

## What Not To Do

- Do not hard-code a fixed 16-layer or 16-sampler app budget that hides visible layers.
- Do not flatten a general imported model into one shared UV preview texture.
- Do not open an eye first and attempt recovery after WebGL shader validation fails.
- Do not create a new projected layer per brush dab.
- Do not encode PNG/data URLs during every pointer move.
- Do not rely on WebGL context recovery to solve shader validation errors.
- Do not assume a high-end GPU means unlimited WebGL samplers.

## User-Facing Explanation

Short version:

The black render was caused by the live projected-layer shader asking WebGL for more texture samplers than the browser/GPU allows in one fragment shader. This limit is reported by WebGL and cannot be increased by app code. We should not fix it by hiding layers. The correct fix is to split visible projected layers into batches or precompose them into a cached preview texture, so every visible layer still contributes while each shader stays within the GPU limit.
