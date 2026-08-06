# Bake Pipeline

The current browser bake pipeline composites visible projected layers into one BaseColor PNG for the selected imported object.

Flow:

1. Collect projected, UV, and patch layers for a selected object.
2. Prefer GPU UV-space sampling for the visible projected-layer stack.
3. Fall back to CPU UV rasterization at the same resolution when GPU allocation/rendering fails.
4. Transfer the normal and overlay rasters to a persistent Worker. The Worker builds the top-three quality candidates, resolves the quality blend with WebGPU when available, applies overlays, and returns the finished RGBA buffer. A clearly dominant candidate wins; near-tie candidates blend softly.
5. Dilate seams, encode BaseColor PNG, apply it to the viewport, and persist it when a local workspace is available.

Current limits are one imported object, one UV set, BaseColor output, and no UDIM. Output resolution follows the viewport selector and is never reduced automatically by the bake path.

Production defaults:

- `method: gpu`, with CPU fallback on GPU failure.
- `gpuCompositeMode: cpu-parity` still defines the output algorithm, but the production implementation now runs candidate accumulation and overlays in a Worker and runs the quality resolve in WebGPU.
- The first real bake for each alpha mode (`opaque` and coverage-confidence alpha) also computes the CPU reference in the Worker. GPU output is approved only when alpha is byte-exact, maximum byte delta is at most 1, and the mismatch ratio is at most `0.00001`. Later bakes in the same Worker session skip the CPU resolve.
- WebGPU/device failure or a rejected calibration automatically publishes the exact CPU Worker output. `?perfQualityCpuGold=1` forces CPU output; `?perfQualityGpuAb=1` repeats the CPU/GPU comparison on every bake.
- `gpuProjectedImageUvFlipY: true`, because GPU projected image, mask, and depth textures need Y-flipped sampling to match the CPU image-data convention.

GPU coverage parity validation is disabled in normal production use because it requires an extra CPU rasterization pass. Enable it only while debugging projection divergence:

```js
localStorage.setItem('liclick-debug-gpu-coverage-validation', '1')
```
