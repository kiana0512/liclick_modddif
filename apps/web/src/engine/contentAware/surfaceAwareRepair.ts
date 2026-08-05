export type SurfaceRepairByteArray = Uint8Array | Uint8ClampedArray;

export type SurfaceRepairRegionArray = Uint32Array | Int32Array;

export type SurfaceRepairConnectivity = 4 | 8;

export type SurfaceRepairPhase =
  | 'preparing'
  | 'padding-sources'
  | 'finding-sources'
  | 'propagating'
  | 'locking-source-region'
  | 'writing'
  | 'bleeding'
  | 'complete';

export interface SurfaceRepairProgress {
  phase: SurfaceRepairPhase;
  /** Overall progress in the inclusive range [0, 1]. */
  progress: number;
  /** Progress within the current phase in the inclusive range [0, 1]. */
  phaseProgress: number;
  completed: number;
  total: number;
}

/**
 * A worker-friendly input made exclusively from scalar values and typed arrays.
 *
 * `writeMask` is the original gap mask and normally the only area that may be
 * written. `coverageSkirtPixels` may additionally publish a tightly constrained
 * opaque ring into still-empty input texels inside the same UV region.
 * `sourceExclusionMask` only controls where colors may be sampled from.
 * `topologyMask` must be a conservative raster of model UV coverage so propagation
 * cannot travel through empty texture space.
 *
 * `seamLinks` is an optional flat array of bidirectional pixel-index pairs:
 * `[a0, b0, a1, b1, ...]`. It may bridge UV seams that are disconnected in 2D but
 * touch on the model surface. `topologyRegionIds`, when supplied, prevents regular
 * grid edges from crossing different triangle/island regions; explicit seam links
 * are still allowed to bridge those regions.
 */
export interface SurfaceAwareRepairInput {
  width: number;
  height: number;
  rgba: SurfaceRepairByteArray;
  writeMask: SurfaceRepairByteArray;
  sourceExclusionMask?: SurfaceRepairByteArray;
  topologyMask: SurfaceRepairByteArray;
  seamLinks?: Uint32Array;
  topologyRegionIds?: SurfaceRepairRegionArray;
  /** Maximum physical UV seam edges a colour may cross. Omit for legacy unlimited traversal. */
  maxSeamCrossings?: number;
  /** Extra topology-aware pixels around writeMask that cannot be color sources. */
  sourcePaddingPixels?: number;
  /** Maximum surface-graph distance from a valid source. Defaults to 128 pixels. */
  maxDistance?: number;
  /** Minimum source alpha. Defaults to 250 to reject projection feather pixels. */
  minSourceAlpha?: number;
  /**
   * Reject a source whose RGB is not supported by at least two thirds of its valid
   * 8-neighbourhood. Value is the per-channel RMS distance in bytes; zero
   * disables the filter. This removes thin white/dark projection fringes while
   * retaining coherent light or dark material regions.
   */
  sourceColorOutlierThreshold?: number;
  /** Four-neighbor traversal is safest for disconnected UV islands. */
  connectivity?: SurfaceRepairConnectivity;
  /**
   * Opaque antialiasing skirt around successfully repaired texels. It only enters
   * topology-covered texels in the same UV region whose original input alpha is
   * at most coverageSkirtMaxInputAlpha. Defaults to zero (disabled).
   */
  coverageSkirtPixels?: number;
  /** Maximum original input alpha that the coverage skirt may replace. */
  coverageSkirtMaxInputAlpha?: number;
  /** RGB-only atlas padding around the sparse output. Alpha remains zero. */
  outputBleedPixels?: number;
  /** Reject a connected gap component when any of its texels cannot be repaired. */
  requireCompleteComponents?: boolean;
  /**
   * When dominant-source locking is enabled, keep nearest-source propagation if
   * the competing donor colours exceed this per-channel RMS distance. Omit it
   * to retain unconditional legacy locking.
   */
  dominantSourceColorThreshold?: number;
  /**
   * Forces every connected physical gap component to clone from one dominant
   * source texel. The donor region is selected first, then one real texel wins
   * by ownership area, preventing both cross-region and same-region Voronoi
   * colour stripes.
   */
  lockToDominantSourceRegion?: boolean;
}

export interface SurfaceRepairStats {
  pixelCount: number;
  topologyPixels: number;
  requestedPixels: number;
  eligibleSourcePixels: number;
  sourceColorOutliersRejected: number;
  boundarySourcePixels: number;
  sourcePaddingPixels: number;
  sourceExcludedPixels: number;
  seamLinkPairs: number;
  propagatedPixels: number;
  repairedPixels: number;
  unresolvedPixels: number;
  maxDistance: number;
  maxDistanceReached: number;
  coverageSkirtPixels: number;
  coverageSkirtPixelCount: number;
  outputBleedPixels: number;
  outputBleedPixelCount: number;
  partialComponentsDiscarded: number;
  partialPixelsDiscarded: number;
  sourceRegionLockedComponents: number;
  sourceRegionReassignedPixels: number;
  sourceRegionExtendedPixels: number;
  elapsedMs: number;
}

export interface SurfaceAwareRepairResult {
  /**
    * A dedicated repair-layer image: transparent outside repairedMask and exact
   * cloned source texels inside it. This is not a flattened copy of the source UV.
   */
  filledRgba: Uint8ClampedArray<ArrayBuffer>;
  /** Final layer/write alpha: repaired gap pixels plus the optional constrained skirt. */
  repairedMask: Uint8Array<ArrayBuffer>;
  /** Sampling-only mask, including sourcePaddingPixels. Never use as layer alpha. */
  sourceExclusionMask: Uint8Array<ArrayBuffer>;
  stats: SurfaceRepairStats;
}

