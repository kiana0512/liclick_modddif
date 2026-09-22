import * as THREE from 'three';

type Rect = { x: number; y: number; width: number; height: number };

/** One active eraser owner. Rects are integer canvas bounds from createDirtyRect. */
export class CanvasTexturePatches {
  private texture?: THREE.CanvasTexture;
  private bounds = new THREE.Box2();
  private canvas = document.createElement('canvas');
  private source = new THREE.Texture(this.canvas);

  add(texture: THREE.CanvasTexture, { x, y, width, height }: Rect) {
    if (texture !== this.texture) this.bounds.makeEmpty();
    this.texture = texture;
    this.bounds.expandByPoint(new THREE.Vector2(x, y));
    this.bounds.expandByPoint(new THREE.Vector2(x + width, y + height));
  }

  flush(renderer: THREE.WebGLRenderer, current?: THREE.Texture) {
    const texture = this.texture;
    this.texture = undefined;
    if (!texture || texture !== current) return;
    const { x, y } = this.bounds.min;
    const { x: width, y: height } = this.bounds.getSize(new THREE.Vector2());
    renderer.initTexture(texture);
    this.canvas.width = width;
    this.canvas.height = height;
    this.canvas.getContext('2d')!.drawImage(texture.image, x, y, width, height, 0, 0, width, height);
    // CPU-only patch source; no full readback or destination revision bump.
    renderer.copyTextureToTexture(this.source, texture, null,
      new THREE.Vector2(x, texture.flipY ? texture.image.height - y - height : y));
  }

  dispose() {
    this.texture = undefined;
    this.source.dispose();
    this.canvas.width = this.canvas.height = 1;
  }
}
