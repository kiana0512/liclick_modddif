import type { Layer } from '@/types/layer';

export const UV_REPAINT_VERSION = 4;
export const UV_REPAINT_TILE_SIZE = 256;
export const UV_REPAINT_LAYER_PREFIX = 'local-repaint-uv-native-v1';
export function isNativeUvRepaintLayer(layer: Pick<Layer, 'id' | 'type'>) {
  return layer.type === 'uv' && layer.id.startsWith(UV_REPAINT_LAYER_PREFIX);
}
export type UvRepaintRect = { x: number; y: number; width: number; height: number };
export type UvRepaintPatch = {
  bounds: UvRepaintRect;
  before: Uint8Array<ArrayBuffer>;
  after: Uint8Array<ArrayBuffer>;
};

/** Only coverage actually added by this stroke consumes the working selection. */
export function createUvRepaintSelectionCanvas(patches: UvRepaintPatch[], resolution: number) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = resolution;
  const context = canvas.getContext('2d')!;
  for (const { bounds, before, after } of patches) {
    const image = context.createImageData(bounds.width, bounds.height);
    for (let y = 0; y < bounds.height; y++)
      for (let x = 0; x < bounds.width; x++) {
        const i = (y * bounds.width + x) * 4;
        if (after[i + 3] <= before[i + 3]) continue;
        const j = ((bounds.height - 1 - y) * bounds.width + x) * 4;
        image.data.set([255, 255, 255, after[i + 3]], j);
      }
    context.putImageData(image, bounds.x, resolution - bounds.y - bounds.height);
  }
  return canvas;
}
