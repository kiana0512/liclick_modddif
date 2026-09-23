import { runSurfaceAwareRepair } from '../src/engine/contentAware/runSurfaceAwareRepair.ts';
import { createVisibleSurfaceCompletionPolicy } from '../src/engine/contentAware/visibleSurfaceCompletionPolicy.ts';
import { encodeRgbaPngBlob } from '../src/utils/encodeRgbaPng.ts';
const check = (condition, message) => { if (!condition) throw Error(message); };
export async function run(requested = Number(new globalThis.URLSearchParams(globalThis.location.search).get('resolution'))) {
  const width = requested || 2048, height = width, count = width * height, midpoint = width / 2;
  const rgba = new Uint8ClampedArray(count * 4), writeMask = new Uint8Array(count);
  const topologyMask = new Uint8Array(count).fill(1), topologyRegionIds = new Uint32Array(count).fill(1);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    const red = x < midpoint ? 120 : 150;
    rgba.set([red + y % 4, 80, 95, 255], i * 4);
    if (x >= midpoint - 64 && x < midpoint + 64) { writeMask[i] = 255; rgba[i * 4 + 3] = 0; }
    if (x > width - 248) { topologyRegionIds[i] = 2; rgba.set([230, 175, 30, 255], i * 4); }
    if (x > width - 148) { topologyRegionIds[i] = 3; writeMask[i] = 255; rgba[i * 4 + 3] = 0; }
  }
  const original = rgba.slice();
  const input = { width, height, rgba, writeMask, topologyMask, topologyRegionIds,
    ...createVisibleSurfaceCompletionPolicy(width, height).propagation };
  const mainStart = performance.now(), main = width <= 2048 ? await runSurfaceAwareRepair(input, { useWorker: false }) : undefined;
  const mainMs = performance.now() - mainStart;
  const workerStart = performance.now();
  const worker = await runSurfaceAwareRepair(input, { includeDiagnostics: false });
  const workerMs = performance.now() - workerStart;
  let mismatches = 0;
  for (let i = 0; i < original.length; i++) {
    if (main && main.filledRgba[i] !== worker.filledRgba[i]) mismatches++;
    check(rgba[i] === original[i], 'borrowed input unchanged');
  }
  check(mismatches === 0, 'worker/main bytes identical');
  check(worker.stats.globalFallbackPixels === 0 && worker.stats.sourceRegionLockedComponents === 0, 'no global/single-color fallback');
  check(worker.filledRgba[(width - 50) * 4 + 3] === 0, 'blank foreign component stays open');
  check(!('repairedMask' in worker) && !('sourceExclusionMask' in worker), 'production result omits diagnostic masks');
  check(worker.stats.repairedPixels === 128 * height && worker.stats.maxDistanceReached === 64,
    'wide gap fills beyond the initial 16px, without borrowing from foreign components');
  const center = (midpoint * width + midpoint) * 4;
  check(worker.filledRgba[center] > 120 && worker.filledRgba[center] < 150, 'multi-point pink interpolation');
  const blob = await encodeRgbaPngBlob(width, height, worker.filledRgba);
  const bitmap = await window.createImageBitmap(blob);
  check(bitmap.width === width && bitmap.height === height, 'full-resolution persisted PNG');
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close();
  const restored = context.getImageData(midpoint, midpoint, 1, 1).data;
  check(restored[0] === worker.filledRgba[center] && restored[3] === 255, 'PNG contains exact repaired center');
  const seamRgba = new Uint8ClampedArray(8 * 4), seamMask = new Uint8Array(8);
  const seamTopology = new Uint8Array(8), seamRegions = new Uint32Array(8);
  for (const index of [0, 1, 2]) { seamTopology[index] = 1; seamRegions[index] = 1; }
  for (const index of [5, 6, 7]) { seamTopology[index] = 1; seamRegions[index] = 2; }
  seamRgba.set([154, 88, 42, 255], 0); for (const index of [1, 2, 5, 6, 7]) seamMask[index] = 255;
  const seamPolicy = { ...createVisibleSurfaceCompletionPolicy(8, 1).propagation,
    coverageSkirtPixels: 0, outputBleedPixels: 0, sourceColorOutlierThreshold: 0 };
  const seamFirst = await runSurfaceAwareRepair({ width: 8, height: 1, rgba: seamRgba,
    writeMask: seamMask, topologyMask: seamTopology, topologyRegionIds: seamRegions,
    ...seamPolicy }, { includeDiagnostics: false, returnUnresolvedInput: true,
    transferOwnership: { rgba: true, writeMask: true } });
  check(seamFirst.stats.unresolvedPixels === 3 && seamFirst.continuationSourceRgba && seamFirst.unresolvedMask,
    'fast path returns zero-copy unresolved continuation only when needed');
  const seamSecond = await runSurfaceAwareRepair({ width: 8, height: 1,
    rgba: seamFirst.continuationSourceRgba, writeMask: seamFirst.unresolvedMask,
    topologyMask: seamTopology, topologyRegionIds: seamRegions, seamLinks: new Uint32Array([2, 5]),
    ...seamPolicy, maxSeamCrossings: 1 }, { includeDiagnostics: false,
    accumulatedFilledRgba: seamFirst.filledRgba, transferOwnership: { rgba: true, writeMask: true } });
  check(seamSecond.stats.unresolvedPixels === 0 && seamSecond.stats.repairedPixels === 3,
    'bounded physical seam fallback completes only the residual island');
  for (const index of [1, 2, 5, 6, 7]) check(seamSecond.filledRgba[index * 4 + 3] === 255,
    'accumulated sparse output retains both repair passes');
  return { resolution: `${width}x${height}`, workerMainByteMismatches: mismatches,
    repairedPixels: worker.stats.repairedPixels, unresolvedPixels: worker.stats.unresolvedPixels,
    globalFallbackPixels: worker.stats.globalFallbackPixels, centerRgb: [...restored.slice(0, 3)],
    boundedSeamContinuation: true, mainMs: main ? Math.round(mainMs) : null,
    workerMs: Math.round(workerMs), pngBytes: blob.size };
}
