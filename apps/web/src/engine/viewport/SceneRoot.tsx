import { ContactShadows } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import {
  createDisplayModeMaterial,
  createFlatPreviewMaterial,
  createPbrPreviewMaterial,
  createProjectedLayerStackMaterial,
  createUvOverlayPreviewMaterial,
  disposeGeneratedMaterialTree,
  syncProjectedLayerMaterialProjection,
  updateProjectedLayerStackMaterial,
  updateUvOverlayPreviewMaterial,
} from '@/engine/projection/ProjectedLayerMaterial';
import {
  getLiveProjectedCanvasState,
  getLiveProjectedCanvasTexture,
} from '@/engine/projection/liveProjectedCanvasTextureRegistry';
import {
  canUseLayerStackCache,
  findExactLayerStackTexture,
  findLatestLayerStackPreviewTexture,
  getProjectedLayerStackSignature,
  getVisibleProjectedLayerStack,
} from '@/engine/bake/layerStackCache';
import { useLayerStore } from '@/stores/layerStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSceneStore } from '@/stores/sceneStore';
import { useSettingsStore } from '@/stores/settingsStore';
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
    layer.imageUrl.includes('surface-edit:local-repaint'),
  );
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
            .sort((a, b) => b.layer.order - a.layer.order)
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

