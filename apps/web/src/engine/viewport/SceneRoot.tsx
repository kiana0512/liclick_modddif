import { ContactShadows } from '@react-three/drei';
import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import {
  createDisplayModeMaterial,
  createPbrPreviewMaterial,
  createProjectedLayerStackMaterial,
  createUvOverlayPreviewMaterial,
  disposeGeneratedMaterialTree,
} from '@/engine/projection/ProjectedLayerMaterial';
import {
  canUseLayerStackCache,
  findExactLayerStackTexture,
  getVisibleProjectedLayerStack,
} from '@/engine/bake/layerStackCache';
import { useLayerStore } from '@/stores/layerStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSceneStore } from '@/stores/sceneStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { Grid } from './Grid';
import { ObjectTransformControls } from './ObjectTransformControls';
import { SelectionOutline } from './SelectionOutline';
import type { ModelLoadResult } from '@/engine/loaders/modelImportTypes';
import type { ProjectionPreviewLighting } from '@/engine/projection/projectionTypes';
import type { Layer } from '@/types/layer';

const MAX_LIVE_PROJECTED_PREVIEW_LAYERS = 16;
const RESERVED_PROJECTED_TEXTURE_UNITS = 2;
const RESOLUTION_TO_SIZE = {
  '1K': 1024,
  '2K': 2048,
  '4K': 4096,
  '8K': 8192,
} as const;

function projectedLayerTextureUnitCost(layer: Layer) {
  const usesSourceAlpha = typeof layer.generationId === 'string' && layer.generationId.startsWith('texture-map');
  return 1 + (layer.maskUrl && !usesSourceAlpha ? 1 : 0) + (layer.depthUrl && !usesSourceAlpha ? 1 : 0);
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
    let loadedTexture: THREE.Texture | undefined;
    setLoadedBakedTexture(undefined);
    const textureLoader = new THREE.TextureLoader();
    textureLoader
      .loadAsync(imageUrl)
      .then((texture) => {
        if (cancelled) {
          texture.dispose();
          return;
        }
        loadedTexture = texture;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.flipY = false;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = true;
        texture.anisotropy = 8;
        texture.needsUpdate = true;
        setLoadedBakedTexture(texture);
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn('[Liclick 3D Texture] Could not load baked texture for PBR preview:', error);
        setLoadedBakedTexture(undefined);
      });
    return () => {
      cancelled = true;
      loadedTexture?.dispose();
    };
  }, [imageUrl]);

  return loadedBakedTexture;
}

