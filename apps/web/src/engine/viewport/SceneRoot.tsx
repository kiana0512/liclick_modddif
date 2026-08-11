import { ContactShadows } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import {
  createDisplayModeMaterial,
  createFlatPreviewMaterial,
  createPbrPreviewMaterial,
  createProjectedLayerStackMaterial,
  createUvOverlayPreviewMaterial,
  disposeGeneratedMaterialTree,
  getProjectedLayerSamplerBudget,
  markSparseAlphaBaseTexture,
  syncProjectedLayerMaterialDisplayState,
  syncProjectedLayerMaterialDisplayStateInObject,
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
} from '@/engine/projection/liveProjectedCanvasTextureRegistry';
import { useLiveSurfacePaintPreview } from '@/engine/paint/liveSurfacePaintPreviewRegistry';
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
import { translations, useI18nStore } from '@/stores/i18nStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSceneStore } from '@/stores/sceneStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToastStore } from '@/stores/toastStore';
import { useWorkspaceLayoutStore } from '@/components/workspace/workspaceLayoutStore';
import { Grid } from './Grid';
import { resolveLocalRepaintPreviewActivation } from './localRepaintPreviewActivation';
import { ObjectTransformControls } from './ObjectTransformControls';
import {
  loadPreviewTexture,
  residentPreviewTextureCache,
  uploadPreviewTextureInStripes,
} from './previewTextureCache';
import type { ModelLoadResult } from '@/engine/loaders/modelImportTypes';
import type {
  ProjectionLayerDisplayInput,
  ProjectionLayerStackInput,
  ProjectionPreviewLighting,
} from '@/engine/projection/projectionTypes';
import type { Layer } from '@/types/layer';
import { usesUnlitRenderedColor } from './renderedLayerColor';

const RESOLUTION_TO_SIZE = {
  '1K': 1024,
  '2K': 2048,
  '4K': 4096,
  '8K': 8192,
} as const;

const MAX_IMAGE_ELEMENT_CACHE_SIZE = 32;
const MAX_COMPOSITED_UV_TEXTURE_CACHE_SIZE = 3;
const MAX_RESIDENT_UV_TOGGLE_TEXTURES = 2;
const imageElementCache = new Map<string, Promise<HTMLImageElement>>();
const PROJECTED_PREVIEW_LIMIT_TOAST_KEY = 'projected-preview:sampler-limit';
const PROJECTED_PREVIEW_FAILURE_TOAST_KEY = 'projected-preview:failure';
const RUNTIME_PROJECTION_PREVIEW_MAX_SIDE = 1024;
// Keep a safety margin below the advertised fragment-sampler limit. A projected
// layer can consume color, depth and normal samplers, while a UV/local-repaint
// layer adds another sampler. Some WebGL2 drivers fail to link that direct shader
// before the nominal 16-unit ceiling is reached. Switch as soon as the safety
// boundary is reached, so the fourth fully sampled projection uses arrays instead
// of attempting an unstable 12-sampler direct material.
const PROJECTED_ARRAY_DIRECT_SAMPLER_HEADROOM_RATIO = 0.75;

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
  const scale = Math.min(
    1,
    RUNTIME_PROJECTION_PREVIEW_MAX_SIDE / Math.max(safeWidth, safeHeight),
  );
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
  };
}
function projectionPreviewCopy() {
  return translations[useI18nStore.getState().language];
}

function notifyProjectedPreviewLimit(required: number, available: number) {
  const copy = projectionPreviewCopy();
  useToastStore.getState().pushToast({
    tone: 'warning',
    title: copy.projectedPreviewLimit,
    description: copy.projectedPreviewLimitHelp
      .replace('{required}', String(required))
      .replace('{available}', String(available)),
    dedupeKey: PROJECTED_PREVIEW_LIMIT_TOAST_KEY,
  });
}

function notifyProjectedPreviewFailure(_error: unknown) {
  const copy = projectionPreviewCopy();
  const toastStore = useToastStore.getState();
  toastStore.dismissToastByDedupeKey(PROJECTED_PREVIEW_LIMIT_TOAST_KEY);
  toastStore.pushToast({
    tone: 'error',
    title: copy.projectedPreviewFailed,
    description: copy.projectedPreviewFailedHelp,
    dedupeKey: PROJECTED_PREVIEW_FAILURE_TOAST_KEY,
  });
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
    layer.minimumProjectionFacing ?? 0,
    layer.contentRevision ?? 0,
    layer.needsRebake ? 1 : 0,
    stableNumberListSignature(layer.objectMatrixWorld),
    cameraSignature(layer),
  ].join(':');
}

function isRenderedLocalRepaintLayer(layer: Layer) {
  return usesUnlitRenderedColor(layer);
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
    .filter(
      (layer) =>
        !isOverlayProjectionPatch(layer) && (!layer.objectId || layer.objectId === objectId),
    )
    .map(
      (layer) =>
        `${layer.id}:${layer.type}:${Number(layer.visible)}:${layer.opacity}:${layer.strength ?? 1}:${layer.blendMode}:${layer.adjustments?.hue ?? 0}:${layer.adjustments?.saturation ?? 0}:${layer.adjustments?.lightness ?? 0}`,
    )
    .join('|');
}

function toProjectionLayerDisplayInput(layer: Layer): ProjectionLayerDisplayInput {
  return {
    layerId: layer.id,
    opacity: layer.opacity,
    strength: layer.strength,
    blendMode: layer.blendMode,
    visible: layer.visible,
    hue: (layer.adjustments?.hue ?? 0) / 100,
    saturation: (layer.adjustments?.saturation ?? 0) / 100,
    lightness: (layer.adjustments?.lightness ?? 0) / 100,
  };
}

function useStableValueBySignature<T>(value: T, signature: string) {
  const stableRef = useRef<{ signature: string; value: T }>();
  if (!stableRef.current || stableRef.current.signature !== signature) {
    stableRef.current = { signature, value };
  }
  return stableRef.current.value;
}

export function getPreviewLighting(input: {
  displayMode: string;
  environmentPreset: 'color' | 'studio' | 'soft' | 'dark';
  exposure: number;
  pbrEnvironmentIntensity: number;
  pbrKeyLightIntensity: number;
  pbrLightAzimuth: number;
}): ProjectionPreviewLighting {
  const effectivePreset =
    input.displayMode === 'pbr' && input.environmentPreset === 'color'
      ? 'studio'
      : input.environmentPreset;
  const environmentBase =
    effectivePreset === 'dark' ? 0.38 : effectivePreset === 'soft' ? 0.46 : 0.5;
  const keyBase = effectivePreset === 'dark' ? 1.05 : effectivePreset === 'soft' ? 1.12 : 1.22;
  const environmentScale = input.displayMode === 'pbr' ? input.pbrEnvironmentIntensity / 0.42 : 1;
  const azimuth = THREE.MathUtils.degToRad(input.pbrLightAzimuth);
  const direction = new THREE.Vector3(
    Math.sin(azimuth) * 4.5,
    5.2,
    Math.cos(azimuth) * 4.5,
  ).normalize();
  return {
    enabled: input.displayMode === 'pbr',
    exposure: input.exposure,
    ambientIntensity: environmentBase * input.exposure * environmentScale,
    keyLightIntensity:
      keyBase * input.exposure * (input.displayMode === 'pbr' ? input.pbrKeyLightIntensity : 1),
    keyLightDirection: direction.toArray() as [number, number, number],
  };
}

