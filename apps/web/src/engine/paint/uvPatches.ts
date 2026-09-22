import * as THREE from 'three';

type Rect = { x: number; y: number; width: number; height: number };

/** One active eraser owner; pending integer bounds are unioned per frame. */
export function createPatches() {
  let texture: THREE.CanvasTexture | undefined;
  const bounds = new THREE.Box2();
  const canvas = document.createElement('canvas');
  const source = new THREE.Texture(canvas);
  return {
    add(next: THREE.CanvasTexture, { x, y, width, height }: Rect) {
      if (next !== texture) bounds.makeEmpty();
      texture = next;
      bounds.expandByPoint(new THREE.Vector2(x, y));
      bounds.expandByPoint(new THREE.Vector2(x + width, y + height));
    },
    flush(renderer: THREE.WebGLRenderer, current?: THREE.Texture) {
      const next = texture;
      texture = undefined;
      if (!next || next !== current) return;
      const { x, y } = bounds.min;
      const { x: width, y: height } = bounds.getSize(new THREE.Vector2());
      renderer.initTexture(next);
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d')!.drawImage(next.image, x, y, width, height, 0, 0, width, height);
      renderer.copyTextureToTexture(source, next, null,
        new THREE.Vector2(x, next.flipY ? next.image.height - y - height : y));
    },
    dispose() {
      texture = undefined;
      canvas.width = canvas.height = 1;
    },
  };
}
