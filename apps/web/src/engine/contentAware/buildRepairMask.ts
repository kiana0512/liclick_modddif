export type ContentAwareRepairMaskInput = {
  width: number;
  height: number;
  rgba: Uint8Array | Uint8ClampedArray;
  /** Conservative topology used only to report rejected halo pixels. */
  topologyMask: Uint8Array;
  /** Strict pixel-centre topology. Only these texels may receive output alpha. */
  coreMask: Uint8Array;
  regionIds: Uint32Array;
  conflictMask: Uint8Array;
  hardAlphaThreshold?: number;
  weakAlphaThreshold?: number;
  weakGrowPixels?: 0 | 1;
  signal?: AbortSignal;
  yieldIntervalMs?: number;
};

export type ContentAwareRepairMaskStats = {
  hardPixels: number;
  weakPixels: number;
  totalPixels: number;
  conflictRejectedPixels: number;
  conservativeHaloRejectedPixels: number;
};

export type ContentAwareRepairMaskResult = {
  mask: Uint8Array;
  stats: ContentAwareRepairMaskStats;
};

function validateLength(name: string, actual: number, expected: number) {
  if (actual !== expected) {
    throw new RangeError(`${name} must contain ${expected} entries; received ${actual}.`);
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  const error = new Error('Content-aware repair-mask construction was aborted.');
  error.name = 'AbortError';
  throw error;
}

function now() {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

/**
 * Builds the sparse *final-write* mask for content-aware UV repair.
 *
 * The projection bake deliberately keeps feathered/angle-weighted samples in
 * the 9..255 alpha range. Those samples are authored content, not gaps. A hard
 * gap therefore uses the same <=8 cutoff as the transparent UV bake. One weak
 * alpha texel may be included beside a hard gap to hide bilinear pinholes, but
 * the weak band can never seed itself or spread across a UV region boundary.
 */
export async function buildContentAwareRepairMask(
  input: ContentAwareRepairMaskInput,
): Promise<ContentAwareRepairMaskResult> {
  const pixelCount = input.width * input.height;
  if (!Number.isSafeInteger(pixelCount) || input.width <= 0 || input.height <= 0) {
    throw new RangeError(`Invalid content-aware repair-mask size: ${input.width}x${input.height}.`);
  }
  validateLength('rgba', input.rgba.length, pixelCount * 4);
  validateLength('topologyMask', input.topologyMask.length, pixelCount);
  validateLength('coreMask', input.coreMask.length, pixelCount);
  validateLength('regionIds', input.regionIds.length, pixelCount);
  validateLength('conflictMask', input.conflictMask.length, pixelCount);

  const hardAlphaThreshold = Math.max(0, Math.min(255, input.hardAlphaThreshold ?? 8));
  const weakAlphaThreshold = Math.max(
    hardAlphaThreshold,
    Math.min(255, input.weakAlphaThreshold ?? 24),
  );
  const weakGrowPixels = input.weakGrowPixels ?? 1;
  const yieldIntervalMs = Math.max(2, input.yieldIntervalMs ?? 8);
  const mask = new Uint8Array(pixelCount);
  let hardPixels = 0;
  let weakPixels = 0;
  let conflictRejectedPixels = 0;
  let conservativeHaloRejectedPixels = 0;
  let lastYieldAt = now();

  const checkpoint = async () => {
    throwIfAborted(input.signal);
    if (now() - lastYieldAt < yieldIntervalMs) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    lastYieldAt = now();
    throwIfAborted(input.signal);
  };

  for (let y = 0; y < input.height; y += 1) {
    const rowStart = y * input.width;
    for (let x = 0; x < input.width; x += 1) {
      const index = rowStart + x;
      const alpha = input.rgba[index * 4 + 3];
      if (input.conflictMask[index]) {
        if (input.coreMask[index] && alpha <= hardAlphaThreshold) {
          conflictRejectedPixels += 1;
        }
        continue;
      }
      if (!input.coreMask[index]) {
        if (input.topologyMask[index] && alpha <= hardAlphaThreshold) {
          conservativeHaloRejectedPixels += 1;
        }
        continue;
      }
      if (!input.regionIds[index] || alpha > hardAlphaThreshold) continue;
      mask[index] = 255;
      hardPixels += 1;
    }
    await checkpoint();
  }

  if (weakGrowPixels === 1 && hardPixels > 0) {
    for (let y = 0; y < input.height; y += 1) {
      const rowStart = y * input.width;
      for (let x = 0; x < input.width; x += 1) {
        const index = rowStart + x;
        if (
          mask[index] ||
          !input.coreMask[index] ||
          input.conflictMask[index] ||
          !input.regionIds[index] ||
          input.rgba[index * 4 + 3] > weakAlphaThreshold
        ) {
          continue;
        }
        const regionId = input.regionIds[index];
        const hasHardNeighbor =
          (x > 0 &&
            mask[index - 1] === 255 &&
            input.regionIds[index - 1] === regionId) ||
          (x + 1 < input.width &&
            mask[index + 1] === 255 &&
            input.regionIds[index + 1] === regionId) ||
          (y > 0 &&
            mask[index - input.width] === 255 &&
            input.regionIds[index - input.width] === regionId) ||
          (y + 1 < input.height &&
            mask[index + input.width] === 255 &&
            input.regionIds[index + input.width] === regionId);
        if (!hasHardNeighbor) continue;
        // 128 distinguishes the one-pixel weak band from hard seeds, ensuring
        // iteration order cannot accidentally grow a longer chain.
        mask[index] = 128;
        weakPixels += 1;
      }
      await checkpoint();
    }
    for (let index = 0; index < mask.length; index += 1) {
      if (mask[index] === 128) mask[index] = 255;
      if ((index & 0xffff) === 0) await checkpoint();
    }
  }

  throwIfAborted(input.signal);
  return {
    mask,
    stats: {
      hardPixels,
      weakPixels,
      totalPixels: hardPixels + weakPixels,
      conflictRejectedPixels,
      conservativeHaloRejectedPixels,
    },
  };
}