function useLoadedPreviewTexture(imageUrl?: string, options?: { preserveWhenEmpty?: boolean }) {
  const [loadedTexture, setLoadedTexture] = useState<THREE.Texture>();
  const { gl } = useThree();

  useEffect(() => {
    if (!imageUrl) {
      if (!options?.preserveWhenEmpty) setLoadedTexture(undefined);
      return undefined;
    }
    let cancelled = false;
    // Keep the last valid GPU texture visible while the replacement decodes.
    // Clearing here produced the one-frame black/white flash during repaint,
    // image replacement and UV composition hand-offs.
    void (async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 3 && !cancelled; attempt += 1) {
        try {
          const texture = await loadPreviewTexture(imageUrl);
          await uploadPreviewTextureInStripes(gl, texture);
          if (!cancelled) setLoadedTexture(texture);
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
    })();
    return () => {
      cancelled = true;
    };
  }, [gl, imageUrl, options?.preserveWhenEmpty]);

  return loadedTexture;
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

function useCompositedUvTexture(layers: Layer[]) {
  const [texture, setTexture] = useState<THREE.Texture>();
  const runtimeRef = useRef<{
    refresh: () => void;
    liveRevisions: Map<string, number>;
  }>();
  const currentTextureRef = useRef<THREE.Texture>();
  const textureCacheRef = useRef(new Map<string, THREE.Texture>());
  const layerKey = useMemo(
    () => uvLayerStackPreviewSignature(layers),
    [layers],
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
      setTexture(cachedTexture);
      document.body.dataset.uvCompositeStatus = 'cached';
      document.body.dataset.uvCompositeBackend = 'resident-gpu-cache';
      document.body.dataset.uvCompositeDurationMs = '0';
      return undefined;
    }

    let cancelled = false;
    let composing = false;
    let composeAgain = false;

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
      setTexture(nextTexture);
      trimTextureCache();
      if (replacedForKey && replacedForKey !== nextTexture) retireTexture(replacedForKey);
    };

    void Promise.all(
      uvLayers.map(async (layer) => {
        const live = getLiveProjectedCanvasState(layer.imageUrl);
        return {
          layer,
          source: live?.canvas ?? (await loadImageElement(layer.imageUrl)),
          liveUrl: live ? layer.imageUrl : undefined,
          liveRevision: live?.revision,
        };
      }),
    )
      .then((sources) => {
        if (cancelled) return;
        const sourceWidth = Math.max(
          1,
          ...sources.map(
            ({ source }) =>
              ('naturalWidth' in source ? source.naturalWidth || source.width : source.width) || 1,
          ),
        );
        const sourceHeight = Math.max(
          1,
          ...sources.map(
            ({ source }) =>
              ('naturalHeight' in source ? source.naturalHeight || source.height : source.height) ||
              1,
          ),
        );
        // Keep the composited material at the source UV resolution. Interactive paint and
        // eraser work must never trade the user's texture resolution for viewport speed.
        const width = sourceWidth;
        const height = sourceHeight;
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
            let nextTexture: THREE.Texture;
            if (canCompositeUvLayersInWorker()) {
              document.body.dataset.uvCompositeBackend = 'worker';
              const bitmaps = await Promise.all(
                sortedSources.map(async ({ layer, source }) => ({
                  bitmap: await createImageBitmap(source),
                  opacity: layer.opacity,
                })),
              );
              const bitmap = await compositeUvLayersInWorker(bitmaps);
              nextTexture = new THREE.Texture(bitmap);
            } else {
              document.body.dataset.uvCompositeBackend = 'main-thread-fallback';
              const canvas = document.createElement('canvas');
              canvas.width = width;
              canvas.height = height;
              const context = canvas.getContext('2d');
              if (!context) throw new Error('Could not create UV layer composite canvas.');
              context.clearRect(0, 0, width, height);
              sortedSources.forEach(({ layer, source }) => {
                context.save();
                context.globalAlpha = Math.max(0, Math.min(1, layer.opacity));
                context.globalCompositeOperation = 'source-over';
                context.drawImage(source, 0, 0, width, height);
                context.restore();
              });
              nextTexture = new THREE.CanvasTexture(canvas);
            }
            nextTexture.colorSpace = THREE.SRGBColorSpace;
            nextTexture.flipY = !(
              typeof ImageBitmap !== 'undefined' && nextTexture.image instanceof ImageBitmap
            );
            nextTexture.wrapS = THREE.ClampToEdgeWrapping;
            nextTexture.wrapT = THREE.ClampToEdgeWrapping;
            nextTexture.minFilter = THREE.LinearFilter;
            nextTexture.magFilter = THREE.LinearFilter;
            nextTexture.generateMipmaps = false;
            nextTexture.anisotropy = 8;
            nextTexture.needsUpdate = true;
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
            document.body.dataset.uvCompositeStatus = 'error';
            finishComposeSpan('error', {
              message: error instanceof Error ? error.message : String(error),
            });
            if (
              !cancelled &&
              !(error instanceof DOMException && error.name === 'AbortError')
            )
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
    };
  }, [layerKey, stableLayers]);

  return texture;
}

function SelectionBoundsCorners({ object }: { object: THREE.Object3D }) {
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
      object.updateMatrixWorld(true);
      bounds.setFromObject(object, true);
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
    indicator.update();
    return () => {
      indicator.lines.removeFromParent();
      indicator.geometry.dispose();
      indicator.material.dispose();
    };
  }, [indicator]);

  useFrame(() => {
    object.updateMatrixWorld(true);
    if (!lastMatrixWorldRef.current.equals(object.matrixWorld)) indicator.update();
  });

  return <primitive object={indicator.lines} />;
}

function TopologyWireframeOverlay({ object }: { object: THREE.Object3D }) {
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

    return { group, material };
  }, [object]);

  useFrame(() => {
    overlay.group.matrix.compose(object.position, object.quaternion, object.scale);
    overlay.group.matrixWorldNeedsUpdate = true;
  });

  useEffect(
    () => {
      document.body.dataset.topologyWireframeMeshCount = String(overlay.group.children.length);
      return () => {
        delete document.body.dataset.topologyWireframeMeshCount;
        overlay.group.removeFromParent();
        overlay.material.dispose();
      };
    },
    [overlay],
  );

  return <primitive object={overlay.group} />;
}

