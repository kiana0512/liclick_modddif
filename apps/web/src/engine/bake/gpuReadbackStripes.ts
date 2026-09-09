import type * as THREE from 'three';
import { waitForBrowserPaint } from '@/utils/browserScheduling';

// Eight 8 MiB stripes for a 4K RGBA target keep each driver readback bounded.
// The smaller transfer is intentionally retained: stress testing showed a
// 100.1ms maximum frame versus 433.6ms at 32 MiB, with identical pixels.
const GPU_READBACK_STRIPE_BYTES = 8 * 1024 * 1024;

export async function readRenderTargetPixelsInStripes(
  renderer: THREE.WebGLRenderer,
  target: THREE.WebGLRenderTarget,
  resolution: number,
) {
  const pixels = new Uint8Array(resolution * resolution * 4);
  const rowsPerStripe = Math.max(
    1,
    Math.min(resolution, Math.floor(GPU_READBACK_STRIPE_BYTES / (resolution * 4))),
  );
  let maximumStripeMs = 0;
  const startedAt = performance.now();
  const usesVisibleRenderer = renderer.domElement.isConnected;
  for (let y = 0; y < resolution; y += rowsPerStripe) {
    if (y > 0) {
      if (usesVisibleRenderer) {
        await waitForBrowserPaint();
      } else {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
    }
    const rowCount = Math.min(rowsPerStripe, resolution - y);
    // Read directly into this stripe's final destination. A separate buffer
    // plus pixels.set copied another full RGBA atlas on the main thread per
    // readback (64 MiB at 4K), without changing a single output byte.
    const offset = y * resolution * 4;
    const stripe = pixels.subarray(offset, offset + resolution * rowCount * 4);
    const stripeStartedAt = performance.now();
    await renderer.readRenderTargetPixelsAsync(
      target,
      0,
      y,
      resolution,
      rowCount,
      stripe,
    );
    maximumStripeMs = Math.max(maximumStripeMs, performance.now() - stripeStartedAt);
  }
  if (typeof document !== 'undefined') {
    document.body.dataset.uvBakeReadbackStripeRows = String(rowsPerStripe);
    document.body.dataset.uvBakeReadbackStripeCount = String(
      Math.ceil(resolution / rowsPerStripe),
    );
    document.body.dataset.uvBakeReadbackMaximumStripeMs = maximumStripeMs.toFixed(1);
    document.body.dataset.uvBakeReadbackTotalMs = (performance.now() - startedAt).toFixed(1);
  }
  return pixels;
}

