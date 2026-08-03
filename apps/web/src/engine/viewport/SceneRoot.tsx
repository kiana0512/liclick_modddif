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
  syncProjectedLayerMaterialProjection,
  updateProjectedLayerStackMaterial,
  updateUvOverlayPreviewMaterial,
} from '@/engine/projection/ProjectedLayerMaterial';
import {
  ProjectedLayerPreviewCompositor,
  type ProjectedPreviewComposite,
  type ProjectedPreviewCompositeProgress,
} from '@/engine/projection/ProjectedLayerPreviewCompositor';
import {
  getLiveProjectedCanvasState,
  getLiveProjectedCanvasTexture,
} from '@/engine/projection/liveProjectedCanvasTextureRegistry';
import { useLiveSurfacePaintPreview } from '@/engine/paint/liveSurfacePaintPreviewRegistry';
import { createRuntimeProjectionDepth } from '@/engine/projection/createRuntimeProjectionDepth';
import {
  compareUvLayersForComposition,
  getVisibleUvLayerStack,
} from '@/engine/layers/uvLayerComposition';
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
import { ObjectTransformControls } from './ObjectTransformControls';
import type { ModelLoadResult } from '@/engine/loaders/modelImportTypes';
import type { ProjectionPreviewLighting } from '@/engine/projection/projectionTypes';
import type { Layer } from '@/types/layer';

const RESOLUTION_TO_SIZE = {
  '1K': 1024,
  '2K': 2048,
  '4K': 4096,
  '8K': 8192,
} as const;

const MAX_PREVIEW_TEXTURE_CACHE_SIZE = 12;
const MAX_IMAGE_ELEMENT_CACHE_SIZE = 32;
const bakedTextureCache = new Map<string, Promise<THREE.Texture>>();
const imageElementCache = new Map<string, Promise<HTMLImageElement>>();
const PROJECTED_PREVIEW_LIMIT_TOAST_KEY = 'projected-preview:sampler-limit';
const PROJECTED_PREVIEW_FAILURE_TOAST_KEY = 'projected-preview:failure';
const PROJECTED_TEXTURE_ARRAY_TOAST_KEY = 'projected-preview:texture-array';
const PROJECTED_PREVIEW_PROGRESS_INTERVAL_MS = 250;
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
let lastProjectedPreviewProgressAt = 0;
let lastProjectedPreviewPercent = 0;

function resetProjectedPreviewProgressNotice() {
  lastProjectedPreviewProgressAt = 0;
  lastProjectedPreviewPercent = 0;
}

function projectionPreviewCopy() {
  return translations[useI18nStore.getState().language];
}

