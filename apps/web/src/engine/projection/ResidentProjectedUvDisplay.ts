import * as THREE from 'three';
import type { Layer } from '@/types/layer';
import type { ModelLoadResult } from '@/engine/loaders/modelImportTypes';
import type { UvBakeResolution } from '@/engine/bake/uvBakeTypes';
import { getMergeUvPostprocessOptions } from '@/engine/layers/mergeUvComposition';
import {
  createWorkerBackedMaskPreviewTexture,
  createWorkerBackedPreviewTexture,
  uploadPreviewTextureInStripes,
  releaseTransientPreviewUploadSource,
} from '@/engine/viewport/previewTextureCache';
import { yieldToBrowserTask } from '@/utils/browserScheduling';
import { markSparseAlphaBaseTexture } from './ProjectedLayerMaterial';
import { ProjectedUvRasterCache } from '@/engine/bake/ProjectedUvRasterCache';
import { markResidentUvPending, finishResidentUvPresentation, releaseResidentUvManagement } from './residentUvPresentation';
import { ResidentUvCompressedCache } from './ResidentUvCompressedCache';
import { isLiveProjectedCanvasUrl } from './liveProjectedCanvasTextureRegistry';
import { getRegisteredObjectUrlBlob, revokeRegisteredObjectUrl } from '@/utils/blobUrlRegistry';

export type ProjectedPreviewComposite = {
  signature: string;
  resolution: number;
  colorTexture: THREE.Texture;
  renderedColorMaskTexture: THREE.Texture;
  layerIds: string[];
};
type Request = {
  projectId?: string;
  signature: string;
  renderer: THREE.WebGLRenderer;
  sourceModel: ModelLoadResult;
  sourceLayers: Layer[];
  underlayLayers?: Layer[];
  resolution: UvBakeResolution;
  onReady: (result: ProjectedPreviewComposite) => void;
  onError: (error: unknown) => void;
};

/** UV-DISPLAY-BUFFER/1.1.0. The display owns derived UV buffers, never layers/assets.
 * Use the same resident Top-K and exact postprocess path as explicit UV merge.
 * Keep the front buffer until its replacement has uploaded and been bound.
 */
export class ResidentProjectedUvDisplay {
  private requested?: Request;
  private active = false;
  private revision = 0;
  private disposed = false;
  private retries = 0;
  private retryAt = 0;
  private renderer?: THREE.WebGLRenderer;
  private readonly contextLost = () => {
    this.revision++;
    this.retries = 0;
    this.retryAt = 0;
    if (this.requested)
      markResidentUvPending(this.requested.sourceModel.group, this.requested.sourceModel.objectId);
    this.clearBuffers();
  };
  private front?: ProjectedPreviewComposite;
  private readonly cache = new Map<string, ProjectedPreviewComposite>();
  private readonly rasters = new ProjectedUvRasterCache();
  private readonly compressed = new ResidentUvCompressedCache();
  private readonly maskedSources = new Map<string, string>();
  private maskedSourceBytes = 0;

  request(request: Request) {
    if (this.disposed) return;
    if (this.renderer !== request.renderer) {
      this.renderer?.domElement.removeEventListener('webglcontextlost', this.contextLost);
      this.renderer = request.renderer;
      this.renderer.domElement.addEventListener('webglcontextlost', this.contextLost);
      this.clearBuffers();
    }
    if (this.requested?.signature === request.signature) return;
    if (this.requested && this.requested.sourceModel.group !== request.sourceModel.group)
      releaseResidentUvManagement(this.requested.sourceModel.group);
    this.requested = request;
    markResidentUvPending(request.sourceModel.group, request.sourceModel.objectId);
    this.retries = 0;
    this.retryAt = 0;
    this.revision++;
    const cached = this.cache.get(request.signature);
    if (cached) {
      this.cache.delete(request.signature);
      this.cache.set(request.signature, cached);
      if (cached === this.front) finishResidentUvPresentation(request.sourceModel.group);
      request.onReady(cached);
    }
  }

