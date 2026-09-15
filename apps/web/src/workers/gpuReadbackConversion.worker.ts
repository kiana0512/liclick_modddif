import { padUvIslandGuttersWithTopology } from '../engine/bake/dilation';

const MIN_TRANSPARENT_OUTPUT_ALPHA = 8;
const UNPROJECTED_TEXTURE_FILL: [number, number, number] = [8, 9, 13];

type ConversionRequest = {
  id: number;
  mode: 'final' | 'layer' | 'resident' | 'quality';
  pixels: ArrayBuffer;
  resolution: number;
  outputAlpha?: 'opaque-viewport' | 'transparent';
  packedQuality?: boolean;
};

type GutterRequest = {
  id: number; mode: 'gutter'; pixels: ArrayBuffer; coverage: ArrayBuffer;
  width: number; height: number; topology?: Uint8Array;
  iterations: number; alphaMode: boolean | 'rgb-only';
};
let gutterTopology: Uint8Array | undefined;

type ConversionResponse =
  | {
      id: number;
      mode: 'final' | 'layer' | 'resident';
      imageData: ArrayBuffer;
      coverage: ArrayBuffer;
      coveredPixels: number;
      transparentCleanupTexels?: ArrayBuffer;
    }
  | { id: number; mode: 'quality'; quality: ArrayBuffer }
  | { id: number; mode: 'gutter'; imageData: ArrayBuffer; coverage: ArrayBuffer; paddedPixels: number }
  | { id: number; error: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ConversionRequest | GutterRequest>) => void) | null;
  postMessage(message: ConversionResponse | { ready: 1 }, transfer?: Transferable[]): void;
};

function convertQuality(request: ConversionRequest) {
  const pixels = new Uint8Array(request.pixels);
  const stride = request.packedQuality ? 1 : 4;
  if (pixels.length !== request.resolution * request.resolution * stride) {
    throw new Error('Invalid quality readback byte length.');
  }
  const quality = new Float32Array(request.resolution * request.resolution);
  const rowLength = request.resolution * stride;
  for (let y = 0; y < request.resolution; y += 1) {
    const sourceStart = (request.resolution - 1 - y) * rowLength;
    for (let x = 0; x < request.resolution; x += 1) {
      quality[y * request.resolution + x] = pixels[sourceStart + x * stride + stride - 1] / 255;
    }
  }
  return quality.buffer;
}

function convertColor(request: ConversionRequest) {
  const pixels = new Uint8Array(request.pixels);
  if (request.mode === 'resident') {
    // The caller transfers sole ownership. Flip rows in place instead of
    // allocating/copying another full 64 MiB RGBA buffer for every 4K toggle.
    const size = request.resolution, rowBytes = size * 4;
    if (pixels.length !== size * rowBytes) throw new Error('Invalid resident readback byte length.');
    const row = new Uint8Array(rowBytes), coverage = new Uint8Array(size * size);
    for (let y = 0; y < Math.floor(size / 2); y++) {
      const top = y * rowBytes, bottom = (size - 1 - y) * rowBytes;
      row.set(pixels.subarray(top, top + rowBytes));
      pixels.copyWithin(top, bottom, bottom + rowBytes);
      pixels.set(row, bottom);
    }
    let coveredPixels = 0;
    let cleanup: number[] | undefined = [];
    const words = new Uint32Array(request.pixels);
    for (let index = 0; index < coverage.length; index++) {
      const word=words[index],alpha=word>>>24;
      if (alpha > 0) { coverage[index] = 1; coveredPixels++; }
      if (cleanup && alpha <= MIN_TRANSPARENT_OUTPUT_ALPHA &&
        word !== 0) {
        if(cleanup.length<16384) cleanup.push(index); else cleanup=undefined;
      }
    }
    return { imageData: request.pixels, coverage: coverage.buffer, coveredPixels,
      transparentCleanupTexels: cleanup ? new Uint32Array(cleanup).buffer : undefined };
  }
  const imageData = new Uint8ClampedArray(request.resolution * request.resolution * 4);
  const coverage = new Uint8Array(request.resolution * request.resolution);
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
        coverage[pixelIndex] = 1;
        coveredPixels += 1;
      } else if (request.mode === 'final' && request.outputAlpha === 'opaque-viewport') {
        imageData[targetOffset] = UNPROJECTED_TEXTURE_FILL[0];
        imageData[targetOffset + 1] = UNPROJECTED_TEXTURE_FILL[1];
        imageData[targetOffset + 2] = UNPROJECTED_TEXTURE_FILL[2];
        imageData[targetOffset + 3] = 255;
      }
    }
  }
  return { imageData: imageData.buffer, coverage: coverage.buffer, coveredPixels };
}

scope.onmessage = (event) => {
  const request = event.data;
  try {
    if (request.mode === 'gutter') {
      if(request.topology) gutterTopology=request.topology;
      if(!gutterTopology || request.pixels.byteLength!==request.width*request.height*4)
        throw new Error('Invalid UV gutter Worker input.');
      const image={width:request.width,height:request.height,data:new Uint8ClampedArray(request.pixels)} as ImageData;
      const paddedPixels=padUvIslandGuttersWithTopology(image,new Uint8Array(request.coverage),
        gutterTopology,request.iterations,request.alphaMode,true);
      scope.postMessage({id:request.id,mode:'gutter',imageData:request.pixels,coverage:request.coverage,paddedPixels},
        [request.pixels,request.coverage]);
      return;
    }
    if (request.mode === 'quality') {
      const quality = convertQuality(request);
      scope.postMessage({ id: request.id, mode: 'quality', quality }, [quality]);
      return;
    }
    const result = convertColor(request);
    scope.postMessage(
      { id: request.id, mode: request.mode, ...result },
      [result.imageData, result.coverage, ...(result.transparentCleanupTexels ? [result.transparentCleanupTexels] : [])],
    );
  } catch (error) {
    scope.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

scope.postMessage({ ready: 1 });
