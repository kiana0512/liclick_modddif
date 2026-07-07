import { ContactShadows } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import {
  createDisplayModeMaterial,
  createPbrPreviewMaterial,
  createProjectedLayerStackMaterial,
  createUvOverlayPreviewMaterial,
  disposeGeneratedMaterialTree,
  updateProjectedLayerStackMaterial,
} from '@/engine/projection/ProjectedLayerMaterial';
import {
  canUseLayerStackCache,
  findExactLayerStackTexture,
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
    texture.flipY = false;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
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
  const effectivePreset = input.displayMode === 'pbr' && input.environmentPreset === 'color' ? 'studio' : input.environmentPreset;
  const environmentBase = effectivePreset === 'dark' ? 0.38 : effectivePreset === 'soft' ? 0.46 : 0.5;
  const keyBase = effectivePreset === 'dark' ? 1.05 : effectivePreset === 'soft' ? 1.12 : 1.22;
  const environmentScale = input.displayMode === 'pbr' ? input.pbrEnvironmentIntensity / 0.42 : 1;
  const azimuth = THREE.MathUtils.degToRad(input.pbrLightAzimuth);
  const direction = new THREE.Vector3(Math.sin(azimuth) * 4.5, 5.2, Math.cos(azimuth) * 4.5).normalize();
  return {
    enabled: input.displayMode === 'pbr',
    ambientIntensity: environmentBase * input.exposure * environmentScale,
    keyLightIntensity: keyBase * input.exposure * (input.displayMode === 'pbr' ? input.pbrKeyLightIntensity : 1),
    keyLightDirection: direction.toArray() as [number, number, number],
  };
}

function hasUsableTextureImage(texture: THREE.Texture) {
  const image = texture.image as
    | { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number; data?: unknown }
    | undefined;
  if (!image) return false;
  if (image.data) return true;
  const width = image.naturalWidth ?? image.width ?? 0;
  const height = image.naturalHeight ?? image.height ?? 0;
  return width > 0 && height > 0;
}

function getPreviewMaterialBase(material: THREE.Material | THREE.Material[] | undefined) {
  const sourceMaterial = Array.isArray(material)
    ? material.find(
        (item) => 'map' in item && item.map instanceof THREE.Texture && hasUsableTextureImage(item.map),
      ) ?? material[0]
    : material;
  if (!sourceMaterial) return {};

  const baseTexture =
    'map' in sourceMaterial && sourceMaterial.map instanceof THREE.Texture && hasUsableTextureImage(sourceMaterial.map)
      ? sourceMaterial.map
      : undefined;
  const baseColor =
    'color' in sourceMaterial && sourceMaterial.color instanceof THREE.Color
      ? sourceMaterial.color.clone()
      : undefined;

  return { baseTexture, baseColor };
}

