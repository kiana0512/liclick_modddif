# Capture and Projection Design

## Current View Capture

Capture starts from the active camera, selected object, viewport resolution, and current display settings. The system must save a camera snapshot with position, target, fov/zoom, near/far, view matrix, and projection matrix.

## Passes

- Color: visible shaded color.
- Mask: selected object or visible region mask.
- Depth: depth buffer normalized with enough metadata to compare later.
- Normal: view-space or world-space normal map, explicitly labeled.

## Projection Back to Model

Generated images become projected layers. The projection material uses the stored camera matrices to map model fragments into image UV coordinates.

## Depth Check

Depth checks prevent painting through the model. Compare the projected fragment depth against captured depth using a tolerance and reject fragments outside the captured surface.

## UV Bake Math

1. Iterate target mesh triangles in UV space.
2. For each UV sample, reconstruct or evaluate the matching world position.
3. For each visible layer, project world position into layer camera space.
4. Sample layer image and mask.
5. Composite by order, blend mode, and opacity.
6. Write final texel into the bake render target.

## MVP Limits

- Single object.
- Single material.
- Single UV set.
- 1024 or 2048 output first.
- Basecolor output before normal, roughness, and masks.
