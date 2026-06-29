# Projected Layer Visibility, Blend, And Depth

Earlier projected preview could look like the whole generated image was spread across the model because the shader mainly checked projector frustum bounds. The current path separates loose coverage from strict quality so a single projected image can still cover the visible surface, while bad samples do not dominate seams or overlaps.

## Preview Rules

For every projected fragment:

1. Project world position by `projectionMatrix * viewMatrix`.
2. Reject if clip `w <= 0` or NDC is outside `[-1, 1]`.
3. Convert NDC to projected image UV.
4. Feather near UV borders.
5. Reject backfaces relative to the capture camera.
6. If a mask image exists, reject low alpha/luminance.
7. If a depth image exists, compare approximate projected depth with grayscale captured depth using a bias.
8. Compute coverage from source alpha, layer opacity, view angle, and image-edge fade.
9. Compute quality from coverage plus stricter depth, normal-angle, and edge confidence.
10. If no projected sample covers the fragment, show the original/base material instead of a black edge, white mask, or checker diagnostic.

`Blend` mode is order-independent for the strongest candidates. It keeps the top projected samples by quality, mixes them with a coverage floor, and is intended for multi-view or overlapping generated layers. `Overlay` mode is order-sensitive and paints over the blended base, matching the layer-stack mental model.

## Bake Rules

UV bake uses the same idea per texel: interpolate world position/normal from UV rasterization, then apply frustum, mask, depth, source-alpha, and backface checks before sampling the generated image. Multi-layer bake uses the same loose coverage / strict quality split as preview: blend layers feed the order-independent quality composite, then overlay layers are applied in stack order. Dilation only expands already-written texel edges.

## Depth Limit

Current depth is an MVP grayscale image from `MeshDepthMaterial`, not a calibrated linear depth asset. It catches many obvious projection-through cases but should be replaced with a linear or packed depth buffer before production multiview.

## Multiview Reuse

Future multiview can reuse this visibility function per camera/layer, then composite accepted samples by view weight, angle, and mask confidence.
