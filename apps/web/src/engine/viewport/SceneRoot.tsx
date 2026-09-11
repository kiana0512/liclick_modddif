import { useFrame, useThree } from '@react-three/fiber';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { compileForRenderTarget } from '@/engine/projection/compileForRenderTarget';
import { isResidentProjectedMaterial } from '@/engine/projection/projectedMaterialIdentity';
import { isProjectedUniformBudgetSafe } from '@/engine/projection/projectedUniformBudget';
import { projectionDisplayCapacity, publishPendingProjectionLayers } from '@/engine/projection/projectionDisplayAdmission';
import { useShallow } from 'zustand/react/shallow';
import {
  createDisplayModeMaterial,
  createFlatPreviewMaterial,
  createPbrPreviewMaterial,
  createProjectedLayerStackMaterial,
  createProjectedLayerStackProgramWarmupMaterial,
  createUvOverlayPreviewMaterial,
  disposeGeneratedMaterialTree,
  getProjectedLayerSamplerBudget,
  isProjectedTextureArrayCircuitOpenError,
  markSparseAlphaBaseTexture,
  syncProjectedLayerMaterialDisplayState,
  syncProjectedLayerMaterialDisplayStateInObject,
  syncProjectedLayerLiveEraserPreviewInObject,
  syncProjectedLayerMaterialProjection,
  syncProjectedLayerResidentTextureVisibilityInObject,
  updateProjectedLayerStackMaterial,
  updateUvOverlayPreviewMaterial,
} from '@/engine/projection/ProjectedLayerMaterial';
import {
  ProjectedLayerPreviewCompositor,
  type ProjectedPreviewComposite,
} from '@/engine/projection/ProjectedLayerPreviewCompositor';
import {
  getLiveProjectedCanvasState,
  getLiveProjectedCanvasTexture,
  getLiveProjectedTexture,
  isLiveProjectedCanvasUrl,
} from '@/engine/projection/liveProjectedCanvasTextureRegistry';
import {
  getLiveSurfacePaintPreview,
  useLiveSurfacePaintPreview,
  type LiveSurfacePaintPreview,
} from '@/engine/paint/liveSurfacePaintPreviewRegistry';
import {
  createRuntimeProjectionDepth,
  prepareRuntimeProjectionVisibilityMaterials,
} from '@/engine/projection/createRuntimeProjectionDepth';
import {
  compareUvLayersForComposition,
  getVisibleUvLayerStack,
} from '@/engine/layers/uvLayerComposition';
import {
  canCompositeUvLayersInWorker,
  cancelUvLayerCompositions,
  compositeUvLayerUrlsInWorker,
  compositeUvLayersInWorker,
} from '@/engine/layers/uvLayerCompositeWorker';
import {
  markPerformanceEvent,
  startPerformanceSpan,
} from '@/engine/performance/performanceTimeline';
import {
  canUseLayerStackCache,
  findExactLayerStackTexture,
  getProjectedLayerStackSignature,
  getVisibleProjectedLayerStack,
} from '@/engine/bake/layerStackCache';
import { useLayerStore } from '@/stores/layerStore';
import { useWorkspaceLayoutStore } from '@/components/workspace/workspaceLayoutStore';
import { translations, useI18nStore } from '@/stores/i18nStore';
import {
  scheduleCurrentProjectActiveObjectPersistence,
  useProjectStore,
} from '@/stores/projectStore';
import { useSceneStore } from '@/stores/sceneStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToastStore } from '@/stores/toastStore';
import { createId } from '@/utils/id';
import { Grid } from './Grid';
import { resolveLocalRepaintPreviewActivation } from './localRepaintPreviewActivation';
import { mergeAuthoritativeLocalRepaintLayers } from './projectedPreviewLayerAuthority';
import { shouldMuteLocalRepaintResidentLayer } from '@/engine/localRepaint/orderedPreviewComposition';
import { ObjectTransformControls } from './ObjectTransformControls';
import {
  isViewportInteractionBusy as isSharedViewportInteractionBusy,
  markViewportInteractionActivity,
} from './viewportInteractionState';
import { getTransientLocalRepaintLayerId } from './localRepaintResidentHandoff';
import {
  createWorkerBackedPreviewTexture,
  getReadyResidentPreviewTexture,
  loadPreviewTexture,
  retainPreviewTexture,
  prewarmPreviewTextures,
  uploadPreviewTextureInStripes,
  waitForPreviewTextureUploadsIdle,
} from './previewTextureCache';
import type { ModelLoadResult } from '@/engine/loaders/modelImportTypes';
import type {
  ProjectionLayerDisplayInput,
  ProjectionLayerStackInput,
} from '@/engine/projection/projectionTypes';
import type { Layer } from '@/types/layer';
import type { Capture } from '@/types/capture';
import { usesUnlitRenderedColor } from './renderedLayerColor';
import { getPreviewLighting } from './previewLighting';
import { isPerformanceLabEnabled } from '@/dev/performanceLabPolicy';

const RESOLUTION_TO_SIZE = {
  '1K': 1024,
  '2K': 2048,
  '4K': 4096,
  '8K': 8192,
} as const;

const MAX_IMAGE_ELEMENT_CACHE_SIZE = 32;
// With three merged UV layers the normal eye-toggle working set is four
// combinations (base, base+2, base+3, all). Keeping that exact set resident
// avoids re-composing and re-uploading a 4K texture during rapid toggles.
const MAX_COMPOSITED_UV_TEXTURE_CACHE_SIZE = 4;
const MAX_RESIDENT_UV_TOGGLE_TEXTURES = 6;
const imageElementCache = new Map<string, Promise<HTMLImageElement>>();
const PROJECTED_PREVIEW_LIMIT_TOAST_KEY = 'projected-preview:sampler-limit';
const RUNTIME_PROJECTION_PREVIEW_MAX_SIDE = 1024;
// Keep a safety margin below the advertised fragment-sampler limit. A projected
// layer can consume color, depth and normal samplers, while a UV/local-repaint
// layer adds another sampler. Some WebGL2 drivers fail to link that direct shader
// before the nominal 16-unit ceiling is reached. Switch as soon as the safety
// boundary is reached, so the fourth fully sampled projection uses arrays instead
// of attempting an unstable 12-sampler direct material.
const PROJECTED_ARRAY_DIRECT_SAMPLER_HEADROOM_RATIO = 0.75;

// All model roots share one WebGL renderer. During a cold multi-model restore
// they also request the same projected shader shape at nearly the same time.
// Compiling every shape concurrently makes ANGLE/driver polling monopolize the
// main thread even though texture contents and camera matrices are uniforms.
// Keep exactly one in-flight warmup per renderer + shader structure.
const projectedProgramWarmupsByRenderer = new WeakMap<
  THREE.WebGLRenderer,
  Map<string, Promise<void>>
>();

function getProjectedProgramWarmupMap(renderer: THREE.WebGLRenderer) {
  let warmups = projectedProgramWarmupsByRenderer.get(renderer);
  if (!warmups) {
    warmups = new Map<string, Promise<void>>();
    projectedProgramWarmupsByRenderer.set(renderer, warmups);
  }
  return warmups;
}

function waitForProjectionVisibilityIdle(delayMs: number, timeoutMs = 1200) {
  return new Promise<void>((resolve) => {
    window.setTimeout(() => {
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(() => resolve(), { timeout: timeoutMs });
        return;
      }
      window.requestAnimationFrame(() => resolve());
    }, delayMs);
  });
}

function getRuntimeProjectionPreviewSize(width: number, height: number) {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const scale = Math.min(1, RUNTIME_PROJECTION_PREVIEW_MAX_SIDE / Math.max(safeWidth, safeHeight));
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
  };
}
function projectionPreviewCopy() {
  return translations[useI18nStore.getState().language];
}

function stableNumberListSignature(values?: number[]) {
  if (!values?.length) return '';
  return values.map((value) => (Number.isFinite(value) ? value.toFixed(5) : '0')).join(',');
}

function cameraSignature(layer: Layer) {
  const camera = layer.camera;
  if (!camera) return '';
  return [
    stableNumberListSignature(camera.position),
    stableNumberListSignature(camera.target),
    stableNumberListSignature(camera.quaternion),
    stableNumberListSignature(camera.viewMatrix),
    stableNumberListSignature(camera.projectionMatrix),
    camera.projection,
    camera.type,
    camera.fov ?? '',
    camera.zoom,
    camera.near ?? '',
    camera.far ?? '',
    camera.aspect ?? '',
  ].join('/');
}

function shouldUseProjectionCaptureMask(
  layer: Layer,
  maskUrl: string | undefined,
  depthUrl: string | undefined,
  localRepaint: boolean,
) {
  if (!maskUrl) return false;
  // An UV-space mask is authored layer coverage (for example the keep mask
  // committed by ALG-ERASE-001), not the original capture silhouette. It must
  // remain active even when generated layers use depth for capture visibility;
  // otherwise ending the live eraser preview restores the erased pixels.
  if (layer.maskSpace === 'uv') return true;
  if (layer.projectionCoverageMode === 'capture-mask') return true;
  if (localRepaint || layer.projectionVisibilityPolicy === 'surface-locked-v1') return true;
  if (
    depthUrl &&
    (layer.projectionCoverageMode === 'source-alpha-depth' || Boolean(layer.generationId))
  ) {
    return false;
  }
  return true;
}

function resolveProjectionMask(layer: Layer, capture: Capture | undefined) {
  if (layer.maskUrl) {
    return { maskUrl: layer.maskUrl, maskSpace: layer.maskSpace };
  }
  if (layer.projectionCoverageMode === 'capture-mask' && capture?.maskUrl) {
    return { maskUrl: capture.maskUrl, maskSpace: 'projection' as const };
  }
  return { maskUrl: undefined, maskSpace: layer.maskSpace };
}

function applyLiveProjectedMaskBinding(
  layer: Layer,
  preview: LiveSurfacePaintPreview | undefined,
  objectId: string | undefined,
) {
  if (
    preview?.target !== 'projected-mask' ||
    preview.objectId !== objectId ||
    preview.layerId !== layer.id
  )
    return layer;
  const maskUrl =
    preview.composition === 'replace' ? preview.assetUrl : preview.residentMaskUrl;
  return maskUrl ? { ...layer, maskUrl, maskSpace: 'uv' as const } : layer;
}

function liveProjectedMaskRevisionSignature(maskUrl: string | undefined) {
  if (!maskUrl) return '';
  const revision = getLiveProjectedCanvasState(maskUrl)?.revision;
  return revision === undefined ? '' : `live-mask-r${revision}`;
}

function layerPreviewSignature(layer: Layer, relativeOrder = layer.order) {
  return [
    layer.id,
    layer.type,
    layer.imageUrl ?? '',
    layer.maskUrl ?? '',
    layer.depthUrl ?? '',
    layer.visible ? 1 : 0,
    relativeOrder,
    layer.opacity,
    layer.strength ?? 1,
    layer.blendMode,
    layer.adjustments?.hue ?? 0,
    layer.adjustments?.saturation ?? 0,
    layer.adjustments?.lightness ?? 0,
    layer.renderedColor ? 1 : 0,
    layer.ignoreSourceAlpha ? 1 : 0,
    layer.minimumProjectionFacing ?? 0,
    layer.projectionVisibilityPolicy ?? '',
    layer.projectionCoverageMode ?? '',
    layer.contentRevision ?? 0,
    layer.needsRebake ? 1 : 0,
    stableNumberListSignature(layer.objectMatrixWorld),
    cameraSignature(layer),
  ].join(':');
}

function isRenderedLocalRepaintLayer(layer: Layer) {
  // Repaint layers keep their dedicated resident/overlay presentation and
  // authored display colour; only a final merged UV receives PBR lighting.
  return Boolean(
    layer.id.startsWith('local-repaint-') ||
    layer.role === 'local-repaint-overlay' ||
    layer.role === 'local-repaint-draft' ||
    (layer.imageUrl ?? '').includes('surface-edit:local-repaint') ||
    layer.localRepaintSourceUrl ||
    layer.localRepaintMaskUrl,
  );
}

function reportProjectedPreviewProgress(
  progress: number,
  detail: string,
  options: { done?: boolean; failed?: boolean; layerCount?: number } = {},
) {
  if (typeof window === 'undefined') return;
  if (progress <= 0.12) {
    document.body.dataset.projectedPreviewProgressStartedUnixMs = String(Date.now());
  }
  if (options.done && !options.failed) {
    const startedAt = Number(
      document.body.dataset.projectedPreviewProgressStartedUnixMs ?? Date.now(),
    );
    document.body.dataset.projectedPreviewReadyLatencyMs = String(
      Math.max(0, Date.now() - startedAt),
    );
  }
  document.body.dataset.projectedPreviewProgress = progress.toFixed(3);
  document.body.dataset.projectedPreviewProgressDetail = detail;
  window.dispatchEvent(
    new CustomEvent('liclick:projected-preview-progress', {
      detail: {
        title: options.failed
          ? '投影贴图加载失败'
          : options.done
            ? '投影贴图已就绪'
            : '正在加载投影贴图',
        detail,
        progress,
        done: options.done,
        dismissAfterMs: options.failed ? 4_000 : 500,
        layerCount: options.layerCount,
      },
    }),
  );
}

function isOverlayProjectionPatch(layer: Layer) {
  return Boolean(
    layer.id.startsWith('local-repaint-') ||
    (layer.imageUrl ?? '').includes('surface-edit:local-repaint'),
  );
}

function isUnderlayProjectionPatch(layer: Layer) {
  return Boolean(
    layer.id.startsWith('content-aware-projected-repair') ||
    layer.generationId === 'texture-map-content-aware-repair',
  );
}

function getProjectionCompositeRole(layer: Layer): 'normal' | 'overlay' | 'underlay' {
  if (isUnderlayProjectionPatch(layer)) return 'underlay';
  if (isOverlayProjectionPatch(layer)) return 'overlay';
  return 'normal';
}

function layerStackPreviewSignature(layers: Layer[]) {
  return layers.map(layerPreviewSignature).join('|');
}

/**
 * UV composition depends on the relative UV-layer order, not the absolute row
 * numbers in the mixed UV/projected layer panel. Adding a projected layer at
 * the top renumbers every row; including that absolute order made an unchanged
 * 4K UV stack recomposite once for every arriving projection.
 */
function uvLayerStackPreviewSignature(layers: Layer[]) {
  return [...layers]
    .sort((left, right) => compareUvLayersForComposition(left, right, 'top-to-bottom'))
    .map((layer, relativeIndex) =>
      [
        relativeIndex,
        layer.id,
        layer.imageUrl ?? '',
        layer.role ?? '',
        layer.visible ? 1 : 0,
        layer.opacity,
        layer.blendMode,
        layer.adjustments?.hue ?? 0,
        layer.adjustments?.saturation ?? 0,
        layer.adjustments?.lightness ?? 0,
        layer.contentRevision ?? 0,
      ].join(':'),
    )
    .join('|');
}

function residentUvVisibilityKey(layers: Layer[]) {
  return [...layers]
    .sort((left, right) => compareUvLayersForComposition(left, right, 'top-to-bottom'))
    .map((layer) => layer.id)
    .join('|');
}

function residentUvLayerRenderSignature(layer: Layer, relativeOrder: number) {
  // Visibility is presented by resident samplers and opacity uniforms. Keeping
  // it out of the React material signature prevents an eye click from
  // re-running the complete 4K composition/material effect.
  return [
    relativeOrder,
    layer.id,
    layer.type,
    layer.imageUrl ?? '',
    layer.objectId ?? '',
    layer.role ?? '',
    layer.opacity,
    layer.blendMode,
    layer.adjustments?.hue ?? 0,
    layer.adjustments?.saturation ?? 0,
    layer.adjustments?.lightness ?? 0,
    layer.contentRevision ?? 0,
  ].join(':');
}

function projectedLayerStructureSignature(layer: Layer, relativeOrder = layer.order) {
  return [
    layer.id,
    layer.type,
    layer.imageUrl ?? '',
    layer.maskUrl ?? '',
    layer.maskSpace ?? '',
    layer.depthUrl ?? '',
    layer.depthEncoding ?? '',
    layer.normalUrl ?? '',
    layer.objectId ?? '',
    layer.generationId ?? '',
    layer.captureId ?? '',
    layer.replacementTargetLayerId ?? '',
    layer.renderedColor ? 1 : 0,
    layer.minimumProjectionFacing ?? 0,
    layer.projectionVisibilityPolicy ?? '',
    layer.role ?? '',
    relativeOrder,
    layer.contentRevision ?? 0,
    stableNumberListSignature(layer.objectMatrixWorld),
    cameraSignature(layer),
  ].join(':');
}

function importedModelLayerRenderSignature(layers: Layer[], objectId: string) {
  return layers
    .filter((layer) => !layer.objectId || layer.objectId === objectId)
    .map((layer, relativeOrder) =>
      layer.type === 'projected'
        ? projectedLayerStructureSignature(layer, relativeOrder)
        : layer.type === 'uv'
          ? residentUvLayerRenderSignature(layer, relativeOrder)
          : layerPreviewSignature(layer, relativeOrder),
    )
    .join('|');
}

function importedModelLayerDisplaySignature(layers: Layer[], objectId: string) {
  return layers
    .filter((layer) => !layer.objectId || layer.objectId === objectId)
    .map(
      (layer) =>
        `${layer.id}:${layer.type}:${layer.role ?? ''}:${layer.order}:${Number(layer.visible)}:${layer.opacity}:${layer.strength ?? 1}:${layer.blendMode}:${layer.adjustments?.hue ?? 0}:${layer.adjustments?.saturation ?? 0}:${layer.adjustments?.lightness ?? 0}:${layer.generationId ?? ''}:${layer.captureId ?? ''}:${layer.contentRevision ?? 0}`,
    )
    .join('|');
}

function toProjectionLayerDisplayInput(layer: Layer): ProjectionLayerDisplayInput {
  return {
    layerId: layer.id,
    opacity: layer.opacity,
    strength: layer.strength,
    // Persisted local repaint rows use normal as their user-facing blend mode,
    // but the projected shader presents them as literal ordered replacement
    // patches. Preserve that internal mode during every uniform-only refresh.
    blendMode: isOverlayProjectionPatch(layer) ? 'overlay' : layer.blendMode,
    compositeRole: getProjectionCompositeRole(layer),
    visible: layer.visible,
    hue: (layer.adjustments?.hue ?? 0) / 100,
    saturation: (layer.adjustments?.saturation ?? 0) / 100,
    lightness: (layer.adjustments?.lightness ?? 0) / 100,
  };
}

function getVisibleMergedUvBoundaryOrder(layers: Layer[], objectId?: string) {
  let boundary = Number.POSITIVE_INFINITY;
  for (const layer of layers) {
    if (
      layer.type === 'uv' &&
      layer.role === 'merged-uv' &&
      layer.visible &&
      Boolean(layer.imageUrl) &&
      (!layer.objectId || layer.objectId === objectId)
    ) {
      boundary = Math.min(boundary, layer.order);
    }
  }
  return boundary;
}

function isProjectedLayerAboveMergedUv(layer: Layer, mergedUvBoundaryOrder: number) {
  return !Number.isFinite(mergedUvBoundaryOrder) || layer.order < mergedUvBoundaryOrder;
}

function useStableValueBySignature<T>(value: T, signature: string) {
  const stableRef = useRef<{ signature: string; value: T }>();
  if (!stableRef.current || stableRef.current.signature !== signature) {
    stableRef.current = { signature, value };
  }
  return stableRef.current.value;
}

function readAuthoritativeLocalRepaintLayers(
  _layerRenderSignature: string,
  _uvVisibilityRenderRevision: number,
  objectId: string,
) {
  const layerState = useLayerStore.getState();
  return mergeAuthoritativeLocalRepaintLayers(
    layerState.layers,
    layerState.projectedPreviewLayers,
    objectId,
  );
}

type LoadedPreviewTextureState = {
  texture?: THREE.Texture;
  key?: string;
  requestedKey: string;
  ready: boolean;
};

function useLoadedPreviewTextureState(
  imageUrl?: string,
  options?: {
    preserveWhenEmpty?: boolean;
    colorSpace?: THREE.ColorSpace;
    maxSize?: number;
  },
): LoadedPreviewTextureState {
  const [loadedState, setLoadedState] = useState<{
    key: string;
    texture: THREE.Texture;
  }>();
  const { gl } = useThree();
  const requestKey = imageUrl
    ? `${imageUrl}::${options?.maxSize ? `proxy-${options.maxSize}` : 'full'}`
    : '';

  useEffect(() => {
    // UV-REPAINT-PREVIEW-BINDING v1.0.0: live outputs borrow their repaint owner,
    // not the static cache. Their URLs are not decodable image addresses.
    // Never upload/dispose a render target through the static cache.
    if (isLiveProjectedCanvasUrl(imageUrl)) return undefined;
    if (!imageUrl) {
      if (!options?.preserveWhenEmpty) setLoadedState(undefined);
      return undefined;
    }
    let cancelled = false;
    // Keep the last valid GPU texture visible while the replacement decodes.
    // Clearing here produced the one-frame black/white flash during repaint,
    // image replacement and UV composition hand-offs.
    const releaseTexture = retainPreviewTexture(imageUrl, { maxSize: options?.maxSize });
    void (async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 3 && !cancelled; attempt += 1) {
        try {
          const texture = await loadPreviewTexture(imageUrl, { maxSize: options?.maxSize });
          if (cancelled) return;
          if (options?.colorSpace) texture.colorSpace = options.colorSpace;
          await uploadPreviewTextureInStripes(gl, texture);
          if (!cancelled) setLoadedState({ key: requestKey, texture });
          return;
        } catch (error) {
          lastError = error;
          if (attempt < 2) {
            await new Promise<void>((resolve) =>
              window.setTimeout(resolve, attempt === 0 ? 80 : 200),
            );
          }
        }
      }
      if (!cancelled) {
        console.warn(
          '[Liclick 3D Texture] Could not load texture for viewport preview:',
          lastError,
        );
      }
    })().finally(releaseTexture);
    return () => {
      cancelled = true;
    };
  }, [gl, imageUrl, options?.colorSpace, options?.maxSize, options?.preserveWhenEmpty, requestKey]);

  // `prewarmPreviewTextures` publishes the exact texture into the resident
  // cache before the layer eye is committed. Read that cache synchronously on
  // the first render of the new URL instead of waiting one extra React effect
  // turn; that turn used to expose the reserved white sampler.
  const liveTexture = imageUrl
    ? getLiveProjectedTexture(imageUrl, options?.colorSpace ?? THREE.SRGBColorSpace)
    : undefined;
  const residentTexture =
    liveTexture ??
    getReadyResidentPreviewTexture(imageUrl, gl, { maxSize: options?.maxSize });
  const state = residentTexture ? { key: requestKey, texture: residentTexture } : loadedState;
  const texture = state?.texture;
  if (texture && options?.colorSpace) texture.colorSpace = options.colorSpace;
  return {
    texture,
    key: state?.key,
    requestedKey: requestKey,
    ready: Boolean(imageUrl && texture && state?.key === requestKey),
  };
}

function useLoadedPreviewTexture(
  imageUrl?: string,
  options?: {
    preserveWhenEmpty?: boolean;
    colorSpace?: THREE.ColorSpace;
    maxSize?: number;
  },
) {
  return useLoadedPreviewTextureState(imageUrl, options).texture;
}

function loadImageElement(url: string) {
  const cached = imageElementCache.get(url);
  if (cached) {
    imageElementCache.delete(url);
    imageElementCache.set(url, cached);
    return cached;
  }
  const promise = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => {
      imageElementCache.delete(url);
      reject(new Error(`Could not load UV layer image: ${url.slice(0, 80)}`));
    };
    image.src = url;
  });
  imageElementCache.set(url, promise);
  while (imageElementCache.size > MAX_IMAGE_ELEMENT_CACHE_SIZE) {
    const oldestKey = imageElementCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    imageElementCache.delete(oldestKey);
  }
  return promise;
}

type CompositedUvTextureState = {
  texture?: THREE.Texture;
  key?: string;
  requestedKey: string;
  ready: boolean;
};

