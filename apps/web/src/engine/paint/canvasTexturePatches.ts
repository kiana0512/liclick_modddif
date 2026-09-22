import * as THREE from 'three';

type Rect = { x: number; y: number; width: number; height: number };

/** Keep the existing RGBA/undo semantics; upload only dirty pixels before rendering. */
export class CanvasTexturePatches {
  private pending = new Map<THREE.CanvasTexture, Rect>();
  private canvas = document.createElement('canvas');
  private source = new THREE.Texture(this.canvas);

  add(texture: THREE.CanvasTexture, rect: Rect) {
    const previous = this.pending.get(texture);
    if (previous) {
      const right = Math.max(previous.x + previous.width, rect.x + rect.width);
      const bottom = Math.max(previous.y + previous.height, rect.y + rect.height);
      rect = { x: Math.min(previous.x, rect.x), y: Math.min(previous.y, rect.y), width: 0, height: 0 };
      rect.width = right - rect.x;
      rect.height = bottom - rect.y;
    }
    this.pending.set(texture, rect);
  }

  flush(renderer: THREE.WebGLRenderer, current?: THREE.Texture) {
    for (const [texture, rect] of this.pending) {
      if (texture !== current) continue;
      const image = texture.image as HTMLCanvasElement;
      const x = Math.max(0, Math.floor(rect.x)), y = Math.max(0, Math.floor(rect.y));
      const width = Math.min(image.width, Math.ceil(rect.x + rect.width)) - x;
      const height = Math.min(image.height, Math.ceil(rect.y + rect.height)) - y;
      if (width <= 0 || height <= 0) continue;
      // Initialize once (also honors full-source restores after undo/redo).
      renderer.initTexture(texture);
      this.canvas.width = width;
      this.canvas.height = height;
      this.canvas.getContext('2d')!.drawImage(image, x, y, width, height, 0, 0, width, height);
      // The source remains CPU-only. Three uploads the subimage without a full
      // readback or changing the destination texture's revision/storage.
      renderer.copyTextureToTexture(this.source, texture, null,
        new THREE.Vector2(x, texture.flipY ? image.height - y - height : y));
    }
    this.pending.clear();
  }

  dispose() {
    this.pending.clear();
    this.source.dispose();
    this.canvas.width = this.canvas.height = 1;
  }
}
