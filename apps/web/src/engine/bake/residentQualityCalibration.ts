import * as THREE from 'three';
import { ResidentQualityComposite, residentQualityPolicy, verifyResidentQuality, prepareResidentQualityScores } from './residentQualityComposite';
import { yieldToBrowserTask } from '@/utils/browserScheduling';
import { blendProjectedRastersInWorker } from './qualityBlendWorker';
import { convertLayerGpuReadbackInWorker } from './gpuReadbackConversionWorker';

const pending = new WeakMap<THREE.WebGLRenderer, Map<boolean | 'display', Promise<void>>>();

/** UV-DEVICE-CALIBRATION/1.1.1. Validate both R8/RGBA on the actual renderer; never trust a
 * persisted adapter name. Full-project CPU/GPU comparisons remain release QA.
 */
export async function calibrateResidentQuality(renderer: THREE.WebGLRenderer, preserveAlpha: boolean | 'display') {
  const policy = residentQualityPolicy(renderer, preserveAlpha);
  if (!policy?.retainRasters || new URLSearchParams(location.search).get('perfQualityGpuAb') === '1') return;
  let modes = pending.get(renderer);
  if (!modes) {
    modes = new Map(); pending.set(renderer, modes);
    renderer.domElement.addEventListener('webglcontextlost', () => pending.delete(renderer), { once: true });
  }
  let job = modes.get(preserveAlpha);
  if (!job) {
    const owner = modes;
    job = (async () => {
      await prepareResidentQualityScores();
      const started = performance.now(), resolution = 256, count = resolution ** 2;
      const composite = new ResidentQualityComposite(renderer, resolution);
      const textures: THREE.Texture[] = [];
      const layers = [];
      let sliceStarted=performance.now();
      try {
        for (let layer = 0; layer < 6; layer++) {
          const red = layer % 2 === 0;
          const rgba = new Uint8Array(count * 4), scores = new Uint8Array(count * (red ? 1 : 4));
          const color = new Uint8ClampedArray(count * 4), quality = new Float32Array(count);
          for (let i = 0; i < count; i++) {
            const alpha = layer === 0 ? i & 255 : (i * (layer * 2 + 1) + layer * 31) & 255;
            const q = layer === 0 ? i >>> 8 : ((i >>> 8) * (layer + 1) + layer * 17) & 255;
            const offset = i * 4, target = ((resolution - 1 - (i >>> 8)) * resolution + (i & 255)) * 4;
            for (let c = 0; c < 3; c++) {
              const value = Math.floor(((i * (c * 12 + 7) + layer * 59) & 255) * alpha / 255);
              rgba[offset + c] = value;
              color[target + c] = alpha ? Math.min(255, Math.round(value / (alpha / 255))) : 0;
            }
            rgba[offset + 3] = color[target + 3] = alpha;
            scores[red ? i : offset + 3] = q; quality[target / 4] = q / 255;
            if(i%8192===0 && performance.now()-sliceStarted>=4) {
              await yieldToBrowserTask();sliceStarted=performance.now();
            }
          }
          const image = new THREE.DataTexture(rgba, resolution, resolution);
          const score = new THREE.DataTexture(scores, resolution, resolution, red ? THREE.RedFormat : THREE.RGBAFormat);
          image.needsUpdate = score.needsUpdate = true;
          textures.push(image, score); composite.push(image, score);
          layers.push({ color, quality });
          await yieldToBrowserTask();sliceStarted=performance.now();
        }
        const { output } = await composite.readCorrected(preserveAlpha);
        const candidate = await convertLayerGpuReadbackInWorker(new Uint8Array(output.buffer, output.byteOffset, output.byteLength), resolution, true);
        const reference = await blendProjectedRastersInWorker(layers, resolution, preserveAlpha, [], true);
        if (pending.get(renderer) !== owner || renderer.getContext().isContextLost()) {
          throw new DOMException('UV calibration context changed.', 'AbortError');
        }
        await verifyResidentQuality(renderer, preserveAlpha, { ...reference, imageData: candidate.imageData }, reference);
        document.body.dataset.residentUvDeviceCalibrationMs = (performance.now() - started).toFixed(1);
      } finally {
        composite.dispose(); textures.forEach(texture => texture.dispose());
      }
    })();
    modes.set(preserveAlpha, job);
  }
  await job;
}
