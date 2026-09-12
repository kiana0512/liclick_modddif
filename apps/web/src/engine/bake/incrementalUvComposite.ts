import type { UvBakeResolution } from './uvBakeTypes';

/** Canvas-order coordinates at the original texel density, never a downsample. */
export type UvBakeRegion = { x: number; y: number; size: UvBakeResolution };
export type RawUvComposite = {
  imageData: ImageData;
  coverage: Uint8Array<ArrayBuffer>;
  renderedColorMask: Uint8Array<ArrayBuffer>;
  writtenTexels: number;
};

export function eraserBakeRegion(bounds: { x: number; y: number; width: number; height: number } | undefined,
  resolution: UvBakeResolution): UvBakeRegion | undefined {
  if (!bounds || !Object.values(bounds).every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) return;
  // Include the bilinear footprint of the full-resolution keep-mask.
  const left = Math.max(0, Math.floor(bounds.x) - 2), top = Math.max(0, Math.floor(bounds.y) - 2);
  const right = Math.min(resolution, Math.ceil(bounds.x + bounds.width) + 2);
  const bottom = Math.min(resolution, Math.ceil(bounds.y + bounds.height) + 2);
  for (const size of [512, 1024] as const) {
    if (size >= resolution) break;
    const x = Math.min(Math.floor(left / 128) * 128, resolution - size);
    const y = Math.min(Math.floor(top / 128) * 128, resolution - size);
    if (right <= x + size && bottom <= y + size) return { x, y, size };
  }
}

/** Copy-on-write: postprocessing, upload transfer and failed requests cannot poison the base. */
export function copyRawUvComposite(source: RawUvComposite): RawUvComposite {
  return {
    imageData: new ImageData(source.imageData.data.slice(), source.imageData.width, source.imageData.height),
    coverage: source.coverage.slice(), renderedColorMask: source.renderedColorMask.slice(),
    writtenTexels: source.writtenTexels,
  };
}

export function patchRawUvComposite(base: RawUvComposite, patch: RawUvComposite, region: UvBakeRegion) {
  const width = base.imageData.width;
  if (patch.imageData.width !== region.size || patch.imageData.height !== region.size ||
      !Number.isInteger(region.x) || !Number.isInteger(region.y) ||
      region.x < 0 || region.y < 0 || region.x + region.size > width || region.y + region.size > base.imageData.height)
    throw new Error('Invalid incremental UV region.');
  const result = copyRawUvComposite(base);
  if (patch.renderedColorMask.length && !result.renderedColorMask.length)
    result.renderedColorMask = new Uint8Array(width * base.imageData.height);
  for (let y = 0; y < region.size; y++) {
    const from = y * region.size, to = (y + region.y) * width + region.x;
    for (let x = 0; x < region.size; x++)
      result.writtenTexels += Number(patch.coverage[from + x] > 0) - Number(base.coverage[to + x] > 0);
    result.imageData.data.set(patch.imageData.data.subarray(from * 4, (from + region.size) * 4), to * 4);
    result.coverage.set(patch.coverage.subarray(from, from + region.size), to);
    if (result.renderedColorMask.length) {
      if (patch.renderedColorMask.length)
        result.renderedColorMask.set(patch.renderedColorMask.subarray(from, from + region.size), to);
      else result.renderedColorMask.fill(0, to, to + region.size);
    }
  }
  return result;
}