export interface SurfaceRepairHooks {
  signal?: Pick<AbortSignal, 'aborted'>;
  shouldAbort?: () => boolean;
  onProgress?: (progress: SurfaceRepairProgress) => void;
  /** Limits callback and abort-check frequency during long linear scans. */
  progressStride?: number;
}

export class SurfaceRepairAbortError extends Error {
  override name = 'AbortError';

  constructor(message = 'Surface-aware repair was cancelled.') {
    super(message);
  }
}

interface NormalizedInput {
  width: number;
  height: number;
  pixelCount: number;
  rgba: SurfaceRepairByteArray;
  writeMask: SurfaceRepairByteArray;
  sourceExclusionMask?: SurfaceRepairByteArray;
  topologyMask: SurfaceRepairByteArray;
  seamLinks?: Uint32Array;
  topologyRegionIds?: SurfaceRepairRegionArray;
  maxSeamCrossings: number;
  sourcePaddingPixels: number;
  maxDistance: number;
  minSourceAlpha: number;
  sourceColorOutlierThreshold: number;
  connectivity: SurfaceRepairConnectivity;
  coverageSkirtPixels: number;
  coverageSkirtMaxInputAlpha: number;
  outputBleedPixels: number;
  requireCompleteComponents: boolean;
  dominantSourceColorThreshold?: number;
  lockToDominantSourceRegion: boolean;
}

interface SeamAdjacency {
  heads: Int32Array;
  targets: Uint32Array;
  next: Int32Array;
  pairCount: number;
}

const FOUR_NEIGHBOR_X = new Int8Array([-1, 1, 0, 0]);
const FOUR_NEIGHBOR_Y = new Int8Array([0, 0, -1, 1]);
const EIGHT_NEIGHBOR_X = new Int8Array([-1, 1, 0, 0, -1, 1, -1, 1]);
const EIGHT_NEIGHBOR_Y = new Int8Array([0, 0, -1, 1, -1, -1, 1, 1]);

function now() {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number) {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function validateLength(name: string, value: ArrayLike<number>, expected: number) {
  if (value.length !== expected) {
    throw new RangeError(`${name} must contain ${expected} entries; received ${value.length}.`);
  }
}

function normalizeInput(input: SurfaceAwareRepairInput): NormalizedInput {
  if (!Number.isSafeInteger(input.width) || input.width <= 0) {
    throw new RangeError('Surface repair width must be a positive integer.');
  }
  if (!Number.isSafeInteger(input.height) || input.height <= 0) {
    throw new RangeError('Surface repair height must be a positive integer.');
  }
  const pixelCount = input.width * input.height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount > 0xffffffff) {
    throw new RangeError('Surface repair texture is too large for 32-bit pixel indices.');
  }
  validateLength('rgba', input.rgba, pixelCount * 4);
  validateLength('writeMask', input.writeMask, pixelCount);
  validateLength('topologyMask', input.topologyMask, pixelCount);
  if (input.sourceExclusionMask) {
    validateLength('sourceExclusionMask', input.sourceExclusionMask, pixelCount);
  }
  if (input.topologyRegionIds) {
    validateLength('topologyRegionIds', input.topologyRegionIds, pixelCount);
  }
  if (input.seamLinks && input.seamLinks.length % 2 !== 0) {
    throw new RangeError('seamLinks must contain flat pixel-index pairs.');
  }
  return {
    width: input.width,
    height: input.height,
    pixelCount,
    rgba: input.rgba,
    writeMask: input.writeMask,
    sourceExclusionMask: input.sourceExclusionMask,
    topologyMask: input.topologyMask,
    seamLinks: input.seamLinks,
    topologyRegionIds: input.topologyRegionIds,
    maxSeamCrossings: clampInteger(input.maxSeamCrossings, 255, 0, 255),
    sourcePaddingPixels: clampInteger(input.sourcePaddingPixels, 8, 0, pixelCount),
    maxDistance: clampInteger(input.maxDistance, 128, 0, pixelCount),
    minSourceAlpha: clampInteger(input.minSourceAlpha, 250, 1, 255),
    sourceColorOutlierThreshold: clampInteger(
      input.sourceColorOutlierThreshold,
      0,
      0,
      255,
    ),
    connectivity: input.connectivity === 8 ? 8 : 4,
    coverageSkirtPixels: clampInteger(input.coverageSkirtPixels, 0, 0, 4),
    coverageSkirtMaxInputAlpha: clampInteger(input.coverageSkirtMaxInputAlpha, 0, 0, 255),
    outputBleedPixels: clampInteger(input.outputBleedPixels, 0, 0, 32),
    requireCompleteComponents: input.requireCompleteComponents === true,
    dominantSourceColorThreshold:
      input.dominantSourceColorThreshold === undefined
        ? undefined
        : clampInteger(input.dominantSourceColorThreshold, 0, 0, 255),
    lockToDominantSourceRegion: input.lockToDominantSourceRegion === true,
  };
}

function createAbortChecker(hooks: SurfaceRepairHooks) {
  return () => {
    if (hooks.signal?.aborted || hooks.shouldAbort?.()) {
      throw new SurfaceRepairAbortError();
    }
  };
}

function createProgressReporter(hooks: SurfaceRepairHooks) {
  const stride = clampInteger(hooks.progressStride, 65_536, 1_024, 16_777_216);
  let lastCompleted = -stride;
  let lastPhase: SurfaceRepairPhase | undefined;
  return (
    phase: SurfaceRepairPhase,
    overallStart: number,
    overallSpan: number,
    completed: number,
    total: number,
    force = false,
  ) => {
    if (!hooks.onProgress) return;
    if (!force && phase === lastPhase && completed - lastCompleted < stride) return;
    const phaseProgress = total <= 0 ? 1 : Math.max(0, Math.min(1, completed / total));
    hooks.onProgress({
      phase,
      progress: Math.max(0, Math.min(1, overallStart + overallSpan * phaseProgress)),
      phaseProgress,
      completed,
      total,
    });
    lastPhase = phase;
    lastCompleted = completed;
  };
}

