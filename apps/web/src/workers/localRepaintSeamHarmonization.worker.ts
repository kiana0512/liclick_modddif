import {
  harmonizeLocalRepaintPixels,
  type LocalRepaintSeamHarmonizationOptions,
  type LocalRepaintSeamHarmonizationReport,
} from '../engine/localRepaint/seamHarmonizationCore';

type SeamRequest = {
  id: number;
  generated: ImageBitmap;
  reference: ImageBitmap;
  mask: ImageBitmap;
  width: number;
  height: number;
  options?: LocalRepaintSeamHarmonizationOptions;
};

type SeamResponse =
  | {
      id: number;
      blob: Blob;
      processMs: number;
      report: LocalRepaintSeamHarmonizationReport;
    }
  | { id: number; error: string };

self.onmessage = async (event: MessageEvent<SeamRequest>) => {
  const { id, generated, reference, mask, width, height, options } = event.data;
  const startedAt = performance.now();
  try {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Could not create local repaint seam canvas.');
    const read = (bitmap: ImageBitmap) => {
      context.clearRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      return context.getImageData(0, 0, width, height);
    };
    const generatedPixels = read(generated);
    const referencePixels = read(reference);
    const maskPixels = read(mask);
    const result = harmonizeLocalRepaintPixels({
      generated: generatedPixels.data,
      reference: referencePixels.data,
      mask: maskPixels.data,
      width,
      height,
      options,
    });
    const output = context.createImageData(width, height);
    output.data.set(result.pixels);
    context.putImageData(output, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const response: SeamResponse = {
      id,
      blob,
      processMs: performance.now() - startedAt,
      report: result.report,
    };
    self.postMessage(response);
  } catch (error) {
    const response: SeamResponse = {
      id,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  } finally {
    generated.close();
    reference.close();
    mask.close();
  }
};

export {};
