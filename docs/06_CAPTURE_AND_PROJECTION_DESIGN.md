# Capture and Projection Design

## Current View Capture

Capture starts from the active camera, selected object, viewport resolution, and current display settings. The system must save a camera snapshot with position, target, fov/zoom, near/far, view matrix, and projection matrix.

## Passes

- Color: visible shaded color.
- Mask: selected object or visible region mask.
- Depth: depth buffer normalized with enough metadata to compare later.
- Normal: view-space or world-space normal map, explicitly labeled.

Phase 2 implementation:

- Color uses the current renderer, scene, and camera in a WebGL render target.
- Mask hides all non-target meshes and renders the selected object white.
- Normal hides all non-target meshes and renders the selected object with `MeshNormalMaterial`.
- Depth hides all non-target meshes and renders the selected object with `MeshDepthMaterial`.
- Each pass restores materials and visibility after render.
- Pass canvases encode through asynchronous PNG Blob URLs. Local-server saves persist those captures into `assets/captures/` through the binary asset API instead of storing base64 payloads in `project.liclick.json`.

## Projection Back to Model

Generated images become projected layers. The projection material uses the stored camera matrices to map model fragments into image UV coordinates.

Phase 2 uses a Liclick custom shader:

1. Save camera projection matrix and world matrix at capture time.
2. Build a projector matrix from `projectionMatrix * inverse(matrixWorld)`.
3. In the vertex shader, pass world position.
4. In the fragment shader, project world position into clip space.
5. Convert clip space to projected image UV.
6. Sample the generated image and blend by layer opacity.

The projection sticks to model world space when the view rotates. It is not a screen overlay.

Phase 8 tightens visibility:

- fragments must be inside the saved camera frustum;
- projected UVs are feathered near the image edge;
- mask alpha/luminance can reject pixels outside the captured object area;
- grayscale depth is used as an MVP occlusion approximation;
- backfaces relative to the projector camera are rejected by default.

## Depth Check

Depth checks prevent painting through the model. The current MVP compares projected NDC depth against the captured grayscale depth texture with a bias/tolerance. This is approximate because the current depth pass is image-encoded, not a calibrated linear depth buffer.

## UV Bake Math

1. Iterate target mesh triangles in UV space.
2. For each UV sample, reconstruct or evaluate the matching world position.
3. For each visible layer, project world position into layer camera space.
4. Sample layer image and mask.
5. Composite by order, blend mode, and opacity.
6. Write final texel into the bake render target.

## Phase 3 UV Bake MVP

The current automatic bake implementation is GPU-first in `apps/web/src/engine/bake`. It renders visible projected layers into UV space on an offscreen WebGL render target, then uses the CPU rasterizer only as a same-resolution fallback or low-resolution coverage validation path.

Algorithm:

1. Load the active projected layer image into `ImageData`.
2. Create a basecolor output at the selected viewport resolution.
3. Traverse meshes under the imported model group.
4. Require `position` and `uv`; compute normals if absent.
5. For each indexed or non-indexed triangle, map UVs to canvas pixels.
6. Rasterize the UV triangle bounding box with barycentric coordinates.
7. Interpolate world position and world normal.
8. Optionally skip backfaces using `dot(surfaceNormal, cameraToPointDirection)`.
9. Project world position through the saved projected layer camera matrix.
10. Skip texels outside clip space.
11. Sample the projected image and blend with layer opacity.
12. Run seam dilation and covered-texel sharpening on GPU when the GPU path succeeds.
13. Encode PNG and apply it to the model material. Local-server projects upload the PNG as a binary asset.

Texture direction:

- The bake writes canvas Y as `1.0 - uv.y`.
- The applied Three.js texture uses `flipY = false` to keep the baked canvas aligned with the model UVs in this MVP.

Depth:

- Strict depth occlusion is not part of Phase 3.
- The bake uses in-frustum checks and optional normal backface culling.
- Depth-aware rejection should be added before multiview or production bake.

## MVP Limits

- Single object.
- Single material.
- Single UV set.
- 1024, 2048, 4096, or 8192 output, constrained by browser/GPU texture limits.
- Basecolor output before normal, roughness, and masks.
- Active projected layer preview is supported; automatic bake composites the visible projected-layer stack into one BaseColor.
- Phase 3 implements BaseColor UV bake only.
