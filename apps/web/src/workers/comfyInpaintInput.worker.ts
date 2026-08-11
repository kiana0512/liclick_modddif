import { encodeRgbaPngBytes } from '@/utils/encodeRgbaPngCore';

type ComposeRequest = {
  id: number;
  source: ImageBitmap;
  mask: ImageBitmap;
  width: number;
  height: number;
};

type ComposeResponse =
  | { id: number; dataUrl: string; processMs: number }
  | { id: number; error: string };

function encodePngDataUrl(bytes: Uint8Array) {
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
    binary += String.fromCharCode(...chunk);
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

self.onmessage = (event: MessageEvent<ComposeRequest>) => {
  const { id, source, mask, width, height } = event.data;
  const startedAt = performance.now();
  try {
    const sourceCanvas = new OffscreenCanvas(width, height);
    const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
    if (!sourceContext) throw new Error('Could not create the inpaint source canvas.');
    sourceContext.drawImage(source, 0, 0, width, height);
    const sourcePixels = sourceContext.getImageData(0, 0, width, height);

    const maskCanvas = new OffscreenCanvas(width, height);
    const maskContext = maskCanvas.getContext('2d', { willReadFrequently: true });
    if (!maskContext) throw new Error('Could not create the inpaint mask canvas.');
    maskContext.imageSmoothingEnabled = true;
    maskContext.imageSmoothingQuality = 'high';
    maskContext.drawImage(mask, 0, 0, width, height);

    const sourceWidth = Math.max(1, source.width);
    const sourceHeight = Math.max(1, source.height);
    const upscale = Math.max(width / sourceWidth, height / sourceHeight);
    let sampledMaskContext = maskContext;
    if (upscale > 1.05) {
      const contourCanvas = new OffscreenCanvas(width, height);
      const contourContext = contourCanvas.getContext('2d', { willReadFrequently: true });
      if (contourContext) {
        contourContext.filter = `blur(${Math.min(3, Math.max(0.75, upscale * 0.65))}px)`;
        contourContext.drawImage(maskCanvas, 0, 0);
        contourContext.filter = 'none';
        sampledMaskContext = contourContext;
      }
    }
    const maskPixels = sampledMaskContext.getImageData(0, 0, width, height).data;
    for (let offset = 0; offset < sourcePixels.data.length; offset += 4) {
      const coverage =
        (Math.max(maskPixels[offset], maskPixels[offset + 1], maskPixels[offset + 2]) *
          (maskPixels[offset + 3] / 255)) /
        255;
      const edgeCoverage = Math.max(0, Math.min(1, (coverage - 0.42) / 0.16));
      const antialiasedCoverage = edgeCoverage * edgeCoverage * (3 - 2 * edgeCoverage);
      sourcePixels.data[offset + 3] = Math.round((1 - antialiasedCoverage) * 255);
    }

    const encoded = encodeRgbaPngBytes(width, height, sourcePixels.data);
    const response: ComposeResponse = {
      id,
      dataUrl: encodePngDataUrl(encoded),
      processMs: performance.now() - startedAt,
    };
    self.postMessage(response);
  } catch (error) {
    const response: ComposeResponse = {
      id,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  } finally {
    source.close();
    mask.close();
  }
};

export {};
