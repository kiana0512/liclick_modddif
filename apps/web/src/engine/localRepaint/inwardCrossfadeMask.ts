export const LOCAL_REPAINT_INWARD_CROSSFADE_REFERENCE_SIZE = 2048;
export const LOCAL_REPAINT_INWARD_CROSSFADE_REFERENCE_WIDTH = 16;
export const LOCAL_REPAINT_INWARD_CROSSFADE_MIN_WIDTH = 6;
export const LOCAL_REPAINT_INWARD_CROSSFADE_MAX_WIDTH = 24;
export const LOCAL_REPAINT_INWARD_CROSSFADE_MASK_THRESHOLD = 0.08;

/** ALG-LR-UV-PAINT v2.0.0: analytic inward blend of the actual brush capsule.
 * Distances are CSS pixels, normalized to a 2K viewport (not UV-island edges or
 * the generation selection). Small brushes retain an opaque centre. */
export function getLocalRepaintStrokeBlend(radius: number, feather: number, viewportSpan: number) {
  const scale = viewportSpan / LOCAL_REPAINT_INWARD_CROSSFADE_REFERENCE_SIZE;
  const outer = radius - Math.min(3 * scale, radius * 0.25);
  const width = Math.min(outer, Math.max(
    LOCAL_REPAINT_INWARD_CROSSFADE_REFERENCE_WIDTH * scale,
    radius * Math.max(0, Math.min(1, feather)),
  ));
  return [(outer - width) / radius, outer / radius] as const;
}

export type LocalRepaintMaskRect = { x: number; y: number; width: number; height: number };

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function smoothstep01(value: number) {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

export function getLocalRepaintInwardCrossfadeWidth(width: number, height: number) {
  return clamp(
    Math.round(
      (Math.max(width, height) / LOCAL_REPAINT_INWARD_CROSSFADE_REFERENCE_SIZE) *
        LOCAL_REPAINT_INWARD_CROSSFADE_REFERENCE_WIDTH,
    ),
    LOCAL_REPAINT_INWARD_CROSSFADE_MIN_WIDTH,
    LOCAL_REPAINT_INWARD_CROSSFADE_MAX_WIDTH,
  );
}

function expandRect(rect: LocalRepaintMaskRect, amount: number, width: number, height: number) {
  const x = clamp(Math.floor(rect.x - amount), 0, width);
  const y = clamp(Math.floor(rect.y - amount), 0, height);
  const right = clamp(Math.ceil(rect.x + rect.width + amount), x, width);
  const bottom = clamp(Math.ceil(rect.y + rect.height + amount), y, height);
  return { x, y, width: right - x, height: bottom - y };
}

export function createLocalRepaintInwardCrossfadePixels(input: {
  source: Uint8ClampedArray;
  width: number;
  height: number;
  crossfadeWidth?: number;
}) {
  const { source, width, height } = input;
  const crossfadeWidth = clamp(
    Math.round(input.crossfadeWidth ?? getLocalRepaintInwardCrossfadeWidth(width, height)),
    1,
    Math.max(width, height),
  );
  const pixelCount = width * height;
  const maximumDistance = crossfadeWidth * 3;
  const unreachable = maximumDistance + 12;
  // A zero border represents the unchanged outside-of-image boundary. It
  // removes edge branches and the separate inside bitmap from both sweeps.
  const stride = width + 2;
  const distances = new Uint16Array(stride * (height + 2));
  const threshold = Math.round(LOCAL_REPAINT_INWARD_CROSSFADE_MASK_THRESHOLD * 255);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const authoredCoverage =
        (Math.max(source[offset] ?? 0, source[offset + 1] ?? 0, source[offset + 2] ?? 0) *
          (source[offset + 3] ?? 255)) / 255;
      if (authoredCoverage < threshold) continue;
      const index = (y + 1) * stride + x + 1;
      distances[index] = Math.min(
        unreachable & 0xffff,
        distances[index - 1] + 3,
        distances[index - stride] + 3,
        distances[index - stride - 1] + 4,
        distances[index - stride + 1] + 4,
      );
    }
  }

  // Chamfer distances are integers. Evaluate the unchanged smoothstep once per
  // distance, not once per pixel, and publish during the final distance sweep.
  // Build bytes first so packed writes preserve RGBA on either host byte order.
  const weightBytes = new Uint8ClampedArray((maximumDistance + 1) * 4);
  for (let distance = 0; distance <= maximumDistance; distance += 1) {
    const value = Math.round(
      smoothstep01(Math.max(0, distance - 3) / Math.max(1, maximumDistance - 3)) * 255,
    );
    weightBytes.set([value, value, value, 255], distance * 4);
  }
  const weights = new Uint32Array(weightBytes.buffer);
  const output = new Uint8ClampedArray(pixelCount * 4);
  const outputWords = new Uint32Array(output.buffer);
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = (y + 1) * stride + x + 1;
      let value = weights[0];
      if (distances[index]) {
        const distance = Math.min(
          distances[index],
          distances[index + 1] + 3,
          distances[index + stride] + 3,
          distances[index + stride + 1] + 4,
          distances[index + stride - 1] + 4,
        );
        distances[index] = distance;
        value = weights[Math.min(maximumDistance, distance)];
      }
      outputWords[y * width + x] = value;
    }
  }
  return output;
}

