import {
  buildEditMask,
  buildProtectMask,
  computeMaskBoundingBox,
  createEmptyMask,
} from '../engine/localRepaint/maskUtils';
import type { MaskBitmap } from '../types/localRepaint';

type MaskPreparationRequest = {
  id: number;
  bitmap: ImageBitmap;
  objectMask: MaskBitmap;
  holeMask: MaskBitmap;
  mode: 'edit_layer_image' | 'repair_current_view';
  includeBlankArea: boolean;
  limitToBlankAndSelection: boolean;
  preserveUnmaskedArea: boolean;
};

type MaskPreparationResponse =
  | {
      id: number;
      userMask: MaskBitmap;
      editMask: MaskBitmap;
      protectMask: MaskBitmap;
      bbox?: { x: number; y: number; w: number; h: number };
      processMs: number;
    }
  | { id: number; error: string };

function resizeMask(mask: MaskBitmap, width: number, height: number): MaskBitmap {
  if (mask.width === width && mask.height === height) return mask;
  const output = createEmptyMask(width, height);
  const maxSourceX = Math.max(0, mask.width - 1);
  const maxSourceY = Math.max(0, mask.height - 1);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(maxSourceY, Math.floor((y / height) * mask.height));
    const sourceRow = sourceY * mask.width;
    const outputRow = y * width;
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(maxSourceX, Math.floor((x / width) * mask.width));
      output.data[outputRow + x] = mask.data[sourceRow + sourceX] ?? 0;
    }
  }
  return output;
}

self.onmessage = (event: MessageEvent<MaskPreparationRequest>) => {
  const { id, bitmap } = event.data;
  const startedAt = performance.now();
  try {
    const width = bitmap.width;
    const height = bitmap.height;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Could not read the local repaint mask.');
    context.clearRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, width, height).data;
    const objectMask = resizeMask(event.data.objectMask, width, height);
    const holeMask = resizeMask(event.data.holeMask, width, height);
    const userMask = createEmptyMask(width, height);
    for (let index = 0; index < userMask.data.length; index += 1) {
      userMask.data[index] =
        pixels[index * 4 + 3] > 8 && (objectMask.data[index] ?? 0) > 8 ? 255 : 0;
    }
    const editMask =
      event.data.mode === 'edit_layer_image'
        ? userMask
        : buildEditMask(userMask, holeMask, {
            includeBlankArea: event.data.includeBlankArea,
            dilationRadius: event.data.limitToBlankAndSelection ? 0 : 8,
          });
    const protectMask = event.data.preserveUnmaskedArea
      ? buildProtectMask(objectMask, editMask)
      : createEmptyMask(width, height);
    const response: MaskPreparationResponse = {
      id,
      userMask,
      editMask,
      protectMask,
      bbox: computeMaskBoundingBox(editMask),
      processMs: performance.now() - startedAt,
    };
    self.postMessage(response, {
      transfer: [
        ...new Set([userMask.data.buffer, editMask.data.buffer, protectMask.data.buffer]),
      ],
    });
  } catch (error) {
    const response: MaskPreparationResponse = {
      id,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  } finally {
    bitmap.close();
  }
};

export {};