  step() {
    const request = this.requested;
    if (
      this.active ||
      !request ||
      this.disposed ||
      this.cache.has(request.signature) ||
      request.renderer.getContext().isContextLost() ||
      performance.now() < this.retryAt
    )
      return;
    this.active = true;
    const revision = this.revision;
    const cancelled = () => this.disposed || revision !== this.revision;
    const guard = () => {
      if (cancelled()) throw new DOMException('UV display superseded.', 'AbortError');
    };
    const startedAt = performance.now();
    const stages: Record<string, number> = {};
    const created: THREE.Texture[] = [];
    const transientSources: string[] = [];
    let sourcesClosed = false;
    document.body.dataset.residentUvProjectionStatus = 'computing';
    void (async () => {
      let persistentKey: string | undefined;
      let restored = await this.compressed.restore(request.signature);
      // Only the first presentation consults disk synchronously. Subsequent eye
      // changes must not wait for source hashing before GPU recomposition.
      const keyPromise = !restored && request.projectId ? import('@/engine/bake/persistentMergePreparation')
        .then(({ persistentMergeKey }) => persistentMergeKey({
          projectId: request.projectId!, objectId: request.sourceModel.objectId,
          resolution: request.resolution, group: request.sourceModel.group,
          layers: [...request.sourceLayers, ...(request.underlayLayers ?? [])].filter(layer => layer.visible && layer.opacity > 0),
          purpose: 'resident-uv-display-2',
        })).catch(() => undefined) : Promise.resolve(undefined);
      if (!restored && !this.front) {
        persistentKey = await keyPromise;
        guard();
        restored = await this.compressed.restore(request.signature, persistentKey);
      }
      guard();
      stages.cacheLookupMs = performance.now() - startedAt;
      const { bakeVisibleProjectedLayersToTexture } =
        await import('@/engine/bake/bakeProjectedLayerToTexture');
      guard();
      let sourceLayers = request.sourceLayers.filter(layer => layer.visible && layer.opacity > 0);
      const prepareStartedAt = performance.now();
      if (!restored) {
        const [{ prepareMergeProjectionLayers }, { createProjectionMaskedImage }] = await Promise.all([
          import('@/engine/bake/prepareMergeProjectionLayers'), import('./createMaskedProjectedImage'),
        ]);
        sourceLayers = await prepareMergeProjectionLayers(sourceLayers, async (image, mask, options) => {
          guard();
          const key = JSON.stringify([image, mask, options]);
          const cacheable = !isLiveProjectedCanvasUrl(image) && !isLiveProjectedCanvasUrl(mask);
          const cached = cacheable ? this.maskedSources.get(key) : undefined;
          if (cached) return cached;
          const url = await createProjectionMaskedImage(image, mask, options);
          if (sourcesClosed || cancelled()) {
            revokeRegisteredObjectUrl(url);
            throw new DOMException('UV source preparation superseded.', 'AbortError');
          }
          const bytes = getRegisteredObjectUrlBlob(url)?.size ?? Infinity;
          if (cacheable && !cancelled() && this.maskedSourceBytes + bytes <= 64 * 1024 * 1024 && this.maskedSources.size < 64) {
            this.maskedSources.set(key, url); this.maskedSourceBytes += bytes;
          } else transientSources.push(url);
          return url;
        });
        guard();
      }
      stages.maskPreparationMs = performance.now() - prepareStartedAt;
      const bakeStartedAt = performance.now();
      const result = restored
        ? {
            ...restored,
            report: {
              performanceBreakdown: { compressedUvRestoreMs: performance.now() - startedAt },
            },
          }
        : await bakeVisibleProjectedLayersToTexture({
            objectId: request.sourceModel.objectId,
            sourceModel: request.sourceModel,
            rasterCache: this.rasters,
            transientLayers: sourceLayers,
            resolution: request.resolution,
            enableBackfaceCulling: true,
            enableDilation: false,
            dilationPixels: 0,
            ...getMergeUvPostprocessOptions(request.resolution),
            repairMissingUvSeams: true,
            outputAlpha: 'transparent',
            commitToProject: false,
            markSourceLayersBaked: false,
            skipImageEncoding: true,
            skipCanvasUpload: true,
            checkCancelled: guard,
            onProgress: guard,
          });
      stages.completeBakeMs = performance.now() - bakeStartedAt;
      guard();
      if (!result.imageData) throw new Error('UV display calculation returned no pixels.');
      const mask = result.renderedColorMask;
      let hasRenderedColor = false;
      if (mask) {
        let sliceStarted = performance.now();
        const words = new Uint32Array(mask.buffer, mask.byteOffset, Math.floor(mask.length / 4));
        for (let i = 0; i < words.length; i++) {
          if (words[i] !== 0) {
            hasRenderedColor = true;
            break;
          }
          if (i % 262144 === 0 && performance.now() - sliceStarted >= 4) {
            guard();
            await yieldToBrowserTask();
            sliceStarted = performance.now();
          }
        }
        for (let i = words.length * 4; i < mask.length; i++) hasRenderedColor ||= mask[i] !== 0;
      }
      const underlayStartedAt = performance.now();
      if (!restored && request.underlayLayers?.length) {
        const { compositeRgbaUrlUnderWithWebGpu } = await import('@/engine/performance/webGpuRgbaComposite');
        for (const layer of request.underlayLayers) {
          guard();
          const rgba = result.imageData.data;
          // Preserve rendered-color attribution when albedo underneath adds coverage.
          const alpha = mask && hasRenderedColor ? new Uint8Array(mask.length) : undefined;
          if (alpha) for (let start = 0; start < alpha.length; start += 262144) {
            for (let i = start; i < Math.min(start + 262144, alpha.length); i++) alpha[i] = rgba[i * 4 + 3];
            await yieldToBrowserTask(); guard();
          }
          const combined = await compositeRgbaUrlUnderWithWebGpu(rgba, layer.imageUrl,
            request.resolution, request.resolution, layer.opacity);
          guard();
          result.imageData = new ImageData(combined.data, request.resolution, request.resolution);
          if (alpha && mask) for (let start = 0; start < alpha.length; start += 262144) {
            for (let i = start; i < Math.min(start + 262144, alpha.length); i++) {
              const coverage = combined.data[i * 4 + 3];
              mask[i] = coverage ? Math.round(mask[i] * alpha[i] / coverage) : 0;
            }
            await yieldToBrowserTask(); guard();
          }
        }
      }
      stages.underlayCompositeMs = performance.now() - underlayStartedAt;
      const uploadStartedAt = performance.now();
      const bitmap = await createImageBitmap(result.imageData, {
        imageOrientation: 'flipY',
        premultiplyAlpha: 'none',
      });
      if (cancelled()) {
        bitmap.close();
        guard();
      }
      const colorTexture = await createWorkerBackedPreviewTexture(bitmap);
      created.push(colorTexture);
      guard();
      // Establish the sparse base sampler profile before the stripe upload.
      // Changing it after upload reallocates a worker-owned DataTexture with no CPU pixels.
      markSparseAlphaBaseTexture(colorTexture);
      let renderedColorMaskTexture: THREE.Texture;
      if (mask && hasRenderedColor) {
        renderedColorMaskTexture = await createWorkerBackedMaskPreviewTexture(
          mask,
          request.resolution,
          request.resolution,
        );
      } else {
        renderedColorMaskTexture = new THREE.DataTexture(
          new Uint8Array([0]),
          1,
          1,
          THREE.RedFormat,
        );
        renderedColorMaskTexture.needsUpdate = true;
      }
      created.push(renderedColorMaskTexture);
      renderedColorMaskTexture.colorSpace = THREE.NoColorSpace;
      guard();
      await uploadPreviewTextureInStripes(request.renderer, colorTexture, {
        shouldCancel: cancelled,
      });
      await uploadPreviewTextureInStripes(request.renderer, renderedColorMaskTexture, {
        shouldCancel: cancelled,
      });
      guard();
      releaseTransientPreviewUploadSource(request.renderer, colorTexture);
      releaseTransientPreviewUploadSource(request.renderer, renderedColorMaskTexture);
      const buffer = {
        signature: request.signature,
        resolution: request.resolution,
        colorTexture,
        renderedColorMaskTexture,
        layerIds: request.sourceLayers
          .filter((layer) => layer.visible && layer.opacity > 0)
          .map((layer) => layer.id),
      };
      this.cache.set(request.signature, buffer);
      created.length = 0;
      stages.displayUploadMs = performance.now() - uploadStartedAt;
      document.body.dataset.residentUvProjectionDurationMs = (
        performance.now() - startedAt
      ).toFixed(1);
      document.body.dataset.residentUvProjectionStages = JSON.stringify(
        { ...result.report.performanceBreakdown, ...stages },
      );
      request.onReady(buffer);
      if (!restored) {
        void keyPromise.then(key => {
          if (!cancelled()) this.compressed.offer(request.signature, result.imageData!, result.renderedColorMask, key);
        });
      }
    })()
      .catch((error) => {
        created.forEach((texture) => texture.dispose());
        if (!cancelled()) {
          if (++this.retries < 3) this.retryAt = performance.now() + 500;
          else {
            this.retryAt = Infinity;
            markResidentUvPending(request.sourceModel.group, request.sourceModel.objectId, error);
            document.body.dataset.residentUvProjectionStatus = 'error';
            request.onError(error);
          }
        }
      })
      .finally(() => {
        sourcesClosed = true;
        transientSources.forEach(revokeRegisteredObjectUrl);
        this.active = false;
      });
  }

