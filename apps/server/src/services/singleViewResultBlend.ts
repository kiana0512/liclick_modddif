import sharp from 'sharp';
import { setImmediate } from 'node:timers/promises';

export const SINGLE_VIEW_RESULT_BLEND = 'single-view-ndv-v1';
export type BlendCamera = { projection: 'perspective' | 'orthographic'; projectionMatrix: number[] };
type Pixels = { data: Buffer; width: number; height: number };
// captureCurrentView uses an sRGB render target. WebGL encodes the normal
// channels on write (a front normal is 188,188,255), even without OutputPass.
const normalChannel = Float64Array.from({ length: 256 }, (_, byte) => {
  const x = byte / 255;
  return 2 * (x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4) - 1;
});

async function decode(buffer: Buffer): Promise<Pixels> {
  const { data, info } = await sharp(buffer, { limitInputPixels: 4096 * 4096 })
    .toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function sameSize(a: Pixels, b: Pixels) {
  if (a.width !== b.width || a.height !== b.height)
    throw new Error('渐变合成图片尺寸不一致，不能缩放或错位叠加。');
}

/** SINGLE-VIEW-RESULT-BLEND/1.0.0. Frozen view normals, no colour-key holes.
 * Mask bytes are replacement weights, not illumination applied to the RGB. */
export async function prepareSingleViewResultBlend(
  current: Buffer, objectMask: Buffer, normals: Buffer, camera: BlendCamera, signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const p = camera?.projectionMatrix;
  if (!['perspective', 'orthographic'].includes(camera?.projection) ||
      !Array.isArray(p) || p.length !== 16 || !p.every(Number.isFinite) || !p[0] || !p[5])
    throw new Error('渐变合成缺少有效的冻结相机。');
  const [base, silhouette, normal] = await Promise.all([decode(current), decode(objectMask), decode(normals)]);
  sameSize(base, silhouette); sameSize(base, normal);
  const weights = Buffer.alloc(base.width * base.height);
  for (let y = 0; y < base.height; y++) {
    if (y % 32 === 0) { await setImmediate(); signal?.throwIfAborted(); }
    for (let x = 0; x < base.width; x++) {
      const i = y * base.width + x, o = i * 4;
      if (Math.max(silhouette.data[o], silhouette.data[o + 1], silhouette.data[o + 2]) <= 127 || silhouette.data[o + 3] <= 8) continue;
      // Match projectionGapMaskFromAlpha: partial/erased coverage is a gap.
      if (base.data[o + 3] < 255) { weights[i] = 255; continue; }
      const nx = normalChannel[normal.data[o]];
      const ny = normalChannel[normal.data[o + 1]];
      const nz = normalChannel[normal.data[o + 2]];
      const vx = camera.projection === 'perspective' ? -((2 * (x + .5) / base.width - 1) + p[8]) / p[0] : 0;
      const vy = camera.projection === 'perspective' ? -((1 - 2 * (y + .5) / base.height) + p[9]) / p[5] : 0;
      const facing = (nx * vx + ny * vy + nz) / (Math.hypot(nx, ny, nz) * Math.hypot(vx, vy, 1));
      weights[i] = Math.round(255 * Math.max(0, Math.min(1, facing)));
    }
  }
  return { base, weights, maskPng: await sharp(weights, {
    raw: { width: base.width, height: base.height, channels: 1 },
  }).png().toBuffer() };
}

export async function blendSingleViewResult(
  returned: Buffer, prepared: Awaited<ReturnType<typeof prepareSingleViewResultBlend>>, signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const result = await decode(returned);
  sameSize(prepared.base, result);
  const out = Buffer.alloc(result.data.length);
  for (let i = 0; i < prepared.weights.length; i++) {
    if (i % (result.width * 32) === 0) { await setImmediate(); signal?.throwIfAborted(); }
    const weight = prepared.weights[i] / 255, o = i * 4;
    for (let c = 0; c < 3; c++) out[o + c] = Math.round(
      result.data[o + c] * weight + prepared.base.data[o + c] * (1 - weight));
    // Capture alpha describes texture coverage, not final output transparency.
    out[o + 3] = 255;
  }
  return sharp(out, { raw: { width: result.width, height: result.height, channels: 4 } }).png().toBuffer();
}
