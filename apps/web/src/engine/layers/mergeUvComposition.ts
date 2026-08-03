import type { Layer } from '@/types/layer';

export function isContentAwareUvUnderlay(
  layer: Pick<Layer, 'id' | 'type' | 'role' | 'generationId'>,
) {
  return Boolean(
    layer.type === 'uv' &&
      (layer.role === 'content-aware-underlay' ||
        layer.generationId === 'texture-map-content-aware-repair' ||
        layer.id.startsWith('content-aware-uv-repair')),
  );
}

export function isFlattenableUvMergeSource(
  layer: Pick<Layer, 'id' | 'type' | 'role' | 'generationId' | 'imageUrl'>,
) {
  return Boolean(
    layer.type === 'uv' &&
      layer.imageUrl &&
      isContentAwareUvUnderlay(layer),
  );
}

/**
 * Composites `underlay` behind the existing straight-alpha `front` pixels.
 * The operation is intentionally in-place so a 4K/8K merge does not allocate
 * another full-size RGBA result for every selected layer.
 */
export function compositeRgbaUnderInPlace(
  front: Uint8Array | Uint8ClampedArray,
  underlay: Uint8Array | Uint8ClampedArray,
  opacity = 1,
) {
  if (front.length !== underlay.length || front.length % 4 !== 0) {
    throw new RangeError('RGBA buffers must have the same four-channel length.');
  }
  const layerOpacity = Math.max(0, Math.min(1, opacity));
  if (layerOpacity <= 0) return front;

  for (let offset = 0; offset < front.length; offset += 4) {
    const frontAlpha = front[offset + 3] / 255;
    const underlayAlpha = (underlay[offset + 3] / 255) * layerOpacity;
    const visibleUnderlayAlpha = underlayAlpha * (1 - frontAlpha);
    const outputAlpha = frontAlpha + visibleUnderlayAlpha;

    // Fully transparent RGB is still meaningful texture-atlas padding. Keep
    // the nearest-front padding instead of erasing it during the flatten.
    if (outputAlpha <= 0) {
      if (
        front[offset] === 0 &&
        front[offset + 1] === 0 &&
        front[offset + 2] === 0
      ) {
        front[offset] = underlay[offset];
        front[offset + 1] = underlay[offset + 1];
        front[offset + 2] = underlay[offset + 2];
      }
      front[offset + 3] = 0;
      continue;
    }

    for (let channel = 0; channel < 3; channel += 1) {
      front[offset + channel] = Math.round(
        (front[offset + channel] * frontAlpha +
          underlay[offset + channel] * visibleUnderlayAlpha) /
          outputAlpha,
      );
    }
    front[offset + 3] = Math.round(outputAlpha * 255);
  }
  return front;
}

export function getRgbaAlphaCoverageRatio(
  rgba: Uint8Array | Uint8ClampedArray,
  alphaThreshold = 8,
) {
  if (rgba.length % 4 !== 0) throw new RangeError('RGBA buffer length must be divisible by four.');
  let coveredPixels = 0;
  for (let offset = 3; offset < rgba.length; offset += 4) {
    if (rgba[offset] > alphaThreshold) coveredPixels += 1;
  }
  return rgba.length === 0 ? 0 : coveredPixels / (rgba.length / 4);
}

export function getMergeUvPostprocessOptions(resolution: number) {
  const safeResolution = Math.max(1, Math.floor(resolution));
  return {
    // Restore the verified atlas postprocess profile. The two-pixel gutter is
    // outside model UV triangles and retains source alpha for bilinear sampling.
    uvIslandGutterPixels: Math.min(8, Math.max(2, Math.ceil(safeResolution / 512))),
    // Broad topology dilation paints intentionally empty surfaces. Keep it off;
    // only fully enclosed components are eligible for the dedicated pass.
    uvCoverageGapPixels: 0,
    uvInteriorHolePixels: Math.min(2, Math.max(1, Math.ceil(safeResolution / 2048))),
    // Reconcile only a small geometry-paired seam band.
    uvSeamRepairPixels: Math.min(4, Math.max(2, Math.ceil(safeResolution / 1024))),
  };
}