function buildSeamAdjacency(input: NormalizedInput): SeamAdjacency | undefined {
  const links = input.seamLinks;
  if (!links || links.length === 0) return undefined;
  const heads = new Int32Array(input.pixelCount);
  heads.fill(-1);
  const targets = new Uint32Array(links.length);
  const next = new Int32Array(links.length);
  let edgeCount = 0;
  let pairCount = 0;
  for (let offset = 0; offset < links.length; offset += 2) {
    const first = links[offset];
    const second = links[offset + 1];
    if (first >= input.pixelCount || second >= input.pixelCount) {
      throw new RangeError(`seamLinks pair ${offset / 2} contains an out-of-range pixel index.`);
    }
    if (first === second || input.topologyMask[first] === 0 || input.topologyMask[second] === 0) {
      continue;
    }
    targets[edgeCount] = second;
    next[edgeCount] = heads[first];
    heads[first] = edgeCount;
    edgeCount += 1;
    targets[edgeCount] = first;
    next[edgeCount] = heads[second];
    heads[second] = edgeCount;
    edgeCount += 1;
    pairCount += 1;
  }
  if (pairCount === 0) return undefined;
  return {
    heads,
    targets: targets.subarray(0, edgeCount),
    next: next.subarray(0, edgeCount),
    pairCount,
  };
}

function buildSourceExclusionMask(
  input: NormalizedInput,
  queue: Uint32Array,
  seams: SeamAdjacency | undefined,
  checkAbort: () => void,
  report: ReturnType<typeof createProgressReporter>,
) {
  const exclusion = new Uint8Array(input.pixelCount);
  let head = 0;
  let tail = 0;
  for (let index = 0; index < input.pixelCount; index += 1) {
    if (input.writeMask[index] !== 0 && input.topologyMask[index] !== 0) {
      exclusion[index] = 255;
      queue[tail] = index;
      tail += 1;
    }
    if ((index & 0x3fff) === 0) checkAbort();
    report('preparing', 0, 0.12, index + 1, input.pixelCount);
  }
  report('preparing', 0, 0.12, input.pixelCount, input.pixelCount, true);

  const neighborX = input.connectivity === 8 ? EIGHT_NEIGHBOR_X : FOUR_NEIGHBOR_X;
  const neighborY = input.connectivity === 8 ? EIGHT_NEIGHBOR_Y : FOUR_NEIGHBOR_Y;
  let distance = 0;
  let layerEnd = tail;
  while (head < tail && distance < input.sourcePaddingPixels) {
    const currentLayerEnd = layerEnd;
    while (head < currentLayerEnd) {
      const index = queue[head];
      head += 1;
      const x = index % input.width;
      const y = Math.floor(index / input.width);
      for (let direction = 0; direction < neighborX.length; direction += 1) {
        const nextX = x + neighborX[direction];
        const nextY = y + neighborY[direction];
        if (nextX < 0 || nextY < 0 || nextX >= input.width || nextY >= input.height) {
          continue;
        }
        const neighbor = nextY * input.width + nextX;
        if (
          exclusion[neighbor] !== 0 ||
          input.topologyMask[neighbor] === 0 ||
          (input.topologyRegionIds &&
            input.topologyRegionIds[index] !== input.topologyRegionIds[neighbor])
        ) {
          continue;
        }
        exclusion[neighbor] = 255;
        queue[tail] = neighbor;
        tail += 1;
      }
      if (seams) {
        for (let edge = seams.heads[index]; edge >= 0; edge = seams.next[edge]) {
          const neighbor = seams.targets[edge];
          if (exclusion[neighbor] !== 0 || input.topologyMask[neighbor] === 0) continue;
          exclusion[neighbor] = 255;
          queue[tail] = neighbor;
          tail += 1;
        }
      }
      if ((head & 0x3fff) === 0) checkAbort();
    }
    layerEnd = tail;
    distance += 1;
    report('padding-sources', 0.12, 0.13, distance, Math.max(1, input.sourcePaddingPixels), true);
  }
  if (input.sourcePaddingPixels === 0) {
    report('padding-sources', 0.12, 0.13, 1, 1, true);
  }

  let excludedPixels = 0;
  for (let index = 0; index < input.pixelCount; index += 1) {
    if (input.sourceExclusionMask?.[index]) exclusion[index] = 255;
    if (exclusion[index] !== 0 && input.topologyMask[index] !== 0) excludedPixels += 1;
    if ((index & 0x3fff) === 0) checkAbort();
  }
  return { exclusion, excludedPixels };
}

function isBoundarySource(
  index: number,
  input: NormalizedInput,
  owner: Int32Array,
  seams: SeamAdjacency | undefined,
) {
  const x = index % input.width;
  const y = Math.floor(index / input.width);
  const neighborX = input.connectivity === 8 ? EIGHT_NEIGHBOR_X : FOUR_NEIGHBOR_X;
  const neighborY = input.connectivity === 8 ? EIGHT_NEIGHBOR_Y : FOUR_NEIGHBOR_Y;
  for (let direction = 0; direction < neighborX.length; direction += 1) {
    const nextX = x + neighborX[direction];
    const nextY = y + neighborY[direction];
    if (nextX < 0 || nextY < 0 || nextX >= input.width || nextY >= input.height) continue;
    const neighbor = nextY * input.width + nextX;
    if (
      input.topologyMask[neighbor] !== 0 &&
      owner[neighbor] === -1 &&
      (!input.topologyRegionIds ||
        input.topologyRegionIds[index] === input.topologyRegionIds[neighbor])
    ) {
      return true;
    }
  }
  if (seams) {
    for (let edge = seams.heads[index]; edge >= 0; edge = seams.next[edge]) {
      if (owner[seams.targets[edge]] === -1) return true;
    }
  }
  return false;
}

