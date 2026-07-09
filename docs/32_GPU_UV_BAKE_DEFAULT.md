# GPU UV Bake Default

As of 2026-07-09, the UV bake production path is GPU-first with CPU fallback.

## Current decision

- CPU rasterization remains the golden reference.
- Normal production bake defaults to GPU sampling.
- If GPU setup, allocation, or rendering fails, the bake falls back to the CPU path at the same resolution.
- GPU projected image, mask, and depth inputs must all be sampled with Y flipped. Do not flip the final baked UV texture for this fix.
- The default GPU composite mode is `cpu-parity`: GPU rasterizes each projected layer, then the existing CPU golden compositor performs quality candidate selection, soft blending, overlay application, dilation, sharpening, and viewport fill.

## Why

The original GPU mismatch had two separate causes:

1. The offscreen renderer inherited viewport DPR, which produced a bottom-left anchored scale/crop in UV space.
2. GPU projected input sampling used a different Y convention from CPU `ImageData`. The correct adaptation is to flip the GPU sampling coordinates for the projected color image, mask, and depth image together.

After those were fixed, the remaining visual mismatch came from composition strategy rather than projection math: CPU uses a top-k quality blend with color consistency and residual coverage mixing, while the old GPU `quality-depth` mode selected a single quality winner through the depth buffer. `cpu-parity` keeps GPU sampling but reuses the CPU golden compositor to align the final UV layer.

## Console commands

Production default:

```js
LiclickUvDebug.useDefault()
LiclickUvDebug.status()
```

Temporarily force CPU golden path:

```js
LiclickUvDebug.useCpu({ ttlMs: 10 * 60 * 1000 })
```

Temporarily force GPU:

```js
LiclickUvDebug.useGpu({ ttlMs: 10 * 60 * 1000 })
```

Compare CPU golden and GPU default:

```js
await LiclickUvDebug.compare({
  resolution: 1024,
  allVisible: true,
  download: true,
  logProgress: true
})
```

Reproduce the old unflipped GPU projected input sampling:

```js
await LiclickUvDebug.compare({
  resolution: 1024,
  gpuProjectedImageUvFlipY: false,
  download: true
})
```

Reproduce the old GPU quality-depth winner compositor:

```js
await LiclickUvDebug.compare({
  resolution: 1024,
  gpuCompositeMode: 'quality-depth',
  download: true
})
```
