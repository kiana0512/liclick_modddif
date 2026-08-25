export const LOCAL_REPAINT_INWARD_CROSSFADE_REFERENCE_SIZE = 2048;
export const LOCAL_REPAINT_INWARD_CROSSFADE_REFERENCE_WIDTH = 16;
export const LOCAL_REPAINT_INWARD_CROSSFADE_MIN_WIDTH = 6;
export const LOCAL_REPAINT_INWARD_CROSSFADE_MAX_WIDTH = 24;
export const LOCAL_REPAINT_INWARD_CROSSFADE_MASK_THRESHOLD = 0.08;

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
  const distances = new Uint16Array(pixelCount);
  const inside = new Uint8Array(pixelCount);
  const threshold = Math.round(LOCAL_REPAINT_INWARD_CROSSFADE_MASK_THRESHOLD * 255);

  for (let index = 0, offset = 0; index < pixelCount; index += 1, offset += 4) {
    const authoredCoverage =
      (Math.max(source[offset] ?? 0, source[offset + 1] ?? 0, source[offset + 2] ?? 0) *
        (source[offset + 3] ?? 255)) /
      255;
    const isInside = authoredCoverage >= threshold;
    inside[index] = isInside ? 1 : 0;
    distances[index] = isInside ? unreachable : 0;
  }

  const relax = (index: number, candidate: number) => {
    if (candidate < distances[index]) distances[index] = candidate;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!inside[index]) continue;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) relax(index, 3);
      if (x > 0) relax(index, distances[index - 1] + 3);
      if (y > 0) relax(index, distances[index - width] + 3);
      if (x > 0 && y > 0) relax(index, distances[index - width - 1] + 4);
      if (x + 1 < width && y > 0) relax(index, distances[index - width + 1] + 4);
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = y * width + x;
      if (!inside[index]) continue;
      if (x + 1 < width) relax(index, distances[index + 1] + 3);
      if (y + 1 < height) relax(index, distances[index + width] + 3);
      if (x + 1 < width && y + 1 < height) relax(index, distances[index + width + 1] + 4);
      if (x > 0 && y + 1 < height) relax(index, distances[index + width - 1] + 4);
    }
  }

  const output = new Uint8ClampedArray(pixelCount * 4);
  for (let index = 0, offset = 0; index < pixelCount; index += 1, offset += 4) {
    const inwardDistance = Math.max(0, Math.min(maximumDistance, distances[index]) - 3);
    const localRepaintWeight = inside[index]
      ? smoothstep01(inwardDistance / Math.max(1, maximumDistance - 3))
      : 0;
    const value = Math.round(localRepaintWeight * 255);
    output[offset] = value;
    output[offset + 1] = value;
    output[offset + 2] = value;
    output[offset + 3] = 255;
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