function SelectionEdgeGlow({ object }: { object: THREE.Object3D }) {
  const glowGroupRef = useRef<THREE.Group>();
  const shellMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: '#ff62d2',
        transparent: true,
        opacity: 0.62,
        side: THREE.BackSide,
        depthTest: true,
        depthWrite: false,
        toneMapped: false,
      }),
    [],
  );
  const edgeMaterial = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        color: '#ff62d2',
        transparent: true,
        opacity: 1,
        depthTest: true,
        depthWrite: false,
        toneMapped: false,
      }),
    [],
  );

  useEffect(
    () => () => {
      shellMaterial.dispose();
      edgeMaterial.dispose();
    },
    [edgeMaterial, shellMaterial],
  );

  useEffect(() => {
    const glowGroup = new THREE.Group();
    glowGroup.name = 'Liclick Selection Edge Glow';
    glowGroup.userData.liclickSelectionGlow = true;
    glowGroup.renderOrder = 80;
    const edgeGeometries: THREE.EdgesGeometry[] = [];
    object.updateMatrixWorld(true);
    const inverseRoot = object.matrixWorld.clone().invert();
    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      if (child.userData.liclickPaintOverlay || child.userData.liclickSelectionGlow) return;
      const localMatrix = inverseRoot.clone().multiply(child.matrixWorld);
      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      localMatrix.decompose(position, quaternion, scale);

      const glowMesh = new THREE.Mesh(child.geometry, shellMaterial);
      glowMesh.position.copy(position);
      glowMesh.quaternion.copy(quaternion);
      glowMesh.scale.copy(scale.clone().multiplyScalar(1.052));
      glowMesh.renderOrder = 80;
      glowMesh.userData.liclickSelectionGlow = true;
      glowGroup.add(glowMesh);

      const edgeGeometry = new THREE.EdgesGeometry(child.geometry, 32);
      edgeGeometries.push(edgeGeometry);
      const edgeLines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
      edgeLines.position.copy(position);
      edgeLines.quaternion.copy(quaternion);
      edgeLines.scale.copy(scale.clone().multiplyScalar(1.012));
      edgeLines.renderOrder = 82;
      edgeLines.userData.liclickSelectionGlow = true;
      glowGroup.add(edgeLines);
    });
    object.add(glowGroup);
    glowGroupRef.current = glowGroup;
    return () => {
      glowGroup.removeFromParent();
      edgeGeometries.forEach((geometry) => geometry.dispose());
      glowGroupRef.current = undefined;
    };
  }, [edgeMaterial, object, shellMaterial]);

  useFrame(({ clock }) => {
    const pulse = Math.sin(clock.elapsedTime * 4.8);
    shellMaterial.opacity = 0.5 + pulse * 0.12;
    edgeMaterial.opacity = 0.9 + pulse * 0.1;
    glowGroupRef.current?.updateMatrixWorld(true);
  });
  return null;
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
      ) return;

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
}: {
  importedModel: ModelLoadResult;
  showSelectionGlow: boolean;
}) {
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
  const layers = useLayerStore((state) => state.layers);
  const localRepaintPreviewLayer = useSceneStore((state) => state.localRepaintPreviewLayer);
  const activeLayerId = useLayerStore((state) => state.activeProjectedLayerId);
  const project = useProjectStore((state) =>
    state.currentProjectId
      ? state.projects.find((item) => item.id === state.currentProjectId)
      : undefined,
  );
  const importedObjectId = importedModel?.objectId;
  const visibleProjectedLayers = useMemo(
    () => {
      const storedLayers = importedObjectId
        ? getVisibleProjectedLayerStack(layers, importedObjectId)
        : [];
      if (
        !localRepaintPreviewLayer?.visible ||
        !localRepaintPreviewLayer.imageUrl ||
        !localRepaintPreviewLayer.camera ||
        (localRepaintPreviewLayer.objectId &&
          localRepaintPreviewLayer.objectId !== importedObjectId)
      )
        return storedLayers;
      return [
        localRepaintPreviewLayer,
        ...storedLayers.filter((layer) => layer.id !== localRepaintPreviewLayer.id),
      ];
    },
    [importedObjectId, layers, localRepaintPreviewLayer],
  );
  const visibleProjectedLayerSignature = useMemo(
    () => layerStackPreviewSignature(visibleProjectedLayers),
    [visibleProjectedLayers],
  );
  const stableVisibleProjectedLayers = useStableValueBySignature(
    visibleProjectedLayers,
    visibleProjectedLayerSignature,
  );
  const lastProjectedTransformRef = useRef<THREE.Matrix4>();
  const previewProjectedLayers = useMemo(
    () => {
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
        .sort((a, b) => b.order - a.order);
      if (
        !localRepaintPreviewLayer?.visible ||
        !localRepaintPreviewLayer.imageUrl ||
        !localRepaintPreviewLayer.camera ||
        (localRepaintPreviewLayer.objectId &&
          localRepaintPreviewLayer.objectId !== importedObjectId)
      )
        return storedLayers;
      return [
        ...storedLayers.filter((layer) => layer.id !== localRepaintPreviewLayer.id),
        localRepaintPreviewLayer,
      ];
    },
    [importedObjectId, layers, localRepaintPreviewLayer],
  );
  const previewProjectedLayerSignature = useMemo(
    () => layerStackPreviewSignature(previewProjectedLayers),
    [previewProjectedLayers],
  );
  const stablePreviewProjectedLayers = useStableValueBySignature(
    previewProjectedLayers,
    previewProjectedLayerSignature,
  );
  const visibleUvLayers = useMemo(
    () =>
      layers
        .filter(
          (layer) =>
            layer.type === 'uv' &&
            layer.visible &&
            layer.imageUrl &&
            (!layer.objectId || layer.objectId === importedObjectId),
        )
        .sort((a, b) => a.order - b.order),
    [importedObjectId, layers],
  );
  const visibleUvLayerSignature = useMemo(
    () => layerStackPreviewSignature(visibleUvLayers),
    [visibleUvLayers],
  );
  const stableVisibleUvLayers = useStableValueBySignature(visibleUvLayers, visibleUvLayerSignature);
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
  const previewBakedTextureRecord = useMemo(
    () =>
      exactBakedTextureRecord ??
      findLatestLayerStackPreviewTexture(
        project,
        stableVisibleProjectedLayers,
        undefined,
        importedObjectId,
      ),
    [exactBakedTextureRecord, importedObjectId, project, stableVisibleProjectedLayers],
  );
  const loadedBakedTexture = useLoadedPreviewTexture(previewBakedTextureRecord?.imageUrl);
  const liveTopUvLayer = useMemo(() => {
    const topLayer = stableVisibleUvLayers[0];
    if (
      !topLayer ||
      (!getLiveProjectedCanvasState(topLayer.imageUrl) &&
        !isRenderedLocalRepaintLayer(topLayer))
    )
      return undefined;
    // The live projected stroke is the newest visual edit and must stay above
    // the already-committed UV patch until this stroke is baked into that patch.
    if (
      localRepaintPreviewLayer?.visible &&
      stableVisibleProjectedLayers.some((layer) => layer.id === localRepaintPreviewLayer.id)
    )
      return undefined;
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
    if (topLayer.order >= topProjectedOrder) return undefined;
    return topLayer;
  }, [localRepaintPreviewLayer, stableVisibleProjectedLayers, stableVisibleUvLayers]);
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
    hasLocalRepaintPreview ||
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
      const selected = false;
      model.group.updateMatrixWorld(true);
      const projectedLayerInput = canPreviewProjectedLayers
        ? {
            layers: stablePreviewProjectedLayers.map((layer) => {
              return {
                layerId: layer.id,
                imageUrl: layer.imageUrl,
                maskUrl: layer.maskUrl,
                maskSpace: layer.maskSpace,
                depthUrl: layer.depthUrl,
                camera: layer.camera!,
                objectMatrixWorld: layer.objectMatrixWorld,
                opacity: layer.opacity,
                strength: layer.strength ?? 1,
                // A local repaint is a patch over the already visible projection,
                // not another competing base projection. Treat legacy saved layers
                // the same way so their boundary cannot reveal the dark empty base.
                blendMode: isRenderedLocalRepaintLayer(layer) ? 'overlay' : layer.blendMode,
                visible: layer.visible,
                hue: (layer.adjustments?.hue ?? 0) / 100,
                saturation: (layer.adjustments?.saturation ?? 0) / 100,
                lightness: (layer.adjustments?.lightness ?? 0) / 100,
                useMask: Boolean(layer.maskUrl),
                useDepthCheck: Boolean(layer.depthUrl),
                renderedColor: isRenderedLocalRepaintLayer(layer),
              };
            }),
            objectId: model.objectId,
            currentObjectMatrixWorld: model.group.matrixWorld.toArray(),
            uvOverlayHue: directUvLayer ? (directUvLayer.adjustments?.hue ?? 0) / 100 : 0,
            uvOverlaySaturation: directUvLayer ? (directUvLayer.adjustments?.saturation ?? 0) / 100 : 0,
            uvOverlayLightness: directUvLayer ? (directUvLayer.adjustments?.lightness ?? 0) / 100 : 0,
            depthTest: true,
            enableBackfaceCulling: true,
            edgeFeather: 0.004,
            depthBias: 0.025,
            previewLighting,
          }
        : undefined;

      const meshes: THREE.Mesh[] = [];
      model.group.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        if (child.userData.liclickPaintOverlay) return;
        meshes.push(child);
      });

      for (const child of meshes) {
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
        if ((loadedUvTexture || liveTopUvTexture) && !projectedLayerInput) {
          const uvMaterialInput = {
            displayMode,
            selected,
            ...(loadedUvTexture
              ? {
                  uvOverlayTexture: loadedUvTexture,
                  uvOverlayHue: directUvLayer ? (directUvLayer.adjustments?.hue ?? 0) / 100 : 0,
                  uvOverlaySaturation: directUvLayer ? (directUvLayer.adjustments?.saturation ?? 0) / 100 : 0,
                  uvOverlayLightness: directUvLayer ? (directUvLayer.adjustments?.lightness ?? 0) / 100 : 0,
                }
              : {}),
            ...(liveTopUvTexture
              ? {
                  liveUvOverlayTexture: liveTopUvTexture,
                  liveUvOverlayOpacity: liveTopUvLayer?.opacity ?? 1,
                  liveUvOverlayRenderedColor: liveTopUvLayer
                    ? isRenderedLocalRepaintLayer(liveTopUvLayer)
                    : false,
                }
              : {}),
            previewLighting,
            ...(liveSurfaceMaskTexture ? { surfaceMaskTexture: liveSurfaceMaskTexture } : {}),
            ...(bakedTexture ? { baseTexture: bakedTexture } : {}),
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
        const projectedMaterial = projectedLayerInput
          ? await createProjectedLayerStackMaterial({
              ...projectedLayerInput,
              ...(loadedUvTexture ? { uvOverlayTexture: loadedUvTexture } : {}),
              ...topUvProjectedOverlayInput,
            })
          : undefined;
        if (cancelled) {
          disposeGeneratedMaterialTree(projectedMaterial);
          return;
        }
        child.material =
          projectedMaterial ?? createDisplayModeMaterial(displayMode, selected, bakedTexture);
        if (previousMaterial !== child.material) disposeGeneratedMaterialTree(previousMaterial);
      }
      syncProjectedLayerMaterialProjection(model.group);
      if (lastProjectedTransformRef.current) {
        lastProjectedTransformRef.current.copy(model.group.matrixWorld);
      } else {
        lastProjectedTransformRef.current = model.group.matrixWorld.clone();
      }
    }

    void applyMaterials();

    return () => {
      cancelled = true;
    };
  }, [
    canPreviewProjectedLayers,
    displayMode,
    directUvLayer,
    importedModel,
    loadedBakedTexture,
    loadedUvTexture,
    liveTopUvLayer,
    liveTopUvTexture,
    liveSurfaceMaskTexture,
    previewLighting,
    stablePreviewProjectedLayers,
    topUvProjectedOverlayInput,
    visibleStackHasBakedPreview,
  ]);

  if (!importedModel) return null;

  if (!objectVisible) return null;

  return (
    <>
      <primitive
        object={importedModel.group}
        onClick={(event: { stopPropagation: () => void }) => {
          event.stopPropagation();
          selectObject(importedModel.objectId);
        }}
      />
      {displayMode === 'wire' && <TopologyWireframeOverlay object={importedModel.group} />}
      {showSelectionGlow && selectedObjectId === importedModel.objectId && (
        <SelectionEdgeGlow object={importedModel.group} />
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
  const renderedModels =
    workspaceMode === 'scene' || workspaceMode === 'export'
      ? importedModels
      : importedModels.filter((model) => model.objectId === activeObjectId);
  const showSelectionGlow = workspaceMode === 'scene' || workspaceMode === 'export';

  return (
    <group onPointerMissed={() => selectObject(undefined)}>
      <ambientLight intensity={ambientIntensity} />
      <hemisphereLight args={['#fff0e8', '#302640', 0.82]} />
      <directionalLight position={keyLightPosition} intensity={keyIntensity} castShadow />
      <directionalLight position={fillLightPosition} intensity={fillIntensity} />
      <Grid />
      {renderedModels.map((model) => (
        <ImportedModel
          key={model.objectId}
          importedModel={model}
          showSelectionGlow={showSelectionGlow}
        />
      ))}
      <ObjectTransformControls />
      <ContactShadows position={[0, -0.02, 0]} opacity={0.22} scale={8} blur={2.4} />
    </group>
  );
}
