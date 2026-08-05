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
  /**
   * Permit blank cross-surface/component UV overlaps as final-write targets.
   * This is intended only for a sparse underlay built from an already-resolved
   * final projection composite. Defaults to false.
   */
  allowConflictedWrites?: boolean;
  hardAlphaThreshold?: number;
  weakAlphaThreshold?: number;
  weakGrowPixels?: 0 | 1;
  /**
   * Reject connected hard-gap components smaller than this many texels.
   * Defaults to 16 texels per megapixel (minimum 4).
   */
  minimumComponentPixels?: number;
  /**
   * Keep a narrow component when its bounding-box span reaches this value,
   * even if its area is below `minimumComponentPixels`. Set to 0 to disable
   * the long-seam exception. Defaults to 12 texels per 1K of linear size.
   */
  minimumComponentSpan?: number;
  signal?: AbortSignal;
  yieldIntervalMs?: number;
};

export type ContentAwareRepairMaskStats = {
  hardPixels: number;
  weakPixels: number;
  totalPixels: number;
  conflictRejectedPixels: number;
  conservativeHaloRejectedPixels: number;
  noiseRejectedPixels: number;
  noiseRejectedComponents: number;
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

function normalizeThreshold(value: number | undefined, fallback: number, minimum: number) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.floor(value));
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
  const megapixelScale = pixelCount / (1024 * 1024);
  const linearScale = Math.sqrt(megapixelScale);
  const minimumComponentPixels = normalizeThreshold(
    input.minimumComponentPixels,
    Math.max(4, Math.round(16 * megapixelScale)),
    1,
  );
  const minimumComponentSpan = normalizeThreshold(
    input.minimumComponentSpan,
    Math.max(4, Math.round(12 * linearScale)),
    0,
  );
  const yieldIntervalMs = Math.max(2, input.yieldIntervalMs ?? 8);
  const mask = new Uint8Array(pixelCount);
  let hardPixels = 0;
  let weakPixels = 0;
  let conflictRejectedPixels = 0;
  let conservativeHaloRejectedPixels = 0;
  let noiseRejectedPixels = 0;
  let noiseRejectedComponents = 0;
  let lastYieldAt = now();

  const checkpoint = async () => {
    throwIfAborted(input.signal);
    if (now() - lastYieldAt < yieldIntervalMs) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    lastYieldAt = now();
    throwIfAborted(input.signal);
  };

  throwIfAborted(input.signal);

  for (let y = 0; y < input.height; y += 1) {
    const rowStart = y * input.width;
    for (let x = 0; x < input.width; x += 1) {
      const index = rowStart + x;
      const alpha = input.rgba[index * 4 + 3];
      // Intra-component UV-island overlaps (kind 1) are safe final-write
      // targets: one repaired texel closes both sides of the same physical
      // skin seam. Cross-component writes require an explicit underlay opt-in.
      // The caller decides donor policy separately; this function only marks
      // final-write targets.
      if (input.conflictMask[index] > 1 && !input.allowConflictedWrites) {
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

  // A transparent projection contains thousands of isolated one-texel misses
  // around rasterized edges. Treating every miss as content to synthesize is
  // what creates the dirty UV-layer speckles. Filter hard seeds by connected
  // component before weak growth so rejected noise cannot grow a halo.
  //
  // States used during this pass:
  //   255 = unvisited hard seed, 254 = queued, 253 = retained component.
  if (hardPixels > 0 && minimumComponentPixels > 1) {
    const queue = new Uint32Array(pixelCount);
    let processedComponents = 0;
    for (let seed = 0; seed < pixelCount; seed += 1) {
      if (mask[seed] !== 255) continue;

      const regionId = input.regionIds[seed];
      let head = 0;
      let tail = 1;
      queue[0] = seed;
      mask[seed] = 254;
      let minX = input.width;
      let minY = input.height;
      let maxX = -1;
      let maxY = -1;

      while (head < tail) {
        const index = queue[head];
        head += 1;
        const y = Math.floor(index / input.width);
        const x = index - y * input.width;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;

        if (
          x > 0 &&
          mask[index - 1] === 255 &&
          input.regionIds[index - 1] === regionId
        ) {
          mask[index - 1] = 254;
          queue[tail] = index - 1;
          tail += 1;
        }
        if (
          x + 1 < input.width &&
          mask[index + 1] === 255 &&
          input.regionIds[index + 1] === regionId
        ) {
          mask[index + 1] = 254;
          queue[tail] = index + 1;
          tail += 1;
        }
        if (
          y > 0 &&
          mask[index - input.width] === 255 &&
          input.regionIds[index - input.width] === regionId
        ) {
          mask[index - input.width] = 254;
          queue[tail] = index - input.width;
          tail += 1;
        }
        if (
          y + 1 < input.height &&
          mask[index + input.width] === 255 &&
          input.regionIds[index + input.width] === regionId
        ) {
          mask[index + input.width] = 254;
          queue[tail] = index + input.width;
          tail += 1;
        }
        if ((head & 0x3fff) === 0) await checkpoint();
      }

      const componentSpan = Math.max(maxX - minX + 1, maxY - minY + 1);
      const retainComponent =
        tail >= minimumComponentPixels ||
        (minimumComponentSpan > 0 && componentSpan >= minimumComponentSpan);
      const outputState = retainComponent ? 253 : 0;
      for (let componentIndex = 0; componentIndex < tail; componentIndex += 1) {
        mask[queue[componentIndex]] = outputState;
        if (componentIndex > 0 && (componentIndex & 0xffff) === 0) await checkpoint();
      }
      if (!retainComponent) {
        hardPixels -= tail;
        noiseRejectedPixels += tail;
        noiseRejectedComponents += 1;
      }
      processedComponents += 1;
      if ((processedComponents & 0xff) === 0) await checkpoint();
    }

    for (let index = 0; index < pixelCount; index += 1) {
      if (mask[index] === 253) mask[index] = 255;
      if ((index & 0xffff) === 0) await checkpoint();
    }
  }

  if (weakGrowPixels === 1 && hardPixels > 0) {
    for (let y = 0; y < input.height; y += 1) {
      const rowStart = y * input.width;
      for (let x = 0; x < input.width; x += 1) {
        const index = rowStart + x;
        if (
          mask[index] ||
          !input.coreMask[index] ||
          (input.conflictMask[index] > 1 && !input.allowConflictedWrites) ||
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
      noiseRejectedPixels,
      noiseRejectedComponents,
    },
  };
}
