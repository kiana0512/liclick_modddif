export {};

const MIN_TRANSPARENT_OUTPUT_ALPHA = 8;
const UNPROJECTED_TEXTURE_FILL: [number, number, number] = [8, 9, 13];

type ConversionRequest = {
  id: number;
  mode: 'final' | 'layer' | 'quality';
  pixels: ArrayBuffer;
  resolution: number;
  outputAlpha?: 'opaque-viewport' | 'transparent';
};

type ConversionResponse =
  | {
      id: number;
      mode: 'final';
      imageData: ArrayBuffer;
      coverage: ArrayBuffer;
      recycledPixels: ArrayBuffer;
      coveredPixels: number;
    }
  | {
      id: number;
      mode: 'layer';
      imageData: ArrayBuffer;
      recycledPixels: ArrayBuffer;
      coveredPixels: number;
    }
  | { id: number; mode: 'quality'; quality: ArrayBuffer; recycledPixels: ArrayBuffer }
  | { id: number; error: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ConversionRequest>) => void) | null;
  postMessage(message: ConversionResponse, transfer?: Transferable[]): void;
};

function convertQuality(request: ConversionRequest) {
  const pixels = new Uint8Array(request.pixels);
  // Quality originates from an 8-bit render-target alpha channel. Keep that
  // canonical byte representation until the blend worker consumes it instead
  // of expanding every 4K layer to a 64 MiB Float32Array.
  const quality = new Uint8Array(request.resolution * request.resolution);
  const rowLength = request.resolution * 4;
  for (let y = 0; y < request.resolution; y += 1) {
    const sourceStart = (request.resolution - 1 - y) * rowLength;
    for (let x = 0; x < request.resolution; x += 1) {
      quality[y * request.resolution + x] = pixels[sourceStart + x * 4 + 3];
    }
  }
  return quality.buffer;
}

function convertColor(request: ConversionRequest) {
  const pixels = new Uint8Array(request.pixels);
  const imageData = new Uint8ClampedArray(request.resolution * request.resolution * 4);
  const coverage =
    request.mode === 'final' ? new Uint8Array(request.resolution * request.resolution) : undefined;
  const rowLength = request.resolution * 4;
  let coveredPixels = 0;
  for (let y = 0; y < request.resolution; y += 1) {
    const sourceStart = (request.resolution - 1 - y) * rowLength;
    const targetStart = y * rowLength;
    for (let x = 0; x < request.resolution; x += 1) {
      const pixelIndex = y * request.resolution + x;
      const sourceOffset = sourceStart + x * 4;
      const targetOffset = targetStart + x * 4;
      let red = pixels[sourceOffset];
      let green = pixels[sourceOffset + 1];
      let blue = pixels[sourceOffset + 2];
      const alphaByte = pixels[sourceOffset + 3];
      if (
        request.mode === 'final' &&
        request.outputAlpha === 'transparent' &&
        alphaByte <= MIN_TRANSPARENT_OUTPUT_ALPHA
      ) {
        continue;
      }
      if (alphaByte > 0) {
        if (alphaByte < 255) {
          const alpha = alphaByte / 255;
          red = Math.min(255, Math.round(red / alpha));
          green = Math.min(255, Math.round(green / alpha));
          blue = Math.min(255, Math.round(blue / alpha));
        }
        imageData[targetOffset] = red;
        imageData[targetOffset + 1] = green;
        imageData[targetOffset + 2] = blue;
        imageData[targetOffset + 3] = alphaByte;
        if (coverage) coverage[pixelIndex] = 1;
        coveredPixels += 1;
      } else if (request.mode === 'final' && request.outputAlpha === 'opaque-viewport') {
        imageData[targetOffset] = UNPROJECTED_TEXTURE_FILL[0];
        imageData[targetOffset + 1] = UNPROJECTED_TEXTURE_FILL[1];
        imageData[targetOffset + 2] = UNPROJECTED_TEXTURE_FILL[2];
        imageData[targetOffset + 3] = 255;
      }
    }
  }
  return { imageData: imageData.buffer, coverage: coverage?.buffer, coveredPixels };
}

scope.onmessage = (event) => {
  const request = event.data;
  try {
    if (request.mode === 'quality') {
      const quality = convertQuality(request);
      scope.postMessage(
        { id: request.id, mode: 'quality', quality, recycledPixels: request.pixels },
        [quality, request.pixels],
      );
      return;
    }
    const result = convertColor(request);
    if (request.mode === 'final' && result.coverage) {
      scope.postMessage(
        {
          id: request.id,
          mode: 'final',
          ...result,
          coverage: result.coverage,
          recycledPixels: request.pixels,
        },
        [result.imageData, result.coverage, request.pixels],
      );
    } else {
      scope.postMessage(
        {
          id: request.id,
          mode: 'layer',
          imageData: result.imageData,
          recycledPixels: request.pixels,
          coveredPixels: result.coveredPixels,
        },
        [result.imageData, request.pixels],
      );
    }
  } catch (error) {
    scope.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
