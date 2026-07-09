# Bake Pipeline

The current browser bake pipeline composites visible projected layers into one BaseColor PNG for the selected imported object.

Flow:

1. Collect projected, UV, and patch layers for a selected object.
2. Prefer GPU UV-space rendering for the visible projected-layer stack.
3. Fall back to CPU UV rasterization at the same resolution when GPU allocation/rendering fails.
4. Composite normal projected layers by projection quality. A clearly dominant candidate wins; near-tie candidates blend softly. Overlay layers remain order-sensitive and paint above the blended base.
5. Dilate seams, encode BaseColor PNG, apply it to the viewport, and persist it when a local workspace is available.

Current limits are one imported object, one UV set, BaseColor output, and no UDIM. Output resolution follows the viewport selector and is never reduced automatically by the bake path.

GPU coverage parity validation is disabled in normal production use because it requires an extra CPU rasterization pass. Enable it only while debugging projection divergence:

```js
localStorage.setItem('liclick-debug-gpu-coverage-validation', '1')
```