function useCompositedUvTextureState(
  layers: Layer[],
  options?: { maxSize?: number },
): CompositedUvTextureState {
  const [textureState, setTextureState] = useState<{
    key: string;
    texture: THREE.Texture;
  }>();
  const { gl } = useThree();
  const workerOwnerKeyRef = useRef(createId('uv-composite'));
  const runtimeRef = useRef<{
    refresh: () => void;
    liveRevisions: Map<string, number>;
  }>();
  const currentTextureRef = useRef<THREE.Texture>();
  const textureCacheRef = useRef(new Map<string, THREE.Texture>());
  const layerKey = useMemo(
    () => `${uvLayerStackPreviewSignature(layers)}::${options?.maxSize ?? 'full'}`,
    [layers, options?.maxSize],
  );
  const stableLayers = useStableValueBySignature(layers, layerKey);

  useFrame(() => {
    const runtime = runtimeRef.current;
    if (!runtime || runtime.liveRevisions.size === 0) return;
    let changed = false;
    runtime.liveRevisions.forEach((revision, url) => {
      const nextRevision = getLiveProjectedCanvasState(url)?.revision;
      if (nextRevision === undefined || nextRevision === revision) return;
      runtime.liveRevisions.set(url, nextRevision);
      changed = true;
    });
    if (!changed) return;
    runtime.refresh();
  });

  useEffect(
    () => () => {
      const textures = new Set(textureCacheRef.current.values());
      if (currentTextureRef.current) textures.add(currentTextureRef.current);
      textureCacheRef.current.clear();
      currentTextureRef.current = undefined;
      textures.forEach((cachedTexture) => {
        if (typeof ImageBitmap !== 'undefined' && cachedTexture.image instanceof ImageBitmap)
          cachedTexture.image.close();
        cachedTexture.dispose();
      });
    },
    [],
  );

  useEffect(() => {
    const workerOwnerKey = workerOwnerKeyRef.current;
    const uvLayers = stableLayers.filter((layer) => layer.visible && layer.imageUrl);
    if (uvLayers.length === 0) {
      // Keep finished composites resident. Visibility toggles are frequent and
      // must not turn into a 4K ImageBitmap -> Worker -> GPU upload round trip.
      // The bounded cache owns retirement instead of this empty-state branch.
      return undefined;
    }

    const containsLiveCanvas = uvLayers.some((layer) =>
      Boolean(getLiveProjectedCanvasState(layer.imageUrl)),
    );
    const cachedTexture = containsLiveCanvas ? undefined : textureCacheRef.current.get(layerKey);
    if (cachedTexture) {
      textureCacheRef.current.delete(layerKey);
      textureCacheRef.current.set(layerKey, cachedTexture);
      currentTextureRef.current = cachedTexture;
      setTextureState({ key: layerKey, texture: cachedTexture });
      document.body.dataset.uvCompositeStatus = 'cached';
      document.body.dataset.uvCompositeBackend = 'resident-gpu-cache';
      document.body.dataset.uvCompositeDurationMs = '0';
      return undefined;
    }

    let cancelled = false;
    let composing = false;
    let composeAgain = false;
    const useWorkerUrlSources =
      canCompositeUvLayersInWorker() &&
      uvLayers.every(
        (layer) => !getLiveProjectedCanvasState(layer.imageUrl) && Boolean(layer.imageUrl),
      );

    const waitForInteractionIdle = async () => {
      while (!cancelled && isSharedViewportInteractionBusy()) {
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      }
    };

    const retireTexture = (retiredTexture: THREE.Texture) => {
      window.requestAnimationFrame(() =>
        window.requestAnimationFrame(() => {
          if (typeof ImageBitmap !== 'undefined' && retiredTexture.image instanceof ImageBitmap)
            retiredTexture.image.close();
          retiredTexture.dispose();
        }),
      );
    };

    const trimTextureCache = () => {
      while (textureCacheRef.current.size > MAX_COMPOSITED_UV_TEXTURE_CACHE_SIZE) {
        const oldestKey = textureCacheRef.current.keys().next().value as string | undefined;
        if (!oldestKey) break;
        const oldestTexture = textureCacheRef.current.get(oldestKey);
        textureCacheRef.current.delete(oldestKey);
        if (oldestTexture && oldestTexture !== currentTextureRef.current) {
          retireTexture(oldestTexture);
        }
      }
    };

    const publishTexture = (nextTexture: THREE.Texture) => {
      if (cancelled) {
        if (typeof ImageBitmap !== 'undefined' && nextTexture.image instanceof ImageBitmap)
          nextTexture.image.close();
        nextTexture.dispose();
        return;
      }
      const replacedForKey = textureCacheRef.current.get(layerKey);
      textureCacheRef.current.delete(layerKey);
      textureCacheRef.current.set(layerKey, nextTexture);
      currentTextureRef.current = nextTexture;
      setTextureState({ key: layerKey, texture: nextTexture });
      trimTextureCache();
      if (replacedForKey && replacedForKey !== nextTexture) retireTexture(replacedForKey);
    };

    void Promise.all(
      uvLayers.map(async (layer) => {
        const live = getLiveProjectedCanvasState(layer.imageUrl);
        return {
          layer,
          // Static URL compositions are decoded by the worker. Loading the
          // same 4K files into HTMLImageElement first caused a repeatable
          // 0.93-0.99s main-thread task during project restore.
          source:
            live?.canvas ??
            (useWorkerUrlSources ? undefined : await loadImageElement(layer.imageUrl)),
          liveUrl: live ? layer.imageUrl : undefined,
          liveRevision: live?.revision,
        };
      }),
    )
      .then((sources) => {
        if (cancelled) return;
        const sourceWidth = Math.max(
          1,
          ...sources.flatMap(({ source }) =>
            source
              ? [
                  ('naturalWidth' in source ? source.naturalWidth || source.width : source.width) ||
                    1,
                ]
              : [],
          ),
        );
        const sourceHeight = Math.max(
          1,
          ...sources.flatMap(({ source }) =>
            source
              ? [
                  ('naturalHeight' in source
                    ? source.naturalHeight || source.height
                    : source.height) || 1,
                ]
              : [],
          ),
        );
        // Keep the composited material at the source UV resolution. Interactive paint and
        // eraser work must never trade the user's texture resolution for viewport speed.
        const compositeScale = options?.maxSize
          ? Math.min(1, options.maxSize / Math.max(sourceWidth, sourceHeight))
          : 1;
        let width = Math.max(1, Math.round(sourceWidth * compositeScale));
        let height = Math.max(1, Math.round(sourceHeight * compositeScale));
        const sortedSources = [...sources].sort((left, right) =>
          compareUvLayersForComposition(left.layer, right.layer, 'bottom-to-top'),
        );
        const compose = async () => {
          if (composing) {
            composeAgain = true;
            return;
          }
          composing = true;
          const composeStartedAt = performance.now();
          const finishComposeSpan = startPerformanceSpan('uv-composite', 'compose-uv-stack', {
            layerCount: sortedSources.length,
            width,
            height,
          });
          document.body.dataset.uvCompositeStatus = 'composing';
          try {
            // A local repaint submission captures four exact render passes. Do not
            // start a background 4K UV composition while those passes own the GPU.
            await waitForInteractionIdle();
            if (cancelled) return;
            let nextTexture: THREE.Texture;
            if (canCompositeUvLayersInWorker()) {
              document.body.dataset.uvCompositeBackend = 'worker';
              const staticSources = useWorkerUrlSources;
              const bitmap = staticSources
                ? await compositeUvLayerUrlsInWorker(
                    sortedSources.map(({ layer }) => ({
                      imageUrl: layer.imageUrl!,
                      opacity: layer.opacity,
                    })),
                    workerOwnerKey,
                  )
                : await compositeUvLayersInWorker(
                    await Promise.all(
                      sortedSources.map(async ({ layer, source }) => {
                        if (!source) throw new Error('UV composition source was not decoded.');
                        return {
                          bitmap: await createImageBitmap(source),
                          opacity: layer.opacity,
                        };
                      }),
                    ),
                    workerOwnerKey,
                  );
              if (options?.maxSize && bitmap.width > options.maxSize) {
                const resizedScale = options.maxSize / Math.max(bitmap.width, bitmap.height);
                const resizedBitmap = await createImageBitmap(bitmap, {
                  resizeWidth: Math.max(1, Math.round(bitmap.width * resizedScale)),
                  resizeHeight: Math.max(1, Math.round(bitmap.height * resizedScale)),
                  resizeQuality: 'medium',
                });
                bitmap.close();
                width = resizedBitmap.width;
                height = resizedBitmap.height;
                nextTexture = await createWorkerBackedPreviewTexture(resizedBitmap);
              } else {
                if (staticSources) {
                  width = bitmap.width;
                  height = bitmap.height;
                }
                nextTexture = await createWorkerBackedPreviewTexture(bitmap);
              }
              document.body.dataset.uvCompositeDecodeBackend = staticSources
                ? 'worker-fetch-image-bitmap'
                : 'main-thread-live-bitmap';
            } else {
              document.body.dataset.uvCompositeBackend = 'main-thread-fallback';
              const canvas = document.createElement('canvas');
              canvas.width = width;
              canvas.height = height;
              const context = canvas.getContext('2d');
              if (!context) throw new Error('Could not create UV layer composite canvas.');
              context.clearRect(0, 0, width, height);
              sortedSources.forEach(({ layer, source }) => {
                if (!source) throw new Error('UV composition source was not decoded.');
                context.save();
                context.globalAlpha = Math.max(0, Math.min(1, layer.opacity));
                context.globalCompositeOperation = 'source-over';
                context.drawImage(source, 0, 0, width, height);
                context.restore();
              });
              nextTexture = new THREE.CanvasTexture(canvas);
            }
            nextTexture.colorSpace = THREE.SRGBColorSpace;
            // Worker composites are already oriented for GL, including the
            // dimension-only DataTexture used by striped bitmap uploads.
            // Preserve the factory's flipY=false; only CanvasTexture needs a flip.
            if (nextTexture instanceof THREE.CanvasTexture) nextTexture.flipY = true;
            nextTexture.wrapS = THREE.ClampToEdgeWrapping;
            nextTexture.wrapT = THREE.ClampToEdgeWrapping;
            nextTexture.minFilter = THREE.LinearFilter;
            nextTexture.magFilter = THREE.LinearFilter;
            nextTexture.generateMipmaps = false;
            nextTexture.anisotropy = 8;
            nextTexture.needsUpdate = true;
            // The worker keeps CPU composition off the UI thread, but handing
            // a fresh 4096 ImageBitmap directly to the renderer still causes a
            // monolithic texImage2D frame. Finish the exact full-resolution
            // upload in bounded stripes before swapping the visible texture.
            document.body.dataset.uvCompositeStatus = 'gpu-upload';
            await waitForInteractionIdle();
            if (cancelled) {
              if (typeof ImageBitmap !== 'undefined' && nextTexture.image instanceof ImageBitmap)
                nextTexture.image.close();
              nextTexture.dispose();
              return;
            }
            await uploadPreviewTextureInStripes(gl, nextTexture, {
              shouldCancel: () => cancelled,
            });
            if (cancelled) {
              if (typeof ImageBitmap !== 'undefined' && nextTexture.image instanceof ImageBitmap)
                nextTexture.image.close();
              nextTexture.dispose();
              return;
            }
            publishTexture(nextTexture);
            document.body.dataset.uvCompositeStatus = 'ready';
            document.body.dataset.uvCompositeDurationMs = String(
              Math.round((performance.now() - composeStartedAt) * 10) / 10,
            );
            document.body.dataset.uvCompositeSize = `${width}x${height}`;
            finishComposeSpan('end', {
              backend: document.body.dataset.uvCompositeBackend,
              durationMs: performance.now() - composeStartedAt,
            });
          } catch (error) {
            if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) {
              finishComposeSpan('end', { cancelled: true });
              return;
            }
            document.body.dataset.uvCompositeStatus = 'error';
            finishComposeSpan('error', {
              message: error instanceof Error ? error.message : String(error),
            });
            console.warn('[Liclick 3D Texture] Could not composite UV layer stack:', error);
          } finally {
            composing = false;
            if (composeAgain && !cancelled) {
              composeAgain = false;
              void compose();
            }
          }
        };
        const runtime = {
          refresh: () => void compose(),
          liveRevisions: new Map(
            sources.flatMap(({ liveUrl, liveRevision }) =>
              liveUrl && liveRevision !== undefined ? [[liveUrl, liveRevision] as const] : [],
            ),
          ),
        };
        runtimeRef.current = runtime;
        void compose();
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn('[Liclick 3D Texture] Could not composite UV layer stack:', error);
      });

    return () => {
      cancelled = true;
      runtimeRef.current = undefined;
      cancelUvLayerCompositions(workerOwnerKey);
    };
  }, [gl, layerKey, options?.maxSize, stableLayers]);

  return {
    texture: textureState?.texture,
    key: textureState?.key,
    requestedKey: layerKey,
    ready: Boolean(textureState?.texture && textureState.key === layerKey),
  };
}

function useCompositedUvTexture(layers: Layer[], options?: { maxSize?: number }) {
  return useCompositedUvTextureState(layers, options).texture;
}

const selectionBoundsCache = new WeakMap<
  THREE.Object3D,
  { matrixWorld: THREE.Matrix4; bounds: THREE.Box3 }
>();

function SelectionBoundsCorners({ object, objectId }: { object: THREE.Object3D; objectId: string }) {
  const lastMatrixWorldRef = useRef(
    new THREE.Matrix4().set(Number.NaN, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1),
  );
  const indicator = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(8 * 3 * 2 * 3);
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const material = new THREE.LineBasicMaterial({
      color: '#ff8a68',
      transparent: true,
      opacity: 0.92,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
    });
    const lines = new THREE.LineSegments(geometry, material);
    lines.visible = false;
    lines.name = 'Liclick Selection Bounds Corners';
    lines.renderOrder = 82;
    lines.frustumCulled = false;
    lines.userData.liclickSelectionGlow = true;
    lines.userData.liclickViewportHelper = true;
    lines.raycast = () => undefined;

    const bounds = new THREE.Box3();
    const size = new THREE.Vector3();
    const paddedBounds = new THREE.Box3();

    const update = () => {
      object.updateWorldMatrix(true, false);
      // Selection chrome does not need the per-vertex `precise` path. That path
      // scans every vertex whenever selection moves to another high-poly model
      // and blocks presentation. Geometry bounds preserve the indicator's AABB
      // semantics without touching texture or projection output.
      const cachedBounds = selectionBoundsCache.get(object);
      if (cachedBounds?.matrixWorld.equals(object.matrixWorld)) {
        bounds.copy(cachedBounds.bounds);
      } else {
        bounds.setFromObject(object, false);
        selectionBoundsCache.set(object, {
          matrixWorld: object.matrixWorld.clone(),
          bounds: bounds.clone(),
        });
      }
      if (bounds.isEmpty()) {
        lines.visible = false;
        return;
      }

      lines.visible = true;
      bounds.getSize(size);
      const padding = Math.max(size.length() * 0.012, 0.001);
      paddedBounds.copy(bounds).expandByScalar(padding);
      paddedBounds.getSize(size);

      const attribute = geometry.getAttribute('position') as THREE.BufferAttribute;
      let vertexIndex = 0;
      for (const xAtMax of [false, true]) {
        for (const yAtMax of [false, true]) {
          for (const zAtMax of [false, true]) {
            const startX = xAtMax ? paddedBounds.max.x : paddedBounds.min.x;
            const startY = yAtMax ? paddedBounds.max.y : paddedBounds.min.y;
            const startZ = zAtMax ? paddedBounds.max.z : paddedBounds.min.z;
            const inwardX = xAtMax ? -1 : 1;
            const inwardY = yAtMax ? -1 : 1;
            const inwardZ = zAtMax ? -1 : 1;

            attribute.setXYZ(vertexIndex++, startX, startY, startZ);
            attribute.setXYZ(vertexIndex++, startX + inwardX * size.x * 0.16, startY, startZ);
            attribute.setXYZ(vertexIndex++, startX, startY, startZ);
            attribute.setXYZ(vertexIndex++, startX, startY + inwardY * size.y * 0.16, startZ);
            attribute.setXYZ(vertexIndex++, startX, startY, startZ);
            attribute.setXYZ(vertexIndex++, startX, startY, startZ + inwardZ * size.z * 0.16);
          }
        }
      }
      attribute.needsUpdate = true;
      geometry.computeBoundingSphere();
      lastMatrixWorldRef.current.copy(object.matrixWorld);
    };

    return { geometry, material, lines, update };
  }, [object]);

  useEffect(() => {
    return () => {
      indicator.lines.removeFromParent();
      indicator.geometry.dispose();
      indicator.material.dispose();
    };
  }, [indicator]);

  useFrame(() => {
    // React can still be reconciling the previous model when this frame runs.
    // Presentation must use the current selection, never a captured prop or a
    // visibility snapshot restored by an earlier offscreen capture.
    if (
      useSceneStore.getState().selectedObjectId !== objectId ||
      useWorkspaceLayoutStore.getState().mode !== 'scene' ||
      !object.visible
    ) {
      indicator.lines.visible = false;
      return;
    }
    // Camera motion cannot change the model root. Recurse through children only
    // when this indicator is activated or a transform changed the root matrix.
    object.updateWorldMatrix(true, false);
    if (!indicator.lines.visible || !lastMatrixWorldRef.current.equals(object.matrixWorld)) {
      indicator.update();
    }
  });

  return <primitive object={indicator.lines} />;
}

function TopologyWireframeOverlay({
  object,
  visible,
}: {
  object: THREE.Object3D;
  visible: boolean;
}) {
  const { gl, camera } = useThree();
  const overlay = useMemo(() => {
    const group = new THREE.Group();
    group.name = 'Liclick Topology Wireframe Overlay';
    group.userData.liclickViewportHelper = true;
    group.userData.liclickWireframeOverlay = true;
    group.matrixAutoUpdate = false;
    group.renderOrder = 40;

    const material = new THREE.MeshBasicMaterial({
      color: '#24252a',
      wireframe: true,
      transparent: true,
      opacity: 0.82,
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      toneMapped: false,
    });

    object.updateMatrixWorld(true);
    const inverseRoot = object.matrixWorld.clone().invert();
    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      if (
        child.userData.liclickPaintOverlay ||
        child.userData.liclickSelectionGlow ||
        child.userData.liclickWireframeOverlay
      )
        return;

      const localMatrix = inverseRoot.clone().multiply(child.matrixWorld);
      const wireMesh = new THREE.Mesh(child.geometry, material);
      wireMesh.name = `Liclick Topology Wireframe - ${child.name || child.uuid}`;
      wireMesh.matrix.copy(localMatrix);
      wireMesh.matrixAutoUpdate = false;
      wireMesh.renderOrder = 40;
      wireMesh.frustumCulled = child.frustumCulled;
      wireMesh.userData.liclickViewportHelper = true;
      wireMesh.userData.liclickWireframeOverlay = true;
      wireMesh.raycast = () => undefined;
      group.add(wireMesh);
    });

    group.visible = false;
    return { group, material };
  }, [object]);

  overlay.group.visible = visible;

  useFrame(() => {
    if (!overlay.group.visible) return;
    overlay.group.matrix.compose(object.position, object.quaternion, object.scale);
    overlay.group.matrixWorldNeedsUpdate = true;
  });

  useEffect(() => {
    document.body.dataset.topologyWireframeMeshCount = String(overlay.group.children.length);
    document.body.dataset.topologyWireframeReady = '0';
    let cancelled = false;
    const compile = async () => {
      const compileScene = new THREE.Scene();
      const compileGroup = overlay.group.clone(true);
      compileGroup.visible = true;
      compileGroup.traverse((child) => {
        child.visible = true;
        child.frustumCulled = false;
      });
      compileScene.add(compileGroup);
      if (typeof gl.compileAsync === 'function') {
        await gl.compileAsync(compileScene, camera);
      } else {
        gl.compile(compileScene, camera);
      }
      // WebGLRenderer builds the wireframe index buffer lazily on the first
      // real draw; compiling a tiny box only warmed the shader and left a
      // reproducible 33 ms stall on the user's first Wireframe click. Submit
      // the exact model geometries to a 1x1 target while model restore is still
      // preparing. This preserves the final line output and makes the later
      // mode switch a visibility/uniform-only operation.
      await waitForProjectionVisibilityIdle(0);
      while (!cancelled && isSharedViewportInteractionBusy(250)) {
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      }
      if (cancelled) return;
      const warmTarget = new THREE.WebGLRenderTarget(1, 1, {
        depthBuffer: true,
        stencilBuffer: false,
        generateMipmaps: false,
      });
      const previousTarget = gl.getRenderTarget();
      const previousAutoClear = gl.autoClear;
      try {
        document.body.dataset.topologyWireframePhase = 'actual-geometry-prewarm';
        gl.autoClear = true;
        gl.setRenderTarget(warmTarget);
        gl.render(compileScene, camera);
      } finally {
        gl.setRenderTarget(previousTarget);
        gl.autoClear = previousAutoClear;
        warmTarget.dispose();
        compileGroup.removeFromParent();
        delete document.body.dataset.topologyWireframePhase;
      }
      if (!cancelled) document.body.dataset.topologyWireframeReady = '1';
    };
    const compilePromise = compile().catch(() => {
      if (!cancelled) document.body.dataset.topologyWireframeReady = 'error';
    });
    return () => {
      cancelled = true;
      delete document.body.dataset.topologyWireframeMeshCount;
      delete document.body.dataset.topologyWireframeReady;
      overlay.group.removeFromParent();
      // Three.js' parallel shader poller keeps the material in its internal Set
      // until compileAsync settles. Disposing it during rapid multi-model
      // restore clears currentProgram and makes that poller dereference
      // undefined (`currentProgram.isReady()`). Keep the tiny wire material alive
      // until the pending compile has finished, then release it.
      if (compilePromise) {
        void compilePromise.finally(() => overlay.material.dispose());
      } else {
        overlay.material.dispose();
      }
    };
  }, [camera, gl, overlay]);

  return <primitive object={overlay.group} />;
}

function ModelRestoreLoadingIndicator({ object }: { object: THREE.Object3D }) {
  const billboardRef = useRef<THREE.Group>(null);
  const spinnerRef = useRef<THREE.Group>(null);
  const frame = useMemo(() => {
    object.updateWorldMatrix(true, true);
    const bounds = new THREE.Box3().setFromObject(object);
    const center = bounds.isEmpty()
      ? object.getWorldPosition(new THREE.Vector3())
      : bounds.getCenter(new THREE.Vector3());
    const size = bounds.isEmpty() ? 1 : bounds.getSize(new THREE.Vector3()).length();
    return { center, radius: THREE.MathUtils.clamp(size * 0.055, 0.08, 0.28) };
  }, [object]);

  useFrame(({ camera }, delta) => {
    if (billboardRef.current) billboardRef.current.quaternion.copy(camera.quaternion);
    if (!spinnerRef.current) return;
    spinnerRef.current.rotation.z -= delta * 2.8;
  });

  return (
    <group ref={billboardRef} position={frame.center} renderOrder={1000}>
      <group ref={spinnerRef}>
        <mesh>
          <torusGeometry args={[frame.radius, frame.radius * 0.13, 8, 48, Math.PI * 1.55]} />
          <meshBasicMaterial
            color="#e24acb"
            depthTest={false}
            depthWrite={false}
            toneMapped={false}
            transparent
            opacity={0.95}
          />
        </mesh>
        <mesh>
          <circleGeometry args={[frame.radius * 0.12, 20]} />
          <meshBasicMaterial
            color="#ffffff"
            depthTest={false}
            depthWrite={false}
            toneMapped={false}
            transparent
            opacity={0.9}
          />
        </mesh>
      </group>
    </group>
  );
}

