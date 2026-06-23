import { loadImageData } from '@/engine/bake/imageSampler';

type Rgb = [number, number, number];

function smoothstep(edge0: number, edge1: number, value: number) {
  const x = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return x * x * (3 - 2 * x);
}

function getMaskValue(maskImage: ImageData, index: number) {
  return Math.max(maskImage.data[index], maskImage.data[index + 1], maskImage.data[index + 2]);
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function estimateBackgroundColor(sourceImage: ImageData, maskImage: ImageData): Rgb {
  const reds: number[] = [];
  const greens: number[] = [];
  const blues: number[] = [];
  const stride = Math.max(1, Math.floor(Math.min(sourceImage.width, sourceImage.height) / 180));

  for (let y = 0; y < sourceImage.height; y += stride) {
    for (let x = 0; x < sourceImage.width; x += stride) {
      const index = (y * sourceImage.width + x) * 4;
      const isMaskBackground = getMaskValue(maskImage, index) < 12;
      const isImageBorder =
        x < stride * 3 ||
        y < stride * 3 ||
        x >= sourceImage.width - stride * 3 ||
        y >= sourceImage.height - stride * 3;
      if (!isMaskBackground && !isImageBorder) continue;
      reds.push(sourceImage.data[index]);
      greens.push(sourceImage.data[index + 1]);
      blues.push(sourceImage.data[index + 2]);
    }
  }

  return [median(reds), median(greens), median(blues)];
}

function colorDistanceFromBackground(sourceImage: ImageData, index: number, background: Rgb) {
  const dr = sourceImage.data[index] - background[0];
  const dg = sourceImage.data[index + 1] - background[1];
  const db = sourceImage.data[index + 2] - background[2];
  return Math.sqrt(dr * dr + dg * dg + db * db) / 441.67295593;
}

function estimateBackgroundThreshold(sourceImage: ImageData, maskImage: ImageData, background: Rgb) {
  const distances: number[] = [];
  const stride = Math.max(1, Math.floor(Math.min(sourceImage.width, sourceImage.height) / 160));
  for (let y = 0; y < sourceImage.height; y += stride) {
    for (let x = 0; x < sourceImage.width; x += stride) {
      const index = (y * sourceImage.width + x) * 4;
      const isMaskBackground = getMaskValue(maskImage, index) < 12;
      const isImageBorder =
        x < stride * 3 ||
        y < stride * 3 ||
        x >= sourceImage.width - stride * 3 ||
        y >= sourceImage.height - stride * 3;
      if (!isMaskBackground && !isImageBorder) continue;
      distances.push(colorDistanceFromBackground(sourceImage, index, background));
    }
  }
  const base = median(distances);
  const deviations = distances.map((value) => Math.abs(value - base));
  const mad = median(deviations);
  return {
    hard: Math.min(0.14, Math.max(0.045, base + mad * 4 + 0.025)),
    soft: Math.min(0.24, Math.max(0.1, base + mad * 8 + 0.08)),
  };
}

function findConnectedBackground(sourceImage: ImageData, maskImage: ImageData, background: Rgb, hardThreshold: number) {
  const { width, height } = sourceImage;
  const total = width * height;
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;

  function canVisit(pixelIndex: number) {
    if (visited[pixelIndex]) return false;
    const dataIndex = pixelIndex * 4;
    const geometryAlpha = smoothstep(18, 80, getMaskValue(maskImage, dataIndex));
    if (geometryAlpha < 0.04) return true;
    return colorDistanceFromBackground(sourceImage, dataIndex, background) <= hardThreshold;
  }

  function enqueue(pixelIndex: number) {
    if (!canVisit(pixelIndex)) return;
    visited[pixelIndex] = 1;
    queue[tail] = pixelIndex;
    tail += 1;
  }

  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }

  while (head < tail) {
    const pixelIndex = queue[head];
    head += 1;
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    if (x > 0) enqueue(pixelIndex - 1);
    if (x < width - 1) enqueue(pixelIndex + 1);
    if (y > 0) enqueue(pixelIndex - width);
    if (y < height - 1) enqueue(pixelIndex + width);
  }

  return visited;
}

function drawImageDataToScaledCanvas(imageData: ImageData, width: number, height: number) {
  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = imageData.width;
  sourceCanvas.height = imageData.height;
  const sourceContext = sourceCanvas.getContext('2d');
  if (!sourceContext) throw new Error('Could not create source image canvas.');
  sourceContext.putImageData(imageData, 0, 0);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Could not create scaled image canvas.');
  context.drawImage(sourceCanvas, 0, 0, width, height);
  return context.getImageData(0, 0, width, height);
}

export async function createMaskedProjectedImage(imageUrl: string, maskUrl: string) {
  const [sourceImage, sourceMask] = await Promise.all([loadImageData(imageUrl), loadImageData(maskUrl)]);
  const maskImage =
    sourceMask.width === sourceImage.width && sourceMask.height === sourceImage.height
      ? sourceMask
      : drawImageDataToScaledCanvas(sourceMask, sourceImage.width, sourceImage.height);

  const canvas = document.createElement('canvas');
  canvas.width = sourceImage.width;
  canvas.height = sourceImage.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create masked projected image canvas.');

  const background = estimateBackgroundColor(sourceImage, maskImage);
  const thresholds = estimateBackgroundThreshold(sourceImage, maskImage, background);
  const connectedBackground = findConnectedBackground(sourceImage, maskImage, background, thresholds.hard);
  const output = new ImageData(sourceImage.width, sourceImage.height);
  for (let index = 0; index < sourceImage.data.length; index += 4) {
    const pixelIndex = index / 4;
    const maskValue = getMaskValue(maskImage, index);
    const geometryAlpha = smoothstep(18, 80, maskValue);
    const matteDistance = colorDistanceFromBackground(sourceImage, index, background);
    const connectedBackgroundAlpha = connectedBackground[pixelIndex]
      ? 1 - smoothstep(thresholds.hard, thresholds.soft, matteDistance)
      : 0;
    const sourceAlpha = sourceImage.data[index + 3] / 255;
    const alpha = geometryAlpha * (1 - connectedBackgroundAlpha) * sourceAlpha;
    output.data[index] = sourceImage.data[index];
    output.data[index + 1] = sourceImage.data[index + 1];
    output.data[index + 2] = sourceImage.data[index + 2];
    output.data[index + 3] = Math.round(alpha * 255);
    if (output.data[index + 3] === 0) {
      output.data[index] = 0;
      output.data[index + 1] = 0;
      output.data[index + 2] = 0;
    }
  }

  context.putImageData(output, 0, 0);
  return canvas.toDataURL('image/png');
}
