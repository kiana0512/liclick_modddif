import * as THREE from 'three';
import { createWorkerBackedPreviewTexture, releaseTransientPreviewUploadSource,
  uploadPreviewTextureInStripes } from '@/engine/viewport/previewTextureCache';
import { yieldToBrowserTask } from '@/utils/browserScheduling';
import { markSparseAlphaBaseTexture } from './ProjectedLayerMaterial';

/** Publish a new front buffer atomically; never edit the displayed/authored texture. */
export async function uploadUvDisplayPatch(renderer: THREE.WebGLRenderer, image: ImageData,
  previous: { image: ImageData; texture: THREE.Texture }, cancelled: () => boolean) {
  const { width, height } = image;
  const guard = () => { if (cancelled()) throw new DOMException('UV patch superseded.', 'AbortError'); };
  if (previous.image.width !== width || previous.image.height !== height) return;
  const a = new Uint32Array(image.data.buffer, image.data.byteOffset, width * height);
  const b = new Uint32Array(previous.image.data.buffer, previous.image.data.byteOffset, width * height);
  let left = width, right = 0, top = height, bottom = 0, started = performance.now();
  for (let y = 0; y < height; y++) {
    const start = y * width;
    for (let x = 0; x < width; x++) if (a[start + x] !== b[start + x]) {
      left = Math.min(left, x); right = Math.max(right, x + 1);
      top = Math.min(top, y); bottom = y + 1;
    }
    if (performance.now() - started >= 4) { await yieldToBrowserTask(); guard(); started = performance.now(); }
  }
  guard();
  const target = new THREE.WebGLRenderTarget(width, height, { depthBuffer: false, generateMipmaps: false });
  markSparseAlphaBaseTexture(target.texture);
  // All existing display owners release textures. Forward that lifetime to its framebuffer.
  target.texture.addEventListener('dispose', () => target.dispose());
  let patch: THREE.Texture | undefined;
  try {
    if (left < right) {
      const w = right - left, h = bottom - top, data = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) data.set(image.data.subarray(((top + y) * width + left) * 4,
        ((top + y) * width + right) * 4), y * w * 4);
      patch = await createWorkerBackedPreviewTexture(new ImageData(data, w, h));
      markSparseAlphaBaseTexture(patch);
      await uploadPreviewTextureInStripes(renderer, patch, { allowWhileInteracting: true, shouldCancel: cancelled });
      guard();
    }
    const old = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
    const viewport = renderer.getViewport(new THREE.Vector4()), scissor = renderer.getScissor(new THREE.Vector4());
    const scissorTest = renderer.getScissorTest();
    try {
      renderer.setRenderTarget(target);
      renderer.copyTextureToTexture(previous.texture, target.texture);
      if (patch) renderer.copyTextureToTexture(patch, target.texture, null, new THREE.Vector2(left, height - bottom));
    } finally {
      renderer.setRenderTarget(old, face, mip); renderer.setViewport(viewport);
      renderer.setScissor(scissor); renderer.setScissorTest(scissorTest);
    }
    document.body.dataset.residentUvDisplayUploadedTexels = String(left < right ? (right - left) * (bottom - top) : 0);
    return target.texture;
  } catch (error) { target.texture.dispose(); throw error; }
  finally { if (patch) { releaseTransientPreviewUploadSource(renderer, patch); patch.dispose(); } }
}