export function updateLocalRepaintInwardCrossfadeCanvas(input: {
  sourceContext: CanvasRenderingContext2D;
  targetContext: CanvasRenderingContext2D;
  width: number;
  height: number;
  dirtyRect?: LocalRepaintMaskRect;
}) {
  const crossfadeWidth = getLocalRepaintInwardCrossfadeWidth(input.width, input.height);
  const outputRect = input.dirtyRect
    ? expandRect(input.dirtyRect, crossfadeWidth + 2, input.width, input.height)
    : { x: 0, y: 0, width: input.width, height: input.height };
  if (outputRect.width <= 0 || outputRect.height <= 0) return outputRect;
  const sampleRect = expandRect(outputRect, crossfadeWidth + 2, input.width, input.height);
  const source = input.sourceContext.getImageData(sampleRect.x, sampleRect.y, sampleRect.width, sampleRect.height);
  const derived = createLocalRepaintInwardCrossfadePixels({
    source: source.data,
    width: sampleRect.width,
    height: sampleRect.height,
    crossfadeWidth,
  });
  const offsetX = outputRect.x - sampleRect.x;
  const offsetY = outputRect.y - sampleRect.y;
  const output = input.targetContext.createImageData(outputRect.width, outputRect.height);
  for (let y = 0; y < outputRect.height; y += 1) {
    const sourceStart = ((y + offsetY) * sampleRect.width + offsetX) * 4;
    const targetStart = y * outputRect.width * 4;
    output.data.set(derived.subarray(sourceStart, sourceStart + outputRect.width * 4), targetStart);
  }
  input.targetContext.putImageData(output, outputRect.x, outputRect.y);
  return outputRect;
}

/** ALG-LR-008 v3.1.0: generation selection is not a manual brush boundary.
 * Feather the actual strokes, not this source-space permission texture.
 * Source alpha, capture depth and the actual brush still bound all writes.
 */
export function createManualRepaintFalloffPixels(mask: ImageData) {
  const output = new Uint8ClampedArray(mask.data.length);
  for (let i = 0; i < mask.data.length; i += 4) {
    if (Math.max(mask.data[i], mask.data[i + 1], mask.data[i + 2]) * mask.data[i + 3] / 65025 > 0.03) {
      output.fill(255);
      break;
    }
  }
  return output;
}

/** Automatic application remains inside the original author selection. */
export function createBoundedRepaintFalloffPixels(mask: ImageData) {
  const output = createLocalRepaintInwardCrossfadePixels({
    source: mask.data, width: mask.width, height: mask.height,
  });
  for (let i = 0; i < output.length; i += 4) {
    const authored = Math.max(mask.data[i], mask.data[i + 1], mask.data[i + 2]) * mask.data[i + 3] / 255;
    const alpha = Math.min(output[i], authored);
    output[i] = output[i + 1] = output[i + 2] = 255;
    output[i + 3] = alpha;
  }
  return output;
}
