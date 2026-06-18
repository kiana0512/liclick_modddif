# Projected Layer Visibility And Depth

Earlier projected preview could look like the whole generated image was spread across the model because the shader mainly checked projector frustum bounds. Phase 8 adds the missing visibility gates.

## Preview Rules

For every projected fragment:

1. Project world position by `projectionMatrix * viewMatrix`.
2. Reject if clip `w <= 0` or NDC is outside `[-1, 1]`.
3. Convert NDC to projected image UV.
4. Feather near UV borders.
5. Reject backfaces relative to the capture camera.
6. If a mask image exists, reject low alpha/luminance.
7. If a depth image exists, compare approximate projected depth with grayscale captured depth using a bias.

## Bake Rules

UV bake uses the same idea per texel: interpolate world position/normal from UV rasterization, then apply frustum, mask, depth, and backface checks before sampling the generated image. Dilation only expands already-written texel edges.

## Depth Limit

Current depth is an MVP grayscale image from `MeshDepthMaterial`, not a calibrated linear depth asset. It catches many obvious projection-through cases but should be replaced with a linear or packed depth buffer before production multiview.

## Multiview Reuse

Future multiview can reuse this visibility function per camera/layer, then composite accepted samples by view weight, angle, and mask confidence.