function ImportedModel({
  importedModel,
  showSelectionGlow,
  workspaceVisible,
}: {
  importedModel: ModelLoadResult;
  showSelectionGlow: boolean;
  workspaceVisible: boolean;
}) {
  const { gl, invalidate, camera } = useThree();
  const displayMode = useSceneStore((state) => state.displayMode);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const objectVisible = useSceneStore(
    (state) =>
      state.objects.find((object) => object.id === importedModel.objectId)?.visible ?? true,
  );
  const selectObject = useSceneStore((state) => state.selectObject);
  const environmentPreset = useSettingsStore((state) => state.environmentPreset);
  const exposure = useSettingsStore((state) => state.exposure);
  const pbrEnvironmentIntensity = useSettingsStore((state) => state.pbrEnvironmentIntensity);
  const pbrKeyLightIntensity = useSettingsStore((state) => state.pbrKeyLightIntensity);
  const pbrLightAzimuth = useSettingsStore((state) => state.pbrLightAzimuth);
  const resolution = useSettingsStore((state) => state.resolution);
  const localRepaintPreviewLayerId = useSceneStore(
    (state) => state.localRepaintPreviewLayer?.id,
  );
  const [uvVisibilityRenderRevision, setUvVisibilityRenderRevision] = useState(0);
  const residentUvPresentationCacheRef = useRef(new Map<string, THREE.Texture>());
  const pendingUvVisibilityRenderKeyRef = useRef('');
  const texturedRestoreReady =
    !importedModel.restoreStage || importedModel.restoreStage === 'full';
  const layerRenderSignature = useLayerStore((state) =>
    importedModelLayerRenderSignature(
      (state.projectedPreviewLayers ?? state.layers).filter(
        (layer) => layer.id !== localRepaintPreviewLayerId,
      ),
      importedModel.objectId,
    ),
  );
  const layers = useMemo(
    () => {
      const layerState = useLayerStore.getState();
      return (layerState.projectedPreviewLayers ?? layerState.layers).filter(
        (layer) => layer.id !== localRepaintPreviewLayerId,
      );
    },
    [layerRenderSignature, localRepaintPreviewLayerId, uvVisibilityRenderRevision],
  );
  const liveSurfacePaintPreview = useLiveSurfacePaintPreview();
  // SurfacePaintOverlay owns the renderer-only local repaint preview as a
  // transparent, precompiled mesh overlay. Never insert that temporary layer
  // into the 14-layer projected stack: doing so rebuilt every texture array and
  // left valid brush input invisible while a multi-second shader compiled.
  // Persisted repaint rows remain in `layers` and rejoin the ordinary stack
  // after the live session is cleared.
  const visibleLocalRepaintPreviewLayer = useMemo<Layer | undefined>(() => undefined, []);
  const activeLayerId = useLayerStore((state) => state.activeProjectedLayerId);
  const project = useProjectStore((state) =>
    state.currentProjectId
      ? state.projects.find((item) => item.id === state.currentProjectId)
      : undefined,
  );
  const captureById = useMemo(
    () => new Map(project?.captures.map((capture) => [capture.id, capture] as const) ?? []),
    [project?.captures],
  );
  const [runtimeVisibilityByLayerId, setRuntimeVisibilityByLayerId] = useState<
    Record<string, { depthUrl: string; normalUrl: string }>
  >({});
  const [initialProjectedMaterialReady, setInitialProjectedMaterialReady] = useState(false);
  const projectedTextureArrayBuildRef = useRef<{
    signature: string;
    cancelled: boolean;
    promise: Promise<THREE.ShaderMaterial | undefined>;
  }>();
  // The authoritative projected material stays fully resident while geometry-only
  // or empty-layer views temporarily present the canonical white membrane. This
  // makes those views exact MeshStandardMaterial renders without paying a rebuild
  // when the user opens an eye again.
  const residentProjectedMaterialRef = useRef<THREE.ShaderMaterial>();
  const projectedPreviewInteractionRef = useRef({ pointerDown: false, lastMovedAt: 0 });
  useEffect(() => {
    if (stableResidentUvToggleLayers.length === 0) {
      document.body.dataset.residentUvToggleTextureCount = '0';
      document.body.dataset.residentUvTogglePrewarmMs = '0.0';
      document.body.dataset.residentUvToggleReady = '1';
      return;
    }
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
  }, [gl]);
  useEffect(() => {
    // Restore the saved projection stack before rebuilding runtime depth and
    // normal textures. Starting both jobs together changes the material
    // signature during the first texture-array upload and can strand local
    // repaint in its disabled preparation state.
    if (!texturedRestoreReady || !initialProjectedMaterialReady) return undefined;
    let cancelled = false;
    const candidates = [
      ...layers,
      ...(visibleLocalRepaintPreviewLayer ? [visibleLocalRepaintPreviewLayer] : []),
    ].filter(
      (layer) =>
        layer.type === 'projected' &&
        !isRenderedLocalRepaintLayer(layer) &&
        layer.visible &&
        layer.imageUrl &&
        layer.camera &&
        (!layer.objectId || layer.objectId === importedModel.objectId),
    );
    if (candidates.length === 0) return undefined;

    void (async () => {
      const waitForInteractionIdle = async () => {
        while (!cancelled) {
          const interaction = projectedPreviewInteractionRef.current;
          const paintTool = useSceneStore.getState().paintTool;
          const busy =
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
        // Stored capture depth is sufficient for the first visible material.
        // Rebuild the sharper runtime depth/crease-normal pair after the model
        // and its textures have had time to present, yielding between layers.
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
    visibleLocalRepaintPreviewLayer,
  ]);
  const importedObjectId = importedModel?.objectId;
  const liveProjectedEraserMaskTexture = useMemo(() => {
    if (
      liveSurfacePaintPreview?.target !== 'projected-mask' ||
      liveSurfacePaintPreview.composition !== 'multiply-original-mask' ||
      liveSurfacePaintPreview.objectId !== importedObjectId
    )
      return undefined;
    return getLiveProjectedCanvasTexture(
      liveSurfacePaintPreview.assetUrl,
      THREE.NoColorSpace,
      { flipY: false },
    );
  }, [importedObjectId, liveSurfacePaintPreview]);
  const visibleProjectedLayers = useMemo(() => {
    if (!texturedRestoreReady) return [];
    const storedLayers = (
      importedObjectId ? getVisibleProjectedLayerStack(layers, importedObjectId) : []
    ).map((layer) =>
      liveSurfacePaintPreview?.target === 'projected-mask' &&
      liveSurfacePaintPreview.composition === 'replace' &&
      liveSurfacePaintPreview.objectId === importedObjectId &&
      liveSurfacePaintPreview.layerId === layer.id
        ? {
            ...layer,
            maskUrl: liveSurfacePaintPreview.assetUrl,
            maskSpace: 'uv' as const,
          }
        : layer,
    );
    if (
      !visibleLocalRepaintPreviewLayer?.imageUrl ||
      !visibleLocalRepaintPreviewLayer.camera ||
      (visibleLocalRepaintPreviewLayer.objectId &&
        visibleLocalRepaintPreviewLayer.objectId !== importedObjectId)
    )
      return storedLayers;
    return [
      visibleLocalRepaintPreviewLayer,
      ...storedLayers.filter((layer) => layer.id !== visibleLocalRepaintPreviewLayer.id),
    ];
  }, [
    importedObjectId,
    layers,
    liveSurfacePaintPreview,
    texturedRestoreReady,
    visibleLocalRepaintPreviewLayer,
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
  const previewProjectedLayers = useMemo(() => {
    if (!texturedRestoreReady) return [];
    const projectedCandidates = layers
      .filter(
        (layer) =>
          layer.type === 'projected' &&
          layer.imageUrl &&
          layer.camera &&
          (!layer.objectId || layer.objectId === importedObjectId),
      );
    const coldVisibleCandidates = projectedCandidates
      .filter((layer) => layer.visible)
      .sort((left, right) => left.order - right.order);
    const coldLocalRepaintCandidates = coldVisibleCandidates.filter(
      (layer) =>
        isRenderedLocalRepaintLayer(layer) ||
        Boolean(layer.localRepaintSourceUrl || layer.localRepaintMaskUrl),
    );
    const residentCandidates = initialProjectedMaterialReady
      ? projectedCandidates
      : coldLocalRepaintCandidates.length > 0
        ? coldLocalRepaintCandidates
        : coldVisibleCandidates.slice(0, 1);
    const storedLayers = residentCandidates
      // Cold restore presents visible layers first. Only after that atomic
      // material is on screen do hidden layers join the resident GPU material;
      // otherwise fourteen hidden projections can block the only visible local
      // repaint result for many seconds after refresh. When no repaint exists,
      // the top visible projection is the first meaningful preview.
      // Layer order 0 is the top row in the panel. Feed the shader bottom-up so
      // later overlay evaluations preserve that visible stacking order.
      .sort((a, b) => b.order - a.order)
      .map((layer) =>
        liveSurfacePaintPreview?.target === 'projected-mask' &&
        liveSurfacePaintPreview.composition === 'replace' &&
        liveSurfacePaintPreview.objectId === importedObjectId &&
        liveSurfacePaintPreview.layerId === layer.id
          ? {
              ...layer,
              maskUrl: liveSurfacePaintPreview.assetUrl,
              maskSpace: 'uv' as const,
            }
          : layer,
      );
    if (
      !visibleLocalRepaintPreviewLayer?.imageUrl ||
      !visibleLocalRepaintPreviewLayer.camera ||
      (visibleLocalRepaintPreviewLayer.objectId &&
        visibleLocalRepaintPreviewLayer.objectId !== importedObjectId)
    )
      return storedLayers;
    return [
      ...storedLayers.filter((layer) => layer.id !== visibleLocalRepaintPreviewLayer.id),
      visibleLocalRepaintPreviewLayer,
    ];
  }, [
    importedObjectId,
    initialProjectedMaterialReady,
    layers,
    liveSurfacePaintPreview,
    texturedRestoreReady,
    visibleLocalRepaintPreviewLayer,
  ]);
  const previewProjectedLayerSignature = useMemo(
    () => layerStackPreviewSignature(previewProjectedLayers),
    [previewProjectedLayers],
  );
  const stablePreviewProjectedLayers = useStableValueBySignature(
    previewProjectedLayers,
    previewProjectedLayerSignature,
  );
  const previewProjectionInputs = useMemo(
    () =>
      stablePreviewProjectedLayers.map((layer) => {
        const runtimeVisibility = runtimeVisibilityByLayerId[layer.id];
        const capture = layer.captureId ? captureById.get(layer.captureId) : undefined;
        const depthUrl = runtimeVisibility?.depthUrl ?? layer.depthUrl ?? capture?.depthUrl;
        // Capture.normalUrl is a smooth shaded normal pass intended for image
        // generation. Projection visibility requires the flat geometric normal
        // produced by createRuntimeProjectionDepth; mixing the two clips large
        // regions on curved or low-poly surfaces. Until that runtime pass is
        // ready, depth-only visibility is safer and matches the bake footprint.
        const normalUrl = runtimeVisibility?.normalUrl;
        return {
          layerId: layer.id,
          imageUrl: layer.imageUrl,
          maskUrl: layer.maskUrl,
          maskSpace: layer.maskSpace,
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
          visible: layer.visible,
          hue: (layer.adjustments?.hue ?? 0) / 100,
          saturation: (layer.adjustments?.saturation ?? 0) / 100,
          lightness: (layer.adjustments?.lightness ?? 0) / 100,
          useMask: Boolean(layer.maskUrl),
          useDepthCheck: Boolean(depthUrl),
          useNormalCheck: Boolean(runtimeVisibility?.normalUrl),
          renderedColor: usesUnlitRenderedColor(layer),
          minimumProjectionFacing: layer.minimumProjectionFacing,
        };
      }),
    [captureById, runtimeVisibilityByLayerId, stablePreviewProjectedLayers],
  );
  useEffect(() => {
    const unsubscribe = useLayerStore.subscribe((state, previousState) => {
      if (
        importedModelLayerDisplaySignature(state.layers, importedModel.objectId) ===
        importedModelLayerDisplaySignature(previousState.layers, importedModel.objectId)
      )
        return;
      const startedAt = performance.now();
      const displayLayers = state.layers
        .filter(
          (layer) =>
            layer.type === 'projected' &&
            !isOverlayProjectionPatch(layer) &&
            (!layer.objectId || layer.objectId === importedModel.objectId),
        )
        .map(toProjectionLayerDisplayInput);
      if (
        visibleLocalRepaintPreviewLayer?.type === 'projected' &&
        !displayLayers.some((layer) => layer.layerId === visibleLocalRepaintPreviewLayer.id)
      ) {
        displayLayers.push(toProjectionLayerDisplayInput(visibleLocalRepaintPreviewLayer));
      }
      const currentDisplayMode = useSceneStore.getState().displayMode;
      const currentSettings = useSettingsStore.getState();
      const objectUvLayers = state.layers.filter(
        (layer) =>
          layer.type === 'uv' &&
          Boolean(layer.imageUrl) &&
          (!layer.objectId || layer.objectId === importedModel.objectId),
      );
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
      const residentSingleUvTexture =
        visibleOrdinaryUvLayers.length === 1
          ? residentPreviewTextureCache.get(visibleOrdinaryUvLayers[0].imageUrl ?? '')
          : undefined;
      const visibleUvKey = residentUvVisibilityKey(visibleOrdinaryUvLayers);
      const residentCompositeUvTexture =
        visibleOrdinaryUvLayers.length > 1
          ? residentUvPresentationCacheRef.current.get(visibleUvKey)
          : undefined;
      const residentUvTexture = residentSingleUvTexture ?? residentCompositeUvTexture;
      if (
        visibleOrdinaryUvLayers.length > 0 &&
        !residentUvTexture &&
        pendingUvVisibilityRenderKeyRef.current !== visibleUvKey
      ) {
        pendingUvVisibilityRenderKeyRef.current = visibleUvKey;
        setUvVisibilityRenderRevision((revision) => revision + 1);
      }
      syncProjectedLayerResidentTextureVisibilityInObject(importedModel.group, {
        ...(residentUvTexture ? { uvOverlayTexture: residentUvTexture } : {}),
        uvOverlayOpacity:
          visibleOrdinaryUvLayers.length === 1 ? visibleOrdinaryUvLayers[0].opacity : visibleOrdinaryUvLayers.length > 1 ? 1 : 0,
        topUvOverlayOpacity: visibleLocalRepaintUvLayers[0]?.opacity ?? 0,
        baseTextureOpacity:
          visibleContentAwareUvLayers.length === 1
            ? visibleContentAwareUvLayers[0].opacity
            : visibleContentAwareUvLayers.length > 1
              ? 1
              : 0,
      });
      syncProjectedLayerMaterialDisplayStateInObject(
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
      invalidate();
      document.body.dataset.projectedDisplayPath = 'uniform';
      document.body.dataset.projectedDisplayUniformMs = String(
        Math.round((performance.now() - startedAt) * 100) / 100,
      );

    });
    return () => {
      unsubscribe();
    };
  }, [importedModel, invalidate, visibleLocalRepaintPreviewLayer]);
  const contentAwareUvUnderlayLayers = useMemo(
    () =>
      texturedRestoreReady
        ? layers.filter(
            (layer) =>
              layer.type === 'uv' &&
              layer.role === 'content-aware-underlay' &&
              Boolean(layer.imageUrl) &&
              (!layer.objectId || layer.objectId === importedObjectId),
          )
        : [],
    [importedObjectId, layers, texturedRestoreReady],
  );
  // Content-aware repair normally produces one sparse 4K UV underlay. Keep that
  // decoded texture and its sampler resident even while its eye is closed. The
  // eye can then be represented by one opacity uniform instead of tearing down
  // the base-map shader structure and rebuilding every projected texture array.
  const residentContentAwareUvUnderlayLayer =
    contentAwareUvUnderlayLayers.length === 1 ? contentAwareUvUnderlayLayers[0] : undefined;
  const visibleCompositedContentAwareUvUnderlayLayers = useMemo(
    () =>
      residentContentAwareUvUnderlayLayer
        ? []
        : contentAwareUvUnderlayLayers.filter((layer) => layer.visible),
    [contentAwareUvUnderlayLayers, residentContentAwareUvUnderlayLayer],
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
      texturedRestoreReady
        ? layers
            .filter(
              (layer) =>
                layer.type === 'uv' &&
                layer.role !== 'content-aware-underlay' &&
                layer.role !== 'local-repaint-overlay' &&
                layer.role !== 'local-repaint-draft' &&
                Boolean(layer.imageUrl) &&
                (!layer.objectId || layer.objectId === importedObjectId),
            )
            .sort((left, right) => left.order - right.order)
            .slice(0, MAX_RESIDENT_UV_TOGGLE_TEXTURES)
        : [],
    [importedObjectId, layers, texturedRestoreReady],
  );
  const residentUvToggleSignature = useMemo(
    () => residentUvToggleLayers.map((layer) => `${layer.id}:${layer.imageUrl}`).join('|'),
    [residentUvToggleLayers],
  );
  const stableResidentUvToggleLayers = useStableValueBySignature(
    residentUvToggleLayers,
    residentUvToggleSignature,
  );
  useEffect(() => {
    let cancelled = false;
    const startedAt = performance.now();
    const warm = async () => {
      // Decode independent UV assets together. The previous serial loop made
      // two 4K layers pay the full network/decode latency back-to-back.
      const textures = await Promise.all(
        stableResidentUvToggleLayers.map(async (layer) => {
          if (!layer.imageUrl) return undefined;
          let lastError: unknown;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              return await loadPreviewTexture(layer.imageUrl);
            } catch (error) {
              lastError = error;
              if (attempt < 2) {
                await new Promise<void>((resolve) =>
                  window.setTimeout(resolve, attempt === 0 ? 80 : 200),
                );
              }
            }
          }
          throw lastError;
        }),
      );
      for (const texture of textures) {
        if (!texture) continue;
        if (cancelled) return;
        // Spread bounded 4K uploads across frames so prewarming never turns
        // into one long main-thread/GPU submission spike.
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        if (cancelled) return;
        await uploadPreviewTextureInStripes(gl, texture);
      }
      document.body.dataset.residentUvToggleTextureCount = String(
        stableResidentUvToggleLayers.length,
      );
      document.body.dataset.residentUvTogglePrewarmMs = (
        performance.now() - startedAt
      ).toFixed(1);
      document.body.dataset.residentUvToggleReady = '1';
    };
    document.body.dataset.residentUvToggleReady = '0';
    void warm().catch((error) => {
      if (!cancelled)
        console.warn('[Liclick 3D Texture] UV toggle texture prewarm was incomplete:', error);
    });
    return () => {
      cancelled = true;
    };
  }, [gl, residentUvToggleSignature, stableResidentUvToggleLayers]);
  // Keep one finished UV texture and its shader sampler resident. Its eye switch
  // becomes a uniform update instead of a texture reload and shader recompile.
  const hasResidentUvOverlaySampler = Boolean(
    texturedRestoreReady &&
      layers.some(
        (layer) =>
          layer.type === 'uv' &&
          layer.role !== 'content-aware-underlay' &&
          layer.role !== 'local-repaint-overlay' &&
          Boolean(layer.imageUrl) &&
          (!layer.objectId || layer.objectId === importedObjectId),
      ),
  );
  const directProjectedSamplerBudget = useMemo(
    () =>
      getProjectedLayerSamplerBudget(previewProjectionInputs, gl.capabilities.maxTextures, {
        useBaseMap: contentAwareUvUnderlayLayers.length > 0,
        useUvOverlayMap: hasResidentUvOverlaySampler,
      }),
    [
      contentAwareUvUnderlayLayers.length,
      gl.capabilities.maxTextures,
      hasResidentUvOverlaySampler,
      previewProjectionInputs,
    ],
  );
  const projectedTextureArraySamplerBudget = useMemo(
    () =>
      getProjectedLayerSamplerBudget(previewProjectionInputs, gl.capabilities.maxTextures, {
        useBaseMap: contentAwareUvUnderlayLayers.length > 0,
        useUvOverlayMap: hasResidentUvOverlaySampler,
        useTextureArrays: true,
      }),
    [
      contentAwareUvUnderlayLayers.length,
      gl.capabilities.maxTextures,
      hasResidentUvOverlaySampler,
      previewProjectionInputs,
    ],
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
  const projectedTextureArrayStructureSignature = useMemo(
    () =>
      `${contentAwareUvUnderlayLayers
        .map(
          (layer) =>
            `${layer.id}:${layer.imageUrl ?? ''}:${layer.contentRevision ?? 0}:${layer.objectId ?? ''}`,
        )
        .join('|')}|${previewProjectionInputs
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
            layer.objectMatrixWorld?.join(',') ?? '',
            layer.camera.viewMatrix?.join(',') ?? '',
            layer.camera.projectionMatrix?.join(',') ?? '',
          ].join('~'),
        )
        .join('|')}`,
    [contentAwareUvUnderlayLayers, previewProjectionInputs],
  );
  const projectedSamplerBudget = useProjectedTextureArrays
    ? projectedTextureArraySamplerBudget
    : directProjectedSamplerBudget;
  const textureArrayCompositionFallbackRequired = Boolean(
    useProjectedTextureArrays &&
    projectedTextureArrayStructureSignature &&
    failedProjectedTextureArraySignature === projectedTextureArrayStructureSignature,
  );
  const canUseDirectVisibleStackAfterArrayFailure = Boolean(
    textureArrayCompositionFallbackRequired && directProjectedSamplerStable,
  );
  // Prefer an exact projected material. If the device still rejects a downscaled
  // array, preserve every visible layer through the tiled compositor rather than
  // dropping layers. UV-safe imports may use this path proactively as before.
  const canUseProgressiveUvFallback = Boolean(
    importedModel?.group.userData.liclickUvCompositeSafe === true ||
    (textureArrayCompositionFallbackRequired && !canUseDirectVisibleStackAfterArrayFailure),
  );
  const projectedPreviewNeedsComposition = Boolean(
    !projectedSamplerBudget.withinBudget ||
    (textureArrayCompositionFallbackRequired && !canUseDirectVisibleStackAfterArrayFailure),
  );
  const activeProjectedPreviewInput = useMemo(
    () => {
      // A live repaint is the latency-sensitive foreground patch. Keep it on a
      // dedicated sampler and out of the packed background texture array even
      // before its persistent layer row exists. Otherwise the first stop event
      // changes the active row, repacks 14 background slices and produces a
      // 200ms+ frame. The direct path also samples the native generated image
      // instead of the array's memory-budget preview size.
      if (visibleLocalRepaintPreviewLayer?.visible) {
        const liveRepaintInput = previewProjectionInputs.find(
          (layer) => layer.layerId === visibleLocalRepaintPreviewLayer.id,
        );
        if (liveRepaintInput) return liveRepaintInput;
      }
      return previewProjectionInputs.find(
        (layer) => layer.layerId === activeLayerId && layer.visible,
      );
    },
    [activeLayerId, previewProjectionInputs, visibleLocalRepaintPreviewLayer],
  );
  const progressiveBackgroundInputs = useMemo(
    () =>
      activeProjectedPreviewInput
        ? previewProjectionInputs.filter(
            (layer) => layer.layerId !== activeProjectedPreviewInput.layerId,
          )
        : previewProjectionInputs,
    [activeProjectedPreviewInput, previewProjectionInputs],
  );
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
        previewProjectionInputs
          .filter((layer) => layer.visible)
          .map((layer) => layer.layerId),
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
      !projectedPreviewNeedsComposition ||
      !canUseProgressiveUvFallback ||
      progressiveBackgroundInputs.length === 0 ||
      !importedModel
    ) {
      projectedPreviewCompositorRef.current?.cancelPending();
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
        notifyProjectedPreviewFailure(error);
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
  const residentContentAwareUnderlayTexture = useLoadedPreviewTexture(
    residentContentAwareUvUnderlayLayer?.imageUrl,
  );
  const compositedContentAwareUnderlayTexture = useCompositedUvTexture(
    visibleCompositedContentAwareUvUnderlayLayers,
  );
  const loadedContentAwareUnderlayTexture =
    residentContentAwareUnderlayTexture ?? compositedContentAwareUnderlayTexture;
  const contentAwareUnderlayOpacity = residentContentAwareUvUnderlayLayer
    ? residentContentAwareUvUnderlayLayer.visible
      ? residentContentAwareUvUnderlayLayer.opacity
      : 0
    : loadedContentAwareUnderlayTexture
      ? 1
      : 0;
  useEffect(() => {
    if (!loadedContentAwareUnderlayTexture) return;
    markSparseAlphaBaseTexture(loadedContentAwareUnderlayTexture);
  }, [loadedContentAwareUnderlayTexture]);
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
  const loadedBakedTexture = useLoadedPreviewTexture(previewBakedTextureRecord?.imageUrl);
  const liveTopUvLayer = useMemo(() => {
    const topLayer = stableVisibleUvLayers[0];
    if (
      !topLayer ||
      (!getLiveProjectedCanvasState(topLayer.imageUrl) && !isRenderedLocalRepaintLayer(topLayer))
    )
      return undefined;
    const hasLiveLocalRepaintStroke = Boolean(
      localRepaintPreviewLayerId,
    );
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
  const directUvLayer = residentDirectUvLayer ??
    (nonLiveUvLayers.length === 1 ? nonLiveUvLayers[0] : undefined);
  const compositedUvLayers = directUvLayer
    ? nonLiveUvLayers.filter((layer) => layer.id !== directUvLayer.id)
    : nonLiveUvLayers;
  const uvOverlayOpacity = directUvLayer
    ? directUvLayer.visible
      ? directUvLayer.opacity
      : 0
    : compositedUvLayers.length > 0
      ? 1
      : 0;
  const compositedUvTexture = useCompositedUvTexture(compositedUvLayers);
  const directUvTexture = useLoadedPreviewTexture(directUvLayer?.imageUrl, {
    preserveWhenEmpty: true,
  });
  const loadedUvTexture = directUvLayer
    ? directUvTexture
    : (compositedUvTexture ?? directUvTexture);
  useEffect(() => {
    if (!loadedUvTexture) return;
    document.body.dataset.textureRestoreUvReady = '1';
    document.body.dataset.textureRestoreUvReadyMs = performance.now().toFixed(1);
  }, [loadedUvTexture]);
  const visibleResidentUvKey = useMemo(
    () =>
      residentUvVisibilityKey(
        stableVisibleUvLayers.filter(
          (layer) =>
            layer.role !== 'local-repaint-overlay' && layer.role !== 'local-repaint-draft',
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
  // Keep the projected shader and its texture arrays resident even when every
  // projected layer is hidden. Visibility is already represented by each
  // layer's opacity uniform, so replacing the shader with a white/baked material
  // at zero visible layers only destroys GPU state and forces an asynchronous
  // rebuild when an eye is enabled again. It also lets a stale/blank baked cache
  // win that race and leave the object permanently white.
  //
  // Exact baked previews remain useful for legacy stacks that cannot be sampled
  // as projected layers (for example, records without camera data). A resident
  // projection stack must stay authoritative for interactive visibility changes.
  const visibleStackHasBakedPreview =
    Boolean(previewBakedTextureRecord) &&
    !visibleStackNeedsLivePreview &&
    !hasResidentProjectedLayers;
  const canPreviewProjectedLayers =
    !visibleStackHasBakedPreview &&
    hasResidentProjectedLayers;
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
    syncProjectedLayerResidentTextureVisibilityInObject(importedModel.group, {
      uvOverlayOpacity,
      topUvOverlayOpacity: liveTopUvLayer?.visible ? liveTopUvLayer.opacity : 0,
      baseTextureOpacity: contentAwareUnderlayOpacity,
    });
    syncProjectedLayerMaterialDisplayStateInObject(
      importedModel.group,
      previewProjectionInputs,
      displayMode === 'normal',
      displayMode === 'wire',
      previewLighting,
    );
    invalidate();
  }, [
    contentAwareUnderlayOpacity,
    displayMode,
    importedModel,
    invalidate,
    liveTopUvLayer,
    previewLighting,
    previewProjectionInputs,
    uvOverlayOpacity,
  ]);

  useFrame(() => {
    const interaction = projectedPreviewInteractionRef.current;
    const isInteracting =
      interaction.pointerDown || performance.now() - interaction.lastMovedAt < 140;
    // CPU timing around renderer.render() does not include queued GPU work. Cap
    // operation count too, so background composition cannot flood the GPU queue.
    projectedPreviewCompositorRef.current?.step(isInteracting ? 1 : 2.5, isInteracting ? 1 : 2);
    if (stableVisibleProjectedLayers.length === 0) {
      lastProjectedTransformRef.current = undefined;
      return;
    }
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

  useEffect(() => {
    if (!importedModel) return;
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
    };
    const isViewportInteractionBusy = () => {
      const interaction = projectedPreviewInteractionRef.current;
      const paintTool = useSceneStore.getState().paintTool;
      return Boolean(
        interaction.pointerDown ||
          performance.now() - interaction.lastMovedAt < 180 ||
          document.body.dataset.perfSimulatedViewportInteraction === '1' ||
          document.body.dataset.perfViewportStressMeasuring === '1' ||
          paintTool === 'inpaint-add' ||
          paintTool === 'inpaint-subtract' ||
          paintTool === 'inpaint-apply',
      );
    };
    const waitForViewportInteractionIdle = async () => {
      while (!cancelled && isViewportInteractionBusy()) {
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      }
    };
    const precompileProjectedMaterial = async (material: THREE.ShaderMaterial) => {
      if (typeof gl.compileAsync !== 'function') return false;
      if (cancelled) return false;
      const compileScene = new THREE.Scene();
      const compileGeometry = new THREE.BoxGeometry(1, 1, 1);
      const compileMesh = new THREE.Mesh(compileGeometry, material);
      compileMesh.frustumCulled = false;
      compileScene.add(compileMesh);
      const compileStartedAt = performance.now();
      try {
        await gl.compileAsync(compileScene, camera);
      } finally {
        const compileDurationMs = performance.now() - compileStartedAt;
        if (typeof document !== 'undefined') {
          document.body.dataset.projectedMaterialCompileDurationMs =
            compileDurationMs.toFixed(1);
          document.body.dataset.projectedMaterialCompileCompletedUnixMs = String(Date.now());
        }
        markPerformanceEvent('projection', 'projected-material-precompile', {
          durationMs: compileDurationMs,
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

    async function applyMaterials() {
      if (model.restoreStage === 'bounds') return;
      if (model.restoreStage === 'outline') {
        const outlineMaterial = createFlatPreviewMaterial(undefined, false, undefined, previewLighting);
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
        return;
      }
      const selected = false;
      model.group.updateMatrixWorld(true);
      const progressiveActiveInputs = activeProjectedPreviewInput
        ? [activeProjectedPreviewInput]
        : [];
      const useProjectedTextureArrayMaterial =
        useProjectedTextureArrays && !textureArrayCompositionFallbackRequired;
      const materialProjectionInputs = progressiveProjectedPreviewReady
        ? progressiveActiveInputs
        : progressiveIncrementalPreviewReady
          ? progressiveIncrementalInputs
          : previewProjectionInputs;
      const showWhiteMembrane = Boolean(
        materialProjectionInputs.length > 0 &&
          materialProjectionInputs.every((layer) => !layer.visible) &&
          (!loadedUvTexture || uvOverlayOpacity <= 0) &&
          !liveTopUvTexture &&
          (!loadedContentAwareUnderlayTexture || contentAwareUnderlayOpacity <= 0),
      );
      const showGeometryOnlyDisplay = displayMode === 'normal' || displayMode === 'wire';
      const bypassProjectedMaterial = showWhiteMembrane || showGeometryOnlyDisplay;
      const activeProgressivePreviewBase = showWhiteMembrane
        ? undefined
        : progressivePreviewBase;
      const projectedLayerInput =
        !bypassProjectedMaterial &&
        canPreviewProjectedLayers &&
        materialProjectionInputs.length > 0
          ? {
              layers: materialProjectionInputs,
              objectId: model.objectId,
              currentObjectMatrixWorld: model.group.matrixWorld.toArray(),
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
      if (new URLSearchParams(window.location.search).has('perfScenario')) {
        document.body.dataset.projectedPreviewStatus = JSON.stringify(previewStatus);
      }
      if (projectedPreviewOverBudget) {
        const warningKey = `${projectedSamplerBudget.required}/${projectedSamplerBudget.available}:${previewProjectedLayerSignature}`;
        if (lastProjectedSamplerWarningRef.current !== warningKey) {
          lastProjectedSamplerWarningRef.current = warningKey;
          console.warn(
            `[Liclick 3D Texture] Projected preview kept the last valid material because ${projectedSamplerBudget.required} fragment texture units exceed the device limit of ${projectedSamplerBudget.available}.`,
          );
          notifyProjectedPreviewLimit(
            projectedSamplerBudget.required,
            projectedSamplerBudget.available,
          );
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
          material.name.startsWith('LiclickProjectedLayerStack:'),
        );
      });
      const hasPresentedBootstrapMaterial = meshes.some((mesh) => {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        return materials.some(
          (material) => material.userData.liclickProjectedBootstrap === true,
        );
      });
      const exactBakedBootstrapTexture =
        loadedBakedTexture &&
        !hasLiveProjectedPreview &&
        !liveProjectedEraserMaskTexture &&
        !stableVisibleProjectedLayers.some((layer) => layer.needsRebake)
          ? loadedBakedTexture
          : undefined;
      const canPresentUvBootstrap = Boolean(
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
                      uvOverlayOpacity,
                      uvOverlayHue: directUvLayer
                        ? (directUvLayer.adjustments?.hue ?? 0) / 100
                        : 0,
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
                      liveUvOverlaySaturation:
                        (liveTopUvLayer?.adjustments?.saturation ?? 0) / 100,
                      liveUvOverlayLightness:
                        (liveTopUvLayer?.adjustments?.lightness ?? 0) / 100,
                    }
                  : {}),
              }),
        });
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
        document.body.dataset.projectedBootstrapMaterialMode = exactBakedBootstrapTexture
          ? 'exact-baked'
          : 'uv-resident';
        invalidate();
      }
      let finalProjectedMaterialCommitted = false;
      const representativeProjectedLayer =
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
            const disposedBootstrapMaterials = new Set<
              THREE.Material | THREE.Material[]
            >();
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
      const bypassMaterial = bypassProjectedMaterial
        ? createDisplayModeMaterial(displayMode, selected, undefined, previewLighting)
        : undefined;

      const residentProjectedMaterial = residentProjectedMaterialRef.current;
      if (projectedLayerInput && residentProjectedMaterial) {
        const residentInput: ProjectionLayerStackInput = {
          ...projectedLayerInput,
          ...(loadedUvTexture ? { uvOverlayTexture: loadedUvTexture } : {}),
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
          if (
            previousMaterial instanceof THREE.ShaderMaterial &&
            previousMaterial.name.startsWith('LiclickProjectedLayerStack:')
          ) {
            const alreadyResident = residentProjectedMaterialRef.current;
            if (!alreadyResident) {
              residentProjectedMaterialRef.current = previousMaterial;
            } else if (alreadyResident !== previousMaterial) {
              disposeGeneratedMaterialTree(previousMaterial);
            }
          } else if (previousMaterial !== bypassMaterial) {
            disposeGeneratedMaterialTree(previousMaterial);
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
          disposeGeneratedMaterialTree(previousMaterial);
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
          disposeGeneratedMaterialTree(previousMaterial);
          continue;
        }
        if (displayMode === 'pbr' && !projectedLayerInput) {
          child.material = createPbrPreviewMaterial(
            undefined,
            selected,
            bakedTexture,
            previewLighting,
          );
          disposeGeneratedMaterialTree(previousMaterial);
          continue;
        }
        if (displayMode === 'flat' && !projectedLayerInput) {
          child.material = createFlatPreviewMaterial(
            undefined,
            selected,
            bakedTexture,
            previewLighting,
          );
          disposeGeneratedMaterialTree(previousMaterial);
          continue;
        }
        if (
          projectedLayerInput &&
          updateProjectedLayerStackMaterial(previousMaterial, {
            ...projectedLayerInput,
            ...(loadedUvTexture ? { uvOverlayTexture: loadedUvTexture } : {}),
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
            ...topUvProjectedOverlayInput,
          };
          try {
            if (useProjectedTextureArrayMaterial) {
              usingSharedTextureArrayBuild = true;
              const textureArrayBuildSignature = [
                projectedTextureArrayStructureSignature,
                loadedUvTexture?.uuid ?? '',
                liveTopUvTexture?.uuid ?? '',
              ].join('|');
              sharedTextureArrayBuildSignature = textureArrayBuildSignature;
              if (
                projectedTextureArrayBuildRef.current?.signature !== textureArrayBuildSignature
              ) {
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
              sharedProjectedMaterial =
                await projectedTextureArrayBuildRef.current.promise;
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
                await precompileProjectedMaterial(sharedProjectedMaterial);
                if (visibleLayerCount > 0) {
                  reportProjectedPreviewProgress(
                    0.96,
                    '材质已就绪，正在按图层眼睛状态发布',
                    { layerCount: visibleLayerCount },
                  );
                }
                if (
                  projectedTextureArrayBuildRef.current?.signature !==
                  textureArrayBuildSignature
                ) {
                  disposeGeneratedMaterialTree(sharedProjectedMaterial);
                  return;
                }
                syncProjectedLayerMaterialDisplayState(
                  sharedProjectedMaterial,
                  projectedLayerInput.layers,
                  displayMode === 'normal',
                  displayMode === 'wire',
                );
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
            }
          } catch (error) {
            if (
              usingSharedTextureArrayBuild &&
              projectedTextureArrayBuildRef.current?.signature ===
                sharedTextureArrayBuildSignature
            ) {
              projectedTextureArrayBuildRef.current = undefined;
            }
            if (!useProjectedTextureArrayMaterial || cancelled) throw error;
            console.warn(
              '[Liclick 3D Texture] Projected texture arrays are unavailable; switching the complete visible stack to a bounded fallback.',
              error,
            );
            const visibleLayerCount = projectedLayerInput.layers.filter(
              (layer) => layer.visible,
            ).length;
            if (visibleLayerCount > 0) {
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
              projectedTextureArrayBuildRef.current?.signature ===
                sharedTextureArrayBuildSignature,
          );
          if (!sharedBuildStillCurrent) disposeGeneratedMaterialTree(projectedMaterial);
          return;
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
        if (sharedProjectedMaterial) {
          document.body.dataset.projectedFinalMaterialReadyUnixMs = String(Date.now());
          document.body.dataset.textureRestoreProjectedReady = '1';
          document.body.dataset.textureRestoreProjectedReadyMs = performance.now().toFixed(1);
          const stackState = sharedProjectedMaterial.userData
            .liclickProjectedLayerStackState as
            | { bindings?: Array<{ layerId?: string }> }
            | undefined;
          const loadedLayerIds = new Set(
            stackState?.bindings?.flatMap((binding) =>
              binding.layerId ? [binding.layerId] : [],
            ) ?? [],
          );
          document.body.dataset.textureRestoreLoadedProjectedLayers = String(
            loadedLayerIds.size,
          );
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
            reportProjectedPreviewProgress(
              1,
              `${visibleLoadedLayerCount} 个可见投影图层已显示`,
              { done: true, layerCount: visibleLoadedLayerCount },
            );
          }
        }
      }
      syncProjectedLayerMaterialProjection(model.group);
      useToastStore.getState().dismissToastByDedupeKey(PROJECTED_PREVIEW_FAILURE_TOAST_KEY);
      if (lastProjectedTransformRef.current) {
        lastProjectedTransformRef.current.copy(model.group.matrixWorld);
      } else {
        lastProjectedTransformRef.current = model.group.matrixWorld.clone();
      }
      const sceneState = useSceneStore.getState();
      const activation = resolveLocalRepaintPreviewActivation({
        consumedKey: activatedLocalRepaintPreviewKeyRef.current,
        paintTool: sceneState.paintTool,
        preview: visibleLocalRepaintPreviewLayer,
        currentPreview: sceneState.localRepaintPreviewLayer,
        currentSource: sceneState.localRepaintProjectionSource,
        processedLayerIds:
          projectedLayerInput && !projectedPreviewOverBudget
            ? previewStatus.processedLayerIds
            : [],
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
        notifyProjectedPreviewFailure(error);
      })
      .finally(() => {
        // The gate means the first material pass has settled, not necessarily
        // that every optional normal/depth asset succeeded. This preserves the
        // newer strict visibility policy without deadlocking its runtime repair.
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
    gl,
    importedModel,
    initialProjectedMaterialReady,
    loadedBakedTexture,
    loadedContentAwareUnderlayTexture,
    contentAwareUnderlayOpacity,
    loadedUvTexture,
    gl.capabilities.maxTextures,
    liveProjectedEraserMaskTexture,
    liveSurfacePaintPreview,
    liveTopUvLayer,
    liveTopUvTexture,
    liveSurfaceMaskTexture,
    previewLighting,
    previewBakedTextureRecord,
    previewProjectionInputs,
    previewProjectedLayerSignature,
    progressiveProjectedPreview,
    progressiveProjectedPreviewReady,
    progressiveIncrementalInputs,
    progressiveIncrementalPreviewReady,
    canUseProgressivePreviewBase,
    progressivePreviewBase,
    projectedSamplerBudget,
    projectedPreviewNeedsComposition,
    projectedTextureArrayStructureSignature,
    textureArrayCompositionFallbackRequired,
    useProjectedTextureArrays,
    activeProjectedPreviewInput,
    stablePreviewProjectedLayers,
    topUvProjectedOverlayInput,
    uvOverlayOpacity,
    visibleLocalRepaintPreviewLayer,
    visibleStackHasBakedPreview,
  ]);

  if (!importedModel) return null;

  // Keep this component and its decoded texture/material state alive when the
  // workspace hides the model. Returning only its scene primitive prevents a
  // scene/texture switch from rebuilding the complete material pipeline.
  if (!objectVisible || !workspaceVisible) return null;

  return (
    <>
      <primitive
        object={importedModel.group}
        onClick={(event: { stopPropagation: () => void }) => {
          event.stopPropagation();
          selectObject(importedModel.objectId);
        }}
      />
      {importedModel.restoreStage !== 'bounds' && displayMode === 'wire' && (
        <TopologyWireframeOverlay object={importedModel.group} />
      )}
      {texturedRestoreReady &&
        showSelectionGlow &&
        selectedObjectId === importedModel.objectId && (
          <SelectionBoundsCorners object={importedModel.group} />
        )}
    </>
  );
}

export function SceneRoot() {
  const importedModels = useSceneStore((state) => state.importedModels);
  const importedModel = useSceneStore((state) => state.importedModel);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const selectObject = useSceneStore((state) => state.selectObject);
  const displayMode = useSceneStore((state) => state.displayMode);
  const workspaceMode = useWorkspaceLayoutStore((state) => state.mode);
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
  const activeObjectId = selectedObjectId ?? importedModel?.objectId ?? importedModels[0]?.objectId;
  const isSceneWorkspace = workspaceMode === 'scene' || workspaceMode === 'export';
  const workspaceVisibleModels = isSceneWorkspace
    ? importedModels
    : importedModels.filter((model) => model.objectId === activeObjectId);
  const workspaceVisibleModelIds = new Set(
    workspaceVisibleModels.map((model) => model.objectId),
  );
  const showSelectionGlow = isSceneWorkspace;
  const hasProgressiveRestore = workspaceVisibleModels.some(
    (model) => model.restoreStage && model.restoreStage !== 'full',
  );

  return (
    <group onPointerMissed={() => selectObject(undefined)}>
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
          showSelectionGlow={showSelectionGlow}
          workspaceVisible={workspaceVisibleModelIds.has(model.objectId)}
        />
      ))}
      <ObjectTransformControls />
      {!hasProgressiveRestore && (
        <ContactShadows position={[0, -0.02, 0]} opacity={0.22} scale={8} blur={2.4} />
      )}
    </group>
  );
}
