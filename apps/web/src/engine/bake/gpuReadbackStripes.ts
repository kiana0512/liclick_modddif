import type * as THREE from 'three';
import { waitForBrowserPaint, yieldToBrowserTask } from '@/utils/browserScheduling';

// UV-READBACK-SCHEDULING/1.1.1: square UV and rectangular capture readback.
// Private contexts pipeline eight stripes while retaining at most 8 MiB of PBOs.
const GPU_READBACK_STRIPE_BYTES = 1024 * 1024;

export async function readRenderTargetPixelsInStripes(
  renderer: THREE.WebGLRenderer,
  target: THREE.WebGLRenderTarget,
  resolution: number,
  height = resolution,
) {
  const pixels = new Uint8Array(resolution * height * 4);
  const rowsPerStripe = Math.max(
    1,
    Math.min(height, Math.floor(GPU_READBACK_STRIPE_BYTES / (resolution * 4))),
  );
  let maximumStripeMs = 0;
  const startedAt = performance.now();
  const usesVisibleRenderer = renderer.domElement.isConnected;
  // Pipeline only the isolated bake context. The onscreen renderer keeps its
  // original one-stripe paint boundary; private work holds at most 8 MiB of PBOs.
  const depth = usesVisibleRenderer ? 1 : 8;
  const pending: Array<Promise<{ error?: unknown }>> = [];
  let nextY = 0;
  const submit = () => {
    const y = nextY;
    nextY += rowsPerStripe;
    const rowCount = Math.min(rowsPerStripe, height - y);
    const offset = y * resolution * 4;
    const stripe = pixels.subarray(offset, offset + resolution * rowCount * 4);
    const stripeStartedAt = performance.now();
    // Observe failures immediately, including a later stripe failing first.
    // Drain outstanding reads before releasing their target on any failure.
    const task = (async () => {
      try {
        await renderer.readRenderTargetPixelsAsync(target, 0, y, resolution, rowCount, stripe);
        maximumStripeMs = Math.max(maximumStripeMs, performance.now() - stripeStartedAt);
        return {};
      } catch (error) { return { error }; }
    })();
    pending.push(task);
  };
  try {
    while (nextY < height && pending.length < depth) submit();
    while (pending.length) {
      const completed = await pending.shift()!;
      if ('error' in completed) throw completed.error;
      if (nextY >= height && !pending.length) break;
      if (usesVisibleRenderer) {
        await waitForBrowserPaint();
      } else {
        await yieldToBrowserTask();
      }
      if (nextY < height) submit();
    }
  } finally {
    await Promise.all(pending);
  }
  if (typeof document !== 'undefined') {
    document.body.dataset.uvBakeReadbackStripeRows = String(rowsPerStripe);
    document.body.dataset.uvBakeReadbackStripeCount = String(
      Math.ceil(height / rowsPerStripe),
    );
    document.body.dataset.uvBakeReadbackMaximumStripeMs = maximumStripeMs.toFixed(1);
    document.body.dataset.uvBakeReadbackTotalMs = (performance.now() - startedAt).toFixed(1);
  }
  return pixels;
}
