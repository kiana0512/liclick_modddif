import * as THREE from 'three';
import type { Layer } from '@/types/layer';
import type { ModelLoadResult } from '@/engine/loaders/modelImportTypes';
import type { UvBakeResolution } from '@/engine/bake/uvBakeTypes';
import { eraserBakeRegion, type RawUvComposite } from '@/engine/bake/incrementalUvComposite';
import { uploadUvDisplayPatch } from './uploadUvDisplayPatch';
import { getMergeUvPostprocessOptions } from '@/engine/layers/mergeUvComposition';
import {
  createWorkerBackedMaskPreviewTexture,
  createWorkerBackedPreviewTexture,
  uploadPreviewTextureInStripes,
  releaseTransientPreviewUploadSource,
  type PreviewTextureUploadTimings,
} from '@/engine/viewport/previewTextureCache';
import { waitForBrowserPaint, yieldToBrowserTask } from '@/utils/browserScheduling';
import { isViewportInteractionBusy, waitForViewportInteractionIdle } from '@/engine/viewport/viewportInteractionState';
import { uploadUvRgba } from '@/engine/bake/uvContributionTiles';
import { markSparseAlphaBaseTexture } from './ProjectedLayerMaterial';
import { ProjectedUvRasterCache } from '@/engine/bake/ProjectedUvRasterCache';
import { markResidentUvPending, finishResidentUvPresentation, releaseResidentUvManagement } from './residentUvPresentation';
import { ResidentUvCompressedCache } from './ResidentUvCompressedCache';
import { isLiveProjectedCanvasUrl, registerLiveProjectedCanvasTexture, releaseLiveProjectedCanvasTexture, getLiveProjectedCanvasState } from './liveProjectedCanvasTextureRegistry';
import type { ResidentUvMaskBinding } from './residentUvPresentation';
import { getEraserUvDraft } from '@/engine/paint/eraserUvDraft';
import { getLiveSurfacePaintPreview } from '@/engine/paint/liveSurfacePaintPreviewRegistry';
import { getRegisteredObjectUrlBlob, revokeRegisteredObjectUrl } from '@/utils/blobUrlRegistry';