function isBaseEligibleSource(
  index: number,
  input: NormalizedInput,
  exclusion: Uint8Array,
) {
  return Boolean(
    input.topologyMask[index] !== 0 &&
      input.writeMask[index] === 0 &&
      exclusion[index] === 0 &&
      input.rgba[index * 4 + 3] >= input.minSourceAlpha,
  );
}

function hasSupportedSourceColor(
  index: number,
  input: NormalizedInput,
  exclusion: Uint8Array,
) {
  const threshold = input.sourceColorOutlierThreshold;
  if (threshold <= 0) return true;
  const x = index % input.width;
  const y = Math.floor(index / input.width);
  const offset = index * 4;
  const region = input.topologyRegionIds?.[index];
  const maximumDistanceSquared = threshold * threshold * 3;
  let comparableNeighbors = 0;
  let supportingNeighbors = 0;

  for (let direction = 0; direction < EIGHT_NEIGHBOR_X.length; direction += 1) {
    const nextX = x + EIGHT_NEIGHBOR_X[direction];
    const nextY = y + EIGHT_NEIGHBOR_Y[direction];
    if (nextX < 0 || nextY < 0 || nextX >= input.width || nextY >= input.height) continue;
    const neighbor = nextY * input.width + nextX;
    if (!isBaseEligibleSource(neighbor, input, exclusion)) continue;
    if (input.topologyRegionIds && input.topologyRegionIds[neighbor] !== region) continue;
    comparableNeighbors += 1;
    const neighborOffset = neighbor * 4;
    const red = input.rgba[offset] - input.rgba[neighborOffset];
    const green = input.rgba[offset + 1] - input.rgba[neighborOffset + 1];
    const blue = input.rgba[offset + 2] - input.rgba[neighborOffset + 2];
    if (red * red + green * green + blue * blue <= maximumDistanceSquared) {
      supportingNeighbors += 1;
    }
  }

  // Sparse/sliver UV islands may not have a complete pixel neighbourhood.
  // Keep those sources; otherwise require majority colour support so a thin
  // matte fringe cannot become a donor for the whole connected repair gap.
  return comparableNeighbors < 3 || supportingNeighbors * 3 >= comparableNeighbors * 2;
}

type SourceRegionLockStats = {
  lockedComponents: number;
  reassignedPixels: number;
  extendedPixels: number;
};

/**
 * Collapses competing seam donors to one UV source region per connected gap.
 *
 * The first propagation pass is still useful: it tells us how much of the gap
 * each donor region would own. We select the region with the largest ownership
 * area, retain only those seeds, and flood the complete gap component again.
 * Regular adjacency deliberately stays inside one target UV region. Explicit
 * seam links join only the paired UV islands that touch on the model surface,
 * so one physical gap gets one donor without creating a global colour decision
 * across unrelated islands on dense high-poly meshes.
 * The chosen source is a real input texel; RGB values are never averaged.
 * `queue` and `scratchMask` are reused, so this adds no full-resolution buffer.
 */