const ImportedModel = memo(function ImportedModel({
  importedModel,
  onSelect,
  showSelectionGlow,
  workspaceVisible,
}: {
  importedModel: ModelLoadResult;
  onSelect: (objectId: string) => void;
  showSelectionGlow: boolean;
  workspaceVisible: boolean;
}) {
  const { gl, invalidate, camera } = useThree();
  const displayMode = useSceneStore((state) => state.displayMode);
  // Subscribe to this model's selection bit instead of the global object id.
  // With nine models mounted in scene view, the string subscription rendered
  // every complete material pipeline for each click. Only the old and new
  // selected models need to reconcile selection-owned background preparation.
  const selected = useSceneStore(
    (state) => state.selectedObjectId === importedModel.objectId,
  );
  const objectVisible = useSceneStore(
    (state) =>
      state.objects.find((object) => object.id === importedModel.objectId)?.visible ?? true,
  );
  const environmentPreset = useSettingsStore((state) => state.environmentPreset);
  const exposure = useSettingsStore((state) => state.exposure);
  const pbrEnvironmentIntensity = useSettingsStore((state) => state.pbrEnvironmentIntensity);
  const pbrKeyLightIntensity = useSettingsStore((state) => state.pbrKeyLightIntensity);
  const pbrLightAzimuth = useSettingsStore((state) => state.pbrLightAzimuth);
  const resolution = useSettingsStore((state) => state.resolution);
  const localRepaintPreviewLayer = useSceneStore((state) => state.localRepaintPreviewLayer);
  const localRepaintPaintTool = useSceneStore((state) => state.paintTool);
  const activeLayerId = useLayerStore((state) => state.activeProjectedLayerId);
  const localRepaintLiveFeedbackRequested =
    localRepaintPaintTool === 'inpaint-apply' ||
    (localRepaintPaintTool === 'eraser' && localRepaintPreviewLayer?.id === activeLayerId);
  const transientWhitePresentationObjectId = useSceneStore(
    (state) => state.transientWhitePresentationObjectId,
  );
  const localRepaintPreviewLayerId = localRepaintPreviewLayer?.id;
  // A completed repaint row must stay resident in the projected texture array
  // while its renderer-owned eraser twin is active. Removing and later adding
  // that existing row turns an eye toggle into an asynchronous structural
  // material rebuild; the icon can already be visible while the row is still
  // absent (or remains muted by a late build). A brand-new repaint has no
  // resident row yet and can still use the lightweight transient path.
  // The live marker can retain its pre-publication revision across many strokes.
  // Consult the authoritative rows, otherwise a completed layer is excluded
  // until the next generation and its entire array rebuild lands on that click.
  const transientLocalRepaintPreviewLayerId = useLayerStore((state) =>
    getTransientLocalRepaintLayerId(localRepaintPreviewLayerId, state.layers),
  );
  const hasAuthoritativeVisibleTextureLayer = useLayerStore((state) =>
    state.layers.some(
      (layer) =>
        layer.visible &&
        Boolean(layer.imageUrl) &&
        (!layer.objectId || layer.objectId === importedModel.objectId) &&
        (layer.type === 'uv' || (layer.type === 'projected' && Boolean(layer.camera))),
    ),
  );
  const [uvVisibilityRenderRevision, setUvVisibilityRenderRevision] = useState(0);
  const residentUvPresentationCacheRef = useRef(new Map<string, THREE.Texture>());
  const pendingUvVisibilityRenderKeyRef = useRef('');
  const uvPresentationRef = useRef<{
    texture?: THREE.Texture;
    opacity: number;
    renderedColor: boolean;
  }>({ opacity: 0, renderedColor: false });
  const contentAwareUnderlayPresentationRef = useRef<{
    texture?: THREE.Texture;
    opacity: number;
  }>({ opacity: 0 });
  const proxyTextureMaxSize = importedModel.restoreStage === 'proxy' ? 512 : undefined;
  const texturedRestoreReady =
    !importedModel.restoreStage ||
    importedModel.restoreStage === 'proxy' ||
    importedModel.restoreStage === 'full';
  const layerRenderSignature = useLayerStore((state) =>
    importedModelLayerRenderSignature(
      mergeAuthoritativeLocalRepaintLayers(
        state.layers,
        state.projectedPreviewLayers,
        importedModel.objectId,
      ),
      importedModel.objectId,
    ),
  );
  // Structural UV signatures intentionally omit eye state so a visibility
  // toggle does not rebuild/upload a 4K texture. Content-aware underlays still
  // need a live display snapshot, otherwise their cached `visible` flag can
  // survive after the row eye is closed and repaint an apparently hidden UV.
  const contentAwareLayerDisplaySignature = useLayerStore((state) =>
    state.layers
      .filter(
        (layer) =>
          layer.type === 'uv' &&
          layer.role === 'content-aware-underlay' &&
          (!layer.objectId || layer.objectId === importedModel.objectId),
      )
      .map(
        (layer) =>
          `${layer.id}:${Number(layer.visible)}:${layer.opacity}:${layer.imageUrl ?? ''}:${layer.order}`,
      )
      .join('|'),
  );
  const layers = useMemo(
    () =>
      readAuthoritativeLocalRepaintLayers(
        layerRenderSignature,
        uvVisibilityRenderRevision,
        importedModel.objectId,
      ),
    [importedModel.objectId, layerRenderSignature, uvVisibilityRenderRevision],
  );
  const visibleMergedUvBoundaryOrder = useMemo(
    () => getVisibleMergedUvBoundaryOrder(layers, importedModel.objectId),
    [importedModel.objectId, layers],
  );
  const liveSurfacePaintPreview = useLiveSurfacePaintPreview();
  // SurfacePaintOverlay owns the renderer-only local repaint preview. Keep an
  // already-persisted repaint row resident in the projected texture array and
  // mute it by uniform while the overlay is active. Removing/reinserting that
  // row rebuilt every 4K array on each task boundary; a resident zero-opacity
  // binding hands off in one frame and preserves the exact stored pixels.
  const rendererOwnedLocalRepaintPreviewLayerId = useMemo(
    () =>
      localRepaintPreviewLayer &&
      shouldMuteLocalRepaintResidentLayer(
        layers,
        localRepaintPreviewLayer,
        localRepaintPreviewLayer.id,
        localRepaintLiveFeedbackRequested,
      )
        ? localRepaintPreviewLayer.id
        : undefined,
    [layers, localRepaintLiveFeedbackRequested, localRepaintPreviewLayer],
  );
  const project = useProjectStore(
    useShallow((state) => {
      const current = state.currentProjectId
        ? state.projects.find((item) => item.id === state.currentProjectId)
        : undefined;
      return current
        ? { id: current.id, captures: current.captures, bakedTextures: current.bakedTextures }
        : undefined;
    }),
  );
  const captureById = useMemo(
    () => new Map(project?.captures.map((capture) => [capture.id, capture] as const) ?? []),
    [project?.captures],
  );
  const [runtimeVisibilityByLayerId, setRuntimeVisibilityByLayerId] = useState<
    Record<string, { depthUrl: string; normalUrl: string }>
  >({});
  const [initialProjectedMaterialReady, setInitialProjectedMaterialReady] = useState(false);
  const [presentedMaterialGroup, setPresentedMaterialGroup] = useState<THREE.Group | undefined>(
    () => (!importedModel.restoreStage ? importedModel.group : undefined),
  );
  const initialMaterialPresentationReadyForGroup = presentedMaterialGroup === importedModel.group;
  const initialMaterialPresentationVisibleForGroup =
    // Imported models remain immediate. Project restoration, however, must not
    // expose bounds, flat outlines or a 512px proxy before the exact material
    // is ready. A textureless full-stage model may show its final white material.
    !importedModel.restoreStage ||
    (importedModel.restoreStage === 'full' &&
      (!hasAuthoritativeVisibleTextureLayer || initialMaterialPresentationReadyForGroup));
  const revealInitialMaterialPresentation = useCallback(() => {
    if (importedModel.restoreStage && importedModel.restoreStage !== 'full') return;
    // Progressive restore replaces the Group while retaining the same object id.
    // Store the exact published Group instead of a boolean: writing `true` again
    // after a replacement is a React no-op and leaves the new white membrane
    // permanently hidden.
    setPresentedMaterialGroup(importedModel.group);
  }, [importedModel.group, importedModel.restoreStage]);
  useEffect(() => {
    document.body.dataset.atomicModelRevealObjectId = importedModel.objectId;
    document.body.dataset.atomicModelRevealStage = importedModel.restoreStage ?? 'imported';
    document.body.dataset.atomicModelRevealStatus = initialMaterialPresentationVisibleForGroup
      ? 'ready'
      : 'waiting';
  }, [
    importedModel.objectId,
    importedModel.restoreStage,
    initialMaterialPresentationVisibleForGroup,
  ]);
  useEffect(() => {
    if (!objectVisible || !workspaceVisible || !initialMaterialPresentationVisibleForGroup)
      return undefined;

    // React committing the primitive only means that it has entered the R3F
    // tree; it does not mean Chromium has presented the WebGL frame yet. Keep
    // the route loading cover in place until two presentation turns have
    // elapsed, so the first visible editor frame always contains bounds,
    // outline geometry, or the complete model instead of an empty viewport.
    let presentedFrame = 0;
    const committedFrame = window.requestAnimationFrame(() => {
      presentedFrame = window.requestAnimationFrame(() => {
        document.body.dataset.atomicModelRevealPainted = '1';
        document.body.dataset.atomicModelRevealPaintedObjectId = importedModel.objectId;
        window.dispatchEvent(
          new CustomEvent('liclick:initial-model-frame-presented', {
            detail: { objectId: importedModel.objectId },
          }),
        );
      });
    });
    return () => {
      window.cancelAnimationFrame(committedFrame);
      if (presentedFrame) window.cancelAnimationFrame(presentedFrame);
    };
  }, [
    importedModel.group,
    importedModel.objectId,
    initialMaterialPresentationVisibleForGroup,
    objectVisible,
    workspaceVisible,
  ]);
  const projectedTextureArrayBuildRef = useRef<{
    signature: string;
    cancelled: boolean;
    promise: Promise<THREE.ShaderMaterial | undefined>;
    precompilePromise?: Promise<void>;
  }>();
  const committedProjectedMaterialStructureRef = useRef('');
  // The authoritative projected material stays fully resident while geometry-only
  // or empty-layer views temporarily present the canonical white membrane. This
  // makes those views exact MeshStandardMaterial renders without paying a rebuild
  // when the user opens an eye again.
  const residentProjectedMaterialRef = useRef<THREE.ShaderMaterial>();
  const projectedProgramWarmupRef = useRef<{
    signature: string;
    material: THREE.ShaderMaterial;
    ready: boolean;
    disposeWhenReady: boolean;
  }>();
  const acquiredProjectedProgramSignaturesRef = useRef(new Set<string>());
  const projectedPreviewInteractionRef = useRef({ pointerDown: false, lastMovedAt: 0 });
  useEffect(() => {
    if (!workspaceVisible || !selected) return undefined;
    let cancelled = false;
    const prepare = async () => {
      await waitForProjectionVisibilityIdle(0);
      if (cancelled) return;
      try {
        await prepareRuntimeProjectionVisibilityMaterials(gl);
      } catch (error) {
        if (!cancelled) {
          console.warn(
            '[Liclick 3D Texture] Runtime projection visibility material warmup was incomplete:',
            error,
          );
        }
      }
    };
    void prepare();
    return () => {
      cancelled = true;
    };
  }, [gl, importedModel.objectId, selected, workspaceVisible]);
  useEffect(() => {
    // Restore the saved projection stack before rebuilding runtime depth and
    // normal textures. Starting both jobs together changes the material
    // signature during the first texture-array upload and can strand local
    // repaint in its disabled preparation state.
    if (
      !workspaceVisible ||
      !selected ||
      !texturedRestoreReady ||
      !initialProjectedMaterialReady
    )
      return undefined;
    let cancelled = false;
    const candidates = layers.filter((layer) => {
      if (
        layer.type !== 'projected' ||
        !layer.visible ||
        !layer.imageUrl ||
        !layer.camera ||
        (layer.objectId && layer.objectId !== importedModel.objectId)
      ) {
        return false;
      }
      const capture = layer.captureId ? captureById.get(layer.captureId) : undefined;
      const storedDepthUrl = layer.depthUrl ?? capture?.depthUrl;
      const storedDepthIsLinearView = layer.depthUrl
        ? layer.depthEncoding === 'linear-view'
        : capture?.depthEncoding === 'linear-view';
      // The authored depth is captured with the same frozen camera and object
      // matrix as the projected image. Replacing that valid 2K asset a second
      // later with a capped 1K runtime render creates the visible before/after
      // transition and quantises grazing boundaries. Only repair genuinely
      // missing or legacy visibility data in the background.
      return !(storedDepthUrl && storedDepthIsLinearView);
    });
    if (candidates.length === 0) {
      document.body.dataset.runtimeProjectionVisibilityStatus = 'stored';
      document.body.dataset.runtimeProjectionVisibilityTotal = '0';
      document.body.dataset.runtimeProjectionVisibilityCompleted = '0';
      return undefined;
    }

    void (async () => {
      const waitForInteractionIdle = async () => {
        while (!cancelled) {
          const interaction = projectedPreviewInteractionRef.current;
          const paintTool = useSceneStore.getState().paintTool;
          const busy =
            isSharedViewportInteractionBusy() ||
            interaction.pointerDown ||
            performance.now() - interaction.lastMovedAt < 180 ||
            document.body.dataset.perfSimulatedViewportInteraction === '1' ||
            document.body.dataset.perfViewportStressMeasuring === '1' ||
            paintTool === 'inpaint-add' ||
            paintTool === 'inpaint-subtract' ||
            paintTool === 'inpaint-apply';
          if (!busy) return;
          await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        }
      };
      const completedVisibility: Record<string, { depthUrl: string; normalUrl: string }> = {};
      document.body.dataset.runtimeProjectionVisibilityStatus = 'building';
      document.body.dataset.runtimeProjectionVisibilityTotal = String(candidates.length);
      for (let index = 0; index < candidates.length; index += 1) {
        const layer = candidates[index];
        // Missing/legacy visibility data is repaired with runtime depth only.
        // Publishing a flat per-triangle normal pass turns curved grazing
        // boundaries into a visible comb; depth remains the front-surface
        // authority for both ordinary projections and surface-locked repaint.
        await waitForProjectionVisibilityIdle(index === 0 ? 1000 : 32);
        await waitForInteractionIdle();
        if (cancelled) return;
        try {
          const capture = layer.captureId ? captureById.get(layer.captureId) : undefined;
          const previewSize = getRuntimeProjectionPreviewSize(
            capture?.width ?? 1024,
            capture?.height ?? 1024,
          );
          const visibility = await createRuntimeProjectionDepth({
            renderer: gl,
            group: importedModel.group,
            camera: layer.camera!,
            captureObjectMatrixWorld: layer.objectMatrixWorld,
            width: previewSize.width,
            height: previewSize.height,
            includeNormal: false,
            waitForViewportIdle: waitForInteractionIdle,
          });
          if (cancelled) return;
          completedVisibility[layer.id] = visibility;
          document.body.dataset.runtimeProjectionVisibilityCompleted = String(index + 1);
        } catch (error) {
          if (cancelled) return;
          console.error(
            `[Liclick 3D Texture] Could not build projection visibility depth for ${layer.name}.`,
            error,
          );
        }
      }
      if (cancelled || Object.keys(completedVisibility).length === 0) return;
      // Runtime depth/normal refinement is a background quality upgrade. Never
      // publish it while a brush or camera gesture is active: doing so replaces
      // and recompiles the complete projected material beside the live repaint
      // overlay, which can turn an otherwise hot first stroke into a long frame.
      await waitForInteractionIdle();
      if (cancelled) return;
      setRuntimeVisibilityByLayerId((current) => ({
        ...current,
        ...completedVisibility,
      }));
      document.body.dataset.runtimeProjectionVisibilityStatus = 'ready';
    })();
    return () => {
      cancelled = true;
    };
  }, [
    captureById,
    gl,
    importedModel,
    initialProjectedMaterialReady,
    layers,
    texturedRestoreReady,
    selected,
    workspaceVisible,
  ]);
  const importedObjectId = importedModel?.objectId;
  const liveProjectedEraserMaskTexture = useMemo(() => {
    if (
      liveSurfacePaintPreview?.target !== 'projected-mask' ||
      liveSurfacePaintPreview.composition !== 'multiply-original-mask' ||
      liveSurfacePaintPreview.objectId !== importedObjectId
    )
      return undefined;
    return getLiveProjectedCanvasTexture(liveSurfacePaintPreview.assetUrl, THREE.NoColorSpace, {
      flipY: false,
    });
  }, [importedObjectId, liveSurfacePaintPreview]);
  useLayoutEffect(() => {
    // Clearing a transient multiplier is a separate atomic handoff below. The
    // current resident material may still predate the first keep-mask sampler,
    // or an array may still contain the previous mask snapshot. Detaching here
    // would expose the unmasked/previous result until its replacement lands.
    if (!liveProjectedEraserMaskTexture) return;
    const layerId = liveSurfacePaintPreview?.layerId;
    if (
      syncProjectedLayerLiveEraserPreviewInObject(
        importedModel.group,
        layerId,
        liveProjectedEraserMaskTexture,
      )
    ) {
      invalidate();
    }
  }, [importedModel, invalidate, liveProjectedEraserMaskTexture, liveSurfacePaintPreview?.layerId]);
  const visibleProjectedLayers = useMemo(() => {
    if (!texturedRestoreReady) return [];
    const storedLayers = (
      importedObjectId ? getVisibleProjectedLayerStack(layers, importedObjectId) : []
    )
      .filter((layer) => isProjectedLayerAboveMergedUv(layer, visibleMergedUvBoundaryOrder))
      .map((layer) =>
        applyLiveProjectedMaskBinding(layer, liveSurfacePaintPreview, importedObjectId),
      );
    return storedLayers;
  }, [
    importedObjectId,
    layers,
    liveSurfacePaintPreview,
    texturedRestoreReady,
    visibleMergedUvBoundaryOrder,
  ]);
  const visibleProjectedLayerSignature = useMemo(
    () => layerStackPreviewSignature(visibleProjectedLayers),
    [visibleProjectedLayers],
  );
  const stableVisibleProjectedLayers = useStableValueBySignature(
    visibleProjectedLayers,
    visibleProjectedLayerSignature,
  );
  const lastProjectedTransformRef = useRef<THREE.Matrix4>();
  const lastProjectedSamplerWarningRef = useRef('');
  const activatedLocalRepaintPreviewKeyRef = useRef('');
  const projectedPreviewCompositorRef = useRef<ProjectedLayerPreviewCompositor>();
  const [progressiveProjectedPreview, setProgressiveProjectedPreview] =
    useState<ProjectedPreviewComposite>();
  const [failedProjectedTextureArraySignature, setFailedProjectedTextureArraySignature] =
    useState('');
  const allPreviewProjectedLayers = useMemo(() => {
    if (!texturedRestoreReady) return [];
    const projectedCandidates = layers.filter(
      (layer) =>
        layer.type === 'projected' &&
        layer.visible &&
        // Unpublished strokes stay renderer-only. Once published, warm their
        // muted resident row during pointer idle, before the next handoff.
        layer.id !== transientLocalRepaintPreviewLayerId &&
        layer.imageUrl &&
        layer.camera &&
        (!layer.objectId || layer.objectId === importedObjectId) &&
        isProjectedLayerAboveMergedUv(layer, visibleMergedUvBoundaryOrder),
    );
    const storedLayers = projectedCandidates
      // Hidden projections contribute zero pixels, so exclude their 4K samplers
      // from the active shader. Eye-open rebuilds the same authoritative layer;
      // visible colour and composition remain exact.
      // Layer order 0 is the top row in the panel. Feed the shader bottom-up so
      // later overlay evaluations preserve that visible stacking order.
      .sort((a, b) => b.order - a.order)
      .map((layer) =>
        applyLiveProjectedMaskBinding(layer, liveSurfacePaintPreview, importedObjectId),
      );
    return storedLayers;
  }, [
    importedObjectId,
    layers,
    liveSurfacePaintPreview,
    transientLocalRepaintPreviewLayerId,
    texturedRestoreReady,
    visibleMergedUvBoundaryOrder,
  ]);
  const projectedDisplayCapacity = projectionDisplayCapacity(gl.capabilities.maxFragmentUniforms);
  const previewProjectedLayers = useMemo(
    () => allPreviewProjectedLayers.slice(0, projectedDisplayCapacity),
    [allPreviewProjectedLayers, projectedDisplayCapacity],
  );
  useEffect(() => {
    if (!importedObjectId) return;
    publishPendingProjectionLayers(importedObjectId,
      allPreviewProjectedLayers.slice(projectedDisplayCapacity).map((layer) => layer.id));
    return () => publishPendingProjectionLayers(importedObjectId, []);
  }, [importedObjectId, allPreviewProjectedLayers, projectedDisplayCapacity]);
  const previewProjectedLayerSignature = useMemo(
    () => layerStackPreviewSignature(previewProjectedLayers),
    [previewProjectedLayers],
  );
  const stablePreviewProjectedLayers = useStableValueBySignature(
    previewProjectedLayers,
    previewProjectedLayerSignature,
  );
  const projectedProgramWarmupLayers = useMemo(() => {
    // Warm only the exact visible structure. Compiling hidden 4K projection
    // samplers on every workspace/model switch created driver long tasks while
    // producing no pixels.
    const residentLayers = layers
      .filter(
        (layer) =>
          layer.type === 'projected' &&
          layer.visible &&
          layer.id !== transientLocalRepaintPreviewLayerId &&
          layer.imageUrl &&
          layer.camera &&
          (!layer.objectId || layer.objectId === importedObjectId) &&
          isProjectedLayerAboveMergedUv(layer, visibleMergedUvBoundaryOrder),
      )
      .sort((left, right) => right.order - left.order)
      .map((layer) =>
        applyLiveProjectedMaskBinding(layer, liveSurfacePaintPreview, importedObjectId),
      );
    return residentLayers;
  }, [
    importedObjectId,
    layers,
    liveSurfacePaintPreview,
    transientLocalRepaintPreviewLayerId,
    visibleMergedUvBoundaryOrder,
  ]);
  const projectedProgramWarmupInputs = useMemo<ProjectionLayerStackInput['layers']>(
    () =>
      projectedProgramWarmupLayers.map((layer) => {
        const capture = layer.captureId ? captureById.get(layer.captureId) : undefined;
        const projectionMask = resolveProjectionMask(layer, capture);
        const localRepaint = isRenderedLocalRepaintLayer(layer);
        const storedDepthUrl = layer.depthUrl ?? capture?.depthUrl;
        const storedDepthIsLinearView = layer.depthUrl
          ? layer.depthEncoding === 'linear-view'
          : capture?.depthEncoding === 'linear-view';
        const runtimeVisibility =
          storedDepthUrl && storedDepthIsLinearView
            ? undefined
            : runtimeVisibilityByLayerId[layer.id];
        const depthUrl = runtimeVisibility?.depthUrl ?? storedDepthUrl;
        const normalUrl = localRepaint ? undefined : runtimeVisibility?.normalUrl;
        return {
          layerId: layer.id,
          imageUrl: layer.imageUrl!,
          maskUrl: projectionMask.maskUrl,
          maskSpace: projectionMask.maskSpace,
          depthUrl,
          depthIsLinearView:
            Boolean(runtimeVisibility?.depthUrl) ||
            layer.depthEncoding === 'linear-view' ||
            capture?.depthEncoding === 'linear-view',
          normalUrl,
          camera: layer.camera!,
          objectMatrixWorld: layer.objectMatrixWorld,
          opacity: layer.opacity,
          strength: layer.strength ?? 1,
          blendMode: isOverlayProjectionPatch(layer) ? 'overlay' : layer.blendMode,
          compositeRole: getProjectionCompositeRole(layer),
          visible:
            layer.visible &&
            layer.id !== rendererOwnedLocalRepaintPreviewLayerId &&
            isProjectedLayerAboveMergedUv(layer, visibleMergedUvBoundaryOrder),
          hue: (layer.adjustments?.hue ?? 0) / 100,
          saturation: (layer.adjustments?.saturation ?? 0) / 100,
          lightness: (layer.adjustments?.lightness ?? 0) / 100,
          useMask: shouldUseProjectionCaptureMask(
            layer,
            projectionMask.maskUrl,
            depthUrl,
            localRepaint,
          ),
          useDepthCheck: Boolean(depthUrl),
          useNormalCheck: !localRepaint && Boolean(normalUrl),
          ignoreSourceAlpha: layer.ignoreSourceAlpha ?? localRepaint,
          renderedColor: usesUnlitRenderedColor(layer),
          minimumProjectionFacing: layer.minimumProjectionFacing,
          projectionVisibilityPolicy:
            layer.projectionVisibilityPolicy ??
            (isRenderedLocalRepaintLayer(layer) ? 'surface-locked-v1' : 'standard'),
        };
      }),
    [
      captureById,
      rendererOwnedLocalRepaintPreviewLayerId,
      projectedProgramWarmupLayers,
      runtimeVisibilityByLayerId,
      visibleMergedUvBoundaryOrder,
    ],
  );
  const previewProjectionInputs = useMemo(
    () =>
      stablePreviewProjectedLayers.map((layer) => {
        const capture = layer.captureId ? captureById.get(layer.captureId) : undefined;
        const projectionMask = resolveProjectionMask(layer, capture);
        const localRepaint = isRenderedLocalRepaintLayer(layer);
        const storedDepthUrl = layer.depthUrl ?? capture?.depthUrl;
        const storedDepthIsLinearView = layer.depthUrl
          ? layer.depthEncoding === 'linear-view'
          : capture?.depthEncoding === 'linear-view';
        const runtimeVisibility =
          storedDepthUrl && storedDepthIsLinearView
            ? undefined
            : runtimeVisibilityByLayerId[layer.id];
        const depthUrl = runtimeVisibility?.depthUrl ?? storedDepthUrl;
        // Capture normals are generation guidance, not coverage authority.
        // Runtime normal visibility is deliberately opt-in and ordinary saved
        // projections remain on their authored depth for their whole lifetime.
        const normalUrl = localRepaint ? undefined : runtimeVisibility?.normalUrl;
        return {
          layerId: layer.id,
          imageUrl: layer.imageUrl,
          maskUrl: projectionMask.maskUrl,
          maskSpace: projectionMask.maskSpace,
          depthUrl,
          depthIsLinearView:
            Boolean(runtimeVisibility?.depthUrl) ||
            layer.depthEncoding === 'linear-view' ||
            capture?.depthEncoding === 'linear-view',
          normalUrl,
          camera: layer.camera!,
          objectMatrixWorld: layer.objectMatrixWorld,
          opacity: layer.opacity,
          strength: layer.strength ?? 1,
          // Local repaint layers patch the visible projection rather than competing
          // as another base projection, including legacy saved repaint layers.
          blendMode: isOverlayProjectionPatch(layer) ? 'overlay' : layer.blendMode,
          compositeRole: getProjectionCompositeRole(layer),
          // Keep the projection visible while the exact runtime visibility pass
          // is preparing. The stored depth (when present) remains a valid fallback.
          visible:
            layer.visible &&
            layer.id !== rendererOwnedLocalRepaintPreviewLayerId &&
            isProjectedLayerAboveMergedUv(layer, visibleMergedUvBoundaryOrder),
          hue: (layer.adjustments?.hue ?? 0) / 100,
          saturation: (layer.adjustments?.saturation ?? 0) / 100,
          lightness: (layer.adjustments?.lightness ?? 0) / 100,
          useMask: shouldUseProjectionCaptureMask(
            layer,
            projectionMask.maskUrl,
            depthUrl,
            localRepaint,
          ),
          useDepthCheck: Boolean(depthUrl),
          useNormalCheck: !localRepaint && Boolean(normalUrl),
          ignoreSourceAlpha: layer.ignoreSourceAlpha ?? localRepaint,
          renderedColor: usesUnlitRenderedColor(layer),
          minimumProjectionFacing: layer.minimumProjectionFacing,
          projectionVisibilityPolicy:
            layer.projectionVisibilityPolicy ??
            (isRenderedLocalRepaintLayer(layer) ? 'surface-locked-v1' : 'standard'),
        };
      }),
    [
      captureById,
      rendererOwnedLocalRepaintPreviewLayerId,
      runtimeVisibilityByLayerId,
      stablePreviewProjectedLayers,
      visibleMergedUvBoundaryOrder,
    ],
  );
  useEffect(() => {
    const unsubscribe = useLayerStore.subscribe((state, previousState) => {
      if (
        importedModelLayerDisplaySignature(state.layers, importedModel.objectId) ===
        importedModelLayerDisplaySignature(previousState.layers, importedModel.objectId)
      )
        return;
      const startedAt = performance.now();
      const currentPreviewLayer = useSceneStore.getState().localRepaintPreviewLayer;
      const mutedPreviewLayerId = currentPreviewLayer
        ? shouldMuteLocalRepaintResidentLayer(
            state.layers,
            currentPreviewLayer,
            currentPreviewLayer.id,
            useSceneStore.getState().paintTool === 'inpaint-apply',
          )
          ? currentPreviewLayer.id
          : undefined
        : undefined;
      const currentMergedUvBoundaryOrder = getVisibleMergedUvBoundaryOrder(
        state.layers,
        importedModel.objectId,
      );
      const displayLayers = state.layers
        .filter(
          (layer) =>
            layer.type === 'projected' &&
            (!layer.objectId || layer.objectId === importedModel.objectId),
        )
        .map((layer) => ({
          ...toProjectionLayerDisplayInput(layer),
          // Only the currently edited repaint is presented by the renderer-owned
          // low-latency overlay. Historical repaint rows remain authoritative in
          // the resident stack and must recover their stored visibility/opacity.
          visible:
            layer.visible &&
            layer.id !== mutedPreviewLayerId &&
            isProjectedLayerAboveMergedUv(layer, currentMergedUvBoundaryOrder),
        }));
      const currentDisplayMode = useSceneStore.getState().displayMode;
      const currentSettings = useSettingsStore.getState();
      const previousLayerVisibilityById = new Map(
        previousState.layers.map((layer) => [layer.id, layer.visible] as const),
      );
      const previousLayerById = new Map(
        previousState.layers.map((layer) => [layer.id, layer] as const),
      );
      const objectUvLayers = state.layers.filter(
        (layer) =>
          layer.type === 'uv' &&
          Boolean(layer.imageUrl) &&
          (!layer.objectId || layer.objectId === importedModel.objectId),
      );
      const reopenedUvLayer = objectUvLayers.some(
        (layer) => layer.visible && previousLayerVisibilityById.get(layer.id) === false,
      );
      const reopenedProjectedLayer = state.layers.some(
        (layer) =>
          layer.type === 'projected' &&
          layer.visible &&
          previousLayerVisibilityById.get(layer.id) === false &&
          (!layer.objectId || layer.objectId === importedModel.objectId),
      );
      const visibleUvContentChanged = objectUvLayers.some((layer) => {
        if (!layer.visible) return false;
        const previousLayer = previousLayerById.get(layer.id);
        return (
          !previousLayer ||
          previousLayer.imageUrl !== layer.imageUrl ||
          previousLayer.contentRevision !== layer.contentRevision ||
          previousLayer.role !== layer.role
        );
      });
      const visibleProjectedContentChanged = state.layers.some((layer) => {
        if (
          layer.type !== 'projected' ||
          !layer.visible ||
          (layer.objectId && layer.objectId !== importedModel.objectId)
        )
          return false;
        const previousLayer = previousLayerById.get(layer.id);
        return (
          !previousLayer ||
          previousLayer.imageUrl !== layer.imageUrl ||
          previousLayer.maskUrl !== layer.maskUrl ||
          previousLayer.depthUrl !== layer.depthUrl ||
          previousLayer.contentRevision !== layer.contentRevision ||
          previousLayer.role !== layer.role
        );
      });
      const visibleOrdinaryUvLayers = objectUvLayers.filter(
        (layer) =>
          layer.visible &&
          layer.role !== 'content-aware-underlay' &&
          layer.role !== 'local-repaint-overlay' &&
          layer.role !== 'local-repaint-draft',
      );
      const visibleLocalRepaintUvLayers = objectUvLayers.filter(
        (layer) =>
          layer.visible &&
          (layer.role === 'local-repaint-overlay' || layer.role === 'local-repaint-draft'),
      );
      const visibleContentAwareUvLayers = objectUvLayers.filter(
        (layer) => layer.visible && layer.role === 'content-aware-underlay',
      );
      const residentContentAwareTexture =
        visibleContentAwareUvLayers.length === 1
          ? getReadyResidentPreviewTexture(visibleContentAwareUvLayers[0].imageUrl, gl)
          : undefined;
      const previousContentAwarePresentation = contentAwareUnderlayPresentationRef.current;
      const contentAwareTexture =
        residentContentAwareTexture ??
        (visibleContentAwareUvLayers.length > 0 && previousContentAwarePresentation.opacity > 0
          ? previousContentAwarePresentation.texture
          : undefined);
      const contentAwareOpacity =
        visibleContentAwareUvLayers.length === 0
          ? 0
          : residentContentAwareTexture
            ? visibleContentAwareUvLayers[0].opacity
            : previousContentAwarePresentation.opacity > 0
              ? previousContentAwarePresentation.opacity
              : undefined;
      contentAwareUnderlayPresentationRef.current = {
        texture: contentAwareTexture,
        opacity: contentAwareOpacity ?? 0,
      };
      const residentSingleUvTexture =
        visibleOrdinaryUvLayers.length === 1
          ? getReadyResidentPreviewTexture(visibleOrdinaryUvLayers[0].imageUrl, gl)
          : undefined;
      const visibleUvKey = residentUvVisibilityKey(visibleOrdinaryUvLayers);
      const residentCompositeUvTexture =
        visibleOrdinaryUvLayers.length > 1
          ? residentUvPresentationCacheRef.current.get(visibleUvKey)
          : undefined;
      const residentUvTexture = residentSingleUvTexture ?? residentCompositeUvTexture;
      // With multiple repaint rows, the lower rows occupy the ordinary UV
      // sampler too. Their exact composite is owned by the React presentation.
      const hasLowerRepaintUv = visibleLocalRepaintUvLayers.length > 1;
      let requiresMaterialReconciliation = false;
      if (
        visibleOrdinaryUvLayers.length > 0 &&
        !residentUvTexture &&
        pendingUvVisibilityRenderKeyRef.current !== visibleUvKey
      ) {
        pendingUvVisibilityRenderKeyRef.current = visibleUvKey;
        requiresMaterialReconciliation = true;
      }
      const uvMaterialUpdated = syncProjectedLayerResidentTextureVisibilityInObject(
        importedModel.group,
        {
          ...(residentUvTexture && !hasLowerRepaintUv
            ? { uvOverlayTexture: residentUvTexture }
            : {}),
          // A composed editing stack must stay unlit when it contains any layer
          // other than the final merged UV. The direct single-layer path below
          // preserves PBR for role=merged-uv.
          uvOverlayRenderedColor: hasLowerRepaintUv
            ? uvPresentationRef.current.renderedColor
            : visibleOrdinaryUvLayers.some(usesUnlitRenderedColor),
          ...(contentAwareTexture ? { baseTexture: contentAwareTexture } : {}),
          ...(hasLowerRepaintUv
            ? {}
            : residentUvTexture
              ? {
                  uvOverlayOpacity:
                    visibleOrdinaryUvLayers.length === 1 ? visibleOrdinaryUvLayers[0].opacity : 1,
                }
              : visibleOrdinaryUvLayers.length === 0
                ? { uvOverlayOpacity: 0 }
                : {}),
          uvOverlayBelowProjected: Number.isFinite(currentMergedUvBoundaryOrder),
          topUvOverlayOpacity: visibleLocalRepaintUvLayers[0]?.opacity ?? 0,
          // A multi-layer repair presentation is composed asynchronously below.
          // Do not clear the last valid base texture while that exact composite is
          // decoding/uploading; its owner effect will atomically publish the pair.
          baseTextureOpacity: contentAwareOpacity,
        },
      );
      const projectedMaterialUpdated = syncProjectedLayerMaterialDisplayStateInObject(
        importedModel.group,
        displayLayers,
        currentDisplayMode === 'normal',
        currentDisplayMode === 'wire',
        getPreviewLighting({
          displayMode: currentDisplayMode,
          environmentPreset: currentSettings.environmentPreset,
          exposure: currentSettings.exposure,
          pbrEnvironmentIntensity: currentSettings.pbrEnvironmentIntensity,
          pbrKeyLightIntensity: currentSettings.pbrKeyLightIntensity,
          pbrLightAzimuth: currentSettings.pbrLightAzimuth,
        }),
      );
      const hasVisibleUvContribution =
        visibleOrdinaryUvLayers.length > 0 ||
        visibleLocalRepaintUvLayers.length > 0 ||
        visibleContentAwareUvLayers.length > 0;
      const hasVisibleProjectedContribution = displayLayers.some((layer) => layer.visible);
      if (
        reopenedUvLayer ||
        // Repaint routing and mixed lower composites need an exact rebind on
        // either eye direction; a uniform cannot remove one composite member.
        objectUvLayers.some((layer) =>
          (hasLowerRepaintUv || isRenderedLocalRepaintLayer(layer)) &&
          previousLayerVisibilityById.get(layer.id) !== layer.visible,
        ) ||
        reopenedProjectedLayer ||
        visibleUvContentChanged ||
        visibleProjectedContentChanged
      ) {
        requiresMaterialReconciliation = true;
      }
      // Visibility normally stays on the zero-allocation uniform path. A cold
      // restore with every eye closed is the one state where there is no
      // resident shader on the model to receive those uniforms: the viewport
      // intentionally presents a MeshStandardMaterial white membrane. If an
      // eye opens in that state, schedule exactly one React material pass so
      // the already-resident UV texture or projected stack can be attached.
      // Without this fallback the store and eye icon update correctly while
      // every uniform sync is sent to a material that has no matching uniforms,
      // leaving the model white until another structural layer change occurs.
      if (
        (hasVisibleUvContribution && !uvMaterialUpdated) ||
        (hasVisibleProjectedContribution && !projectedMaterialUpdated)
      ) {
        requiresMaterialReconciliation = true;
      }
      if (requiresMaterialReconciliation) {
        setUvVisibilityRenderRevision((revision) => revision + 1);
      }
      invalidate();
      document.body.dataset.projectedDisplayPath = 'uniform';
      document.body.dataset.projectedDisplayUniformMs = String(
        Math.round((performance.now() - startedAt) * 100) / 100,
      );
    });
    return () => {
      unsubscribe();
    };
  }, [gl, importedModel, invalidate, localRepaintPreviewLayerId]);
  useEffect(() => {
    // Display-mode buttons are latency-sensitive too. React effects can land a
    // frame or two after the Zustand write under a busy 4K viewport, leaving
    // normal/wire uniforms briefly stale. Mirror the store change directly to
    // the resident material; this changes uniforms only and never recompiles.
    const unsubscribe = useSceneStore.subscribe((state, previousState) => {
      if (state.displayMode === previousState.displayMode) return;
      const currentLayers = useLayerStore.getState().layers;
      const currentMergedUvBoundaryOrder = getVisibleMergedUvBoundaryOrder(
        currentLayers,
        importedModel.objectId,
      );
      const displayLayers = currentLayers
        .filter(
          (layer) =>
            layer.type === 'projected' &&
            (!layer.objectId || layer.objectId === importedModel.objectId),
        )
        .map((layer) => ({
          ...toProjectionLayerDisplayInput(layer),
          visible:
            layer.visible &&
            !shouldMuteLocalRepaintResidentLayer(
              currentLayers,
              useSceneStore.getState().localRepaintPreviewLayer,
              layer.id,
              useSceneStore.getState().paintTool === 'inpaint-apply',
            ) &&
            isProjectedLayerAboveMergedUv(layer, currentMergedUvBoundaryOrder),
        }));
      const settings = useSettingsStore.getState();
      syncProjectedLayerMaterialDisplayStateInObject(
        importedModel.group,
        displayLayers,
        state.displayMode === 'normal',
        state.displayMode === 'wire',
        getPreviewLighting({
          displayMode: state.displayMode,
          environmentPreset: settings.environmentPreset,
          exposure: settings.exposure,
          pbrEnvironmentIntensity: settings.pbrEnvironmentIntensity,
          pbrKeyLightIntensity: settings.pbrKeyLightIntensity,
          pbrLightAzimuth: settings.pbrLightAzimuth,
        }),
      );
      invalidate();
    });
    return unsubscribe;
  }, [importedModel, invalidate]);
  useLayoutEffect(() => {
    // Changing repaint generations changes only SceneStore renderer ownership;
    // LayerStore itself may be unchanged. Re-publish every resident projected
    // layer so the previous generation is immediately unmuted in the background.
    const sceneState = useSceneStore.getState();
    const settings = useSettingsStore.getState();
    const currentLayers = useLayerStore.getState().layers;
    const currentMergedUvBoundaryOrder = getVisibleMergedUvBoundaryOrder(
      currentLayers,
      importedModel.objectId,
    );
    const displayLayers = currentLayers
      .filter(
        (layer) =>
          layer.type === 'projected' &&
          (!layer.objectId || layer.objectId === importedModel.objectId),
      )
      .map((layer) => ({
        ...toProjectionLayerDisplayInput(layer),
        visible:
          layer.visible &&
          layer.id !== rendererOwnedLocalRepaintPreviewLayerId &&
          isProjectedLayerAboveMergedUv(layer, currentMergedUvBoundaryOrder),
      }));
    syncProjectedLayerMaterialDisplayStateInObject(
      importedModel.group,
      displayLayers,
      sceneState.displayMode === 'normal',
      sceneState.displayMode === 'wire',
      getPreviewLighting({
        displayMode: sceneState.displayMode,
        environmentPreset: settings.environmentPreset,
        exposure: settings.exposure,
        pbrEnvironmentIntensity: settings.pbrEnvironmentIntensity,
        pbrKeyLightIntensity: settings.pbrKeyLightIntensity,
        pbrLightAzimuth: settings.pbrLightAzimuth,
      }),
    );
    invalidate();
  }, [importedModel, invalidate, rendererOwnedLocalRepaintPreviewLayerId]);
  const contentAwareUvUnderlayLayers = useMemo(() => {
    // The signature is an intentional recompute token for relevant LayerStore
    // fields while the source rows are read atomically from getState().
    if (!contentAwareLayerDisplaySignature && useLayerStore.getState().layers.length === 0) {
      return [];
    }
    const liveLayers = useLayerStore.getState().layers;
    return texturedRestoreReady
      ? liveLayers.filter(
          (layer) =>
            layer.type === 'uv' &&
            layer.role === 'content-aware-underlay' &&
            Boolean(layer.imageUrl) &&
            (!layer.objectId || layer.objectId === importedObjectId),
        )
      : [];
  }, [contentAwareLayerDisplaySignature, importedObjectId, texturedRestoreReady]);
  const visibleContentAwareUvUnderlayLayers = useMemo(
    () => contentAwareUvUnderlayLayers.filter((layer) => layer.visible),
    [contentAwareUvUnderlayLayers],
  );
  // A project can contain several repair passes, but an eye toggle commonly
  // leaves exactly one visible. Present that sparse image directly from the
  // resident cache instead of scheduling a new UV composition for the same
  // pixels. Multiple visible passes still use the exact authored-order
  // compositor, so the shortcut changes neither blending nor output quality.
  const residentContentAwareUvUnderlayLayer =
    visibleContentAwareUvUnderlayLayers.length === 1
      ? visibleContentAwareUvUnderlayLayers[0]
      : contentAwareUvUnderlayLayers.length === 1
        ? contentAwareUvUnderlayLayers[0]
        : undefined;
  const visibleCompositedContentAwareUvUnderlayLayers = useMemo(
    () => (residentContentAwareUvUnderlayLayer ? [] : visibleContentAwareUvUnderlayLayers),
    [residentContentAwareUvUnderlayLayer, visibleContentAwareUvUnderlayLayers],
  );
  const residentDirectUvLayer = useMemo(() => {
    if (!texturedRestoreReady) return undefined;
    const candidates = layers.filter(
      (layer) =>
        layer.type === 'uv' &&
        layer.role !== 'content-aware-underlay' &&
        layer.role !== 'local-repaint-overlay' &&
        Boolean(layer.imageUrl) &&
        (!layer.objectId || layer.objectId === importedObjectId),
    );
    return candidates.length === 1 ? candidates[0] : undefined;
  }, [importedObjectId, layers, texturedRestoreReady]);
  const residentUvToggleLayers = useMemo(
    () =>
      layers
        .filter(
          (layer) =>
            layer.type === 'uv' &&
            layer.role !== 'local-repaint-overlay' &&
            layer.role !== 'local-repaint-draft' &&
            Boolean(layer.imageUrl) &&
            (!layer.objectId || layer.objectId === importedObjectId) &&
            // Hidden rows are speculative: warming them automatically can
            // launch a full-resolution composition after the UI is already
            // interactive and then stall a later zoom/workspace switch. The
            // visible stack is the only texture required for the current
            // frame; a hidden row is prepared on demand if the user enables it.
            layer.visible,
        )
        .sort((left, right) => {
          const priority = (layer: Layer) =>
            layer.role === 'content-aware-underlay' ? 0 : layer.visible ? 1 : 2;
          return priority(left) - priority(right) || left.order - right.order;
        })
        .slice(0, MAX_RESIDENT_UV_TOGGLE_TEXTURES),
    [importedObjectId, layers],
  );
  const residentUvToggleSignature = useMemo(
    () => residentUvToggleLayers.map((layer) => `${layer.id}:${layer.imageUrl}`).join('|'),
    [residentUvToggleLayers],
  );
  const stableResidentUvToggleLayers = useStableValueBySignature(
    residentUvToggleLayers,
    residentUvToggleSignature,
  );
  const [residentUvTogglePrewarmReady, setResidentUvTogglePrewarmReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const startedAt = performance.now();
    setResidentUvTogglePrewarmReady(false);
    document.body.dataset.residentUvTogglePrewarmStartedMs = startedAt.toFixed(1);
    const warm = async () => {
      const visibleLayers = stableResidentUvToggleLayers.filter((layer) => layer.visible);
      const hiddenLayers = stableResidentUvToggleLayers.filter((layer) => !layer.visible);
      const uploadLayers = async (targetLayers: Layer[]) => {
        const imageUrls = targetLayers.flatMap((layer) => (layer.imageUrl ? [layer.imageUrl] : []));
        if (imageUrls.length === 0) return !cancelled;
        // Pin every decoded worker bitmap until the complete group has uploaded.
        // Promise.all decode without transaction pinning let a sibling model's
        // cache trim release early stripes before this loop consumed them.
        const results = await prewarmPreviewTextures(imageUrls, {
          maxSize: proxyTextureMaxSize,
        });
        if (cancelled) return false;
        const failed = results.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
        return true;
      };

      // User-visible restore and hidden eye-toggle prewarming are different
      // completion states. Publish the exact visible set first; hidden layers
      // keep warming at the same conservative per-frame budget afterwards.
      if (!(await uploadLayers(visibleLayers))) return;
      document.body.dataset.residentUvVisiblePrewarmCount = String(visibleLayers.length);
      document.body.dataset.residentUvVisiblePrewarmMs = (performance.now() - startedAt).toFixed(1);
      if (visibleLayers.length > 0) {
        document.body.dataset.textureRestoreUvReady = '1';
        document.body.dataset.textureRestoreUvReadyMs = performance.now().toFixed(1);
      }

      if (!(await uploadLayers(hiddenLayers))) return;
      document.body.dataset.residentUvToggleTextureCount = String(
        stableResidentUvToggleLayers.length,
      );
      document.body.dataset.residentUvTogglePrewarmMs = (performance.now() - startedAt).toFixed(1);
      document.body.dataset.residentUvToggleReady = '1';
      setResidentUvTogglePrewarmReady(true);
    };
    document.body.dataset.residentUvToggleReady = '0';
    void warm().catch((error) => {
      if (!cancelled)
        console.warn('[Liclick 3D Texture] UV toggle texture prewarm was incomplete:', error);
    });
    return () => {
      cancelled = true;
    };
  }, [gl, proxyTextureMaxSize, residentUvToggleSignature, stableResidentUvToggleLayers]);
  // Reserve the UV handoff sampler in the initial projected material. The first
  // projected-to-UV conversion can then bind its already-uploaded texture and
  // hide the source projections in one commit, without compiling a replacement
  // shader whose placeholder sampler would be visible as a white membrane.
  const hasResidentUvOverlaySampler = true;
  const directProjectedSamplerBudget = useMemo(
    () =>
      getProjectedLayerSamplerBudget(previewProjectionInputs, gl.capabilities.maxTextures, {
        useBaseMap: true,
        useUvOverlayMap: hasResidentUvOverlaySampler,
      }),
    [gl.capabilities.maxTextures, hasResidentUvOverlaySampler, previewProjectionInputs],
  );
  const projectedTextureArraySamplerBudget = useMemo(
    () =>
      getProjectedLayerSamplerBudget(previewProjectionInputs, gl.capabilities.maxTextures, {
        useBaseMap: true,
        useUvOverlayMap: hasResidentUvOverlaySampler,
        useTextureArrays: true,
      }),
    [gl.capabilities.maxTextures, hasResidentUvOverlaySampler, previewProjectionInputs],
  );
  const projectedProgramWarmupDirectSamplerBudget = useMemo(
    () =>
      getProjectedLayerSamplerBudget(projectedProgramWarmupInputs, gl.capabilities.maxTextures, {
        useBaseMap: true,
        useUvOverlayMap: hasResidentUvOverlaySampler,
      }),
    [gl.capabilities.maxTextures, hasResidentUvOverlaySampler, projectedProgramWarmupInputs],
  );
  const projectedProgramWarmupArraySamplerBudget = useMemo(
    () =>
      getProjectedLayerSamplerBudget(projectedProgramWarmupInputs, gl.capabilities.maxTextures, {
        useBaseMap: true,
        useUvOverlayMap: hasResidentUvOverlaySampler,
        useTextureArrays: true,
      }),
    [gl.capabilities.maxTextures, hasResidentUvOverlaySampler, projectedProgramWarmupInputs],
  );
  const directProjectedSamplerHeadroom = Math.max(
    1,
    Math.floor(gl.capabilities.maxTextures * PROJECTED_ARRAY_DIRECT_SAMPLER_HEADROOM_RATIO),
  );
  const directProjectedSamplerStable = Boolean(
    directProjectedSamplerBudget.withinBudget &&
    directProjectedSamplerBudget.required < directProjectedSamplerHeadroom,
  );
  const useProjectedTextureArrays = Boolean(
    gl.capabilities.isWebGL2 &&
    previewProjectionInputs.length > 1 &&
    projectedTextureArraySamplerBudget.withinBudget &&
    !directProjectedSamplerStable,
  );
  const projectedProgramWarmupDirectStable = Boolean(
    projectedProgramWarmupDirectSamplerBudget.withinBudget &&
    projectedProgramWarmupDirectSamplerBudget.required < directProjectedSamplerHeadroom,
  );
  const useProjectedProgramWarmupTextureArrays = Boolean(
    gl.capabilities.isWebGL2 &&
    projectedProgramWarmupInputs.length > 1 &&
    projectedProgramWarmupArraySamplerBudget.withinBudget &&
    !projectedProgramWarmupDirectStable,
  );
  const projectedTextureArrayStructureSignature = useMemo(
    () =>
      previewProjectionInputs
        .map((layer) =>
          [
            layer.layerId,
            layer.imageUrl,
            layer.maskUrl ?? '',
            useProjectedTextureArrays
              ? liveProjectedMaskRevisionSignature(layer.maskUrl)
              : '',
            layer.depthUrl ?? '',
            layer.normalUrl ?? '',
            layer.maskSpace ?? 'projection',
            layer.useMask ? 1 : 0,
            layer.useDepthCheck ? 1 : 0,
            layer.useNormalCheck ? 1 : 0,
            layer.compositeRole ?? 'normal',
            layer.objectMatrixWorld?.join(',') ?? '',
            layer.camera.viewMatrix?.join(',') ?? '',
            layer.camera.projectionMatrix?.join(',') ?? '',
          ].join('~'),
        )
        .join('|'),
    [previewProjectionInputs, useProjectedTextureArrays],
  );
  const projectedSamplerBudget = useProjectedTextureArrays
    ? projectedTextureArraySamplerBudget
    : directProjectedSamplerBudget;
  const textureArrayCompositionFallbackRequired = Boolean(
    useProjectedTextureArrays &&
    projectedTextureArrayStructureSignature &&
    (failedProjectedTextureArraySignature === projectedTextureArrayStructureSignature ||
      !isProjectedUniformBudgetSafe(previewProjectionInputs.length, gl.capabilities.maxFragmentUniforms)),
  );
  const canUseDirectVisibleStackAfterArrayFailure = Boolean(
    // Once the array path has failed, correctness is more important than the
    // normal headroom preference. A six-view image+depth stack needs most of the
    // 16 available samplers on common WebGL2 devices and is still a valid exact
    // material. Sending it to the progressive compositor instead can leave the
    // last UV/bootstrap material resident if that asynchronous publication is
    // superseded by an eye toggle or eraser clear.
    textureArrayCompositionFallbackRequired && directProjectedSamplerBudget.withinBudget &&
    isProjectedUniformBudgetSafe(previewProjectionInputs.length, gl.capabilities.maxFragmentUniforms),
  );
  // Prefer an exact projected material. If the device still rejects a downscaled
  // array, preserve every visible layer through the tiled compositor rather than
  // dropping layers. UV-safe imports may use this path proactively as before.
  const canUseProgressiveUvFallback = Boolean(
    false,
  );
  const projectedPreviewNeedsComposition = Boolean(
    !projectedSamplerBudget.withinBudget ||
    (textureArrayCompositionFallbackRequired && !canUseDirectVisibleStackAfterArrayFailure),
  );
  // Selection is only a compositor input when that fallback is enabled. An
  // unused active-row array must not restart the resident material effect.
  const progressiveActiveLayerId = canUseProgressiveUvFallback ? activeLayerId : undefined;
  const activeProjectedPreviewInputs = useMemo(() => {
    const active = previewProjectionInputs.find(
      (layer) => layer.layerId === progressiveActiveLayerId && layer.visible,
    );
    return active ? [active] : [];
  }, [progressiveActiveLayerId, previewProjectionInputs]);
  const progressiveBackgroundInputs = useMemo(() => {
    if (activeProjectedPreviewInputs.length === 0) return previewProjectionInputs;
    const activeIds = new Set(activeProjectedPreviewInputs.map((layer) => layer.layerId));
    return previewProjectionInputs.filter((layer) => !activeIds.has(layer.layerId));
  }, [activeProjectedPreviewInputs, previewProjectionInputs]);
  const progressiveBackgroundSignature = useMemo(
    () =>
      `${importedObjectId ?? 'no-object'}:${RESOLUTION_TO_SIZE[resolution]}:${progressiveBackgroundInputs
        .map((layer) =>
          [
            layer.layerId,
            layer.imageUrl,
            layer.maskUrl ?? '',
            layer.depthUrl ?? '',
            layer.normalUrl ?? '',
            layer.opacity,
            layer.visible ? 1 : 0,
            layer.strength,
            layer.blendMode,
            layer.useMask ? 1 : 0,
            layer.maskSpace ?? 'projection',
            layer.useDepthCheck ? 1 : 0,
            layer.depthIsLinearView ? 1 : 0,
            layer.useNormalCheck ? 1 : 0,
            layer.renderedColor ? 1 : 0,
            layer.minimumProjectionFacing ?? 0,
            layer.projectionVisibilityPolicy ?? 'standard',
            layer.compositeRole ?? 'normal',
            layer.hue,
            layer.saturation,
            layer.lightness,
            layer.objectMatrixWorld?.join(',') ?? '',
            layer.camera.position?.join(',') ?? '',
            layer.camera.viewMatrix?.join(',') ?? '',
            layer.camera.projectionMatrix?.join(',') ?? '',
          ].join('~'),
        )
        .join('|')}`,
    [importedObjectId, progressiveBackgroundInputs, resolution],
  );
  const progressiveProjectedPreviewReady =
    canUseProgressiveUvFallback &&
    projectedPreviewNeedsComposition &&
    progressiveProjectedPreview?.signature === progressiveBackgroundSignature;
  const progressivePreviewScopeMatches = Boolean(
    progressiveProjectedPreview &&
    progressiveProjectedPreview.resolution === RESOLUTION_TO_SIZE[resolution] &&
    progressiveProjectedPreview.signature.startsWith(`${importedObjectId ?? 'no-object'}:`),
  );
  const visibleProjectedLayerIds = useMemo(
    () =>
      new Set(
        previewProjectionInputs.filter((layer) => layer.visible).map((layer) => layer.layerId),
      ),
    [previewProjectionInputs],
  );
  const progressiveBaseLayersStillVisible = Boolean(
    progressivePreviewScopeMatches &&
    progressiveProjectedPreview?.layerIds.every((layerId) => visibleProjectedLayerIds.has(layerId)),
  );
  const progressiveIncrementalInputs = useMemo(() => {
    if (!progressiveBaseLayersStillVisible || !progressiveProjectedPreview) return [];
    const baseLayerIds = new Set(progressiveProjectedPreview.layerIds);
    return previewProjectionInputs.filter((layer) => !baseLayerIds.has(layer.layerId));
  }, [previewProjectionInputs, progressiveBaseLayersStillVisible, progressiveProjectedPreview]);
  const progressiveIncrementalBudget = useMemo(
    () =>
      getProjectedLayerSamplerBudget(progressiveIncrementalInputs, gl.capabilities.maxTextures, {
        useBaseMap: true,
        useBaseRenderedColorMaskMap: true,
        useUvOverlayMap: hasResidentUvOverlaySampler,
      }),
    [gl.capabilities.maxTextures, hasResidentUvOverlaySampler, progressiveIncrementalInputs],
  );
  const progressiveIncrementalPreviewReady = Boolean(
    canUseProgressiveUvFallback &&
    projectedPreviewNeedsComposition &&
    !progressiveProjectedPreviewReady &&
    progressiveBaseLayersStillVisible &&
    progressiveIncrementalInputs.length > 0 &&
    progressiveIncrementalBudget.withinBudget,
  );
  const canUseProgressivePreviewBase =
    progressiveProjectedPreviewReady || progressiveIncrementalPreviewReady;
  const progressivePreviewBase =
    canUseProgressivePreviewBase && progressiveProjectedPreview
      ? progressiveProjectedPreview
      : undefined;

  useEffect(() => {
    if (
      !workspaceVisible ||
      !projectedPreviewNeedsComposition ||
      !canUseProgressiveUvFallback ||
      progressiveBackgroundInputs.length === 0 ||
      !importedModel
    ) {
      projectedPreviewCompositorRef.current?.cancelPending();
      if (!workspaceVisible) setProgressiveProjectedPreview(undefined);
      return;
    }
    const compositor =
      projectedPreviewCompositorRef.current ?? new ProjectedLayerPreviewCompositor();
    projectedPreviewCompositorRef.current = compositor;
    compositor.request({
      signature: progressiveBackgroundSignature,
      renderer: gl,
      group: importedModel.group,
      layers: progressiveBackgroundInputs,
      resolution: RESOLUTION_TO_SIZE[resolution],
      onReady: (result) => {
        setProgressiveProjectedPreview(result);
      },
      onError: (error) => {
        console.error('[Liclick 3D Texture] Progressive projected preview failed.', error);
      },
    });
  }, [
    gl,
    canUseProgressiveUvFallback,
    importedModel,
    progressiveBackgroundInputs,
    progressiveBackgroundSignature,
    projectedPreviewNeedsComposition,
    previewProjectionInputs.length,
    resolution,
    workspaceVisible,
  ]);

  useEffect(
    () => () => {
      projectedPreviewCompositorRef.current?.dispose();
      projectedPreviewCompositorRef.current = undefined;
    },
    [],
  );

  useEffect(() => {
    const canvas = gl.domElement;
    const interaction = projectedPreviewInteractionRef.current;
    const markMoved = () => {
      interaction.lastMovedAt = performance.now();
    };
    const markDown = () => {
      interaction.pointerDown = true;
      markMoved();
    };
    const markUp = () => {
      interaction.pointerDown = false;
      markMoved();
    };
    canvas.addEventListener('pointerdown', markDown, { passive: true });
    canvas.addEventListener('pointermove', markMoved, { passive: true });
    window.addEventListener('pointerup', markUp, { passive: true });
    window.addEventListener('pointercancel', markUp, { passive: true });
    return () => {
      canvas.removeEventListener('pointerdown', markDown);
      canvas.removeEventListener('pointermove', markMoved);
      window.removeEventListener('pointerup', markUp);
      window.removeEventListener('pointercancel', markUp);
    };
  }, [gl]);
  const visibleUvLayers = useMemo(
    () =>
      texturedRestoreReady
        ? getVisibleUvLayerStack(layers, importedObjectId, 'top-to-bottom')
            .filter((layer) => layer.role !== 'content-aware-underlay')
            .map((layer) =>
              liveSurfacePaintPreview?.target === 'uv-image' &&
              liveSurfacePaintPreview.objectId === importedObjectId &&
              liveSurfacePaintPreview.layerId === layer.id
                ? { ...layer, imageUrl: liveSurfacePaintPreview.assetUrl }
                : layer,
            )
        : [],
    [importedObjectId, layers, liveSurfacePaintPreview, texturedRestoreReady],
  );
  const visibleUvLayerSignature = useMemo(
    () => uvLayerStackPreviewSignature(visibleUvLayers),
    [visibleUvLayers],
  );
  const stableVisibleUvLayers = useStableValueBySignature(visibleUvLayers, visibleUvLayerSignature);
  const residentContentAwareUnderlayState = useLoadedPreviewTextureState(
    residentContentAwareUvUnderlayLayer?.imageUrl,
    { preserveWhenEmpty: true, maxSize: proxyTextureMaxSize },
  );
  const compositedContentAwareUnderlayState = useCompositedUvTextureState(
    visibleCompositedContentAwareUvUnderlayLayers,
    { maxSize: proxyTextureMaxSize },
  );
  const exactContentAwareUnderlayTexture = residentContentAwareUvUnderlayLayer
    ? residentContentAwareUnderlayState.ready
      ? residentContentAwareUnderlayState.texture
      : undefined
    : compositedContentAwareUnderlayState.ready
      ? compositedContentAwareUnderlayState.texture
      : undefined;
  const requestedContentAwareUnderlayOpacity = residentContentAwareUvUnderlayLayer
    ? residentContentAwareUvUnderlayLayer.visible
      ? residentContentAwareUvUnderlayLayer.opacity
      : 0
    : visibleCompositedContentAwareUvUnderlayLayers.length > 0
      ? 1
      : 0;
  const previousContentAwarePresentation = contentAwareUnderlayPresentationRef.current;
  const preservePreviousContentAwarePresentation =
    visibleContentAwareUvUnderlayLayers.length > 0 && !exactContentAwareUnderlayTexture;
  const loadedContentAwareUnderlayTexture =
    exactContentAwareUnderlayTexture ??
    (preservePreviousContentAwarePresentation
      ? previousContentAwarePresentation.texture
      : undefined);
  // Never publish the base sampler weight before its exact texture is resident.
  // The shader's reserved sampler is intentionally backed by a white fallback;
  // exposing it early produces the white-membrane frame and makes an eye toggle
  // appear to "fix" the layer after the asynchronous decode completes.
  const contentAwareUnderlayOpacity = exactContentAwareUnderlayTexture
    ? requestedContentAwareUnderlayOpacity
    : preservePreviousContentAwarePresentation && loadedContentAwareUnderlayTexture
      ? previousContentAwarePresentation.opacity
      : 0;
  contentAwareUnderlayPresentationRef.current = {
    texture: loadedContentAwareUnderlayTexture,
    opacity: contentAwareUnderlayOpacity,
  };
  useEffect(() => {
    if (loadedContentAwareUnderlayTexture) {
      markSparseAlphaBaseTexture(loadedContentAwareUnderlayTexture);
    }
    const visibleContentAwareLayers = contentAwareUvUnderlayLayers.filter((layer) => layer.visible);
    const state = {
      layerIds: visibleContentAwareLayers.map((layer) => layer.id),
      visibleLayerCount: visibleContentAwareLayers.length,
      eyeVisible: visibleContentAwareLayers.length > 0,
      textureReady: Boolean(loadedContentAwareUnderlayTexture),
      requestedOpacity: requestedContentAwareUnderlayOpacity,
      effectiveOpacity: contentAwareUnderlayOpacity,
      safe: Boolean(loadedContentAwareUnderlayTexture) || contentAwareUnderlayOpacity === 0,
      atMs: Math.round(performance.now() * 10) / 10,
    };
    document.body.dataset.contentAwareUnderlayState = JSON.stringify(state);
    let history: (typeof state)[] = [];
    try {
      history = JSON.parse(
        document.body.dataset.contentAwareUnderlayHistory ?? '[]',
      ) as (typeof state)[];
    } catch {
      history = [];
    }
    const previous = history.at(-1);
    if (
      !previous ||
      previous.visibleLayerCount !== state.visibleLayerCount ||
      previous.textureReady !== state.textureReady ||
      previous.effectiveOpacity !== state.effectiveOpacity
    ) {
      history.push(state);
      document.body.dataset.contentAwareUnderlayHistory = JSON.stringify(history.slice(-16));
    }
  }, [
    contentAwareUvUnderlayLayers,
    contentAwareUnderlayOpacity,
    loadedContentAwareUnderlayTexture,
    requestedContentAwareUnderlayOpacity,
  ]);
  const exactBakedTextureRecord = useMemo(() => {
    const expectedResolution = RESOLUTION_TO_SIZE[resolution];
    const cacheKey = getProjectedLayerStackSignature(
      project?.id,
      importedObjectId,
      expectedResolution,
      stableVisibleProjectedLayers,
    );
    const texture = findExactLayerStackTexture(
      project,
      stableVisibleProjectedLayers,
      expectedResolution,
      importedObjectId,
      cacheKey,
    );
    return canUseLayerStackCache(
      stableVisibleProjectedLayers,
      texture,
      expectedResolution,
      importedObjectId,
      cacheKey,
    )
      ? texture
      : undefined;
  }, [importedObjectId, project, resolution, stableVisibleProjectedLayers]);
  const previewBakedTextureRecord = exactBakedTextureRecord;
  const loadedBakedTexture = useLoadedPreviewTexture(previewBakedTextureRecord?.imageUrl, {
    maxSize: proxyTextureMaxSize,
  });
  const liveTopUvLayer = useMemo(() => {
    const topLayer = stableVisibleUvLayers[0];
    if (
      !topLayer ||
      (!getLiveProjectedCanvasState(topLayer.imageUrl) && !isRenderedLocalRepaintLayer(topLayer))
    )
      return undefined;
    const hasLiveLocalRepaintStroke = Boolean(localRepaintPreviewLayerId);
    // Keep the accumulated local-repaint UV canvas resident while the next
    // projected stroke is being drawn. Moving it back into the ordinary UV
    // compositor clears the old GPU texture while an asynchronous composite is
    // prepared, which makes all previous strokes temporarily disappear.
    // Keep a live or rendered-color top layer separate from the albedo UV stack.
    // Besides avoiding full-resolution recomposites during painting, this lets a
    // baked local-repaint patch retain the same exposure semantics as its live
    // projected preview instead of receiving viewport lighting a second time.
    // A smaller order is a higher row in the layer panel. Only composite the UV
    // patch last when it is actually above every projected layer.
    const topProjectedOrder = stableVisibleProjectedLayers.reduce(
      (topOrder, layer) => Math.min(topOrder, layer.order),
      Number.POSITIVE_INFINITY,
    );
    // A baked local-repaint layer is a literal rendered-color replacement and
    // must stay above the older projected stack. Sending it back into the base
    // UV compositor places it underneath every projection, so the layer preview
    // contains the patch while the model appears unchanged.
    if (isRenderedLocalRepaintLayer(topLayer)) return topLayer;
    if (!hasLiveLocalRepaintStroke && topLayer.order >= topProjectedOrder) return undefined;
    return topLayer;
  }, [localRepaintPreviewLayerId, stableVisibleProjectedLayers, stableVisibleUvLayers]);
  const nonLiveUvLayers = useMemo(
    () =>
      liveTopUvLayer
        ? stableVisibleUvLayers.filter((layer) => layer.id !== liveTopUvLayer.id)
        : stableVisibleUvLayers,
    [liveTopUvLayer, stableVisibleUvLayers],
  );
  // A single UV layer is already a finished UV-space texture. Sample it directly
  // and adjust it with shader uniforms instead of rebuilding a full-resolution canvas.
  // A resident ordinary base alone cannot represent additional lower repaint rows.
  const directUvLayer =
    (nonLiveUvLayers.some(isRenderedLocalRepaintLayer) ? undefined : residentDirectUvLayer) ??
    (nonLiveUvLayers.length === 1 ? nonLiveUvLayers[0] : undefined);
  const compositedUvLayers = directUvLayer
    ? nonLiveUvLayers.filter((layer) => layer.id !== directUvLayer.id)
    : nonLiveUvLayers;
  const requestedUvRenderedColor = directUvLayer
    ? usesUnlitRenderedColor(directUvLayer)
    : compositedUvLayers.some(usesUnlitRenderedColor);
  const requestedUvOverlayOpacity = directUvLayer
    ? directUvLayer.visible
      ? directUvLayer.opacity
      : 0
    : compositedUvLayers.length > 0
      ? 1
      : 0;
  const compositedUvTextureState = useCompositedUvTextureState(compositedUvLayers, {
    maxSize: proxyTextureMaxSize,
  });
  const residentAllVisibleUvLayers = useMemo(
    () =>
      residentUvTogglePrewarmReady && stableResidentUvToggleLayers.length > 1
        ? stableResidentUvToggleLayers.map((layer) =>
            layer.visible ? layer : { ...layer, visible: true },
          )
        : [],
    [residentUvTogglePrewarmReady, stableResidentUvToggleLayers],
  );
  const residentAllVisibleUvKey = useMemo(
    () => residentUvVisibilityKey(residentAllVisibleUvLayers),
    [residentAllVisibleUvLayers],
  );
  const residentAllVisibleUvTexture = useCompositedUvTexture(residentAllVisibleUvLayers, {
    maxSize: proxyTextureMaxSize,
  });
  const directUvTextureState = useLoadedPreviewTextureState(directUvLayer?.imageUrl, {
    preserveWhenEmpty: true,
    maxSize: proxyTextureMaxSize,
  });
  const directUvRenderedColorMaskTexture = useLoadedPreviewTexture(
    directUvLayer?.renderedColorMaskUrl,
    { colorSpace: THREE.NoColorSpace, maxSize: proxyTextureMaxSize },
  );
  const exactUvTexture = directUvLayer
    ? directUvTextureState.ready
      ? directUvTextureState.texture
      : undefined
    : compositedUvTextureState.ready
      ? compositedUvTextureState.texture
      : undefined;
  const previousUvPresentation = uvPresentationRef.current;
  const preservePreviousUvPresentation = nonLiveUvLayers.length > 0 && !exactUvTexture;
  const loadedUvTexture =
    exactUvTexture ?? (preservePreviousUvPresentation ? previousUvPresentation.texture : undefined);
  const uvOverlayOpacity = exactUvTexture
    ? requestedUvOverlayOpacity
    : preservePreviousUvPresentation && previousUvPresentation.texture
      ? previousUvPresentation.opacity
      : 0;
  const directUvRenderedColor = exactUvTexture
    ? requestedUvRenderedColor
    : preservePreviousUvPresentation && previousUvPresentation.texture
      ? previousUvPresentation.renderedColor
      : requestedUvRenderedColor;
  uvPresentationRef.current = {
    texture: loadedUvTexture,
    opacity: uvOverlayOpacity,
    renderedColor: directUvRenderedColor,
  };
  useEffect(() => {
    if (stableResidentUvToggleLayers.length <= 1) {
      document.body.dataset.residentUvCombinationReady = '1';
      return;
    }
    document.body.dataset.residentUvCombinationReady = '0';
    if (!residentAllVisibleUvTexture || !residentAllVisibleUvKey) return;
    let cancelled = false;
    void uploadPreviewTextureInStripes(gl, residentAllVisibleUvTexture).then(() => {
      if (cancelled) return;
      const cache = residentUvPresentationCacheRef.current;
      cache.delete(residentAllVisibleUvKey);
      cache.set(residentAllVisibleUvKey, residentAllVisibleUvTexture);
      document.body.dataset.residentUvCombinationReady = '1';
    });
    return () => {
      cancelled = true;
    };
  }, [
    gl,
    residentAllVisibleUvKey,
    residentAllVisibleUvTexture,
    stableResidentUvToggleLayers.length,
  ]);
  useEffect(() => {
    if (!loadedUvTexture) return;
    document.body.dataset.textureRestoreUvReady = '1';
    document.body.dataset.textureRestoreUvReadyMs = performance.now().toFixed(1);
  }, [loadedUvTexture]);
  const visibleResidentUvKey = useMemo(
    () =>
      residentUvVisibilityKey(
        stableVisibleUvLayers.filter(
          (layer) => layer.role !== 'local-repaint-overlay' && layer.role !== 'local-repaint-draft',
        ),
      ),
    [stableVisibleUvLayers],
  );
  useEffect(() => {
    if (!loadedUvTexture || !visibleResidentUvKey) return;
    const cache = residentUvPresentationCacheRef.current;
    cache.delete(visibleResidentUvKey);
    cache.set(visibleResidentUvKey, loadedUvTexture);
    while (cache.size > MAX_COMPOSITED_UV_TEXTURE_CACHE_SIZE) {
      const oldestKey = cache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      cache.delete(oldestKey);
    }
    if (pendingUvVisibilityRenderKeyRef.current === visibleResidentUvKey) {
      pendingUvVisibilityRenderKeyRef.current = '';
    }
  }, [loadedUvTexture, visibleResidentUvKey]);
  const loadedStaticTopUvTexture = useLoadedPreviewTexture(
    liveTopUvLayer && !getLiveProjectedCanvasState(liveTopUvLayer.imageUrl)
      ? liveTopUvLayer.imageUrl
      : undefined,
    { maxSize: proxyTextureMaxSize },
  );
  const liveTopUvTexture = useMemo(
    () =>
      liveTopUvLayer
        ? (getLiveProjectedCanvasTexture(liveTopUvLayer.imageUrl, THREE.SRGBColorSpace, {
            flipY: true,
          }) ?? loadedStaticTopUvTexture)
        : undefined,
    [liveTopUvLayer, loadedStaticTopUvTexture],
  );
  useEffect(() => {
    if (!liveTopUvTexture) return;
    // Rendered local-repaint patches intentionally bypass the base UV
    // compositor and are shown as a top projected overlay. They are still UV
    // layers in persisted project data, so count this path as restored too.
    document.body.dataset.textureRestoreUvReady = '1';
    document.body.dataset.textureRestoreUvReadyMs = performance.now().toFixed(1);
  }, [liveTopUvTexture]);
  const topUvProjectedOverlayInput = useMemo(
    () =>
      liveTopUvTexture && liveTopUvLayer
        ? {
            topUvOverlayTexture: liveTopUvTexture,
            topUvOverlayOpacity: liveTopUvLayer.opacity,
            topUvOverlayRenderedColor: usesUnlitRenderedColor(liveTopUvLayer),
            topUvOverlayHue: (liveTopUvLayer.adjustments?.hue ?? 0) / 100,
            topUvOverlaySaturation: (liveTopUvLayer.adjustments?.saturation ?? 0) / 100,
            topUvOverlayLightness: (liveTopUvLayer.adjustments?.lightness ?? 0) / 100,
          }
        : undefined,
    [liveTopUvLayer, liveTopUvTexture],
  );
  const liveSurfaceMaskTexture = useMemo(() => {
    if (exactBakedTextureRecord) return undefined;
    const layer = layers.find((item) => item.id === activeLayerId);
    if (layer?.type !== 'projected' || layer.maskSpace !== 'uv' || !layer.maskUrl) return undefined;
    return getLiveProjectedCanvasTexture(layer.maskUrl, THREE.NoColorSpace, { flipY: false });
  }, [activeLayerId, exactBakedTextureRecord, layers]);
  const hasLiveProjectedPreview = useMemo(
    () =>
      stableVisibleProjectedLayers.some(
        (layer) =>
          Boolean(getLiveProjectedCanvasState(layer.imageUrl)) ||
          Boolean(layer.maskUrl && getLiveProjectedCanvasState(layer.maskUrl)),
      ),
    [stableVisibleProjectedLayers],
  );
  const hasLocalRepaintPreview = stableVisibleProjectedLayers.some(isRenderedLocalRepaintLayer);
  const visibleStackNeedsLivePreview =
    hasLiveProjectedPreview ||
    Boolean(liveProjectedEraserMaskTexture) ||
    hasLocalRepaintPreview ||
    contentAwareUvUnderlayLayers.length > 0 ||
    stableVisibleProjectedLayers.some((layer) => layer.needsRebake);
  // A same-layer cache may still describe the previous mask revision. Prefer the
  // projected material while a live canvas is attached or the layer is dirty;
  // otherwise the layer row updates but the model keeps showing the stale bake.
  const hasResidentProjectedLayers = stablePreviewProjectedLayers.length > 0;
  // Building hidden texture arrays speculatively creates large GPU queues that
  // surface later as wheel/drag hitches even when an exact merged UV owns the
  // visible colour. A real eye-open makes the row visible and immediately
  // enters the authoritative projected path.
  const needsInteractiveProjectedMaterial = stableVisibleProjectedLayers.length > 0;
  // Exact baked previews remain useful for legacy stacks that cannot be sampled
  // as projected layers (for example, records without camera data). Once any
  // projected layer is visible, its stack is authoritative; when all are hidden,
  // the exact merged UV can render without retaining a duplicate texture array.
  const visibleStackHasBakedPreview =
    Boolean(previewBakedTextureRecord) &&
    !visibleStackNeedsLivePreview &&
    !hasResidentProjectedLayers;
  const canPreviewProjectedLayers =
    importedModel.restoreStage !== 'proxy' &&
    !visibleStackHasBakedPreview &&
    hasResidentProjectedLayers &&
    needsInteractiveProjectedMaterial;
  const previewLighting = useMemo(
    () =>
      getPreviewLighting({
        displayMode,
        environmentPreset,
        exposure,
        pbrEnvironmentIntensity,
        pbrKeyLightIntensity,
        pbrLightAzimuth,
      }),
    [
      displayMode,
      environmentPreset,
      exposure,
      pbrEnvironmentIntensity,
      pbrKeyLightIntensity,
      pbrLightAzimuth,
    ],
  );

  useEffect(() => {
    // Eye/opacity controls and display modes must update the resident material
    // synchronously. This includes the lit white-membrane fallback: an empty
    // layer stack must retain form without waiting for an async material pass.
    // This effect can also run after a texture or lighting promise settles. Its
    // structural preview input deliberately caches eye state, so never publish
    // visibility from that snapshot: a late effect would reopen a layer that
    // the user has already hidden.
    const authoritativeProjectionLayers = useLayerStore.getState().layers;
    const authoritativeSceneState = useSceneStore.getState();
    const authoritativePreviewLayer = authoritativeSceneState.localRepaintPreviewLayer;
    const authoritativeMutedPreviewLayerId =
      authoritativePreviewLayer &&
      shouldMuteLocalRepaintResidentLayer(
        authoritativeProjectionLayers,
        authoritativePreviewLayer,
        authoritativePreviewLayer.id,
        authoritativeSceneState.paintTool === 'inpaint-apply',
      )
        ? authoritativePreviewLayer.id
        : undefined;
    const authoritativeMergedUvBoundaryOrder = getVisibleMergedUvBoundaryOrder(
      authoritativeProjectionLayers,
      importedModel.objectId,
    );
    const authoritativeProjectionDisplayInputs = authoritativeProjectionLayers
      .filter(
        (layer) =>
          layer.type === 'projected' &&
          (!layer.objectId || layer.objectId === importedModel.objectId),
      )
      .map((layer) => ({
        ...toProjectionLayerDisplayInput(layer),
        visible:
          layer.visible &&
          layer.id !== authoritativeMutedPreviewLayerId &&
          isProjectedLayerAboveMergedUv(layer, authoritativeMergedUvBoundaryOrder),
      }));
    syncProjectedLayerResidentTextureVisibilityInObject(importedModel.group, {
      ...(loadedUvTexture ? { uvOverlayTexture: loadedUvTexture } : {}),
      uvOverlayRenderedColor: directUvRenderedColor,
      ...(loadedContentAwareUnderlayTexture
        ? { baseTexture: loadedContentAwareUnderlayTexture }
        : {}),
      // Never reveal the reserved neutral sampler. Texture and opacity are a
      // single presentation state: publish opacity only after the authored UV
      // texture has decoded and is ready to bind.
      uvOverlayOpacity: loadedUvTexture ? uvOverlayOpacity : 0,
      uvOverlayBelowProjected: Number.isFinite(visibleMergedUvBoundaryOrder),
      topUvOverlayOpacity: liveTopUvLayer?.visible ? liveTopUvLayer.opacity : 0,
      baseTextureOpacity: contentAwareUnderlayOpacity,
    });
    syncProjectedLayerMaterialDisplayStateInObject(
      importedModel.group,
      authoritativeProjectionDisplayInputs,
      displayMode === 'normal',
      displayMode === 'wire',
      previewLighting,
    );
    invalidate();
  }, [
    contentAwareUnderlayOpacity,
    directUvRenderedColor,
    displayMode,
    importedModel,
    invalidate,
    liveTopUvLayer,
    loadedContentAwareUnderlayTexture,
    loadedUvTexture,
    previewLighting,
    previewProjectionInputs,
    uvOverlayOpacity,
    visibleMergedUvBoundaryOrder,
  ]);

  useFrame(() => {
    const interaction = projectedPreviewInteractionRef.current;
    const isInteracting =
      isSharedViewportInteractionBusy(180) ||
      interaction.pointerDown ||
      performance.now() - interaction.lastMovedAt < 140;
    // Interaction owns the frame budget. Even a single compositor operation can
    // enqueue enough GPU work to surface as a later wheel/drag hitch, so suspend
    // the background queue completely until the viewport has settled.
    if (!isInteracting) projectedPreviewCompositorRef.current?.step(2.5, 2);
    if (stableVisibleProjectedLayers.length === 0) {
      lastProjectedTransformRef.current = undefined;
      return;
    }
    // Camera orbit/pan/zoom does not alter the model transform. Avoid forcing a
    // full model-tree matrix traversal on every interaction frame; transform
    // actions already mark/update this group and the renderer keeps it current.
    if (isInteracting) return;
    importedModel.group.updateMatrixWorld(true);
    const currentMatrix = importedModel.group.matrixWorld;
    if (lastProjectedTransformRef.current?.equals(currentMatrix)) return;
    syncProjectedLayerMaterialProjection(importedModel.group);
    if (lastProjectedTransformRef.current) {
      lastProjectedTransformRef.current.copy(currentMatrix);
    } else {
      lastProjectedTransformRef.current = currentMatrix.clone();
    }
  });

  const projectedMaterialStructureKey = [
    importedModel?.objectId ?? '',
    importedModel?.restoreStage ?? '',
    projectedTextureArrayStructureSignature,
    // Base and UV samplers are reserved from the first build. Their texture,
    // opacity and eye-state changes are uniform-only and must never invalidate
    // the 4K projected material structure during an atomic publication.
    // The live eraser sampler is reserved too. Its texture and target layer are
    // patched synchronously by syncProjectedLayerLiveEraserPreviewInObject;
    // including the transient texture UUID here rebuilt the complete resident
    // stack on eraser activation and again on clear. A late build could then
    // publish stale layer visibility after the user reopened other eyes.
    liveTopUvLayer
      ? `${liveTopUvLayer.id}:${liveTopUvLayer.imageUrl ?? ''}:${liveTopUvLayer.contentRevision ?? 0}`
      : '',
    // surfaceMaskTexture belongs exclusively to the non-projected UV/flat
    // material paths below. Including its UUID in the resident projected key
    // rebuilt all 4K projection arrays whenever button 3 selected a masked
    // layer, even though the projected shader never consumes this texture.
    useProjectedTextureArrays ? 'array' : 'direct',
    textureArrayCompositionFallbackRequired ? 'fallback' : 'exact',
  ].join('|');
  useLayoutEffect(() => {
    if (liveProjectedEraserMaskTexture) return;
    if (committedProjectedMaterialStructureRef.current !== projectedMaterialStructureKey) {
      // The old direct material may not own the first keep-mask sampler yet, or
      // the old array may still contain pre-commit pixels. Keep the cumulative
      // live multiplier through eye/tool toggles; applyMaterials clears it on
      // the replacement material only after the persistent mask is resident.
      return;
    }
    if (
      syncProjectedLayerLiveEraserPreviewInObject(importedModel.group, undefined, undefined)
    ) {
      invalidate();
    }
  }, [
    importedModel,
    invalidate,
    liveProjectedEraserMaskTexture,
    projectedMaterialStructureKey,
  ]);
  const showWhiteMembrane = Boolean(
    transientWhitePresentationObjectId === importedModel.objectId ||
    (!hasAuthoritativeVisibleTextureLayer && !liveTopUvTexture && !liveSurfacePaintPreview),
  );

  const projectedProgramWarmupSourceSignature = useMemo(
    () =>
      projectedProgramWarmupInputs
        .map((layer) =>
          [
            layer.layerId,
            layer.imageUrl,
            layer.maskUrl ?? '',
            useProjectedProgramWarmupTextureArrays
              ? liveProjectedMaskRevisionSignature(layer.maskUrl)
              : '',
            layer.depthUrl ?? '',
            layer.normalUrl ?? '',
            layer.useMask ? 1 : 0,
            layer.useDepthCheck ? 1 : 0,
            layer.useNormalCheck ? 1 : 0,
            layer.projectionVisibilityPolicy ?? 'standard',
            layer.compositeRole ?? 'normal',
          ].join('~'),
        )
        .join('|'),
    [projectedProgramWarmupInputs, useProjectedProgramWarmupTextureArrays],
  );
  const projectedProgramWarmupStructureSignature = useMemo(
    () =>
      projectedProgramWarmupInputs
        .map((layer) =>
          [
            layer.maskSpace ?? 'projection',
            layer.useMask ? 1 : 0,
            layer.useDepthCheck ? 1 : 0,
            layer.useNormalCheck ? 1 : 0,
            layer.projectionVisibilityPolicy ?? 'standard',
            layer.compositeRole ?? 'normal',
          ].join('~'),
        )
        .join('|'),
    [projectedProgramWarmupInputs],
  );
  const projectedProgramWarmupTextureArrayStructureSignature = useMemo(
    () =>
      projectedProgramWarmupInputs
        .map((layer) =>
          [
            layer.layerId,
            layer.imageUrl,
            layer.maskUrl ?? '',
            layer.depthUrl ?? '',
            layer.normalUrl ?? '',
            layer.maskSpace ?? 'projection',
            layer.useMask ? 1 : 0,
            layer.useDepthCheck ? 1 : 0,
            layer.useNormalCheck ? 1 : 0,
            layer.compositeRole ?? 'normal',
            layer.objectMatrixWorld?.join(',') ?? '',
            layer.camera.viewMatrix?.join(',') ?? '',
            layer.camera.projectionMatrix?.join(',') ?? '',
          ].join('~'),
        )
        .join('|'),
    [projectedProgramWarmupInputs],
  );
  const projectedProgramWarmupSignature = [
    projectedProgramWarmupSourceSignature,
    useProjectedProgramWarmupTextureArrays ? 'array' : 'direct',
    progressivePreviewBase?.renderedColorMaskTexture ? 'base-mask' : 'base-no-mask',
    directUvRenderedColorMaskTexture ? 'uv-mask' : 'uv-no-mask',
    liveTopUvTexture ? 'top-uv' : 'no-top-uv',
  ].join('|');

  useEffect(() => {
    if (
      !workspaceVisible ||
      !selected ||
      typeof gl.compileAsync !== 'function' ||
      importedModel.restoreStage !== 'outline' ||
      projectedProgramWarmupInputs.length <= 1 ||
      !isProjectedUniformBudgetSafe(projectedProgramWarmupInputs.length, gl.capabilities.maxFragmentUniforms) ||
      !projectedProgramWarmupSignature
    ) {
      return;
    }
    if (acquiredProjectedProgramSignaturesRef.current.has(projectedProgramWarmupSignature)) return;
    if (projectedProgramWarmupRef.current?.signature === projectedProgramWarmupSignature) return;

    const sharedWarmupSignature = [
      projectedProgramWarmupStructureSignature,
      useProjectedProgramWarmupTextureArrays ? 'array' : 'direct',
      progressivePreviewBase?.renderedColorMaskTexture ? 'base-mask' : 'base-no-mask',
      directUvRenderedColorMaskTexture ? 'uv-mask' : 'uv-no-mask',
      liveTopUvTexture ? 'top-uv' : 'no-top-uv',
    ].join('|');
    const sharedWarmups = getProjectedProgramWarmupMap(gl);
    if (sharedWarmups.has(sharedWarmupSignature)) return;

    const material = createProjectedLayerStackProgramWarmupMaterial(
      {
        layers: projectedProgramWarmupInputs,
        objectId: importedModel.objectId,
        depthTest: true,
        reserveBaseMapSampler: true,
        reserveUvOverlaySampler: hasResidentUvOverlaySampler,
        ...(progressivePreviewBase?.renderedColorMaskTexture
          ? { baseRenderedColorMaskTexture: progressivePreviewBase.renderedColorMaskTexture }
          : {}),
        ...(directUvRenderedColorMaskTexture
          ? { uvOverlayRenderedColorMaskTexture: directUvRenderedColorMaskTexture }
          : {}),
        ...(liveTopUvTexture ? { topUvOverlayTexture: liveTopUvTexture } : {}),
      },
      {
        maxTextureImageUnits: gl.capabilities.maxTextures,
        isWebGL2: gl.capabilities.isWebGL2,
        preferTextureArrays: useProjectedProgramWarmupTextureArrays,
      },
    );
    if (!material) return;

    const previousWarmup = projectedProgramWarmupRef.current;
    if (previousWarmup) {
      if (previousWarmup.ready) previousWarmup.material.dispose();
      else previousWarmup.disposeWhenReady = true;
    }
    const warmupRecord = {
      signature: projectedProgramWarmupSignature,
      material,
      ready: false,
      disposeWhenReady: false,
    };
    projectedProgramWarmupRef.current = warmupRecord;
    const compileScene = new THREE.Scene();
    const compileGeometry = new THREE.BoxGeometry(1, 1, 1);
    const compileMesh = new THREE.Mesh(compileGeometry, material);
    compileMesh.frustumCulled = false;
    compileScene.add(compileMesh);
    const startedAt = performance.now();
    document.body.dataset.projectedProgramWarmupStatus = 'pending';
    document.body.dataset.projectedProgramWarmupStartedMs = startedAt.toFixed(1);
    document.body.dataset.projectedProgramWarmupModelStage = importedModel.restoreStage;
    document.body.dataset.projectedProgramWarmupSignature = projectedProgramWarmupSignature;
    const sharedWarmupPromise: Promise<void> = gl
      .compileAsync(compileScene, camera)
      .then(() => {
        warmupRecord.ready = true;
        if (warmupRecord.disposeWhenReady) {
          material.dispose();
          return;
        }
        if (projectedProgramWarmupRef.current !== warmupRecord) return;
        const durationMs = performance.now() - startedAt;
        document.body.dataset.projectedProgramWarmupStatus = 'ready';
        document.body.dataset.projectedProgramWarmupDurationMs = durationMs.toFixed(1);
        markPerformanceEvent('projection', 'projected-program-early-warmup', { durationMs });
      })
      .catch((error) => {
        warmupRecord.ready = true;
        if (warmupRecord.disposeWhenReady) {
          material.dispose();
          return;
        }
        if (projectedProgramWarmupRef.current !== warmupRecord) return;
        document.body.dataset.projectedProgramWarmupStatus = 'error';
        console.warn('[Liclick 3D Texture] Projected shader warmup was unavailable:', error);
      })
      .finally(() => {
        if (sharedWarmups.get(sharedWarmupSignature) === sharedWarmupPromise) {
          sharedWarmups.delete(sharedWarmupSignature);
        }
        compileMesh.removeFromParent();
        compileGeometry.dispose();
      });
    sharedWarmups.set(sharedWarmupSignature, sharedWarmupPromise);
    void sharedWarmupPromise;
  }, [
    camera,
    directUvRenderedColorMaskTexture,
    gl,
    hasResidentUvOverlaySampler,
    importedModel.objectId,
    importedModel.restoreStage,
    liveTopUvTexture,
    projectedProgramWarmupInputs,
    progressivePreviewBase?.renderedColorMaskTexture,
    projectedProgramWarmupSignature,
    projectedProgramWarmupStructureSignature,
    selected,
    useProjectedProgramWarmupTextureArrays,
    workspaceVisible,
  ]);

  useEffect(
    () => () => {
      const warmup = projectedProgramWarmupRef.current;
      if (warmup) {
        if (warmup.ready) warmup.material.dispose();
        else warmup.disposeWhenReady = true;
      }
      projectedProgramWarmupRef.current = undefined;
    },
    [],
  );

  useEffect(() => {
    if (
      !workspaceVisible ||
      !selected ||
      importedModel.restoreStage !== 'outline' ||
      !useProjectedProgramWarmupTextureArrays ||
      projectedProgramWarmupInputs.length <= 1 ||
      !projectedProgramWarmupTextureArrayStructureSignature ||
      textureArrayCompositionFallbackRequired
    ) {
      return;
    }

    const textureArrayBuildSignature = [
      projectedProgramWarmupTextureArrayStructureSignature,
      liveTopUvTexture?.uuid ?? '',
    ].join('|');
    if (projectedTextureArrayBuildRef.current?.signature === textureArrayBuildSignature) return;
    if (projectedTextureArrayBuildRef.current) {
      projectedTextureArrayBuildRef.current.cancelled = true;
    }
    const nextBuild = {
      signature: textureArrayBuildSignature,
      cancelled: false,
      promise: undefined as unknown as Promise<THREE.ShaderMaterial | undefined>,
      precompilePromise: undefined as Promise<void> | undefined,
    };
    const earlyMaterialInput: ProjectionLayerStackInput = {
      layers: projectedProgramWarmupInputs,
      objectId: importedModel.objectId,
      currentObjectMatrixWorld: importedModel.group.matrixWorld.toArray(),
      reserveBaseMapSampler: true,
      reserveUvOverlaySampler: hasResidentUvOverlaySampler,
      depthTest: true,
      enableBackfaceCulling: true,
      edgeFeather: 0.004,
      depthBias: 0.025,
      normalPreview: false,
      wirePreview: false,
      previewLighting,
      ...(directUvRenderedColorMaskTexture
        ? { uvOverlayRenderedColorMaskTexture: directUvRenderedColorMaskTexture }
        : {}),
      ...topUvProjectedOverlayInput,
    };
    document.body.dataset.projectedEarlyArrayBuildStatus = 'building';
    document.body.dataset.projectedEarlyArrayBuildStartedMs = performance.now().toFixed(1);
    nextBuild.promise = createProjectedLayerStackMaterial(earlyMaterialInput, {
      maxTextureImageUnits: gl.capabilities.maxTextures,
      renderer: gl,
      isCancelled: () => nextBuild.cancelled,
      isViewportInteractionBusy: () =>
        isSharedViewportInteractionBusy() ||
        document.body.dataset.perfSimulatedViewportInteraction === '1' ||
        document.body.dataset.perfViewportStressMeasuring === '1',
      preferTextureArrays: true,
    });
    projectedTextureArrayBuildRef.current = nextBuild;

    nextBuild.precompilePromise = nextBuild.promise.then(async (material) => {
      if (!material || nextBuild.cancelled || projectedTextureArrayBuildRef.current !== nextBuild) {
        return;
      }
      const startedAt = performance.now();
      const warmScene = new THREE.Scene();
      const warmGeometry = new THREE.PlaneGeometry(2, 2);
      const warmMesh = new THREE.Mesh(warmGeometry, material);
      warmMesh.frustumCulled = false;
      warmScene.add(warmMesh);
      const warmCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const warmTarget = new THREE.WebGLRenderTarget(1, 1, {
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
      });
      const previousTarget = gl.getRenderTarget();
      const previousAutoClear = gl.autoClear;
      try {
        if (typeof gl.compileAsync === 'function') {
          await compileForRenderTarget(gl, warmScene, warmCamera, gl.getRenderTarget());
        }
        if (nextBuild.cancelled || projectedTextureArrayBuildRef.current !== nextBuild) {
          return;
        }
        gl.autoClear = true;
        gl.setRenderTarget(warmTarget);
        gl.render(warmScene, warmCamera);
        const context = gl.getContext();
        if ('fenceSync' in context) {
          const gl2 = context as WebGL2RenderingContext;
          const sync = gl2.fenceSync(gl2.SYNC_GPU_COMMANDS_COMPLETE, 0);
          if (sync) {
            gl2.flush();
            try {
              while (!nextBuild.cancelled) {
                await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
                const status = gl2.clientWaitSync(sync, 0, 0);
                if (
                  status === gl2.ALREADY_SIGNALED ||
                  status === gl2.CONDITION_SATISFIED ||
                  status === gl2.WAIT_FAILED
                ) {
                  break;
                }
              }
            } finally {
              gl2.deleteSync(sync);
            }
          }
        }
        document.body.dataset.projectedEarlyArrayBuildStatus = 'ready';
        document.body.dataset.projectedEarlyArrayBuildReadyMs = performance.now().toFixed(1);
        document.body.dataset.projectedEarlyArrayPipelinePrewarmMs = (
          performance.now() - startedAt
        ).toFixed(1);
      } finally {
        gl.setRenderTarget(previousTarget);
        gl.autoClear = previousAutoClear;
        warmMesh.removeFromParent();
        warmGeometry.dispose();
        warmTarget.dispose();
      }
    });
    void nextBuild.precompilePromise.catch((error) => {
      if (nextBuild.cancelled) return;
      if (projectedTextureArrayBuildRef.current === nextBuild) {
        projectedTextureArrayBuildRef.current = undefined;
      }
      document.body.dataset.projectedEarlyArrayBuildStatus = 'error';
      console.warn('[Liclick 3D Texture] Early projected array warmup was unavailable:', error);
    });
  }, [
    directUvRenderedColorMaskTexture,
    gl,
    hasResidentUvOverlaySampler,
    importedModel,
    liveTopUvTexture?.uuid,
    previewLighting,
    projectedProgramWarmupInputs,
    projectedProgramWarmupTextureArrayStructureSignature,
    selected,
    textureArrayCompositionFallbackRequired,
    topUvProjectedOverlayInput,
    useProjectedProgramWarmupTextureArrays,
    workspaceVisible,
  ]);

  useEffect(() => {
    if (!workspaceVisible) {
      // Hidden texture-workspace objects must not keep packing and uploading
      // independent 4K projection arrays. Cancel and forget the partial build
      // so selecting the object later starts a fresh authoritative generation
      // instead of reusing a cancelled promise that can only yield white.
      const hiddenBuild = projectedTextureArrayBuildRef.current;
      if (hiddenBuild) hiddenBuild.cancelled = true;
      projectedTextureArrayBuildRef.current = undefined;
      return undefined;
    }
    if (!importedModel) return;
    let hasResidentProjectedMaterial = false;
    let hasPresentedMaterial = false;
    let presentsOnlyWhiteMembrane = true;
    importedModel.group.traverse((child) => {
      if (!(child instanceof THREE.Mesh) || child.userData.liclickPaintOverlay) return;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      hasPresentedMaterial = true;
      hasResidentProjectedMaterial ||= materials.some((material) =>
        isResidentProjectedMaterial(material),
      );
      presentsOnlyWhiteMembrane &&= materials.every(
        (material) => material.name === 'LiclickWhiteMembranePreview',
      );
    });
    const alreadyPresentsWhiteMembrane = hasPresentedMaterial && presentsOnlyWhiteMembrane;
    if (showWhiteMembrane && alreadyPresentsWhiteMembrane) {
      // The canonical white membrane is the final presentation for an object
      // without a visible texture. Publish a newly restored Group before the
      // material-builder fast path returns.
      revealInitialMaterialPresentation();
      return;
    }
    if (
      !showWhiteMembrane &&
      hasResidentProjectedMaterial &&
      committedProjectedMaterialStructureRef.current === projectedMaterialStructureKey
    ) {
      // Visibility, opacity, lighting and display-mode changes are already
      // applied synchronously by the resident-uniform effects/subscription.
      // Do not let those presentation-only changes enter the async material
      // builder and race a second 4K texture-array upload.
      // A restored Group can already own this resident material while its
      // atomic reveal gate still points at the previously mounted Group.
      revealInitialMaterialPresentation();
      return;
    }
    let cancelled = false;
    const model = importedModel;
    if (
      stableVisibleProjectedLayers.length === 0 &&
      Number(document.body.dataset.projectedPreviewProgress ?? '1') < 1
    ) {
      reportProjectedPreviewProgress(1, '已按图层眼睛状态隐藏投影结果', {
        done: true,
        layerCount: 0,
      });
    }
    const markProjectedBackgroundMaterialCommit = () => {
      if (typeof document === 'undefined') return;
      const previousRevision = Number(
        document.body.dataset.projectedBackgroundMaterialRevision ?? '0',
      );
      document.body.dataset.projectedBackgroundMaterialRevision = String(previousRevision + 1);
    };
    const markProjectedMaterialBuild = () => {
      if (typeof document === 'undefined') return;
      const previousRevision = Number(document.body.dataset.projectedMaterialBuildRevision ?? '0');
      document.body.dataset.projectedMaterialBuildRevision = String(previousRevision + 1);
      const buildReason = {
        unixMs: Date.now(),
        revision: previousRevision + 1,
        phase: document.body.dataset.perfLocalRepaintPhase,
        displayMode,
        previewLayerCount: previewProjectionInputs.length,
        residentLayerCount: stablePreviewProjectedLayers.length,
        useTextureArrays: useProjectedTextureArrays,
        fallback: textureArrayCompositionFallbackRequired,
      };
      document.body.dataset.projectedMaterialBuildReason = JSON.stringify(buildReason);
      if (document.body.dataset.perfLocalRepaintMeasuring === '1') {
        let history: (typeof buildReason)[] = [];
        try {
          history = JSON.parse(
            document.body.dataset.projectedMaterialBuildHistory ?? '[]',
          ) as typeof history;
        } catch {
          history = [];
        }
        history.push(buildReason);
        document.body.dataset.projectedMaterialBuildHistory = JSON.stringify(history.slice(-8));
      }
    };
    const isViewportInteractionBusy = () => {
      const interaction = projectedPreviewInteractionRef.current;
      const localRepaintPhase = document.body.dataset.perfLocalRepaintPhase;
      const simulatedInteractionIsPrewarm = localRepaintPhase === 's6-interaction-source-bind';
      return Boolean(
        isSharedViewportInteractionBusy() ||
        interaction.pointerDown ||
        performance.now() - interaction.lastMovedAt < 180 ||
        (document.body.dataset.perfSimulatedViewportInteraction === '1' &&
          !simulatedInteractionIsPrewarm) ||
        // Selecting a mask tool is not an active stroke. Keeping it selected
        // must not starve the previous repaint's resident-material handoff.
        document.body.dataset.perfViewportStressMeasuring === '1',
      );
    };
    const waitForViewportInteractionIdle = async () => {
      while (!cancelled && isViewportInteractionBusy()) {
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      }
    };
    const precompileProjectedMaterial = async (
      material: THREE.ShaderMaterial,
      target: THREE.WebGLRenderTarget | null = null,
    ) => {
      if (typeof gl.compileAsync !== 'function') return false;
      if (cancelled) return false;
      // On ANGLE/NVIDIA, linking the large projected shader while several 4K
      // stripe uploads are active can turn an otherwise asynchronous compile
      // into a 400ms+ main-thread driver stall. Preserve exact output and wait
      // for the already-started upload batch to release the renderer first.
      await waitForPreviewTextureUploadsIdle(gl, () => cancelled);
      // Join any cold-restore anchor before polling this renderer's program.
      await Promise.all(getProjectedProgramWarmupMap(gl).values());
      await waitForViewportInteractionIdle();
      if (cancelled) return false;
      const compileScene = new THREE.Scene();
      const compileGeometry = new THREE.BoxGeometry(1, 1, 1);
      const compileMesh = new THREE.Mesh(compileGeometry, material);
      compileMesh.frustumCulled = false;
      compileScene.add(compileMesh);
      const compileStartedAt = performance.now();
      try {
        await compileForRenderTarget(gl, compileScene, camera, target);
      } finally {
        const compileDurationMs = performance.now() - compileStartedAt;
        if (typeof document !== 'undefined') {
          document.body.dataset.projectedMaterialCompileDurationMs = compileDurationMs.toFixed(1);
          document.body.dataset.projectedMaterialCompileCompletedUnixMs = String(Date.now());
        }
        markPerformanceEvent('projection', 'projected-material-precompile', {
          durationMs: compileDurationMs,
          target: target ? 'offscreen' : 'viewport',
        });
        compileGeometry.dispose();
        compileMesh.removeFromParent();
      }
      // A newer React effect may supersede this material while the driver is
      // compiling it. The material must not be committed in that case, but the
      // successfully linked program is still valid and should remain resident
      // for the newer effect's structurally identical material.
      return true;
    };

    const prewarmProjectedUvSamplers = async (
      material: THREE.ShaderMaterial,
      textures: THREE.Texture[],
    ) => {
      const uvOverlayMap = material.uniforms.uvOverlayMap;
      const uvOverlayOpacityUniform = material.uniforms.uvOverlayOpacity;
      const useUvOverlayMap = material.uniforms.useUvOverlayMap;
      if (!uvOverlayMap || !uvOverlayOpacityUniform || !useUvOverlayMap || textures.length === 0)
        return;

      const previousMap = uvOverlayMap.value;
      const previousOpacity = uvOverlayOpacityUniform.value;
      const previousUseMap = useUvOverlayMap.value;
      const normalPreviewUniform = material.uniforms.normalPreviewEnabled;
      const previousNormalPreview = normalPreviewUniform?.value;
      const opacityUniforms = Object.entries(material.uniforms)
        .filter(([name]) => /^layerOpacity\d+$/.test(name))
        .map(([, uniform]) => uniform);
      const previousLayerOpacities = opacityUniforms.map((uniform) => uniform.value);
      const warmTarget = new THREE.WebGLRenderTarget(1, 1, {
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
      });
      const warmScene = new THREE.Scene();
      const warmGeometry = new THREE.PlaneGeometry(2, 2);
      const warmMesh = new THREE.Mesh(warmGeometry, material);
      warmMesh.frustumCulled = false;
      warmScene.add(warmMesh);
      const warmCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const context = gl.getContext();

      try {
        // Three selects a distinct output-color/tone-mapping program for an
        // offscreen target. Viewport compilation alone leaves the first warmup
        // draw synchronously linking that variant (440–467ms in perf_3c6a4f18).
        // Keep the same sampler exercise, but finish its exact program first.
        await precompileProjectedMaterial(material, warmTarget);
        if (cancelled) return;
        opacityUniforms.forEach((uniform) => {
          uniform.value = 0;
        });
        uvOverlayOpacityUniform.value = 1;
        useUvOverlayMap.value = 1;
        for (const normalPreview of normalPreviewUniform ? [0, 1] : [0]) {
          if (normalPreviewUniform) normalPreviewUniform.value = normalPreview;
          for (const texture of textures) {
            await waitForViewportInteractionIdle();
            if (cancelled) return;
            uvOverlayMap.value = texture;
            // Never keep an offscreen target bound across an await/rAF. R3F
            // renders the visible scene during that wait and leaves the default
            // framebuffer active. The old code then drew this fullscreen warmup
            // plane into the browser canvas, exposing the UV atlas and the
            // purple normal-preview frame during F5 restore.
            const frameTarget = gl.getRenderTarget();
            const frameAutoClear = gl.autoClear;
            try {
              gl.autoClear = true;
              gl.setRenderTarget(warmTarget);
              gl.render(warmScene, warmCamera);
            } finally {
              gl.setRenderTarget(frameTarget);
              gl.autoClear = frameAutoClear;
            }
            if ('fenceSync' in context) {
              const gl2 = context as WebGL2RenderingContext;
              const sync = gl2.fenceSync(gl2.SYNC_GPU_COMMANDS_COMPLETE, 0);
              if (sync) {
                gl2.flush();
                try {
                  while (!cancelled) {
                    await waitForViewportInteractionIdle();
                    await new Promise<void>((resolve) =>
                      window.requestAnimationFrame(() => resolve()),
                    );
                    const status = gl2.clientWaitSync(sync, 0, 0);
                    if (status === gl2.ALREADY_SIGNALED || status === gl2.CONDITION_SATISFIED)
                      break;
                    if (status === gl2.WAIT_FAILED) break;
                  }
                } finally {
                  gl2.deleteSync(sync);
                }
              }
            }
          }
        }
        document.body.dataset.projectedUvSamplerPrewarmCount = String(textures.length);
      } finally {
        uvOverlayMap.value = previousMap;
        uvOverlayOpacityUniform.value = previousOpacity;
        useUvOverlayMap.value = previousUseMap;
        if (normalPreviewUniform) normalPreviewUniform.value = previousNormalPreview;
        opacityUniforms.forEach((uniform, index) => {
          uniform.value = previousLayerOpacities[index];
        });
        warmMesh.removeFromParent();
        warmGeometry.dispose();
        warmTarget.dispose();
      }
    };

    async function applyMaterials() {
      if (model.restoreStage === 'bounds') return;
      if (model.restoreStage === 'outline') {
        if (model.group.userData.liclickRestoreOutlinePrepared === true) {
          return;
        }
        const outlineMaterial = createFlatPreviewMaterial(
          undefined,
          false,
          undefined,
          previewLighting,
        );
        const disposedMaterials = new Set<THREE.Material | THREE.Material[]>();
        let materialChanged = false;
        model.group.traverse((child) => {
          if (!(child instanceof THREE.Mesh) || child.userData.liclickPaintOverlay) return;
          const previousMaterial = child.material;
          child.material = outlineMaterial;
          if (previousMaterial !== outlineMaterial) materialChanged = true;
          if (previousMaterial !== outlineMaterial && !disposedMaterials.has(previousMaterial)) {
            disposedMaterials.add(previousMaterial);
            disposeGeneratedMaterialTree(previousMaterial);
          }
        });
        if (materialChanged) markProjectedBackgroundMaterialCommit();
        model.group.userData.liclickProjectedPreviewStatus = {
          mode: 'outline',
          ready: false,
          logicalLayerCount: 0,
          processedLayerIds: [],
          missingLayerIds: [],
        };
        // Keep the exact geometry hidden while its authoritative colour stack
        // is decoding. This model's loading indicator owns presentation until
        // the full material is resident.
        return;
      }
      if (
        model.restoreStage === 'proxy' &&
        !loadedUvTexture &&
        !loadedBakedTexture &&
        !loadedContentAwareUnderlayTexture &&
        !liveTopUvTexture
      ) {
        // A proxy is an internal warm-up stage, not user-visible project state.
        return;
      }
      const selected = false;
      model.group.updateMatrixWorld(true);
      const useProjectedTextureArrayMaterial =
        useProjectedTextureArrays && !textureArrayCompositionFallbackRequired;
      const materialProjectionInputs = progressiveProjectedPreviewReady
        ? activeProjectedPreviewInputs
        : progressiveIncrementalPreviewReady
          ? progressiveIncrementalInputs
          : previewProjectionInputs;
      const showGeometryOnlyDisplay = displayMode === 'normal' || displayMode === 'wire';
      const hasResidentProjectionInputs = Boolean(
        canPreviewProjectedLayers && materialProjectionInputs.length > 0,
      );
      // The projected shader already owns white-membrane, normal and wire
      // uniforms. Keep its full-resolution texture arrays resident across
      // display-mode and eye-state changes; replacing it here discarded GPU
      // state and made the next colour frame wait for an async rebuild.
      // An empty colour stack must use the exact same MeshStandardMaterial as
      // the initial model state. Keeping the projected shader and merely
      // zeroing its samplers produced a brighter, low-contrast white membrane
      // because that shader has a separate lighting equation.
      const bypassProjectedMaterial =
        showWhiteMembrane || (showGeometryOnlyDisplay && !hasResidentProjectionInputs);
      const activeProgressivePreviewBase = showWhiteMembrane ? undefined : progressivePreviewBase;
      const projectedLayerInput = hasResidentProjectionInputs
        ? {
            layers: materialProjectionInputs,
            objectId: model.objectId,
            currentObjectMatrixWorld: model.group.matrixWorld.toArray(),
            // Reserve the sparse repair sampler from the first projected
            // material build. Adding/replacing a content-aware result is now
            // a texture + opacity uniform update and cannot invalidate the
            // 14-layer texture-array structure.
            reserveBaseMapSampler: true,
            reserveUvOverlaySampler: hasResidentUvOverlaySampler,
            ...(activeProgressivePreviewBase
              ? {
                  baseTexture: activeProgressivePreviewBase.colorTexture,
                  baseRenderedColorMaskTexture:
                    activeProgressivePreviewBase.renderedColorMaskTexture,
                }
              : loadedContentAwareUnderlayTexture
                ? {
                    baseTexture: loadedContentAwareUnderlayTexture,
                    baseTextureOpacity: contentAwareUnderlayOpacity,
                  }
                : {}),
            uvOverlayHue: directUvLayer ? (directUvLayer.adjustments?.hue ?? 0) / 100 : 0,
            uvOverlaySaturation: directUvLayer
              ? (directUvLayer.adjustments?.saturation ?? 0) / 100
              : 0,
            uvOverlayLightness: directUvLayer
              ? (directUvLayer.adjustments?.lightness ?? 0) / 100
              : 0,
            uvOverlayOpacity,
            uvOverlayBelowProjected: Number.isFinite(visibleMergedUvBoundaryOrder),
            uvOverlayRenderedColor: directUvRenderedColor,
            ...(directUvRenderedColorMaskTexture
              ? { uvOverlayRenderedColorMaskTexture: directUvRenderedColorMaskTexture }
              : {}),
            depthTest: true,
            enableBackfaceCulling: true,
            edgeFeather: 0.004,
            depthBias: 0.025,
            normalPreview: false,
            wirePreview: false,
            previewLighting,
            ...(liveProjectedEraserMaskTexture && liveSurfacePaintPreview
              ? {
                  liveEraserMaskTexture: liveProjectedEraserMaskTexture,
                  liveEraserLayerId: liveSurfacePaintPreview.layerId,
                }
              : {}),
          }
        : undefined;
      const projectedPreviewOverBudget = Boolean(
        canPreviewProjectedLayers &&
        projectedPreviewNeedsComposition &&
        !canUseProgressivePreviewBase,
      );
      const progressiveBaseOnly =
        !showWhiteMembrane && canUseProgressivePreviewBase && materialProjectionInputs.length === 0;
      const previewStatus = {
        mode: projectedPreviewOverBudget
          ? 'gpu-composing'
          : useProjectedTextureArrayMaterial
            ? 'texture-array'
            : progressiveProjectedPreviewReady
              ? 'gpu-composite'
              : progressiveIncrementalPreviewReady
                ? 'gpu-incremental'
                : projectedLayerInput
                  ? 'direct'
                  : previewBakedTextureRecord
                    ? 'exact-baked'
                    : 'base',
        ready: !projectedPreviewOverBudget,
        logicalLayerCount: previewProjectionInputs.length,
        processedLayerIds: projectedPreviewOverBudget
          ? (progressiveProjectedPreview?.layerIds ?? [])
          : previewProjectionInputs.map((layer) => layer.layerId),
        missingLayerIds: projectedPreviewOverBudget
          ? previewProjectionInputs
              .map((layer) => layer.layerId)
              .filter((layerId) => !progressiveProjectedPreview?.layerIds.includes(layerId))
          : [],
        samplerBudget: projectedSamplerBudget,
      };
      model.group.userData.liclickProjectedPreviewStatus = previewStatus;
      if (isPerformanceLabEnabled(window.location.search)) {
        document.body.dataset.projectedPreviewStatus = JSON.stringify(previewStatus);
      }
      if (projectedPreviewOverBudget) {
        const warningKey = `${projectedSamplerBudget.required}/${projectedSamplerBudget.available}:${previewProjectedLayerSignature}`;
        if (lastProjectedSamplerWarningRef.current !== warningKey) {
          lastProjectedSamplerWarningRef.current = warningKey;
          const toastStore = useToastStore.getState();
          toastStore.pushToast({
            title: '投影图层较多，正在准备完整预览',
            description: '当前预览尚未更新完成。可使用图层栏的“合并可见投影层为 UV 图层”减少实时混合负担。',
            tone: 'warning',
            persistent: true,
            dedupeKey: PROJECTED_PREVIEW_LIMIT_TOAST_KEY,
          });
        }
      } else {
        lastProjectedSamplerWarningRef.current = '';
        const toastStore = useToastStore.getState();
        if (
          toastStore.toasts.some(
            (toast) =>
              toast.dedupeKey === PROJECTED_PREVIEW_LIMIT_TOAST_KEY && toast.tone === 'warning',
          )
        ) {
          toastStore.dismissToastByDedupeKey(PROJECTED_PREVIEW_LIMIT_TOAST_KEY);
        }
      }

      const meshes: THREE.Mesh[] = [];
      model.group.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        if (child.userData.liclickPaintOverlay) return;
        meshes.push(child);
      });
      const hasPresentedProjectedMaterial = meshes.some((mesh) => {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        return materials.some((material) =>
          isResidentProjectedMaterial(material),
        );
      });
      const hasPresentedBootstrapMaterial = meshes.some((mesh) => {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        return materials.some((material) => material.userData.liclickProjectedBootstrap === true);
      });
      const exactBakedBootstrapTexture =
        loadedBakedTexture &&
        !showWhiteMembrane &&
        stableVisibleProjectedLayers.length > 0 &&
        !hasLiveProjectedPreview &&
        !liveProjectedEraserMaskTexture &&
        !stableVisibleProjectedLayers.some((layer) => layer.needsRebake)
          ? loadedBakedTexture
          : undefined;
      const canPresentUvBootstrap = Boolean(
        !showWhiteMembrane &&
        (displayMode === 'flat' || displayMode === 'pbr') &&
        !hasPresentedProjectedMaterial &&
        !hasPresentedBootstrapMaterial &&
        (exactBakedBootstrapTexture ||
          (loadedUvTexture && uvOverlayOpacity > 0) ||
          liveTopUvTexture ||
          (loadedContentAwareUnderlayTexture && contentAwareUnderlayOpacity > 0)),
      );
      if (canPresentUvBootstrap) {
        // A cold restore needs several seconds to decode, resize and upload the
        // complete projected texture arrays. Present an already decoded exact
        // bake or UV contribution first, then replace it atomically with the
        // authoritative projected material. This removes the white-membrane
        // wait without changing the final projection algorithm or its output.
        const bootstrapMaterial = createUvOverlayPreviewMaterial({
          displayMode,
          selected,
          showEmptyUvChecker: false,
          previewLighting,
          ...(exactBakedBootstrapTexture
            ? {
                baseTexture: exactBakedBootstrapTexture,
                baseTextureOpacity: 1,
              }
            : {
                ...(loadedContentAwareUnderlayTexture
                  ? {
                      baseTexture: loadedContentAwareUnderlayTexture,
                      baseTextureOpacity: contentAwareUnderlayOpacity,
                    }
                  : {}),
                ...(loadedUvTexture
                  ? {
                      uvOverlayTexture: loadedUvTexture,
                      uvOverlayRenderedColor: directUvRenderedColor,
                      ...(directUvRenderedColorMaskTexture
                        ? {
                            uvOverlayRenderedColorMaskTexture: directUvRenderedColorMaskTexture,
                          }
                        : {}),
                      uvOverlayOpacity,
                      uvOverlayHue: directUvLayer ? (directUvLayer.adjustments?.hue ?? 0) / 100 : 0,
                      uvOverlaySaturation: directUvLayer
                        ? (directUvLayer.adjustments?.saturation ?? 0) / 100
                        : 0,
                      uvOverlayLightness: directUvLayer
                        ? (directUvLayer.adjustments?.lightness ?? 0) / 100
                        : 0,
                    }
                  : {}),
                ...(liveTopUvTexture
                  ? {
                      liveUvOverlayTexture: liveTopUvTexture,
                      liveUvOverlayOpacity: liveTopUvLayer?.opacity ?? 1,
                      liveUvOverlayRenderedColor: liveTopUvLayer
                        ? usesUnlitRenderedColor(liveTopUvLayer)
                        : false,
                      liveUvOverlayHue: (liveTopUvLayer?.adjustments?.hue ?? 0) / 100,
                      liveUvOverlaySaturation: (liveTopUvLayer?.adjustments?.saturation ?? 0) / 100,
                      liveUvOverlayLightness: (liveTopUvLayer?.adjustments?.lightness ?? 0) / 100,
                    }
                  : {}),
              }),
        });
        bootstrapMaterial.userData.liclickProjectedBootstrap = true;
        bootstrapMaterial.userData.liclickExactProjectedBootstrap = Boolean(
          exactBakedBootstrapTexture,
        );
        const disposedBootstrapMaterials = new Set<THREE.Material | THREE.Material[]>();
        for (const mesh of meshes) {
          const previousMaterial = mesh.material;
          mesh.material = bootstrapMaterial;
          if (
            previousMaterial !== bootstrapMaterial &&
            !disposedBootstrapMaterials.has(previousMaterial)
          ) {
            disposedBootstrapMaterials.add(previousMaterial);
            disposeGeneratedMaterialTree(previousMaterial);
          }
        }
        markProjectedBackgroundMaterialCommit();
        document.body.dataset.projectedBootstrapMaterialReadyUnixMs = String(Date.now());
        document.body.dataset.projectedBootstrapMaterialMode = exactBakedBootstrapTexture
          ? 'exact-baked'
          : 'uv-resident';
        invalidate();
      }
      let finalProjectedMaterialCommitted = false;
      // A one-camera bootstrap is visibly incorrect from every other side and
      // produced the white/black/partial-texture sequence captured in the
      // regression video. Keep the full array build, but publish only its final
      // precompiled material.
      const allowProgressiveDirectBootstrap = false as boolean;
      const representativeProjectedLayer =
        allowProgressiveDirectBootstrap &&
        useProjectedTextureArrayMaterial &&
        (displayMode === 'flat' || displayMode === 'pbr') &&
        !hasPresentedProjectedMaterial &&
        !hasPresentedBootstrapMaterial &&
        !canPresentUvBootstrap
          ? (() => {
              const visibleBaseLayers = materialProjectionInputs.filter(
                (layer) => layer.visible && layer.compositeRole !== 'overlay',
              );
              const candidates =
                visibleBaseLayers.length > 0
                  ? visibleBaseLayers
                  : materialProjectionInputs.filter((layer) => layer.visible);
              if (candidates.length <= 1) return candidates[0];
              const objectWorldPosition = new THREE.Vector3();
              const currentViewDirection = new THREE.Vector3();
              model.group.getWorldPosition(objectWorldPosition);
              currentViewDirection.copy(camera.position).sub(objectWorldPosition).normalize();
              return candidates.reduce((best, candidate) => {
                const bestDirection = new THREE.Vector3()
                  .fromArray(best.camera.position)
                  .sub(objectWorldPosition)
                  .normalize();
                const candidateDirection = new THREE.Vector3()
                  .fromArray(candidate.camera.position)
                  .sub(objectWorldPosition)
                  .normalize();
                return candidateDirection.dot(currentViewDirection) >
                  bestDirection.dot(currentViewDirection)
                  ? candidate
                  : best;
              });
            })()
          : undefined;
      if (representativeProjectedLayer && projectedLayerInput) {
        // Projection-only projects have no decoded UV texture to use as their
        // first frame. Build one camera-matched direct layer in parallel with
        // the complete arrays. It is only a progressive placeholder: the same
        // authoritative array promise still determines the final material.
        markProjectedMaterialBuild();
        void createProjectedLayerStackMaterial(
          {
            ...projectedLayerInput,
            layers: [representativeProjectedLayer],
          },
          {
            maxTextureImageUnits: gl.capabilities.maxTextures,
            renderer: gl,
            isCancelled: () => cancelled,
            isViewportInteractionBusy,
            preferTextureArrays: false,
          },
        )
          .then((bootstrapMaterial) => {
            if (!bootstrapMaterial) return;
            if (cancelled || finalProjectedMaterialCommitted) {
              disposeGeneratedMaterialTree(bootstrapMaterial);
              return;
            }
            bootstrapMaterial.userData.liclickProjectedBootstrap = true;
            const disposedBootstrapMaterials = new Set<THREE.Material | THREE.Material[]>();
            for (const mesh of meshes) {
              const previousMaterial = mesh.material;
              mesh.material = bootstrapMaterial;
              if (
                previousMaterial !== bootstrapMaterial &&
                !disposedBootstrapMaterials.has(previousMaterial)
              ) {
                disposedBootstrapMaterials.add(previousMaterial);
                disposeGeneratedMaterialTree(previousMaterial);
              }
            }
            markProjectedBackgroundMaterialCommit();
            document.body.dataset.projectedBootstrapMaterialReadyUnixMs = String(Date.now());
            document.body.dataset.projectedBootstrapMaterialMode = 'projected-direct';
            invalidate();
          })
          .catch((error) => {
            if (!cancelled) {
              console.warn(
                '[Liclick 3D Texture] Progressive direct projection bootstrap was unavailable.',
                error,
              );
            }
          });
      }
      let sharedProjectedMaterial: THREE.ShaderMaterial | undefined;
      let sharedProjectedMaterialRequested = false;
      let reusedResidentProjectedMaterial = false;
      let usingSharedTextureArrayBuild = false;
      let sharedTextureArrayBuildSignature = '';
      let materialChanged = false;
      const disposedPreviousMaterials = new Set<THREE.Material | THREE.Material[]>();
      const retainProjectedMaterialForReuse = (material: THREE.Material | THREE.Material[]) => {
        if (
          !(material instanceof THREE.ShaderMaterial) ||
          !isResidentProjectedMaterial(material)
        )
          return false;
        const alreadyResident = residentProjectedMaterialRef.current;
        if (!alreadyResident) {
          residentProjectedMaterialRef.current = material;
        } else if (alreadyResident !== material) {
          disposeGeneratedMaterialTree(material);
        }
        return true;
      };
      const disposeUnlessRetained = (material: THREE.Material | THREE.Material[]) => {
        if (!retainProjectedMaterialForReuse(material)) {
          disposeGeneratedMaterialTree(material);
        }
      };
      const bypassMaterial = bypassProjectedMaterial
        ? createDisplayModeMaterial(displayMode, selected, undefined, previewLighting)
        : undefined;

      const residentProjectedMaterial = residentProjectedMaterialRef.current;
      if (projectedLayerInput && residentProjectedMaterial) {
        const residentInput: ProjectionLayerStackInput = {
          ...projectedLayerInput,
          ...(loadedUvTexture ? { uvOverlayTexture: loadedUvTexture } : {}),
          uvOverlayRenderedColor: directUvRenderedColor,
          ...(directUvRenderedColorMaskTexture
            ? { uvOverlayRenderedColorMaskTexture: directUvRenderedColorMaskTexture }
            : {}),
          ...topUvProjectedOverlayInput,
        };
        if (updateProjectedLayerStackMaterial(residentProjectedMaterial, residentInput)) {
          sharedProjectedMaterial = residentProjectedMaterial;
          sharedProjectedMaterialRequested = true;
          reusedResidentProjectedMaterial = true;
        } else {
          disposeGeneratedMaterialTree(residentProjectedMaterial);
        }
        residentProjectedMaterialRef.current = undefined;
      }

      for (const child of meshes) {
        // Color in the texture workspace is owned exclusively by the layer
        // stack. Imported Base Color maps are promoted to ordinary, toggleable
        // UV layers during import. When none of those layers contributes, the
        // model must be the neutral white membrane even if the FBX material
        // itself carries a black diffuse color.
        const existingBakedTexture =
          child.userData.bakedTexture instanceof THREE.Texture
            ? child.userData.bakedTexture
            : undefined;
        const bakedTexture =
          !projectedLayerInput && visibleStackHasBakedPreview
            ? (loadedBakedTexture ?? existingBakedTexture)
            : undefined;
        if (bakedTexture) child.userData.bakedTexture = bakedTexture;
        const previousMaterial = child.material;
        if (projectedPreviewOverBudget) continue;
        if (bypassMaterial) {
          if (previousMaterial !== bypassMaterial) {
            disposeUnlessRetained(previousMaterial);
          }
          child.material = bypassMaterial;
          if (previousMaterial !== bypassMaterial) materialChanged = true;
          continue;
        }
        if (
          (loadedUvTexture ||
            liveTopUvTexture ||
            loadedContentAwareUnderlayTexture ||
            progressiveBaseOnly) &&
          !projectedLayerInput
        ) {
          const uvMaterialInput = {
            displayMode,
            selected,
            // When a sparse content-aware repair is the UV base, transparent
            // overlay texels must reveal that repair. The empty-UV checker is
            // only a diagnostic fallback; drawing it here hid valid repairs
            // immediately after projected layers were merged.
            showEmptyUvChecker: !loadedContentAwareUnderlayTexture,
            ...(loadedUvTexture
              ? {
                  uvOverlayTexture: loadedUvTexture,
                  uvOverlayRenderedColor: directUvRenderedColor,
                  uvOverlayOpacity,
                  ...(directUvRenderedColorMaskTexture
                    ? {
                        uvOverlayRenderedColorMaskTexture: directUvRenderedColorMaskTexture,
                      }
                    : {}),
                  uvOverlayHue: directUvLayer ? (directUvLayer.adjustments?.hue ?? 0) / 100 : 0,
                  uvOverlaySaturation: directUvLayer
                    ? (directUvLayer.adjustments?.saturation ?? 0) / 100
                    : 0,
                  uvOverlayLightness: directUvLayer
                    ? (directUvLayer.adjustments?.lightness ?? 0) / 100
                    : 0,
                }
              : {}),
            ...(liveTopUvTexture
              ? {
                  liveUvOverlayTexture: liveTopUvTexture,
                  liveUvOverlayOpacity: liveTopUvLayer?.opacity ?? 1,
                  liveUvOverlayRenderedColor: liveTopUvLayer
                    ? usesUnlitRenderedColor(liveTopUvLayer)
                    : false,
                  liveUvOverlayHue: (liveTopUvLayer?.adjustments?.hue ?? 0) / 100,
                  liveUvOverlaySaturation: (liveTopUvLayer?.adjustments?.saturation ?? 0) / 100,
                  liveUvOverlayLightness: (liveTopUvLayer?.adjustments?.lightness ?? 0) / 100,
                }
              : {}),
            previewLighting,
            ...(liveSurfaceMaskTexture ? { surfaceMaskTexture: liveSurfaceMaskTexture } : {}),
            ...(loadedContentAwareUnderlayTexture
              ? {
                  baseTexture: loadedContentAwareUnderlayTexture,
                  baseTextureOpacity: contentAwareUnderlayOpacity,
                }
              : {}),
            ...(bakedTexture ? { baseTexture: bakedTexture, baseTextureOpacity: 1 } : {}),
            ...(progressiveBaseOnly && progressivePreviewBase
              ? {
                  baseTexture: progressivePreviewBase.colorTexture,
                  baseTextureOpacity: 1,
                  baseRenderedColorMaskTexture: progressivePreviewBase.renderedColorMaskTexture,
                }
              : {}),
          };
          if (updateUvOverlayPreviewMaterial(previousMaterial, uvMaterialInput)) continue;
          child.material = createUvOverlayPreviewMaterial(uvMaterialInput);
          disposeUnlessRetained(previousMaterial);
          continue;
        }
        if (
          bakedTexture &&
          !projectedLayerInput &&
          (displayMode === 'flat' || displayMode === 'pbr')
        ) {
          child.material = createUvOverlayPreviewMaterial({
            displayMode,
            selected,
            baseTexture: bakedTexture,
            ...(liveSurfaceMaskTexture ? { surfaceMaskTexture: liveSurfaceMaskTexture } : {}),
            previewLighting,
          });
          disposeUnlessRetained(previousMaterial);
          continue;
        }
        if (displayMode === 'pbr' && !projectedLayerInput) {
          child.material = createPbrPreviewMaterial(
            undefined,
            selected,
            bakedTexture,
            previewLighting,
          );
          disposeUnlessRetained(previousMaterial);
          continue;
        }
        if (displayMode === 'flat' && !projectedLayerInput) {
          child.material = createFlatPreviewMaterial(
            undefined,
            selected,
            bakedTexture,
            previewLighting,
          );
          disposeUnlessRetained(previousMaterial);
          continue;
        }
        if (
          projectedLayerInput &&
          updateProjectedLayerStackMaterial(previousMaterial, {
            ...projectedLayerInput,
            ...(loadedUvTexture ? { uvOverlayTexture: loadedUvTexture } : {}),
            uvOverlayRenderedColor: directUvRenderedColor,
            ...(directUvRenderedColorMaskTexture
              ? { uvOverlayRenderedColorMaskTexture: directUvRenderedColorMaskTexture }
              : {}),
            ...topUvProjectedOverlayInput,
          })
        ) {
          continue;
        }
        if (projectedLayerInput && !sharedProjectedMaterialRequested) {
          sharedProjectedMaterialRequested = true;
          const projectedMaterialInput: ProjectionLayerStackInput = {
            ...projectedLayerInput,
            ...(loadedUvTexture ? { uvOverlayTexture: loadedUvTexture } : {}),
            uvOverlayRenderedColor: directUvRenderedColor,
            ...(directUvRenderedColorMaskTexture
              ? { uvOverlayRenderedColorMaskTexture: directUvRenderedColorMaskTexture }
              : {}),
            ...topUvProjectedOverlayInput,
          };
          try {
            if (useProjectedTextureArrayMaterial) {
              usingSharedTextureArrayBuild = true;
              const textureArrayBuildSignature = [
                projectedTextureArrayStructureSignature,
                // The UV overlay owns a reserved direct sampler and is updated
                // as a uniform. Including its runtime texture UUID here rebuilt
                // an otherwise unchanged 14-layer array after restore/HMR.
                liveTopUvTexture?.uuid ?? '',
              ].join('|');
              sharedTextureArrayBuildSignature = textureArrayBuildSignature;
              if (projectedTextureArrayBuildRef.current?.signature !== textureArrayBuildSignature) {
                // A newly arrived projection makes every older structural array
                // obsolete. Previously those O(1..N) builds all continued to
                // pack and upload in the background, so a 14-view batch rebuilt
                // the same slices 105 times and repeatedly blocked presentation.
                // Display-only reruns retain the same signature and still reuse
                // the in-flight build.
                if (projectedTextureArrayBuildRef.current) {
                  projectedTextureArrayBuildRef.current.cancelled = true;
                }
                const nextBuild = {
                  signature: textureArrayBuildSignature,
                  cancelled: false,
                  promise: undefined as unknown as Promise<THREE.ShaderMaterial | undefined>,
                  precompilePromise: undefined as Promise<void> | undefined,
                };
                const visibleLayerCount = projectedMaterialInput.layers.filter(
                  (layer) => layer.visible,
                ).length;
                if (visibleLayerCount > 0) {
                  reportProjectedPreviewProgress(
                    0.12,
                    `正在准备 ${visibleLayerCount} 个可见层（${projectedMaterialInput.layers.length} 层驻留）`,
                    { layerCount: visibleLayerCount },
                  );
                }
                markProjectedMaterialBuild();
                nextBuild.promise = createProjectedLayerStackMaterial(projectedMaterialInput, {
                  maxTextureImageUnits: gl.capabilities.maxTextures,
                  renderer: gl,
                  isCancelled: () => nextBuild.cancelled,
                  isViewportInteractionBusy,
                  preferTextureArrays: true,
                });
                projectedTextureArrayBuildRef.current = nextBuild;
              }
              const textureArrayBuild = projectedTextureArrayBuildRef.current;
              sharedProjectedMaterial = await textureArrayBuild.promise;
              if (sharedProjectedMaterial) {
                const visibleLayerCount = projectedMaterialInput.layers.filter(
                  (layer) => layer.visible,
                ).length;
                if (visibleLayerCount > 0) {
                  reportProjectedPreviewProgress(
                    0.86,
                    `GPU 纹理已上传，正在编译 ${visibleLayerCount} 个可见层`,
                    { layerCount: visibleLayerCount },
                  );
                }
                // Shader compilation is a background publication step. It must
                // never compete with pointer/wheel frames even after upload has
                // already completed.
                await waitForViewportInteractionIdle();
                if (cancelled) return;
                // A cold outline restore starts the same structural build early.
                // Wait for its single precompile instead of polling the same
                // material concurrently from two compileAsync calls; Three's
                // parallel poller can otherwise observe an undefined program.
                if (textureArrayBuild.precompilePromise) {
                  await textureArrayBuild.precompilePromise;
                } else {
                  await precompileProjectedMaterial(sharedProjectedMaterial);
                }
                const warmup = projectedProgramWarmupRef.current;
                if (
                  warmup &&
                  warmup.material.vertexShader === sharedProjectedMaterial.vertexShader &&
                  warmup.material.fragmentShader === sharedProjectedMaterial.fragmentShader
                ) {
                  // The real material has now acquired the warmed WebGL program;
                  // release only the texture-free anchor. The program remains
                  // referenced by the authoritative material.
                  if (warmup.ready) warmup.material.dispose();
                  else warmup.disposeWhenReady = true;
                  acquiredProjectedProgramSignaturesRef.current.add(warmup.signature);
                  projectedProgramWarmupRef.current = undefined;
                  document.body.dataset.projectedProgramWarmupMatched = '1';
                } else if (warmup) {
                  document.body.dataset.projectedProgramWarmupMatched = '0';
                }
                const residentUvTextures = stableResidentUvToggleLayers.flatMap((layer) => {
                  const texture = getReadyResidentPreviewTexture(layer.imageUrl, gl);
                  return texture ? [texture] : [];
                });
                if (loadedUvTexture) residentUvTextures.push(loadedUvTexture);
                await prewarmProjectedUvSamplers(sharedProjectedMaterial, [
                  ...new Set(residentUvTextures),
                ]);
                if (visibleLayerCount > 0) {
                  reportProjectedPreviewProgress(0.96, '材质已就绪，正在按图层眼睛状态发布', {
                    layerCount: visibleLayerCount,
                  });
                }
                if (
                  projectedTextureArrayBuildRef.current?.signature !== textureArrayBuildSignature
                ) {
                  disposeGeneratedMaterialTree(sharedProjectedMaterial);
                  return;
                }
                const latestLayerState = useLayerStore.getState();
                const latestPreviewLayerId = useSceneStore.getState().localRepaintPreviewLayer?.id;
                const latestMergedUvBoundaryOrder = getVisibleMergedUvBoundaryOrder(
                  latestLayerState.layers,
                  importedModel.objectId,
                );
                const latestDisplayLayers = latestLayerState.layers
                  .filter(
                    (layer) =>
                      layer.type === 'projected' &&
                      (!layer.objectId || layer.objectId === importedModel.objectId),
                  )
                  .map((layer) => ({
                    ...toProjectionLayerDisplayInput(layer),
                    visible:
                      layer.visible &&
                      layer.id !== latestPreviewLayerId &&
                      isProjectedLayerAboveMergedUv(layer, latestMergedUvBoundaryOrder),
                  }));
                const latestDisplayMode = useSceneStore.getState().displayMode;
                syncProjectedLayerMaterialDisplayState(
                  sharedProjectedMaterial,
                  latestDisplayLayers,
                  latestDisplayMode === 'normal',
                  latestDisplayMode === 'wire',
                );
                const latestObjectUvLayers = latestLayerState.layers.filter(
                  (layer) =>
                    layer.type === 'uv' &&
                    Boolean(layer.imageUrl) &&
                    (!layer.objectId || layer.objectId === importedModel.objectId),
                );
                const latestOrdinaryUvLayers = latestObjectUvLayers.filter(
                  (layer) =>
                    layer.visible &&
                    layer.role !== 'content-aware-underlay' &&
                    layer.role !== 'local-repaint-overlay' &&
                    layer.role !== 'local-repaint-draft',
                );
                const latestOrdinaryUvKey = residentUvVisibilityKey(latestOrdinaryUvLayers);
                const latestResidentUvTexture =
                  latestOrdinaryUvLayers.length === 1
                    ? getReadyResidentPreviewTexture(latestOrdinaryUvLayers[0].imageUrl, gl)
                    : latestOrdinaryUvLayers.length > 1
                      ? residentUvPresentationCacheRef.current.get(latestOrdinaryUvKey)
                      : undefined;
                const latestContentAwareLayers = latestObjectUvLayers.filter(
                  (layer) => layer.visible && layer.role === 'content-aware-underlay',
                );
                const currentContentAwarePresentation = contentAwareUnderlayPresentationRef.current;
                const latestResidentContentAwareTexture =
                  latestContentAwareLayers.length === 1
                    ? getReadyResidentPreviewTexture(latestContentAwareLayers[0].imageUrl, gl)
                    : undefined;
                if (sharedProjectedMaterial.uniforms.uvOverlayOpacity) {
                  if (latestResidentUvTexture && sharedProjectedMaterial.uniforms.uvOverlayMap) {
                    sharedProjectedMaterial.uniforms.uvOverlayMap.value = latestResidentUvTexture;
                  }
                  sharedProjectedMaterial.uniforms.uvOverlayOpacity.value =
                    latestResidentUvTexture && latestOrdinaryUvLayers.length === 1
                      ? latestOrdinaryUvLayers[0].opacity
                      : latestResidentUvTexture && latestOrdinaryUvLayers.length > 1
                        ? 1
                        : 0;
                }
                if (sharedProjectedMaterial.uniforms.uvOverlayBelowProjected) {
                  sharedProjectedMaterial.uniforms.uvOverlayBelowProjected.value = Number.isFinite(
                    latestMergedUvBoundaryOrder,
                  )
                    ? 1
                    : 0;
                }
                if (sharedProjectedMaterial.uniforms.baseTextureOpacity) {
                  const latestContentAwareTexture =
                    latestResidentContentAwareTexture ??
                    (latestContentAwareLayers.length > 0
                      ? currentContentAwarePresentation.texture
                      : undefined);
                  if (latestContentAwareTexture && sharedProjectedMaterial.uniforms.baseMap) {
                    sharedProjectedMaterial.uniforms.baseMap.value = latestContentAwareTexture;
                  }
                  if (latestContentAwareLayers.length === 0) {
                    sharedProjectedMaterial.uniforms.baseTextureOpacity.value = 0;
                  } else if (latestResidentContentAwareTexture) {
                    sharedProjectedMaterial.uniforms.baseTextureOpacity.value =
                      latestContentAwareLayers[0].opacity;
                  } else if (currentContentAwarePresentation.texture) {
                    sharedProjectedMaterial.uniforms.baseTextureOpacity.value =
                      currentContentAwarePresentation.opacity;
                  }
                }
              }
            } else {
              markProjectedMaterialBuild();
              sharedProjectedMaterial = await createProjectedLayerStackMaterial(
                projectedMaterialInput,
                {
                  maxTextureImageUnits: gl.capabilities.maxTextures,
                  renderer: gl,
                  isCancelled: () => cancelled,
                  isViewportInteractionBusy,
                  preferTextureArrays: useProjectedTextureArrayMaterial,
                },
              );
              // Direct stacks also need a linked program before the visible
              // render loop can acquire them; arrays already wait above.
              if (sharedProjectedMaterial) await precompileProjectedMaterial(sharedProjectedMaterial);
            }
          } catch (error) {
            if (
              usingSharedTextureArrayBuild &&
              projectedTextureArrayBuildRef.current?.signature === sharedTextureArrayBuildSignature
            ) {
              projectedTextureArrayBuildRef.current = undefined;
            }
            if (!useProjectedTextureArrayMaterial || cancelled) throw error;
            const circuitWasAlreadyOpen = isProjectedTextureArrayCircuitOpenError(error);
            if (!circuitWasAlreadyOpen) {
              console.warn(
                '[Liclick 3D Texture] Projected texture arrays are unavailable; switching the complete visible stack to a bounded fallback.',
                error,
              );
            }
            const visibleLayerCount = projectedLayerInput.layers.filter(
              (layer) => layer.visible,
            ).length;
            if (visibleLayerCount > 0 && !circuitWasAlreadyOpen) {
              reportProjectedPreviewProgress(
                1,
                error instanceof Error ? error.message : '投影纹理加载失败，请重试',
                { done: true, failed: true, layerCount: visibleLayerCount },
              );
            }
            setFailedProjectedTextureArraySignature(projectedTextureArrayStructureSignature);
            return;
          }
        }
        if (!reusedResidentProjectedMaterial && !usingSharedTextureArrayBuild) {
          await waitForViewportInteractionIdle();
        }
        const projectedMaterial = projectedLayerInput ? sharedProjectedMaterial : undefined;
        if (cancelled) {
          // A newer effect may be awaiting the same structural array upload.
          // Preserve it only while it is still the active shared build.
          const sharedBuildStillCurrent = Boolean(
            usingSharedTextureArrayBuild &&
            projectedTextureArrayBuildRef.current?.signature === sharedTextureArrayBuildSignature,
          );
          if (!sharedBuildStillCurrent) disposeGeneratedMaterialTree(projectedMaterial);
          return;
        }
        if (projectedMaterial && projectedLayerInput) {
          // A newer effect may intentionally reuse an in-flight texture-array
          // build because the layer structure is unchanged. Its samplers are
          // valid, but the build was created with the earlier effect's live
          // eraser layer/texture. Rebind every uniform-only input immediately
          // before publication so the shared material cannot resurrect that
          // stale binding after several short eraser clicks or a layer switch.
          updateProjectedLayerStackMaterial(projectedMaterial, {
            ...projectedLayerInput,
            ...(loadedUvTexture ? { uvOverlayTexture: loadedUvTexture } : {}),
            uvOverlayRenderedColor: directUvRenderedColor,
            ...(directUvRenderedColorMaskTexture
              ? { uvOverlayRenderedColorMaskTexture: directUvRenderedColorMaskTexture }
              : {}),
            ...topUvProjectedOverlayInput,
          });
        }
        if (projectedMaterial) finalProjectedMaterialCommitted = true;
        child.material =
          projectedMaterial ??
          createDisplayModeMaterial(displayMode, selected, bakedTexture, previewLighting);
        if (previousMaterial !== child.material) materialChanged = true;
        if (
          usingSharedTextureArrayBuild &&
          projectedTextureArrayBuildRef.current?.signature === sharedTextureArrayBuildSignature
        ) {
          projectedTextureArrayBuildRef.current = undefined;
        }
        if (
          previousMaterial !== child.material &&
          !disposedPreviousMaterials.has(previousMaterial)
        ) {
          disposedPreviousMaterials.add(previousMaterial);
          disposeGeneratedMaterialTree(previousMaterial);
        }
      }
      if (materialChanged) {
        markProjectedBackgroundMaterialCommit();
        window.dispatchEvent(
          new CustomEvent('liclick:projected-material-resident', {
            detail: { objectId: importedModel.objectId },
          }),
        );
        if (sharedProjectedMaterial) {
          document.body.dataset.projectedFinalMaterialReadyUnixMs = String(Date.now());
          document.body.dataset.textureRestoreProjectedReady = '1';
          document.body.dataset.textureRestoreProjectedReadyMs = performance.now().toFixed(1);
          const stackState = sharedProjectedMaterial.userData.liclickProjectedLayerStackState as
            | { bindings?: Array<{ layerId?: string }> }
            | undefined;
          const loadedLayerIds = new Set(
            stackState?.bindings?.flatMap((binding) =>
              binding.layerId ? [binding.layerId] : [],
            ) ?? [],
          );
          document.body.dataset.textureRestoreLoadedProjectedLayers = String(loadedLayerIds.size);
          const expectedLocalRepaintIds = stablePreviewProjectedLayers
            .filter(
              (layer) =>
                isRenderedLocalRepaintLayer(layer) ||
                Boolean(layer.localRepaintSourceUrl || layer.localRepaintMaskUrl),
            )
            .map((layer) => layer.id);
          document.body.dataset.textureRestoreLoadedLocalRepaintLayers = String(
            expectedLocalRepaintIds.filter((layerId) => loadedLayerIds.has(layerId)).length,
          );
          const visibleLoadedLayerCount =
            projectedLayerInput?.layers.filter(
              (layer) => layer.visible && loadedLayerIds.has(layer.layerId),
            ).length ?? 0;
          if (visibleLoadedLayerCount > 0) {
            reportProjectedPreviewProgress(1, `${visibleLoadedLayerCount} 个可见投影图层已显示`, {
              done: true,
              layerCount: visibleLoadedLayerCount,
            });
          }
        }
      }
      // Any async texture-array/runtime-visibility build may have started in a
      // previous display mode. Re-apply the current store authority after the
      // final material assignment so a late cold build cannot overwrite a
      // user's normal/wire/PBR click with stale uniforms.
      const authoritativeSceneState = useSceneStore.getState();
      const authoritativeSettings = useSettingsStore.getState();
      const authoritativeLayers = useLayerStore.getState().layers;
      const authoritativePreviewLayer = authoritativeSceneState.localRepaintPreviewLayer;
      const authoritativeMutedPreviewLayerId =
        authoritativePreviewLayer &&
        shouldMuteLocalRepaintResidentLayer(
          authoritativeLayers,
          authoritativePreviewLayer,
          authoritativePreviewLayer.id,
          authoritativeSceneState.paintTool === 'inpaint-apply',
        )
          ? authoritativePreviewLayer.id
          : undefined;
      const authoritativeMergedUvBoundaryOrder = getVisibleMergedUvBoundaryOrder(
        authoritativeLayers,
        importedModel.objectId,
      );
      const authoritativeDisplayLayers = authoritativeLayers
        .filter(
          (layer) =>
            layer.type === 'projected' &&
            (!layer.objectId || layer.objectId === importedModel.objectId),
        )
        .map((layer) => ({
          ...toProjectionLayerDisplayInput(layer),
          visible:
            layer.visible &&
            layer.id !== authoritativeMutedPreviewLayerId &&
            isProjectedLayerAboveMergedUv(layer, authoritativeMergedUvBoundaryOrder),
        }));
      const authoritativeLighting = getPreviewLighting({
        displayMode: authoritativeSceneState.displayMode,
        environmentPreset: authoritativeSettings.environmentPreset,
        exposure: authoritativeSettings.exposure,
        pbrEnvironmentIntensity: authoritativeSettings.pbrEnvironmentIntensity,
        pbrKeyLightIntensity: authoritativeSettings.pbrKeyLightIntensity,
        pbrLightAzimuth: authoritativeSettings.pbrLightAzimuth,
      });
      syncProjectedLayerMaterialDisplayStateInObject(
        model.group,
        authoritativeDisplayLayers,
        authoritativeSceneState.displayMode === 'normal',
        authoritativeSceneState.displayMode === 'wire',
        authoritativeLighting,
      );
      // An older async projected-material build may finish after UV merge and
      // carry the previous editing layer's unlit flag. Re-apply the latest UV
      // role after the final material assignment so role=merged-uv always
      // receives PBR lighting, while every other UV stack stays unlit.
      const authoritativeUvLayers = authoritativeLayers.filter(
        (layer) =>
          layer.type === 'uv' &&
          Boolean(layer.imageUrl) &&
          (!layer.objectId || layer.objectId === importedModel.objectId),
      );
      const authoritativeOrdinaryUvLayers = authoritativeUvLayers.filter(
        (layer) =>
          layer.visible &&
          layer.role !== 'content-aware-underlay' &&
          layer.role !== 'local-repaint-overlay' &&
          layer.role !== 'local-repaint-draft',
      );
      const authoritativeContentAwareUvLayers = authoritativeUvLayers.filter(
        (layer) => layer.visible && layer.role === 'content-aware-underlay',
      );
      const authoritativeLocalRepaintUvLayers = authoritativeUvLayers.filter(
        (layer) =>
          layer.visible &&
          (layer.role === 'local-repaint-overlay' || layer.role === 'local-repaint-draft'),
      );
      const hasLowerRepaintUv = authoritativeLocalRepaintUvLayers.some(
        (layer) => layer.id !== liveTopUvLayer?.id,
      );
      const authoritativeOrdinaryUvKey = residentUvVisibilityKey(authoritativeOrdinaryUvLayers);
      const authoritativeExactUvTexture =
        authoritativeOrdinaryUvLayers.length === 1
          ? getReadyResidentPreviewTexture(authoritativeOrdinaryUvLayers[0].imageUrl, gl)
          : authoritativeOrdinaryUvLayers.length > 1
            ? residentUvPresentationCacheRef.current.get(authoritativeOrdinaryUvKey)
            : undefined;
      // PROXY-EXACT-ATOMIC-HANDOFF v1.0.0: a restore-stage transition can
      // remount SceneRoot after its 512px proxy is already resident but before
      // the exact 4K upload is ready. Preserve a valid sampler until the exact
      // texture can replace it in one committed material update.
      const authoritativeProxyUvTexture =
        authoritativeOrdinaryUvLayers.length === 1
          ? getReadyResidentPreviewTexture(authoritativeOrdinaryUvLayers[0].imageUrl, gl, {
              maxSize: 512,
            })
          : undefined;
      // A previously decoded texture may remain resident for the next eye-open,
      // but it must never count as a visible contribution when every ordinary
      // UV row is authoritatively hidden. The old fallback resurrected the
      // merged UV at opacity 1 when an async projected material published late.
      const authoritativeResidentUvTexture =
        hasLowerRepaintUv
          ? loadedUvTexture
          : authoritativeOrdinaryUvLayers.length > 0
            ? (authoritativeExactUvTexture ?? loadedUvTexture ?? authoritativeProxyUvTexture)
            : undefined;
      const authoritativeUvTextureSource = authoritativeExactUvTexture
        ? 'exact'
        : loadedUvTexture
          ? 'current-valid'
          : authoritativeProxyUvTexture
            ? 'proxy'
            : 'missing';
      const authoritativeResidentContentAwareTexture =
        authoritativeContentAwareUvLayers.length === 1
          ? getReadyResidentPreviewTexture(authoritativeContentAwareUvLayers[0].imageUrl, gl)
          : undefined;
      const authoritativeContentAwarePresentation = contentAwareUnderlayPresentationRef.current;
      const authoritativeContentAwareTexture =
        authoritativeResidentContentAwareTexture ??
        (authoritativeContentAwareUvLayers.length > 0
          ? authoritativeContentAwarePresentation.texture
          : undefined);
      const authoritativeContentAwareOpacity =
        authoritativeContentAwareUvLayers.length === 0
          ? 0
          : authoritativeResidentContentAwareTexture
            ? authoritativeContentAwareUvLayers[0].opacity
            : authoritativeContentAwareTexture
              ? authoritativeContentAwarePresentation.opacity
              : undefined;
      syncProjectedLayerResidentTextureVisibilityInObject(model.group, {
        ...(authoritativeResidentUvTexture
          ? { uvOverlayTexture: authoritativeResidentUvTexture }
          : {}),
        uvOverlayRenderedColor: hasLowerRepaintUv
          ? directUvRenderedColor
          : authoritativeOrdinaryUvLayers.some(usesUnlitRenderedColor),
        ...(authoritativeContentAwareTexture
          ? { baseTexture: authoritativeContentAwareTexture }
          : {}),
        ...(authoritativeResidentUvTexture
          ? {
              uvOverlayOpacity:
                hasLowerRepaintUv
                  ? uvOverlayOpacity
                  : authoritativeOrdinaryUvLayers.length === 1
                    ? authoritativeOrdinaryUvLayers[0].opacity
                    : 1,
            }
          : authoritativeOrdinaryUvLayers.length === 0
            ? { uvOverlayOpacity: 0 }
            : {}),
        uvOverlayBelowProjected: Number.isFinite(authoritativeMergedUvBoundaryOrder),
        topUvOverlayOpacity: authoritativeLocalRepaintUvLayers[0]?.opacity ?? 0,
        baseTextureOpacity: authoritativeContentAwareOpacity,
      });
      if (isPerformanceLabEnabled(window.location.search)) {
        const materialStates: Array<{
          meshName: string;
          meshVisible: boolean;
          meshRenderOrder: number;
          paintOverlay: boolean;
          localRepaintOverlay: boolean;
          uvCount: number;
          name: string;
          useUvOverlayMap: number | null;
          uvOverlayOpacity: number | null;
          uvOverlayTextureId: string | null;
          uvOverlayImageSize: string | null;
          projectedLayerCount: number | null;
          projectedLayerOpacities: number[] | null;
        }> = [];
        model.group.traverse((child) => {
          if (!(child instanceof THREE.Mesh)) return;
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          for (const material of materials) {
            if (!(material instanceof THREE.ShaderMaterial)) continue;
            const uvOverlayTexture = material.uniforms.uvOverlayMap?.value as
              | THREE.Texture
              | undefined;
            const uvOverlayImage = uvOverlayTexture?.image as
              | { width?: number; height?: number }
              | undefined;
            const opacityValue = material.uniforms.projectedLayerOpacities?.value;
            materialStates.push({
              meshName: child.name,
              meshVisible: child.visible,
              meshRenderOrder: child.renderOrder,
              paintOverlay: Boolean(child.userData.liclickPaintOverlay),
              localRepaintOverlay: Boolean(child.userData.liclickLocalRepaintGpuOverlay),
              uvCount: child.geometry.getAttribute('uv')?.count ?? 0,
              name: material.name,
              useUvOverlayMap: material.uniforms.useUvOverlayMap
                ? Number(material.uniforms.useUvOverlayMap.value ?? 0)
                : null,
              uvOverlayOpacity: material.uniforms.uvOverlayOpacity
                ? Number(material.uniforms.uvOverlayOpacity.value ?? 0)
                : null,
              uvOverlayTextureId: uvOverlayTexture?.uuid ?? null,
              uvOverlayImageSize:
                uvOverlayImage?.width && uvOverlayImage?.height
                  ? `${uvOverlayImage.width}x${uvOverlayImage.height}`
                  : null,
              projectedLayerCount: material.uniforms.projectedLayerCount
                ? Number(material.uniforms.projectedLayerCount.value ?? 0)
                : null,
              projectedLayerOpacities:
                opacityValue && typeof opacityValue.length === 'number'
                  ? Array.from(opacityValue as ArrayLike<number>, Number)
                  : null,
            });
          }
        });
        let objectDiagnostics: Record<string, unknown> = {};
        try {
          objectDiagnostics = JSON.parse(
            document.body.dataset.projectedObjectDiagnostics ?? '{}',
          ) as Record<string, unknown>;
        } catch {
          objectDiagnostics = {};
        }
        objectDiagnostics[importedModel.objectId] = {
          ordinaryUvLayerIds: authoritativeOrdinaryUvLayers.map((layer) => layer.id),
          authoritativeUvTextureId: authoritativeResidentUvTexture?.uuid ?? null,
          authoritativeUvTextureSource,
          materialStates,
        };
        document.body.dataset.projectedObjectDiagnostics = JSON.stringify(objectDiagnostics);
      }
      document.body.dataset.contentAwareFinalMaterialReconcile = JSON.stringify({
        visibleLayerCount: authoritativeContentAwareUvLayers.length,
        textureReady: Boolean(authoritativeContentAwareTexture),
        effectiveOpacity: authoritativeContentAwareOpacity ?? null,
        atMs: Math.round(performance.now() * 10) / 10,
      });
      // The live eraser registry is the synchronous authority. React effect
      // closures can become stale while a large texture array uploads, so read
      // the current selection again after assigning the final material and
      // atomically bind (or disable) its multiplier on the newly resident
      // shader. This prevents an old layer index from turning erased pixels into
      // the diagonal empty-projection hatch shown by the user.
      const authoritativeLiveSurfacePreview = getLiveSurfacePaintPreview();
      const authoritativeLiveEraserTexture =
        authoritativeLiveSurfacePreview?.target === 'projected-mask' &&
        authoritativeLiveSurfacePreview.composition === 'multiply-original-mask' &&
        authoritativeLiveSurfacePreview.objectId === importedModel.objectId
          ? getLiveProjectedCanvasTexture(
              authoritativeLiveSurfacePreview.assetUrl,
              THREE.NoColorSpace,
              { flipY: false },
            )
          : undefined;
      const authoritativeLiveEraserLayerId = authoritativeLiveEraserTexture
        ? authoritativeLiveSurfacePreview?.layerId
        : undefined;
      syncProjectedLayerLiveEraserPreviewInObject(
        model.group,
        authoritativeLiveEraserLayerId,
        authoritativeLiveEraserTexture,
      );
      document.body.dataset.projectedLiveEraserBinding = authoritativeLiveEraserLayerId ?? 'none';
      syncProjectedLayerMaterialProjection(model.group);
      const presentsProjectedMaterial = meshes.some((mesh) => {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        return materials.some((material) =>
          isResidentProjectedMaterial(material),
        );
      });
      committedProjectedMaterialStructureRef.current = presentsProjectedMaterial
        ? projectedMaterialStructureKey
        : '';
      const authoritativeHasVisibleProjection = authoritativeDisplayLayers.some(
        (layer) => layer.visible,
      );
      const presentsExactProjectedBootstrap = meshes.every((mesh) => {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        return materials.every(
          (material) => material.userData.liclickExactProjectedBootstrap === true,
        );
      });
      const presentsColorMaterial = meshes.every((mesh) => {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        return materials.every(
          (material) =>
            isResidentProjectedMaterial(material) ||
            material.name === 'LiclickUvOverlayPreview',
        );
      });
      if (
        showWhiteMembrane ||
        (authoritativeHasVisibleProjection
          ? presentsProjectedMaterial || presentsExactProjectedBootstrap
          : presentsColorMaterial)
      ) {
        revealInitialMaterialPresentation();
      }
      if (lastProjectedTransformRef.current) {
        lastProjectedTransformRef.current.copy(model.group.matrixWorld);
      } else {
        lastProjectedTransformRef.current = model.group.matrixWorld.clone();
      }
      const sceneState = useSceneStore.getState();
      const activation = resolveLocalRepaintPreviewActivation({
        consumedKey: activatedLocalRepaintPreviewKeyRef.current,
        paintTool: sceneState.paintTool,
        preview: undefined,
        currentPreview: sceneState.localRepaintPreviewLayer,
        currentSource: sceneState.localRepaintProjectionSource,
        processedLayerIds:
          projectedLayerInput && !projectedPreviewOverBudget ? previewStatus.processedLayerIds : [],
      });
      activatedLocalRepaintPreviewKeyRef.current = activation.nextConsumedKey;
      if (activation.shouldActivate) sceneState.setPaintTool('inpaint-apply');
    }

    void applyMaterials()
      .catch((error) => {
        if (cancelled) return;
        console.error(
          '[Liclick 3D Texture] Projected preview failed; keeping the last valid material.',
          error,
        );
      })
      .finally(() => {
        // The gate means the single authoritative resident-material pass has
        // settled, not necessarily that every optional repair asset succeeded.
        if (!cancelled && !initialProjectedMaterialReady) {
          setInitialProjectedMaterialReady(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    camera,
    canPreviewProjectedLayers,
    displayMode,
    directUvLayer,
    directUvRenderedColor,
    directUvRenderedColorMaskTexture,
    gl,
    importedModel,
    loadedBakedTexture,
    loadedContentAwareUnderlayTexture,
    contentAwareUnderlayOpacity,
    loadedUvTexture,
    gl.capabilities.maxTextures,
    hasLiveProjectedPreview,
    hasResidentUvOverlaySampler,
    initialProjectedMaterialReady,
    invalidate,
    liveTopUvLayer,
    liveTopUvTexture,
    liveProjectedEraserMaskTexture,
    liveSurfacePaintPreview,
    liveSurfaceMaskTexture,
    localRepaintPreviewLayerId,
    previewLighting,
    previewBakedTextureRecord,
    previewProjectionInputs,
    previewProjectedLayerSignature,
    projectedMaterialStructureKey,
    progressiveProjectedPreview,
    progressiveProjectedPreviewReady,
    progressiveIncrementalInputs,
    progressiveIncrementalPreviewReady,
    canUseProgressivePreviewBase,
    progressivePreviewBase,
    projectedSamplerBudget,
    projectedPreviewNeedsComposition,
    projectedTextureArrayStructureSignature,
    showWhiteMembrane,
    revealInitialMaterialPresentation,
    stableResidentUvToggleLayers,
    stableVisibleProjectedLayers,
    textureArrayCompositionFallbackRequired,
    useProjectedTextureArrays,
    activeProjectedPreviewInputs,
    stablePreviewProjectedLayers,
    topUvProjectedOverlayInput,
    uvOverlayOpacity,
    visibleMergedUvBoundaryOrder,
    visibleStackHasBakedPreview,
    workspaceVisible,
  ]);

  if (!importedModel) return null;

  return (
    <>
      {/* Retain warmed wireframe resources across model/workspace selection.
          Only geometry replacement or real unmount releases this helper. */}
      {initialMaterialPresentationReadyForGroup && importedModel.restoreStage !== 'bounds' && (
        <TopologyWireframeOverlay
          object={importedModel.group}
          visible={objectVisible && workspaceVisible && displayMode === 'wire'}
        />
      )}
      {objectVisible && workspaceVisible && (
        <>
          <primitive
            object={importedModel.group}
            visible={initialMaterialPresentationVisibleForGroup}
            onClick={(event: { stopPropagation: () => void }) => {
              event.stopPropagation();
              onSelect(importedModel.objectId);
            }}
          />
          {!initialMaterialPresentationVisibleForGroup && (
            <ModelRestoreLoadingIndicator object={importedModel.group} />
          )}
          {/* Scene selection keeps each visible object's indicator resident. */}
          {texturedRestoreReady && showSelectionGlow && (
            <SelectionBoundsCorners object={importedModel.group} objectId={importedModel.objectId} />
          )}
        </>
      )}
    </>
  );
});

export function SceneRoot() {
  const importedModels = useSceneStore((state) => state.importedModels);
  const activeImportedModelId = useSceneStore((state) => state.importedModel?.objectId);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const workspaceMode = useWorkspaceLayoutStore((state) => state.mode);
  const selectObject = useSceneStore((state) => state.selectObject);
  const displayMode = useSceneStore((state) => state.displayMode);
  const environmentPreset = useSettingsStore((state) => state.environmentPreset);
  const exposure = useSettingsStore((state) => state.exposure);
  const pbrEnvironmentIntensity = useSettingsStore((state) => state.pbrEnvironmentIntensity);
  const pbrKeyLightIntensity = useSettingsStore((state) => state.pbrKeyLightIntensity);
  const pbrLightAzimuth = useSettingsStore((state) => state.pbrLightAzimuth);
  const previewLighting = getPreviewLighting({
    displayMode,
    environmentPreset,
    exposure,
    pbrEnvironmentIntensity,
    pbrKeyLightIntensity,
    pbrLightAzimuth,
  });
  const keyLightPosition: [number, number, number] = previewLighting.keyLightDirection.map(
    (value) => value * 5.6,
  ) as [number, number, number];
  const fillLightPosition: [number, number, number] = [
    -keyLightPosition[0] * 0.72,
    2.2,
    -keyLightPosition[2] * 0.72,
  ];
  const ambientIntensity = previewLighting.ambientIntensity;
  const keyIntensity = previewLighting.keyLightIntensity;
  const fillIntensity = previewLighting.ambientIntensity * 0.52;
  // Texture authoring is scoped to one selected object. Keep every imported
  // model mounted so its geometry/material cache survives object switches,
  // but only attach the active model to the visible scene. Other workspaces
  // retain the full arrangement for scene review and project thumbnails.
  const textureObjectId = selectedObjectId ?? activeImportedModelId;
  const workspaceVisibleModels =
    workspaceMode === 'texture'
      ? importedModels.filter((model) => model.objectId === textureObjectId)
      : importedModels;
  const workspaceVisibleModelIds = new Set(workspaceVisibleModels.map((model) => model.objectId));
  const showSelectionGlow = workspaceMode === 'scene';
  const hasProgressiveRestore = workspaceVisibleModels.some(
    (model) => model.restoreStage === 'bounds' || model.restoreStage === 'outline',
  );
  const selectImportedObject = useCallback(
    (objectId: string) => {
      markViewportInteractionActivity();
      selectObject(objectId);
      scheduleCurrentProjectActiveObjectPersistence(objectId);
    },
    [selectObject],
  );
  const clearViewportSelection = useCallback(() => {
    // Texture authoring always needs one active object. Clearing it on an empty
    // viewport click made the visibility filter remove every model and looked
    // like a failed load. Scene review still supports deliberate deselection.
    if (workspaceMode === 'texture') return;
    markViewportInteractionActivity();
    selectObject(undefined);
  }, [selectObject, workspaceMode]);

  return (
    <group onPointerMissed={clearViewportSelection}>
      <ambientLight intensity={ambientIntensity} />
      <hemisphereLight args={['#fff0e8', '#302640', 0.82]} />
      <directionalLight
        position={keyLightPosition}
        intensity={keyIntensity}
        castShadow={!hasProgressiveRestore}
      />
      <directionalLight position={fillLightPosition} intensity={fillIntensity} />
      <Grid />
      {importedModels.map((model) => (
        <ImportedModel
          key={model.objectId}
          importedModel={model}
          onSelect={selectImportedObject}
          showSelectionGlow={showSelectionGlow}
          workspaceVisible={workspaceVisibleModelIds.has(model.objectId)}
        />
      ))}
      <ObjectTransformControls />
    </group>
  );
}