function notifyProjectedPreviewLimit(required: number, available: number) {
  resetProjectedPreviewProgressNotice();
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

function notifyProjectedPreviewProgress(progress: ProjectedPreviewCompositeProgress) {
  const copy = projectionPreviewCopy();
  const percent = Math.max(1, Math.min(99, Math.round(progress.progress * 100)));
  const now = performance.now();
  if (
    percent === lastProjectedPreviewPercent ||
    (now - lastProjectedPreviewProgressAt < PROJECTED_PREVIEW_PROGRESS_INTERVAL_MS &&
      percent - lastProjectedPreviewPercent < 2)
  ) {
    return;
  }
  lastProjectedPreviewProgressAt = now;
  lastProjectedPreviewPercent = percent;
  useToastStore.getState().pushToast({
    tone: 'info',
    title: copy.projectedPreviewComposing,
    description: copy.projectedPreviewComposingHelp.replace('{progress}', String(percent)),
    dedupeKey: PROJECTED_PREVIEW_LIMIT_TOAST_KEY,
    persistent: true,
  });
}

function notifyProjectedPreviewReady(layerCount: number) {
  resetProjectedPreviewProgressNotice();
  const copy = projectionPreviewCopy();
  const toastStore = useToastStore.getState();
  toastStore.dismissToastByDedupeKey(PROJECTED_PREVIEW_LIMIT_TOAST_KEY);
  toastStore.pushToast({
    tone: 'success',
    title: copy.projectedPreviewReady,
    description: copy.projectedPreviewReadyHelp.replace('{count}', String(layerCount)),
    dedupeKey: PROJECTED_PREVIEW_LIMIT_TOAST_KEY,
  });
}

function notifyProjectedPreviewFailure(_error: unknown) {
  resetProjectedPreviewProgressNotice();
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

function notifyProjectedTextureArrayPreparing(layerCount: number) {
  const copy = projectionPreviewCopy();
  useToastStore.getState().pushToast({
    tone: 'info',
    title: copy.projectedTextureArrayPreparing,
    description: copy.projectedTextureArrayPreparingHelp.replace('{count}', String(layerCount)),
    dedupeKey: PROJECTED_TEXTURE_ARRAY_TOAST_KEY,
  });
}

function notifyProjectedTextureArrayReady(layerCount: number) {
  const copy = projectionPreviewCopy();
  const toastStore = useToastStore.getState();
  toastStore.dismissToastByDedupeKey(PROJECTED_PREVIEW_FAILURE_TOAST_KEY);
  toastStore.dismissToastByDedupeKey(PROJECTED_TEXTURE_ARRAY_TOAST_KEY);
  toastStore.pushToast({
    tone: 'success',
    title: copy.projectedTextureArrayReady,
    description: copy.projectedTextureArrayReadyHelp.replace('{count}', String(layerCount)),
    dedupeKey: PROJECTED_TEXTURE_ARRAY_TOAST_KEY,
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

function layerPreviewSignature(layer: Layer) {
  return [
    layer.id,
    layer.type,
    layer.imageUrl ?? '',
    layer.maskUrl ?? '',
    layer.depthUrl ?? '',
    layer.visible ? 1 : 0,
    layer.order,
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
  return Boolean(
    layer.renderedColor ||
    layer.id.startsWith('local-repaint-') ||
    layer.id.startsWith('content-aware-projected-repair') ||
    layer.generationId === 'texture-map-content-aware-repair' ||
    layer.imageUrl.includes('surface-edit:local-repaint'),
  );
}

function isOverlayProjectionPatch(layer: Layer) {
  return Boolean(
    layer.id.startsWith('local-repaint-') || layer.imageUrl.includes('surface-edit:local-repaint'),
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

function useStableValueBySignature<T>(value: T, signature: string) {
  const stableRef = useRef<{ signature: string; value: T }>();
  if (!stableRef.current || stableRef.current.signature !== signature) {
    stableRef.current = { signature, value };
  }
  return stableRef.current.value;
}

function trimBakedTextureCache() {
  while (bakedTextureCache.size > MAX_PREVIEW_TEXTURE_CACHE_SIZE) {
    const oldestKey = bakedTextureCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const texturePromise = bakedTextureCache.get(oldestKey);
    bakedTextureCache.delete(oldestKey);
    void texturePromise?.then((texture) => texture.dispose()).catch(() => undefined);
  }
}

function loadPreviewTexture(imageUrl: string) {
  const cached = bakedTextureCache.get(imageUrl);
  if (cached) {
    bakedTextureCache.delete(imageUrl);
    bakedTextureCache.set(imageUrl, cached);
    return cached;
  }
  const texturePromise = new THREE.TextureLoader().loadAsync(imageUrl).then((texture) => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = true;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.anisotropy = 8;
    texture.needsUpdate = true;
    return texture;
  });
  bakedTextureCache.set(imageUrl, texturePromise);
  trimBakedTextureCache();
  return texturePromise;
}

function getPreviewLighting(input: {
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

function useLoadedPreviewTexture(imageUrl?: string) {
  const [loadedTexture, setLoadedTexture] = useState<THREE.Texture>();

  useEffect(() => {
    if (!imageUrl) {
      setLoadedTexture(undefined);
      return undefined;
    }
    let cancelled = false;
    setLoadedTexture(undefined);
    loadPreviewTexture(imageUrl)
      .then((texture) => {
        if (cancelled) return;
        setLoadedTexture(texture);
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn('[Liclick 3D Texture] Could not load texture for viewport preview:', error);
        setLoadedTexture(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [imageUrl]);

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
    texture: THREE.CanvasTexture;
    draw: () => void;
    liveRevisions: Map<string, number>;
  }>();
  const layerKey = useMemo(
    () =>
      layers
        .map(
          (layer) =>
            `${layer.id}:${layer.imageUrl}:${layer.opacity}:${layer.blendMode}:${layer.order}`,
        )
        .join('|'),
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
    runtime.draw();
    runtime.texture.needsUpdate = true;
  });

  useEffect(() => {
    const uvLayers = stableLayers.filter((layer) => layer.visible && layer.imageUrl);
    if (uvLayers.length === 0) {
      setTexture(undefined);
      return undefined;
    }

    let cancelled = false;
    let nextTexture: THREE.CanvasTexture | undefined;
    setTexture(undefined);

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
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Could not create UV layer composite canvas.');
        const draw = () => {
          context.clearRect(0, 0, width, height);
          [...sources]
            .sort((left, right) =>
              compareUvLayersForComposition(left.layer, right.layer, 'bottom-to-top'),
            )
            .forEach(({ layer, source }) => {
              context.save();
              context.globalAlpha = Math.max(0, Math.min(1, layer.opacity));
              context.globalCompositeOperation = 'source-over';
              context.drawImage(source, 0, 0, width, height);
              context.restore();
            });
        };
        draw();

        nextTexture = new THREE.CanvasTexture(canvas);
        nextTexture.colorSpace = THREE.SRGBColorSpace;
        nextTexture.flipY = true;
        nextTexture.wrapS = THREE.ClampToEdgeWrapping;
        nextTexture.wrapT = THREE.ClampToEdgeWrapping;
        nextTexture.minFilter = THREE.LinearFilter;
        nextTexture.magFilter = THREE.LinearFilter;
        nextTexture.generateMipmaps = false;
        nextTexture.anisotropy = 8;
        nextTexture.needsUpdate = true;
        runtimeRef.current = {
          texture: nextTexture,
          draw,
          liveRevisions: new Map(
            sources.flatMap(({ liveUrl, liveRevision }) =>
              liveUrl && liveRevision !== undefined ? [[liveUrl, liveRevision] as const] : [],
            ),
          ),
        };
        setTexture(nextTexture);
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn('[Liclick 3D Texture] Could not composite UV layer stack:', error);
        setTexture(undefined);
      });

    return () => {
      cancelled = true;
      if (runtimeRef.current?.texture === nextTexture) runtimeRef.current = undefined;
      nextTexture?.dispose();
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
    () => () => {
      overlay.group.removeFromParent();
      overlay.material.dispose();
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
  const { gl } = useThree();
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
  const texturedRestoreReady =
    !importedModel.restoreStage || importedModel.restoreStage === 'full';
  const layers = useLayerStore((state) => state.layers);
  const liveSurfacePaintPreview = useLiveSurfacePaintPreview();
  const localRepaintPreviewLayer = useSceneStore((state) => state.localRepaintPreviewLayer);
  const visibleLocalRepaintPreviewLayer = useMemo(() => {
    if (!localRepaintPreviewLayer?.visible) return undefined;
    const storedLayer = layers.find((layer) => layer.id === localRepaintPreviewLayer.id);
    // Once the renderer-only repaint preview has a matching row in the layer
    // stack, that row is authoritative. Otherwise hiding the row leaves the
    // duplicate live preview visible on the model.
    if (storedLayer && !storedLayer.visible) return undefined;
    return localRepaintPreviewLayer;
  }, [layers, localRepaintPreviewLayer]);
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
  useEffect(() => {
    if (!texturedRestoreReady) return undefined;
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
      const completedVisibility: Record<string, { depthUrl: string; normalUrl: string }> = {};
      for (let index = 0; index < candidates.length; index += 1) {
        const layer = candidates[index];
        // Stored capture depth is sufficient for the first visible material.
        // Rebuild the sharper runtime depth/crease-normal pair after the model
        // and its textures have had time to present, yielding between layers.
        await waitForProjectionVisibilityIdle(index === 0 ? 1000 : 32);
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
          });
          if (cancelled) return;
          completedVisibility[layer.id] = visibility;
        } catch (error) {
          if (cancelled) return;
          console.error(
            `[Liclick 3D Texture] Could not build projection visibility depth for ${layer.name}.`,
            error,
          );
        }
      }
      if (cancelled || Object.keys(completedVisibility).length === 0) return;
      setRuntimeVisibilityByLayerId((current) => ({
        ...current,
        ...completedVisibility,
      }));
    })();
    return () => {
      cancelled = true;
    };
  }, [
    captureById,
    gl,
    importedModel,
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
  const lastProjectedTextureArrayNoticeRef = useRef('');
  const activatedLocalRepaintPreviewKeyRef = useRef('');
  const projectedPreviewCompositorRef = useRef<ProjectedLayerPreviewCompositor>();
  const projectedPreviewInteractionRef = useRef({ pointerDown: false, lastMovedAt: 0 });
  const [progressiveProjectedPreview, setProgressiveProjectedPreview] =
    useState<ProjectedPreviewComposite>();
  const [failedProjectedTextureArraySignature, setFailedProjectedTextureArraySignature] =
    useState('');
  const previewProjectedLayers = useMemo(() => {
    if (!texturedRestoreReady) return [];
    const storedLayers = layers
      .filter(
        (layer) =>
          layer.type === 'projected' &&
          layer.visible &&
          layer.imageUrl &&
          layer.camera &&
          (!layer.objectId || layer.objectId === importedObjectId),
      )
      // Layer order 0 is the top row in the panel. Feed the shader bottom-up
      // so later overlay evaluations preserve that visible stacking order.
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
          renderedColor: isRenderedLocalRepaintLayer(layer),
          minimumProjectionFacing: layer.minimumProjectionFacing,
        };
      }),
    [captureById, runtimeVisibilityByLayerId, stablePreviewProjectedLayers],
  );
  const contentAwareUvUnderlayLayer = useMemo(
    () =>
      texturedRestoreReady
        ? layers.find(
            (layer) =>
              layer.type === 'uv' &&
              layer.role === 'content-aware-underlay' &&
              layer.visible &&
              Boolean(layer.imageUrl) &&
              (!layer.objectId || layer.objectId === importedObjectId),
          )
        : undefined,
    [importedObjectId, layers, texturedRestoreReady],
  );
  const hasVisibleUvOverlay = useMemo(
    () =>
      texturedRestoreReady &&
      layers.some(
        (layer) =>
          layer.type === 'uv' &&
          layer.role !== 'content-aware-underlay' &&
          layer.visible &&
          Boolean(layer.imageUrl) &&
          (!layer.objectId || layer.objectId === importedObjectId),
      ),
    [importedObjectId, layers, texturedRestoreReady],
  );
  const directProjectedSamplerBudget = useMemo(
    () =>
      getProjectedLayerSamplerBudget(previewProjectionInputs, gl.capabilities.maxTextures, {
        useBaseMap: Boolean(contentAwareUvUnderlayLayer),
        useUvOverlayMap: hasVisibleUvOverlay,
      }),
    [
      contentAwareUvUnderlayLayer,
      gl.capabilities.maxTextures,
      hasVisibleUvOverlay,
      previewProjectionInputs,
    ],
  );
  const projectedTextureArraySamplerBudget = useMemo(
    () =>
      getProjectedLayerSamplerBudget(previewProjectionInputs, gl.capabilities.maxTextures, {
        useBaseMap: Boolean(contentAwareUvUnderlayLayer),
        useUvOverlayMap: hasVisibleUvOverlay,
        useTextureArrays: true,
      }),
    [
      contentAwareUvUnderlayLayer,
      gl.capabilities.maxTextures,
      hasVisibleUvOverlay,
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
      `${contentAwareUvUnderlayLayer?.id ?? ''}:${contentAwareUvUnderlayLayer?.imageUrl ?? ''}|${previewProjectionInputs
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
    [contentAwareUvUnderlayLayer, previewProjectionInputs],
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
    () => previewProjectionInputs.find((layer) => layer.layerId === activeLayerId),
    [activeLayerId, previewProjectionInputs],
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
            layer.opacity,
            layer.strength,
            layer.blendMode,
            layer.useMask ? 1 : 0,
            layer.maskSpace ?? 'projection',
            layer.useDepthCheck ? 1 : 0,
            layer.renderedColor ? 1 : 0,
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
    () => new Set(previewProjectionInputs.map((layer) => layer.layerId)),
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
        useUvOverlayMap: hasVisibleUvOverlay,
      }),
    [gl.capabilities.maxTextures, hasVisibleUvOverlay, progressiveIncrementalInputs],
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
        notifyProjectedPreviewReady(previewProjectionInputs.length);
      },
      onProgress: notifyProjectedPreviewProgress,
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
    () => layerStackPreviewSignature(visibleUvLayers),
    [visibleUvLayers],
  );
  const stableVisibleUvLayers = useStableValueBySignature(visibleUvLayers, visibleUvLayerSignature);
  const loadedContentAwareUnderlayTexture = useLoadedPreviewTexture(
    contentAwareUvUnderlayLayer?.imageUrl,
  );
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
      visibleLocalRepaintPreviewLayer &&
      stableVisibleProjectedLayers.some((layer) => layer.id === visibleLocalRepaintPreviewLayer.id),
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
    if (!hasLiveLocalRepaintStroke && topLayer.order >= topProjectedOrder) return undefined;
    return topLayer;
  }, [stableVisibleProjectedLayers, stableVisibleUvLayers, visibleLocalRepaintPreviewLayer]);
  const nonLiveUvLayers = useMemo(
    () =>
      liveTopUvLayer
        ? stableVisibleUvLayers.filter((layer) => layer.id !== liveTopUvLayer.id)
        : stableVisibleUvLayers,
    [liveTopUvLayer, stableVisibleUvLayers],
  );
  // A single UV layer is already a finished UV-space texture. Sample it directly
  // and adjust it with shader uniforms instead of rebuilding a full-resolution canvas.
  const directUvLayer = nonLiveUvLayers.length === 1 ? nonLiveUvLayers[0] : undefined;
  const compositedUvLayers = directUvLayer ? [] : nonLiveUvLayers;
  const compositedUvTexture = useCompositedUvTexture(compositedUvLayers);
  const directUvTexture = useLoadedPreviewTexture(directUvLayer?.imageUrl);
  const loadedUvTexture = directUvTexture ?? compositedUvTexture;
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
  const topUvProjectedOverlayInput = useMemo(
    () =>
      liveTopUvTexture && liveTopUvLayer
        ? {
            topUvOverlayTexture: liveTopUvTexture,
            topUvOverlayOpacity: liveTopUvLayer.opacity,
            topUvOverlayRenderedColor: isRenderedLocalRepaintLayer(liveTopUvLayer),
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
    Boolean(contentAwareUvUnderlayLayer) ||
    stableVisibleProjectedLayers.some((layer) => layer.needsRebake);
  // A same-layer cache may still describe the previous mask revision. Prefer the
  // projected material while a live canvas is attached or the layer is dirty;
  // otherwise the layer row updates but the model keeps showing the stale bake.
  const visibleStackHasBakedPreview =
    Boolean(previewBakedTextureRecord) && !visibleStackNeedsLivePreview;
  const canPreviewProjectedLayers =
    !visibleStackHasBakedPreview &&
    stableVisibleProjectedLayers.length > 0 &&
    stablePreviewProjectedLayers.length > 0 &&
    (displayMode === 'flat' || displayMode === 'pbr');
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

  useFrame(() => {
    const interaction = projectedPreviewInteractionRef.current;
    const isInteracting =
      interaction.pointerDown || performance.now() - interaction.lastMovedAt < 140;
    projectedPreviewCompositorRef.current?.step(isInteracting ? 1.25 : 5, isInteracting ? 1 : 4);
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

    async function applyMaterials() {
      if (model.restoreStage === 'bounds') return;
      if (model.restoreStage === 'outline') {
        const outlineMaterial = createFlatPreviewMaterial(undefined, false);
        const disposedMaterials = new Set<THREE.Material | THREE.Material[]>();
        model.group.traverse((child) => {
          if (!(child instanceof THREE.Mesh) || child.userData.liclickPaintOverlay) return;
          const previousMaterial = child.material;
          child.material = outlineMaterial;
          if (previousMaterial !== outlineMaterial && !disposedMaterials.has(previousMaterial)) {
            disposedMaterials.add(previousMaterial);
            disposeGeneratedMaterialTree(previousMaterial);
          }
        });
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
      const shouldAnnounceTextureArray = Boolean(
        canPreviewProjectedLayers &&
        useProjectedTextureArrayMaterial &&
        projectedTextureArrayStructureSignature &&
        lastProjectedTextureArrayNoticeRef.current !== projectedTextureArrayStructureSignature,
      );
      if (shouldAnnounceTextureArray) {
        lastProjectedTextureArrayNoticeRef.current = projectedTextureArrayStructureSignature;
        notifyProjectedTextureArrayPreparing(previewProjectionInputs.length);
      }
      const projectedLayerInput =
        canPreviewProjectedLayers && materialProjectionInputs.length > 0
          ? {
              layers: materialProjectionInputs,
              objectId: model.objectId,
              currentObjectMatrixWorld: model.group.matrixWorld.toArray(),
              ...(progressivePreviewBase
                ? {
                    baseTexture: progressivePreviewBase.colorTexture,
                    baseRenderedColorMaskTexture: progressivePreviewBase.renderedColorMaskTexture,
                  }
                : loadedContentAwareUnderlayTexture
                  ? { baseTexture: loadedContentAwareUnderlayTexture }
                  : {}),
              uvOverlayHue: directUvLayer ? (directUvLayer.adjustments?.hue ?? 0) / 100 : 0,
              uvOverlaySaturation: directUvLayer
                ? (directUvLayer.adjustments?.saturation ?? 0) / 100
                : 0,
              uvOverlayLightness: directUvLayer
                ? (directUvLayer.adjustments?.lightness ?? 0) / 100
                : 0,
              depthTest: true,
              enableBackfaceCulling: true,
              edgeFeather: 0.004,
              depthBias: 0.025,
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
        canUseProgressivePreviewBase && materialProjectionInputs.length === 0;
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
      let sharedProjectedMaterial: THREE.ShaderMaterial | undefined;
      let sharedProjectedMaterialRequested = false;
      const disposedPreviousMaterials = new Set<THREE.Material | THREE.Material[]>();

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
            ...(loadedUvTexture
              ? {
                  uvOverlayTexture: loadedUvTexture,
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
                    ? isRenderedLocalRepaintLayer(liveTopUvLayer)
                    : false,
                  liveUvOverlayHue: (liveTopUvLayer?.adjustments?.hue ?? 0) / 100,
                  liveUvOverlaySaturation: (liveTopUvLayer?.adjustments?.saturation ?? 0) / 100,
                  liveUvOverlayLightness: (liveTopUvLayer?.adjustments?.lightness ?? 0) / 100,
                }
              : {}),
            previewLighting,
            ...(liveSurfaceMaskTexture ? { surfaceMaskTexture: liveSurfaceMaskTexture } : {}),
            ...(loadedContentAwareUnderlayTexture
              ? { baseTexture: loadedContentAwareUnderlayTexture }
              : {}),
            ...(bakedTexture ? { baseTexture: bakedTexture } : {}),
            ...(progressiveBaseOnly && progressivePreviewBase
              ? {
                  baseTexture: progressivePreviewBase.colorTexture,
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
          child.material = createPbrPreviewMaterial(undefined, selected, bakedTexture);
          disposeGeneratedMaterialTree(previousMaterial);
          continue;
        }
        if (displayMode === 'flat' && !projectedLayerInput) {
          child.material = createFlatPreviewMaterial(undefined, selected, bakedTexture);
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
          const projectedMaterialInput = {
            ...projectedLayerInput,
            ...(loadedUvTexture ? { uvOverlayTexture: loadedUvTexture } : {}),
            ...topUvProjectedOverlayInput,
          };
          try {
            sharedProjectedMaterial = await createProjectedLayerStackMaterial(
              projectedMaterialInput,
              {
                maxTextureImageUnits: gl.capabilities.maxTextures,
                renderer: gl,
                isCancelled: () => cancelled,
                preferTextureArrays: useProjectedTextureArrayMaterial,
              },
            );
          } catch (error) {
            if (!useProjectedTextureArrayMaterial || cancelled) throw error;
            console.warn(
              '[Liclick 3D Texture] Projected texture arrays are unavailable; switching the complete visible stack to a bounded fallback.',
              error,
            );
            useToastStore.getState().dismissToastByDedupeKey(PROJECTED_TEXTURE_ARRAY_TOAST_KEY);
            setFailedProjectedTextureArraySignature(projectedTextureArrayStructureSignature);
            return;
          }
        }
        const projectedMaterial = projectedLayerInput ? sharedProjectedMaterial : undefined;
        if (cancelled) {
          disposeGeneratedMaterialTree(projectedMaterial);
          return;
        }
        child.material =
          projectedMaterial ?? createDisplayModeMaterial(displayMode, selected, bakedTexture);
        if (
          previousMaterial !== child.material &&
          !disposedPreviousMaterials.has(previousMaterial)
        ) {
          disposedPreviousMaterials.add(previousMaterial);
          disposeGeneratedMaterialTree(previousMaterial);
        }
      }
      syncProjectedLayerMaterialProjection(model.group);
      useToastStore.getState().dismissToastByDedupeKey(PROJECTED_PREVIEW_FAILURE_TOAST_KEY);
      if (shouldAnnounceTextureArray && !cancelled) {
        notifyProjectedTextureArrayReady(previewProjectionInputs.length);
      }
      if (lastProjectedTransformRef.current) {
        lastProjectedTransformRef.current.copy(model.group.matrixWorld);
      } else {
        lastProjectedTransformRef.current = model.group.matrixWorld.clone();
      }
      if (
        projectedLayerInput &&
        !projectedPreviewOverBudget &&
        visibleLocalRepaintPreviewLayer &&
        previewStatus.processedLayerIds.includes(visibleLocalRepaintPreviewLayer.id)
      ) {
        const activationKey = [
          visibleLocalRepaintPreviewLayer.id,
          visibleLocalRepaintPreviewLayer.generationId ?? '',
          visibleLocalRepaintPreviewLayer.replacementTargetLayerId ?? '',
          visibleLocalRepaintPreviewLayer.maskUrl ?? '',
        ].join('|');
        if (activatedLocalRepaintPreviewKeyRef.current !== activationKey) {
          activatedLocalRepaintPreviewKeyRef.current = activationKey;
          const sceneState = useSceneStore.getState();
          const currentPreview = sceneState.localRepaintPreviewLayer;
          const currentSource = sceneState.localRepaintProjectionSource;
          if (
            sceneState.paintTool === 'none' &&
            currentPreview?.id === visibleLocalRepaintPreviewLayer.id &&
            currentSource?.generationId === visibleLocalRepaintPreviewLayer.generationId &&
            currentSource?.targetLayerId ===
              visibleLocalRepaintPreviewLayer.replacementTargetLayerId
          ) {
            sceneState.setPaintTool('inpaint-apply');
          }
        }
      }
    }

    void applyMaterials().catch((error) => {
      if (cancelled) return;
      console.error(
        '[Liclick 3D Texture] Projected preview failed; keeping the last valid material.',
        error,
      );
      notifyProjectedPreviewFailure(error);
    });

    return () => {
      cancelled = true;
    };
  }, [
    canPreviewProjectedLayers,
    displayMode,
    directUvLayer,
    gl,
    importedModel,
    loadedBakedTexture,
    loadedContentAwareUnderlayTexture,
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