  hasPendingWork(signature: string) {
    return Boolean(
      !this.disposed &&
        this.requested?.signature === signature &&
        !this.cache.has(signature) &&
        this.retryAt !== Infinity,
    );
  }

  acknowledgePresentation(texture: THREE.Texture) {
    const buffer = [...this.cache.values()].find((value) => value.colorTexture === texture);
    if (!buffer) return;
    this.front = buffer;
    this.compressed.activate(buffer.signature);
    if (this.requested?.signature === buffer.signature)
      finishResidentUvPresentation(this.requested.sourceModel.group);
    // Upload bitmaps have been released; account for actual GPU dimensions,
    // including the single-pixel mask used by ordinary BaseColor stacks.
    const size = (value: ProjectedPreviewComposite) =>
      value.resolution ** 2 * 4 +
      value.renderedColorMaskTexture.image.width * value.renderedColorMaskTexture.image.height;
    let bytes = [...this.cache.values()].reduce((total, value) => total + size(value), 0);
    for (const [key, value] of this.cache) {
      if (bytes <= 512 * 1024 * 1024 && this.cache.size <= 32) break;
      if (value === this.front || key === this.requested?.signature) continue;
      bytes -= size(value);
      value.colorTexture.dispose();
      value.renderedColorMaskTexture.dispose();
      this.cache.delete(key);
    }
  }
  cancelPending() {
    if (this.requested) releaseResidentUvManagement(this.requested.sourceModel.group);
    this.revision++;
    this.requested = undefined;
  }
  dispose() {
    this.disposed = true;
    this.cancelPending();
    this.renderer?.domElement.removeEventListener('webglcontextlost', this.contextLost);
    this.rasters.dispose();
    this.compressed.dispose();
    this.maskedSources.forEach(revokeRegisteredObjectUrl);
    this.maskedSources.clear(); this.maskedSourceBytes = 0;
    this.clearBuffers();
  }
  private clearBuffers() {
    for (const value of this.cache.values()) {
      value.colorTexture.dispose();
      value.renderedColorMaskTexture.dispose();
    }
    this.cache.clear();
    this.front = undefined;
  }
}