function lockGapComponentsToDominantSourceRegion(
  input: NormalizedInput,
  owner: Int32Array,
  queue: Uint32Array,
  scratchMask: Uint8Array,
  seams: SeamAdjacency | undefined,
  checkAbort: () => void,
  report: ReturnType<typeof createProgressReporter>,
): SourceRegionLockStats {
  if (!input.lockToDominantSourceRegion || !input.topologyRegionIds) {
    report('locking-source-region', 0.85, 0.03, 1, 1, true);
    return { lockedComponents: 0, reassignedPixels: 0, extendedPixels: 0 };
  }

  const neighborX = input.connectivity === 8 ? EIGHT_NEIGHBOR_X : FOUR_NEIGHBOR_X;
  const neighborY = input.connectivity === 8 ? EIGHT_NEIGHBOR_Y : FOUR_NEIGHBOR_Y;
  const donorCounts = new Map<number, number>();
  const sourceCounts = new Map<number, number>();
  let lockedComponents = 0;
  let reassignedPixels = 0;
  let extendedPixels = 0;

  for (let start = 0; start < input.pixelCount; start += 1) {
    if (
      input.writeMask[start] === 0 ||
      input.topologyMask[start] === 0 ||
      scratchMask[start] !== 0
    ) {
      continue;
    }

    let head = 0;
    let tail = 1;
    queue[0] = start;
    scratchMask[start] = 1;
    donorCounts.clear();
    sourceCounts.clear();
    const targetRegion = input.topologyRegionIds[start];
    let spansMultipleTargetRegions = false;
    let hasUnresolvedOwner = false;

    // Gather one physical write component. Regular grid edges stay inside one
    // UV region, while an explicit seam edge may bridge two UV islands that
    // touch on the model surface. Unrelated islands have no seam edge and
    // therefore remain independent colour decisions.
    while (head < tail) {
      const index = queue[head];
      head += 1;
      if (input.topologyRegionIds[index] !== targetRegion) {
        spansMultipleTargetRegions = true;
      }
      const source = owner[index];
      if (source >= 0) {
        const sourceRegion = input.topologyRegionIds[source];
        if (sourceRegion) donorCounts.set(sourceRegion, (donorCounts.get(sourceRegion) ?? 0) + 1);
        sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
      } else {
        hasUnresolvedOwner = true;
      }

      const x = index % input.width;
      const y = Math.floor(index / input.width);
      for (let direction = 0; direction < neighborX.length; direction += 1) {
        const nextX = x + neighborX[direction];
        const nextY = y + neighborY[direction];
        if (nextX < 0 || nextY < 0 || nextX >= input.width || nextY >= input.height) continue;
        const neighbor = nextY * input.width + nextX;
        if (
          scratchMask[neighbor] !== 0 ||
          input.writeMask[neighbor] === 0 ||
          input.topologyMask[neighbor] === 0 ||
          input.topologyRegionIds[index] !== input.topologyRegionIds[neighbor]
        ) {
          continue;
        }
        scratchMask[neighbor] = 1;
        queue[tail] = neighbor;
        tail += 1;
      }
      if (seams) {
        for (let edge = seams.heads[index]; edge >= 0; edge = seams.next[edge]) {
          const neighbor = seams.targets[edge];
          if (
            scratchMask[neighbor] !== 0 ||
            input.writeMask[neighbor] === 0 ||
            input.topologyMask[neighbor] === 0
          ) {
            continue;
          }
          scratchMask[neighbor] = 1;
          queue[tail] = neighbor;
          tail += 1;
        }
      }
      if ((head & 0x3fff) === 0) checkAbort();
    }

    const componentSize = tail;
    // Dominant locking is a colour-stabilisation pass, not a way to bypass the
    // configured propagation radius. Leave incomplete components unresolved so
    // the later completeness pass can reject the whole coloured-rim/empty-centre
    // result atomically.
    if (input.requireCompleteComponents && hasUnresolvedOwner) {
      report('locking-source-region', 0.85, 0.03, start + 1, input.pixelCount);
      continue;
    }
    // A real donor from the target island is always more trustworthy than a
    // foreign seam donor, even if the first global flood let the foreign donor
    // claim more texels. Only a completely empty island needs a foreign choice.
    // Preserve the historical preference for a component that stays in one UV
    // region. Once seam links join multiple regions, pick one true dominant
    // donor across the complete physical gap instead of biasing whichever UV
    // island happens to have the lowest pixel index.
    const preferSingleTargetRegion = !spansMultipleTargetRegions;
    let dominantRegion =
      preferSingleTargetRegion && donorCounts.has(targetRegion) ? targetRegion : 0;
    let dominantCount = dominantRegion ? (donorCounts.get(dominantRegion) ?? 0) : 0;
    if (!dominantRegion) {
      for (const [sourceRegion, count] of donorCounts) {
        if (count > dominantCount || (count === dominantCount && sourceRegion < dominantRegion)) {
          dominantRegion = sourceRegion;
          dominantCount = count;
        }
      }
    }

    if (!dominantRegion) {
      report('locking-source-region', 0.85, 0.03, start + 1, input.pixelCount);
      continue;
    }

    // A region can still contain many different source pixels. Retaining all
    // of them recreates a nearest-owner Voronoi split inside the gap, which is
    // visible as a white/blue gradient even though the region itself is locked.
    // Select one real source texel by ownership area; ties prefer higher source
    // alpha and finally the lower stable texel index. No RGB values are mixed.
    let dominantSource = -1;
    let dominantSourceCount = 0;
    let dominantSourceAlpha = -1;
    for (const [source, count] of sourceCounts) {
      if (input.topologyRegionIds[source] !== dominantRegion) continue;
      const sourceAlpha = input.rgba[source * 4 + 3];
      if (
        count > dominantSourceCount ||
        (count === dominantSourceCount && sourceAlpha > dominantSourceAlpha) ||
        (count === dominantSourceCount &&
          sourceAlpha === dominantSourceAlpha &&
          (dominantSource < 0 || source < dominantSource))
      ) {
        dominantSource = source;
        dominantSourceCount = count;
        dominantSourceAlpha = sourceAlpha;
      }
    }

    if (dominantSource < 0) {
      report('locking-source-region', 0.85, 0.03, start + 1, input.pixelCount);
      continue;
    }

    // Flat-colour gaps benefit from one stable donor, but textured boundaries
    // must retain Modddif-style multi-source expansion. Measure only donors
    // which actually won part of this gap in the first propagation pass; this
    // avoids an unrelated distant texel disabling an otherwise safe flat fill.
    if (input.dominantSourceColorThreshold !== undefined) {
      const dominantOffset = dominantSource * 4;
      const dominantRed = input.rgba[dominantOffset];
      const dominantGreen = input.rgba[dominantOffset + 1];
      const dominantBlue = input.rgba[dominantOffset + 2];
      let weightedSquaredDistance = 0;
      let weightedChannelCount = 0;
      for (const [source, count] of sourceCounts) {
        if (input.topologyRegionIds[source] !== dominantRegion) continue;
        const sourceOffset = source * 4;
        const redDelta = input.rgba[sourceOffset] - dominantRed;
        const greenDelta = input.rgba[sourceOffset + 1] - dominantGreen;
        const blueDelta = input.rgba[sourceOffset + 2] - dominantBlue;
        weightedSquaredDistance +=
          (redDelta * redDelta + greenDelta * greenDelta + blueDelta * blueDelta) * count;
        weightedChannelCount += count * 3;
      }
      const donorColorRms = Math.sqrt(
        weightedSquaredDistance / Math.max(1, weightedChannelCount),
      );
      if (donorColorRms > input.dominantSourceColorThreshold) {
        report('locking-source-region', 0.85, 0.03, start + 1, input.pixelCount);
        continue;
      }
    }

    if (dominantSourceCount < componentSize) lockedComponents += 1;
    for (let queueIndex = 0; queueIndex < componentSize; queueIndex += 1) {
      const index = queue[queueIndex];
      const previousSource = owner[index];
      if (previousSource < 0) extendedPixels += 1;
      else if (previousSource !== dominantSource) reassignedPixels += 1;
      owner[index] = dominantSource;
      if ((queueIndex & 0x3fff) === 0) checkAbort();
    }
    report('locking-source-region', 0.85, 0.03, start + 1, input.pixelCount);
  }

  // Keep component pixels marked until the outer scan finishes. Clearing a
  // component immediately makes every later pixel in the same gap start the
  // complete flood again, turning a large connected repair from O(N) into
  // O(N²). The buffer is also used by the later completeness/write passes, so
  // restore it once after every component has been visited exactly once.
  scratchMask.fill(0);
  report('locking-source-region', 0.85, 0.03, input.pixelCount, input.pixelCount, true);
  return { lockedComponents, reassignedPixels, extendedPixels };
}