export type ProjectedPreviewComposite = {
  signature: string;
  resolution: number;
  colorTexture: THREE.Texture;
  renderedColorMaskTexture: THREE.Texture;
  layerIds: string[];
  interactive?: boolean;
  maskBindings?: ResidentUvMaskBinding[];
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

let projectedUvBakeKernelPromise:
  | Promise<typeof import('@/engine/bake/bakeProjectedLayerToTexture')>
  | undefined;

/** Decode/parse the exact UV kernel before the first eye interaction. */
export function preloadProjectedUvBakeKernel() {
  projectedUvBakeKernelPromise ??= import('@/engine/bake/bakeProjectedLayerToTexture').catch(
    (error) => {
      projectedUvBakeKernelPromise = undefined;
      throw error;
    },
  );
  return projectedUvBakeKernelPromise;
}

/** UV-DISPLAY-BUFFER/1.5.2. The display owns derived UV buffers, never layers/assets.
 * Use resident Top-K and gutter; seam repair is disabled by default for display.
 * Keep the front buffer until its replacement has uploaded and been bound.
 */
export class ResidentProjectedUvDisplay {
  // Local opt-in comparison; fixed for this instance so its memory caches agree.
  private readonly skipUvSeams = !(typeof window !== 'undefined' &&
    ['127.0.0.1', 'localhost'].includes(window.location.hostname) &&
    new URLSearchParams(window.location.search).get('skipUvSeams') === '0');
  private requested?: Request;
  private active = false;
  private underlayAbort?: AbortController;
  private interactiveOnly = false;
  private revision = 0;
  private disposed = false;
  private retries = 0;
  private retryAt = 0;
  private renderer?: THREE.WebGLRenderer;
  private readonly contextLost = () => {
    this.revision++;
    this.underlayAbort?.abort();
    this.retries = 0;
    this.retryAt = 0;
    if (this.requested)
      markResidentUvPending(this.requested.sourceModel.group, this.requested.sourceModel.objectId);
    this.clearBuffers();
  };
  private front?: ProjectedPreviewComposite;
  private persistAfterPresentation?: { texture: THREE.Texture; run: () => void };
  private rawComposite?: RawUvComposite;
  private previousPixels?: { image: ImageData; texture: THREE.Texture };
  private readonly cache = new Map<string, ProjectedPreviewComposite>();
  private readonly rasters = new ProjectedUvRasterCache(512 * 1024 * 1024, true);
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
    this.underlayAbort?.abort();
    if (this.requested && this.requested.sourceModel.group !== request.sourceModel.group)
      releaseResidentUvManagement(this.requested.sourceModel.group);
    this.requested = request;
    this.persistAfterPresentation = undefined;
    this.rawComposite = undefined;
    markResidentUvPending(request.sourceModel.group, request.sourceModel.objectId);
    this.retries = 0;
    this.retryAt = 0;
    this.revision++;
    const cached = this.cache.get(request.signature);
    document.body.dataset.residentUvProjectionCacheHit = String(Boolean(cached));
    if (cached) {
      this.cache.delete(request.signature);
      this.cache.set(request.signature, cached);
      if (cached === this.front) finishResidentUvPresentation(request.sourceModel.group);
      request.onReady(cached);
    }
  }

  step(interactiveOnly = false) {
    // Remember the latest camera gate even while a superseded job drains.
    this.interactiveOnly = interactiveOnly;
    const original = this.requested;
    if (
      this.active ||
      !original ||
      this.disposed ||
      original.renderer.getContext().isContextLost() ||
      performance.now() < this.retryAt
    )
      return;
    const candidate = getEraserUvDraft();
    const draft = candidate?.owner.target === 'projected-mask' &&
      candidate.owner.objectId === original.sourceModel.objectId &&
      original.sourceLayers.some(layer => layer.id === candidate.owner.layerId && layer.visible && layer.opacity > 0)
      ? candidate : undefined;
    const interactive = Boolean(draft && draft.revision > 0);
    const fastPreview = getLiveSurfacePaintPreview();
    if (interactive && fastPreview?.displayArmed &&
      fastPreview.target === 'projected-mask' &&
      fastPreview.objectId === original.sourceModel.objectId &&
      fastPreview.layerId === draft!.owner.layerId) return;
    draft?.flush();
    if (interactiveOnly && !interactive) return;
    const key = interactive ? `${original.signature}:eraser:${draft!.id}:${draft!.revision}` : original.signature;
    const cached = this.cache.get(key);
    if (cached) {
      // Cancellation/failed commits may leave the authored signature unchanged.
      // Restore its cached buffer instead of leaving an abandoned draft visible.
      if (!interactive && this.front?.interactive) original.onReady(cached);
      return;
    }
    const snapshot = interactive ? draft!.snapshot() : undefined;
    const draftRevision = draft?.revision ?? 0;
    const region = interactive && this.rawComposite
      ? eraserBakeRegion(draft!.pendingBounds(), original.resolution) : undefined;
    const snapshotUrl = snapshot ? registerLiveProjectedCanvasTexture(key, snapshot) : undefined;
    const request = snapshotUrl ? { ...original, projectId: undefined,
      sourceLayers: original.sourceLayers.map(layer => layer.id === draft!.owner.layerId
        ? { ...layer, maskUrl: snapshotUrl, maskSpace: 'uv' as const } : layer),
    } : original;
    if (interactive) markResidentUvPending(original.sourceModel.group, original.sourceModel.objectId);
    this.active = true;
    const revision = this.revision;
    const cancelled = () => {
      const latestDraft = getEraserUvDraft();
      const latestPreview = getLiveSurfacePaintPreview();
      return this.disposed || revision !== this.revision ||
        (interactive ? latestDraft !== draft : Boolean(
          latestDraft?.revision && latestPreview?.displayArmed &&
          latestPreview.target === 'projected-mask' &&
          latestPreview.objectId === original.sourceModel.objectId &&
          latestPreview.layerId === latestDraft.owner.layerId));
    };
    const guard = () => {
      if (cancelled()) throw new DOMException('UV display superseded.', 'AbortError');
    };
    const startedAt = performance.now();
    const maskBindings = request.sourceLayers.flatMap(layer => layer.maskUrl ? [{
      layerId: layer.id, url: layer.maskUrl, revision: getLiveProjectedCanvasState(layer.maskUrl)?.revision,
    }] : []);
    const stages: Record<string, number> = {};
    const created: THREE.Texture[] = [];
    const transientSources: string[] = [];
    let sourcesClosed = false;
    document.body.dataset.residentUvProjectionStatus = 'computing';
    document.body.dataset.residentUvSeamMode = this.skipUvSeams ? 'skipped' : 'enabled-local-test';
    void (async () => {
      let persistentKey: string | undefined;
      let restored = interactive ? undefined : await this.compressed.restore(request.signature);
      // Preserve the original verification snapshot timing. Only the first
      // presentation waits for disk; optional cache publication waits for binding.
      const keyPromise = !restored && request.projectId ? import('@/engine/bake/persistentMergePreparation')
        .then(({ persistentMergeKey }) => persistentMergeKey({
          projectId: request.projectId!, objectId: request.sourceModel.objectId,
          resolution: request.resolution, group: request.sourceModel.group,
          layers: [...request.sourceLayers, ...(request.underlayLayers ?? [])].filter(layer => layer.visible && layer.opacity > 0),
          purpose: this.skipUvSeams ? 'resident-uv-display-4-no-seams' : 'resident-uv-display-4',
        })).catch(() => undefined) : Promise.resolve(undefined);
      if (!interactive && !restored && !this.front) {
        persistentKey = await keyPromise;
        guard();
        restored = await this.compressed.restore(request.signature, persistentKey);
      }
      guard();
      stages.cacheLookupMs = performance.now() - startedAt;
      const { bakeVisibleProjectedLayersToTexture } = await preloadProjectedUvBakeKernel();
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
            repairMissingUvSeams: !this.skipUvSeams,
            outputAlpha: 'transparent',
            commitToProject: false,
            markSourceLayersBaked: false,
            skipImageEncoding: true,
            skipCanvasUpload: true,
            allowWhileInteracting: interactive,
            retainRawComposite: request.resolution <= 2048,
            incrementalUv: region && this.rawComposite ? { region, base: this.rawComposite } : undefined,
            checkCancelled: guard,
            onProgress: guard,
          });
      stages.completeBakeMs = performance.now() - bakeStartedAt;
      guard();
      if (!result.imageData) throw new Error('UV display calculation returned no pixels.');
      if ('rawComposite' in result && result.rawComposite) this.rawComposite = result.rawComposite;
      // Empty is the canonical all-zero mask for ordinary BaseColor stacks.
      // Avoid both a 4K main-thread scan and a needless R8 upload in that case.
      const mask = result.renderedColorMask?.length ? result.renderedColorMask : undefined;
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
        guard();
        const abort = this.underlayAbort = new AbortController();
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
            request.resolution, request.resolution, layer.opacity, abort.signal, false,
            JSON.stringify([layer.id, layer.contentRevision ?? 0]));
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
      const uploadTimings: PreviewTextureUploadTimings = {
        allocationMs: 0, stripeWaitMs: 0, submitMs: 0,
        interactionWaitMs: 0, yieldMs: 0, presentationWaitMs: 0,
      };
      const previousPixels = this.previousPixels?.texture === this.front?.colorTexture ? this.previousPixels : undefined;
      const patched = interactive && previousPixels
        ? await uploadUvDisplayPatch(request.renderer, result.imageData, previousPixels, cancelled) : undefined;
      if (patched) created.push(patched);
      // A full interactive upload transfers its input. Keep one independent CPU
      // mirror only at <=2K; patch uploads transfer only the small extracted region.
      const retainedImage = request.resolution <= 2048
        ? !patched ? new ImageData(result.imageData.data.slice(), request.resolution, request.resolution)
          : result.imageData : undefined;
      // Draft pixels have no persistence/cache consumers. Transfer them directly
      // to the stripe worker instead of creating and cropping a full-size bitmap.
      const direct = !interactive ? await uploadUvRgba(request.renderer,result.imageData.data,
        request.resolution,request.resolution,{flipRows:true,check:guard,
          beforeStripe:()=>waitForViewportInteractionIdle(240,guard),configure:texture=>{
            texture.anisotropy=8;markSparseAlphaBaseTexture(texture);
          }}) : undefined;
      const colorTexture = patched ?? direct ?? await createWorkerBackedPreviewTexture(result.imageData);
      if (!patched) created.push(colorTexture);
      guard();
      // Establish the sparse base sampler profile before the stripe upload.
      // Changing it after upload reallocates a worker-owned DataTexture with no CPU pixels.
      if (!direct) markSparseAlphaBaseTexture(colorTexture);
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
      stages.displayUploadPrepareMs = performance.now() - uploadStartedAt;
      if (!patched && !direct) await uploadPreviewTextureInStripes(request.renderer, colorTexture, {
        allowWhileInteracting: interactive,
        shouldCancel: cancelled,
        deferVisiblePresentationBarrier: !interactive,
        timings: uploadTimings,
      });
      await uploadPreviewTextureInStripes(request.renderer, renderedColorMaskTexture, {
        allowWhileInteracting: interactive,
        shouldCancel: cancelled,
        deferVisiblePresentationBarrier: !interactive,
        timings: uploadTimings,
      });
      guard();
      // Both private textures share the renderer's ordered command stream.
      // Pay the existing presentation barrier once, then publish them together.
      if (!interactive && request.renderer.domElement.isConnected) {
        for (let frame = 0; frame < 2; frame++) {
          const paintStarted = performance.now();
          await waitForBrowserPaint();
          uploadTimings.presentationWaitMs += performance.now() - paintStarted;
          guard();
          const idleStarted = performance.now();
          await waitForViewportInteractionIdle(240, guard);
          uploadTimings.interactionWaitMs += performance.now() - idleStarted;
          guard();
        }
      }
      this.previousPixels = retainedImage ? { image: retainedImage, texture: colorTexture } : undefined;
      draft?.acknowledge(draftRevision);
      releaseTransientPreviewUploadSource(request.renderer, colorTexture);
      releaseTransientPreviewUploadSource(request.renderer, renderedColorMaskTexture);
      const buffer = {
        signature: request.signature,
        resolution: request.resolution,
        colorTexture,
        renderedColorMaskTexture,
        interactive,
        maskBindings,
        layerIds: request.sourceLayers
          .filter((layer) => layer.visible && layer.opacity > 0)
          .map((layer) => layer.id),
      };
      this.cache.set(key, buffer);
      created.length = 0;
      stages.displayUploadMs = performance.now() - uploadStartedAt;
      for (const [name, elapsed] of Object.entries(uploadTimings)) {
        stages[`displayUpload${name[0].toUpperCase()}${name.slice(1)}`] = elapsed;
      }
      stages.displayUploadOtherMs = Math.max(0, stages.displayUploadMs - stages.displayUploadPrepareMs -
        Object.values(uploadTimings).reduce((sum, elapsed) => sum + elapsed, 0));
      document.body.dataset.residentUvProjectionDurationMs = (
        performance.now() - startedAt
      ).toFixed(1);
      document.body.dataset.residentUvProjectionStages = JSON.stringify(
        { ...result.report.performanceBreakdown, ...stages },
      );
      if (!interactive && !restored) {
        this.persistAfterPresentation = { texture: colorTexture, run: () => {
          void yieldToBrowserTask().then(() => {
            if (cancelled()) return undefined;
            return persistentKey ?? keyPromise;
          }).then(key => {
            if (!cancelled()) this.compressed.offer(request.signature, result.imageData!, result.renderedColorMask, key);
          }).catch(() => undefined);
        } };
      }
      request.onReady(buffer);
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
        this.underlayAbort = undefined;
        if (snapshot && snapshotUrl) {
          releaseLiveProjectedCanvasTexture(snapshotUrl, snapshot);
          snapshot.width = snapshot.height = 1;
        }
        // Latest-wins queue: finish one immutable snapshot instead of repeatedly
        // cancelling it on mousemove. A newer gesture revision runs next.
        if (revision !== this.revision || (interactive && !cancelled()))
          queueMicrotask(() => this.step(this.interactiveOnly ||
            (document.visibilityState === 'visible' && isViewportInteractionBusy())));
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
    const persistence = this.persistAfterPresentation;
    if (persistence?.texture === texture) {
      this.persistAfterPresentation = undefined;
      persistence.run();
    }
    if (!buffer.interactive) this.compressed.activate(buffer.signature);
    if (!buffer.interactive && this.requested?.signature === buffer.signature)
      finishResidentUvPresentation(this.requested.sourceModel.group, buffer.maskBindings);
    // Upload bitmaps have been released; account for actual GPU dimensions,
    // including the single-pixel mask used by ordinary BaseColor stacks.
    const size = (value: ProjectedPreviewComposite) =>
      value.resolution ** 2 * 4 +
      value.renderedColorMaskTexture.image.width * value.renderedColorMaskTexture.image.height;
    let bytes = [...this.cache.values()].reduce((total, value) => total + size(value), 0);
    for (const [key, value] of this.cache) {
      if (value.interactive && value !== this.front) {
        bytes -= size(value);
        value.colorTexture.dispose(); value.renderedColorMaskTexture.dispose();
        this.cache.delete(key);
        continue;
      }
    }
    for (const [key, value] of this.cache) {
      if (bytes <= 256 * 1024 * 1024 && this.cache.size <= 32) break;
      if (value === this.front || key === this.requested?.signature) continue;
      bytes -= size(value);
      value.colorTexture.dispose();
      value.renderedColorMaskTexture.dispose();
      this.cache.delete(key);
    }
  }
  cancelPending() {
    this.underlayAbort?.abort();
    this.persistAfterPresentation = undefined;
    this.rawComposite = undefined;
    this.previousPixels = undefined;
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
    this.persistAfterPresentation = undefined;
    this.rawComposite = undefined;
    this.previousPixels = undefined;
    for (const value of this.cache.values()) {
      value.colorTexture.dispose();
      value.renderedColorMaskTexture.dispose();
    }
    this.cache.clear();
    this.front = undefined;
  }
}