function loadImageElement(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load UV layer image: ${url.slice(0, 80)}`));
    image.src = url;
  });
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

function DemoModel() {
  const displayMode = useSceneStore((state) => state.displayMode);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const selectObject = useSceneStore((state) => state.selectObject);
  const selected = selectedObjectId === 'object-demo-capsule';

  const material = useMemo(() => createDisplayModeMaterial(displayMode, selected), [displayMode, selected]);

  return (
    <group
      userData={{ liclickObjectId: 'object-demo-capsule' }}
      onClick={(event) => {
        event.stopPropagation();
        selectObject('object-demo-capsule');
      }}
    >
      <mesh position={[0, 0.72, 0]} material={material} castShadow receiveShadow>
        <capsuleGeometry args={[0.65, 1.15, 24, 48]} />
      </mesh>
      <mesh position={[0, -0.1, 0]} scale={[1.55, 0.18, 1.55]} material={material} castShadow>
        <cylinderGeometry args={[0.55, 0.75, 1, 48]} />
      </mesh>
      {selected && <SelectionOutline />}
    </group>
  );
}

function ImportedModel({ importedModel }: { importedModel: ModelLoadResult }) {
  const displayMode = useSceneStore((state) => state.displayMode);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const selectObject = useSceneStore((state) => state.selectObject);
  const environmentPreset = useSettingsStore((state) => state.environmentPreset);
  const exposure = useSettingsStore((state) => state.exposure);
  const pbrEnvironmentIntensity = useSettingsStore((state) => state.pbrEnvironmentIntensity);
  const pbrKeyLightIntensity = useSettingsStore((state) => state.pbrKeyLightIntensity);
  const pbrLightAzimuth = useSettingsStore((state) => state.pbrLightAzimuth);
  const resolution = useSettingsStore((state) => state.resolution);
  const viewport = useSceneStore((state) => state.viewport);
  const layers = useLayerStore((state) => state.layers);
  const project = useProjectStore((state) =>
    state.currentProjectId ? state.projects.find((item) => item.id === state.currentProjectId) : undefined,
  );
  const importedObjectId = importedModel?.objectId;
  const visibleProjectedLayers = useMemo(
    () => (importedObjectId ? getVisibleProjectedLayerStack(layers, importedObjectId) : []),
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
    const maxTextures = viewport?.gl.capabilities.maxTextures ?? 16;
    let usedTextureUnits = RESERVED_PROJECTED_TEXTURE_UNITS;
    let count = 0;
    for (const layer of visibleProjectedLayers) {
      const nextUsedTextureUnits = usedTextureUnits + projectedLayerTextureUnitCost(layer);
      if (count > 0 && nextUsedTextureUnits > maxTextures) break;
      usedTextureUnits = nextUsedTextureUnits;
      count += 1;
      if (count >= MAX_LIVE_PROJECTED_PREVIEW_LAYERS) break;
    }
    return Math.max(1, count);
  }, [viewport, visibleProjectedLayers]);
  const livePreviewProjectedLayers = useMemo(
    () => visibleProjectedLayers.slice(0, livePreviewLayerLimit),
    [livePreviewLayerLimit, visibleProjectedLayers],
  );
  const exactBakedTextureRecord = useMemo(() => {
    const texture = findExactLayerStackTexture(project, visibleProjectedLayers, RESOLUTION_TO_SIZE[resolution]);
    return canUseLayerStackCache(visibleProjectedLayers, texture, RESOLUTION_TO_SIZE[resolution]) ? texture : undefined;
  }, [project, resolution, visibleProjectedLayers]);
  const loadedBakedTexture = useLoadedBakedTexture(exactBakedTextureRecord?.imageUrl);
  const loadedUvTexture = useCompositedUvTexture(visibleUvLayers);
  const visibleStackIsBaked = Boolean(exactBakedTextureRecord);
  const bakedTextureIsReady = Boolean(loadedBakedTexture);
  const canPreviewProjectedLayers =
    !bakedTextureIsReady && livePreviewProjectedLayers.length > 0 && (displayMode === 'flat' || displayMode === 'pbr');
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
      const selected = selectedObjectId === model.objectId;
      model.group.updateMatrixWorld(true);
      const projectedLayerInput = canPreviewProjectedLayers
        ? {
            layers: livePreviewProjectedLayers.map((layer) => {
              const usesSourceAlpha =
                typeof layer.generationId === 'string' && layer.generationId.startsWith('texture-map');
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
                useMask: !usesSourceAlpha,
                useDepthCheck: !usesSourceAlpha,
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
        const bakedTexture = visibleStackIsBaked ? loadedBakedTexture ?? existingBakedTexture : undefined;
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
    selectedObjectId,
    previewLighting,
    visibleStackIsBaked,
  ]);

  if (!importedModel) return null;

  return (
    <primitive
      object={importedModel.group}
      onClick={(event: { stopPropagation: () => void }) => {
        event.stopPropagation();
        selectObject(importedModel.objectId);
      }}
    />
  );
}

export function SceneRoot() {
  const importedModels = useSceneStore((state) => state.importedModels);
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
  const keyLightPosition: [number, number, number] = previewLighting.keyLightDirection.map((value) => value * 5.6) as [
    number,
    number,
    number,
  ];
  const fillLightPosition: [number, number, number] = [-keyLightPosition[0] * 0.72, 2.2, -keyLightPosition[2] * 0.72];
  const ambientIntensity = previewLighting.ambientIntensity;
  const keyIntensity = previewLighting.keyLightIntensity;
  const fillIntensity = previewLighting.ambientIntensity * 0.52;
  return (
    <group onPointerMissed={() => selectObject(undefined)}>
      <ambientLight intensity={ambientIntensity} />
      <hemisphereLight args={['#fff0e8', '#302640', 0.82]} />
      <directionalLight position={keyLightPosition} intensity={keyIntensity} castShadow />
      <directionalLight position={fillLightPosition} intensity={fillIntensity} />
      <Grid />
      {importedModels.length > 0 ? (
        importedModels.map((model) => <ImportedModel key={model.objectId} importedModel={model} />)
      ) : (
        <DemoModel />
      )}
      <ObjectTransformControls />
      <ContactShadows position={[0, -0.02, 0]} opacity={0.22} scale={8} blur={2.4} />
    </group>
  );
}