/**
 * Repairs a UV gap using nearest-source propagation over the supplied model
 * topology. Runtime and memory are O(number of pixels + seam links).
 *
 * The returned image is an independent sparse UV layer, not a flattened source
 * texture. Exact source RGB texels are cloned, so the algorithm introduces no
 * global-average fallback color and cannot sample across disconnected UV space.
 */
export function repairSurfaceTexture(
  rawInput: SurfaceAwareRepairInput,
  hooks: SurfaceRepairHooks = {},
): SurfaceAwareRepairResult {
  const startedAt = now();
  const input = normalizeInput(rawInput);
  const checkAbort = createAbortChecker(hooks);
  const report = createProgressReporter(hooks);
  checkAbort();

  const seams = buildSeamAdjacency(input);
  // A bounded seam hop is a donor bridge, not permission to merge complete UV
  // regions into one colour/completeness decision. This lets a fully blank
  // island borrow from one true physical neighbour without letting that colour
  // continue through an arbitrary chain of islands.
  const componentSeams = input.maxSeamCrossings < 255 ? undefined : seams;
  const seamCrossings =
    seams && input.maxSeamCrossings < 255 ? new Uint8Array(input.pixelCount) : undefined;
  const queue = new Uint32Array(input.pixelCount);
  const { exclusion, excludedPixels } = buildSourceExclusionMask(
    input,
    queue,
    componentSeams,
    checkAbort,
    report,
  );

  // owner starts as a compact three-state map: -2 is an eligible source, -1 is
  // traversable/unseen, and non-negative values are propagated source indices.
  // This avoids a separate full-resolution eligibility allocation.
  const owner = new Int32Array(input.pixelCount);
  let topologyPixels = 0;
  let requestedPixels = 0;
  let eligibleSourcePixels = 0;
  let sourceColorOutliersRejected = 0;
  for (let index = 0; index < input.pixelCount; index += 1) {
    const inTopology = input.topologyMask[index] !== 0;
    if (inTopology) topologyPixels += 1;
    if (inTopology && input.writeMask[index] !== 0) requestedPixels += 1;
    const baseEligible = isBaseEligibleSource(index, input, exclusion);
    const colorSupported = baseEligible && hasSupportedSourceColor(index, input, exclusion);
    const isEligible = baseEligible && colorSupported;
    if (baseEligible && !colorSupported) sourceColorOutliersRejected += 1;
    if (isEligible) {
      owner[index] = -2;
      eligibleSourcePixels += 1;
    } else {
      owner[index] = -1;
    }
    if ((index & 0x3fff) === 0) checkAbort();
    report('finding-sources', 0.25, 0.2, index + 1, input.pixelCount);
  }

  let head = 0;
  let tail = 0;
  let boundarySourcePixels = 0;
  for (let index = 0; index < input.pixelCount; index += 1) {
    if (owner[index] === -2 && isBoundarySource(index, input, owner, seams)) {
      owner[index] = index;
      queue[tail] = index;
      tail += 1;
      boundarySourcePixels += 1;
    }
    if ((index & 0x3fff) === 0) checkAbort();
    report('finding-sources', 0.25, 0.2, index + 1, input.pixelCount);
  }
  report('finding-sources', 0.25, 0.2, input.pixelCount, input.pixelCount, true);

  const neighborX = input.connectivity === 8 ? EIGHT_NEIGHBOR_X : FOUR_NEIGHBOR_X;
  const neighborY = input.connectivity === 8 ? EIGHT_NEIGHBOR_Y : FOUR_NEIGHBOR_Y;
  let distance = 0;
  let maxDistanceReached = 0;
  let layerEnd = tail;
  while (head < tail && distance < input.maxDistance) {
    const currentLayerEnd = layerEnd;
    let addedAtNextDistance = false;
    while (head < currentLayerEnd) {
      const index = queue[head];
      head += 1;
      const source = owner[index];
      const x = index % input.width;
      const y = Math.floor(index / input.width);
      for (let direction = 0; direction < neighborX.length; direction += 1) {
        const nextX = x + neighborX[direction];
        const nextY = y + neighborY[direction];
        if (nextX < 0 || nextY < 0 || nextX >= input.width || nextY >= input.height) {
          continue;
        }
        const neighbor = nextY * input.width + nextX;
        if (
          owner[neighbor] !== -1 ||
          input.topologyMask[neighbor] === 0 ||
          (input.topologyRegionIds &&
            input.topologyRegionIds[index] !== input.topologyRegionIds[neighbor])
        ) {
          continue;
        }
        owner[neighbor] = source;
        if (seamCrossings) seamCrossings[neighbor] = seamCrossings[index];
        queue[tail] = neighbor;
        tail += 1;
        addedAtNextDistance = true;
      }
      if (seams) {
        for (let edge = seams.heads[index]; edge >= 0; edge = seams.next[edge]) {
          const neighbor = seams.targets[edge];
          const nextSeamCrossings = (seamCrossings?.[index] ?? 0) + 1;
          if (nextSeamCrossings > input.maxSeamCrossings) continue;
          if (owner[neighbor] !== -1 || input.topologyMask[neighbor] === 0) {
            continue;
          }
          owner[neighbor] = source;
          if (seamCrossings) seamCrossings[neighbor] = nextSeamCrossings;
          queue[tail] = neighbor;
          tail += 1;
          addedAtNextDistance = true;
        }
      }
      if ((head & 0x3fff) === 0) checkAbort();
    }
    layerEnd = tail;
    distance += 1;
    if (addedAtNextDistance) maxDistanceReached = distance;
    report('propagating', 0.45, 0.4, distance, Math.max(1, input.maxDistance), true);
  }
  if (input.maxDistance === 0 || boundarySourcePixels === 0) {
    report('propagating', 0.45, 0.4, 1, 1, true);
  } else {
    report('propagating', 0.45, 0.4, 1, 1, true);
  }

  const propagatedPixels = Math.max(0, tail - boundarySourcePixels);
  const repairedMask = new Uint8Array(input.pixelCount);
  const sourceRegionLock = lockGapComponentsToDominantSourceRegion(
    input,
    owner,
    queue,
    repairedMask,
    componentSeams,
    checkAbort,
    report,
  );
  let partialComponentsDiscarded = 0;
  let partialPixelsDiscarded = 0;

  // Never publish the reachable rim of a wide gap while leaving its centre
  // transparent. That partial result is the source of the characteristic
  // coloured outline/black-centre artifact. Components are classified using
  // the same topology rules as propagation and the queue is reused, so the
  // check remains O(N) without another pixel-index allocation.
  if (input.requireCompleteComponents) {
    for (let start = 0; start < input.pixelCount; start += 1) {
      if (
        input.writeMask[start] === 0 ||
        input.topologyMask[start] === 0 ||
        repairedMask[start] !== 0
      ) {
        continue;
      }
      head = 0;
      tail = 1;
      queue[0] = start;
      repairedMask[start] = 1;
      let complete = true;
      while (head < tail) {
        const index = queue[head];
        head += 1;
        if (owner[index] < 0) complete = false;
        const x = index % input.width;
        const y = Math.floor(index / input.width);
        for (let direction = 0; direction < neighborX.length; direction += 1) {
          const nextX = x + neighborX[direction];
          const nextY = y + neighborY[direction];
          if (nextX < 0 || nextY < 0 || nextX >= input.width || nextY >= input.height) {
            continue;
          }
          const neighbor = nextY * input.width + nextX;
          if (
            repairedMask[neighbor] !== 0 ||
            input.writeMask[neighbor] === 0 ||
            input.topologyMask[neighbor] === 0 ||
            (input.topologyRegionIds &&
              input.topologyRegionIds[index] !== input.topologyRegionIds[neighbor])
          ) {
            continue;
          }
          repairedMask[neighbor] = 1;
          queue[tail] = neighbor;
          tail += 1;
        }
        if (componentSeams) {
          for (
            let edge = componentSeams.heads[index];
            edge >= 0;
            edge = componentSeams.next[edge]
          ) {
            const neighbor = componentSeams.targets[edge];
            if (
              repairedMask[neighbor] !== 0 ||
              input.writeMask[neighbor] === 0 ||
              input.topologyMask[neighbor] === 0
            ) {
              continue;
            }
            repairedMask[neighbor] = 1;
            queue[tail] = neighbor;
            tail += 1;
          }
        }
        if ((head & 0x3fff) === 0) checkAbort();
      }
      if (complete) {
        for (let queueIndex = 0; queueIndex < tail; queueIndex += 1) {
          repairedMask[queue[queueIndex]] = 2;
        }
      } else {
        partialComponentsDiscarded += 1;
        partialPixelsDiscarded += tail;
      }
    }
  }

  const filledRgba = new Uint8ClampedArray(input.pixelCount * 4);
  head = 0;
  tail = 0;
  let repairedPixels = 0;
  for (let index = 0; index < input.pixelCount; index += 1) {
    const componentAccepted =
      !input.requireCompleteComponents || repairedMask[index] === 2;
    if (
      componentAccepted &&
      input.writeMask[index] !== 0 &&
      input.topologyMask[index] !== 0
    ) {
      const source = owner[index];
      if (source >= 0) {
        const sourceOffset = source * 4;
        const targetOffset = index * 4;
        filledRgba[targetOffset] = input.rgba[sourceOffset];
        filledRgba[targetOffset + 1] = input.rgba[sourceOffset + 1];
        filledRgba[targetOffset + 2] = input.rgba[sourceOffset + 2];
        // A repair texel is an opaque fallback. Source alpha is only a source
        // eligibility signal and must not punch a second soft hole in the layer.
        filledRgba[targetOffset + 3] = 255;
        repairedMask[index] = 255;
        queue[tail] = index;
        tail += 1;
        repairedPixels += 1;
        // Preserve the repaired texel's own UV region as the bleed seed even
        // when its colour arrived through an explicit cross-island seam link.
        owner[index] = index;
      }
    }
    if (input.requireCompleteComponents && repairedMask[index] !== 255) {
      repairedMask[index] = 0;
    }
    if ((index & 0x3fff) === 0) checkAbort();
    report('writing', 0.88, 0.1, index + 1, input.pixelCount);
  }

  // Close the one-texel alpha gap that texture filtering can expose between a
  // repaired component and its UV coverage. Unlike atlas RGB bleed, this skirt
  // is opaque, so it is deliberately conservative: it may only replace texels
  // that were still effectively empty in the composited input, and it cannot
  // cross a topology region boundary. Existing projections and previous repair
  // layers therefore remain untouched.
  let coverageSkirtPixelCount = 0;
  head = 0;
  let coverageSkirtDistance = 0;
  let coverageSkirtLayerEnd = tail;
  while (head < tail && coverageSkirtDistance < input.coverageSkirtPixels) {
    const currentLayerEnd = coverageSkirtLayerEnd;
    while (head < currentLayerEnd) {
      const index = queue[head];
      head += 1;
      const x = index % input.width;
      const y = Math.floor(index / input.width);
      const sourceOffset = index * 4;
      const seedIndex = owner[index] >= 0 ? owner[index] : index;
      for (let direction = 0; direction < EIGHT_NEIGHBOR_X.length; direction += 1) {
        const nextX = x + EIGHT_NEIGHBOR_X[direction];
        const nextY = y + EIGHT_NEIGHBOR_Y[direction];
        if (nextX < 0 || nextY < 0 || nextX >= input.width || nextY >= input.height) {
          continue;
        }
        const neighbor = nextY * input.width + nextX;
        if (
          repairedMask[neighbor] !== 0 ||
          input.topologyMask[neighbor] === 0 ||
          input.rgba[neighbor * 4 + 3] > input.coverageSkirtMaxInputAlpha
        ) {
          continue;
        }
        if (input.topologyRegionIds) {
          const seedRegion = input.topologyRegionIds[seedIndex];
          const targetRegion = input.topologyRegionIds[neighbor];
          if (!seedRegion || targetRegion !== seedRegion) continue;
        }
        const targetOffset = neighbor * 4;
        filledRgba[targetOffset] = filledRgba[sourceOffset];
        filledRgba[targetOffset + 1] = filledRgba[sourceOffset + 1];
        filledRgba[targetOffset + 2] = filledRgba[sourceOffset + 2];
        filledRgba[targetOffset + 3] = 255;
        repairedMask[neighbor] = 255;
        owner[neighbor] = seedIndex;
        queue[tail] = neighbor;
        tail += 1;
        coverageSkirtPixelCount += 1;
      }
      if ((head & 0x3fff) === 0) checkAbort();
    }
    coverageSkirtLayerEnd = tail;
    coverageSkirtDistance += 1;
  }

  // Preserve straight-RGBA texture-atlas padding without expanding the layer
  // coverage. The queue is reused, so this adds one byte per texel and no extra
  // pixel-index allocation. Persistence must use the straight-RGBA PNG encoder.
  let outputBleedPixelCount = 0;
  const repairSeedCount = tail;
  head = 0;
  let bleedDistance = 0;
  let bleedLayerEnd = tail;
  while (head < tail && bleedDistance < input.outputBleedPixels) {
    const currentLayerEnd = bleedLayerEnd;
    while (head < currentLayerEnd) {
      const index = queue[head];
      head += 1;
      const x = index % input.width;
      const y = Math.floor(index / input.width);
      const sourceOffset = index * 4;
      for (let direction = 0; direction < EIGHT_NEIGHBOR_X.length; direction += 1) {
        const nextX = x + EIGHT_NEIGHBOR_X[direction];
        const nextY = y + EIGHT_NEIGHBOR_Y[direction];
        if (nextX < 0 || nextY < 0 || nextX >= input.width || nextY >= input.height) {
          continue;
        }
        const neighbor = nextY * input.width + nextX;
        if (repairedMask[neighbor] !== 0) continue;
        const seedIndex = owner[index] >= 0 ? owner[index] : index;
        if (input.topologyRegionIds && input.topologyMask[neighbor] !== 0) {
          const seedRegion = input.topologyRegionIds[seedIndex];
          const targetRegion = input.topologyRegionIds[neighbor];
          if (!targetRegion || (seedRegion && targetRegion !== seedRegion)) continue;
        }
        const targetOffset = neighbor * 4;
        filledRgba[targetOffset] = filledRgba[sourceOffset];
        filledRgba[targetOffset + 1] = filledRgba[sourceOffset + 1];
        filledRgba[targetOffset + 2] = filledRgba[sourceOffset + 2];
        // Alpha deliberately remains zero outside repairedMask.
        // Value 1 is a temporary bleed-visited marker; real repair alpha is 255.
        repairedMask[neighbor] = 1;
        owner[neighbor] = seedIndex;
        queue[tail] = neighbor;
        tail += 1;
        outputBleedPixelCount += 1;
      }
      if ((head & 0x3fff) === 0) checkAbort();
    }
    bleedLayerEnd = tail;
    bleedDistance += 1;
    report('bleeding', 0.98, 0.02, bleedDistance, Math.max(1, input.outputBleedPixels), true);
  }
  if (input.outputBleedPixels === 0 || repairedPixels === 0) {
    report('bleeding', 0.98, 0.02, 1, 1, true);
  }
  for (let queueIndex = repairSeedCount; queueIndex < tail; queueIndex += 1) {
    repairedMask[queue[queueIndex]] = 0;
  }

  const stats: SurfaceRepairStats = {
    pixelCount: input.pixelCount,
    topologyPixels,
    requestedPixels,
    eligibleSourcePixels,
    sourceColorOutliersRejected,
    boundarySourcePixels,
    sourcePaddingPixels: input.sourcePaddingPixels,
    sourceExcludedPixels: excludedPixels,
    seamLinkPairs: seams?.pairCount ?? 0,
    propagatedPixels,
    repairedPixels,
    unresolvedPixels: requestedPixels - repairedPixels,
    maxDistance: input.maxDistance,
    maxDistanceReached,
    coverageSkirtPixels: input.coverageSkirtPixels,
    coverageSkirtPixelCount,
    outputBleedPixels: input.outputBleedPixels,
    outputBleedPixelCount,
    partialComponentsDiscarded,
    partialPixelsDiscarded,
    sourceRegionLockedComponents: sourceRegionLock.lockedComponents,
    sourceRegionReassignedPixels: sourceRegionLock.reassignedPixels,
    sourceRegionExtendedPixels: sourceRegionLock.extendedPixels,
    elapsedMs: now() - startedAt,
  };
  report('complete', 1, 0, 1, 1, true);
  return {
    filledRgba,
    repairedMask,
    sourceExclusionMask: exclusion,
    stats,
  };
}