function useLoadedBakedTexture(imageUrl?: string) {
  const [loadedBakedTexture, setLoadedBakedTexture] = useState<THREE.Texture>();

  useEffect(() => {
    if (!imageUrl) {
      setLoadedBakedTexture(undefined);
      return undefined;
    }
    let cancelled = false;
    setLoadedBakedTexture(undefined);
    loadPreviewTexture(imageUrl)
      .then((texture) => {
        if (cancelled) return;
        setLoadedBakedTexture(texture);
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn('[Liclick 3D Texture] Could not load baked texture for PBR preview:', error);
        setLoadedBakedTexture(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [imageUrl]);

  return loadedBakedTexture;
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
  const layerKey = useMemo(
    () =>
      layers
        .map((layer) => `${layer.id}:${layer.imageUrl}:${layer.opacity}:${layer.blendMode}:${layer.order}`)
        .join('|'),
    [layers],
  );

  useEffect(() => {
    const uvLayers = layers.filter((layer) => layer.visible && layer.imageUrl);
    if (uvLayers.length === 0) {
      setTexture(undefined);
      return undefined;
    }

    let cancelled = false;
    let nextTexture: THREE.Texture | undefined;
    setTexture(undefined);

    void Promise.all(uvLayers.map((layer) => loadImageElement(layer.imageUrl)))
      .then((images) => {
        if (cancelled) return;
        const width = Math.max(1, ...images.map((image) => image.naturalWidth || image.width || 1));
        const height = Math.max(1, ...images.map((image) => image.naturalHeight || image.height || 1));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Could not create UV layer composite canvas.');
        context.clearRect(0, 0, width, height);

        uvLayers
          .map((layer, index) => ({ layer, image: images[index] }))
          .sort((a, b) => b.layer.order - a.layer.order)
          .forEach(({ layer, image }) => {
            context.save();
            context.globalAlpha = Math.max(0, Math.min(1, layer.opacity));
            context.globalCompositeOperation = 'source-over';
            context.drawImage(image, 0, 0, width, height);
            context.restore();
          });

        nextTexture = new THREE.CanvasTexture(canvas);
        nextTexture.colorSpace = THREE.SRGBColorSpace;
        nextTexture.flipY = false;
        nextTexture.wrapS = THREE.ClampToEdgeWrapping;
        nextTexture.wrapT = THREE.ClampToEdgeWrapping;
        nextTexture.minFilter = THREE.LinearMipmapLinearFilter;
        nextTexture.magFilter = THREE.LinearFilter;
        nextTexture.generateMipmaps = true;
        nextTexture.anisotropy = 8;
        nextTexture.needsUpdate = true;
        setTexture(nextTexture);
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn('[Liclick 3D Texture] Could not composite UV layer stack:', error);
        setTexture(undefined);
      });

    return () => {
      cancelled = true;
      nextTexture?.dispose();
    };
  }, [layerKey, layers]);

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
    (state) => state.objects.find((object) => object.id === importedModel.objectId)?.visible ?? true,
  );
  const selectObject = useSceneStore((state) => state.selectObject);
  const environmentPreset = useSettingsStore((state) => state.environmentPreset);
  const exposure = useSettingsStore((state) => state.exposure);
  const pbrEnvironmentIntensity = useSettingsStore((state) => state.pbrEnvironmentIntensity);
  const pbrKeyLightIntensity = useSettingsStore((state) => state.pbrKeyLightIntensity);
  const pbrLightAzimuth = useSettingsStore((state) => state.pbrLightAzimuth);
  const resolution = useSettingsStore((state) => state.resolution);
  const layers = useLayerStore((state) => state.layers);
  const project = useProjectStore((state) =>
    state.currentProjectId ? state.projects.find((item) => item.id === state.currentProjectId) : undefined,
  );
  const importedObjectId = importedModel?.objectId;
  const visibleProjectedLayers = useMemo(
    () => (importedObjectId ? getVisibleProjectedLayerStack(layers, importedObjectId) : []),
    [importedObjectId, layers],
  );
  const previewProjectedLayers = useMemo(
    () =>
      layers
        .filter(
          (layer) =>
            layer.type === 'projected' &&
            layer.imageUrl &&
            layer.camera &&
            (!layer.objectId || layer.objectId === importedObjectId),
        )
        .sort((a, b) => a.order - b.order),
    [importedObjectId, layers],
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
  const livePreviewLayerLimit = useMemo(() => {
    return Math.max(1, previewProjectedLayers.length);
  }, [previewProjectedLayers]);
  const livePreviewProjectedLayers = useMemo(
    () => previewProjectedLayers.slice(0, livePreviewLayerLimit),
    [livePreviewLayerLimit, previewProjectedLayers],
  );
  const exactBakedTextureRecord = useMemo(() => {
    const expectedResolution = RESOLUTION_TO_SIZE[resolution];
    const cacheKey = getProjectedLayerStackSignature(project?.id, importedObjectId, expectedResolution, visibleProjectedLayers);
    const texture = findExactLayerStackTexture(project, visibleProjectedLayers, expectedResolution, importedObjectId, cacheKey);
    return canUseLayerStackCache(visibleProjectedLayers, texture, expectedResolution, importedObjectId, cacheKey)
      ? texture
      : undefined;
  }, [importedObjectId, project, resolution, visibleProjectedLayers]);
  const loadedBakedTexture = useLoadedBakedTexture(exactBakedTextureRecord?.imageUrl);
  const loadedUvTexture = useCompositedUvTexture(visibleUvLayers);
  const visibleStackIsBaked = Boolean(exactBakedTextureRecord);
  const canPreviewProjectedLayers =
    visibleProjectedLayers.length > 0 && livePreviewProjectedLayers.length > 0 && (displayMode === 'flat' || displayMode === 'pbr');
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
    [displayMode, environmentPreset, exposure, pbrEnvironmentIntensity, pbrKeyLightIntensity, pbrLightAzimuth],
  );

  useEffect(() => {
    if (!importedModel) return;
    let cancelled = false;
    const model = importedModel;

    async function applyMaterials() {
      const selected = false;
      model.group.updateMatrixWorld(true);
      const projectedLayerInput = canPreviewProjectedLayers
        ? {
            layers: livePreviewProjectedLayers.map((layer) => {
              return {
                layerId: layer.id,
                imageUrl: layer.imageUrl,
                maskUrl: layer.maskUrl,
                depthUrl: layer.depthUrl,
                camera: layer.camera!,
                objectMatrixWorld: layer.objectMatrixWorld,
                opacity: layer.opacity,
                strength: layer.strength ?? 1,
                blendMode: layer.blendMode,
                visible: layer.visible,
                hue: (layer.adjustments?.hue ?? 0) / 100,
                saturation: (layer.adjustments?.saturation ?? 0) / 100,
                lightness: (layer.adjustments?.lightness ?? 0) / 100,
                useMask: Boolean(layer.maskUrl),
                useDepthCheck: Boolean(layer.depthUrl),
              };
            }),
            objectId: model.objectId,
            currentObjectMatrixWorld: model.group.matrixWorld.toArray(),
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
        const originalMaterial = (child.userData.sourceMaterial ?? child.userData.originalMaterial) as
          | THREE.Material
          | THREE.Material[]
          | undefined;
        const existingBakedTexture = child.userData.bakedTexture instanceof THREE.Texture ? child.userData.bakedTexture : undefined;
        const bakedTexture = !projectedLayerInput && visibleStackIsBaked ? loadedBakedTexture ?? existingBakedTexture : undefined;
        if (bakedTexture) child.userData.bakedTexture = bakedTexture;
        const previousMaterial = child.material;
        const previewBase = getPreviewMaterialBase(originalMaterial);
        if (loadedUvTexture && !projectedLayerInput) {
          child.material = createUvOverlayPreviewMaterial({
            displayMode,
            selected,
            uvOverlayTexture: loadedUvTexture,
            previewLighting,
            ...previewBase,
            ...(bakedTexture ? { baseTexture: bakedTexture } : {}),
          });
          disposeGeneratedMaterialTree(previousMaterial);
          continue;
        }
        if (bakedTexture && !projectedLayerInput && (displayMode === 'flat' || displayMode === 'pbr')) {
          child.material = createUvOverlayPreviewMaterial({
            displayMode,
            selected,
            ...previewBase,
            baseTexture: bakedTexture,
            previewLighting,
          });
          disposeGeneratedMaterialTree(previousMaterial);
          continue;
        }
        if (displayMode === 'pbr' && !projectedLayerInput) {
          child.material = createPbrPreviewMaterial(originalMaterial, selected, bakedTexture);
          disposeGeneratedMaterialTree(previousMaterial);
          continue;
        }
        if (
          projectedLayerInput &&
          updateProjectedLayerStackMaterial(previousMaterial, {
            ...projectedLayerInput,
            ...previewBase,
            ...(loadedUvTexture ? { uvOverlayTexture: loadedUvTexture } : {}),
          })
        ) {
          continue;
        }
        const projectedMaterial = projectedLayerInput
          ? await createProjectedLayerStackMaterial({
              ...projectedLayerInput,
              ...previewBase,
              ...(loadedUvTexture ? { uvOverlayTexture: loadedUvTexture } : {}),
            })
          : undefined;
        if (cancelled) {
          disposeGeneratedMaterialTree(projectedMaterial);
          return;
        }
        child.material = projectedMaterial ?? createDisplayModeMaterial(displayMode, selected, bakedTexture);
        if (previousMaterial !== child.material) disposeGeneratedMaterialTree(previousMaterial);
      }
    }

    void applyMaterials();

    return () => {
      cancelled = true;
    };
  }, [
    canPreviewProjectedLayers,
    displayMode,
    importedModel,
    livePreviewProjectedLayers,
    loadedBakedTexture,
    loadedUvTexture,
    previewLighting,
    visibleStackIsBaked,
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
  const keyLightPosition: [number, number, number] = previewLighting.keyLightDirection.map((value) => value * 5.6) as [
    number,
    number,
    number,
  ];
  const fillLightPosition: [number, number, number] = [-keyLightPosition[0] * 0.72, 2.2, -keyLightPosition[2] * 0.72];
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
        <ImportedModel key={model.objectId} importedModel={model} showSelectionGlow={showSelectionGlow} />
      ))}
      <ObjectTransformControls />
      <ContactShadows position={[0, -0.02, 0]} opacity={0.22} scale={8} blur={2.4} />
    </group>
  );
}
