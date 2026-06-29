import { ContactShadows } from '@react-three/drei';
import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import {
  createDisplayModeMaterial,
  createPbrPreviewMaterial,
  createProjectedLayerStackMaterial,
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

const MAX_LIVE_PROJECTED_PREVIEW_LAYERS = 16;

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
  const layers = useLayerStore((state) => state.layers);
  const project = useProjectStore((state) =>
    state.currentProjectId ? state.projects.find((item) => item.id === state.currentProjectId) : undefined,
  );
  const importedObjectId = importedModel?.objectId;
  const visibleProjectedLayers = useMemo(
    () => (importedObjectId ? getVisibleProjectedLayerStack(layers, importedObjectId) : []),
    [importedObjectId, layers],
  );
  const visibleUvLayer = useMemo(
    () =>
      layers
        .filter(
          (layer) =>
            layer.type === 'uv' &&
            layer.visible &&
            layer.imageUrl &&
            (!layer.objectId || layer.objectId === importedObjectId),
        )
        .sort((a, b) => a.order - b.order)[0],
    [importedObjectId, layers],
  );
  const livePreviewProjectedLayers = useMemo(
    () => visibleProjectedLayers.slice(0, MAX_LIVE_PROJECTED_PREVIEW_LAYERS),
    [visibleProjectedLayers],
  );
  const exactBakedTextureRecord = useMemo(() => {
    const texture = findExactLayerStackTexture(project, visibleProjectedLayers);
    return canUseLayerStackCache(visibleProjectedLayers, texture) ? texture : undefined;
  }, [project, visibleProjectedLayers]);
  const loadedBakedTexture = useLoadedBakedTexture(exactBakedTextureRecord?.imageUrl);
  const loadedUvTexture = useLoadedBakedTexture(visibleUvLayer?.imageUrl);
  const visibleStackIsBaked = Boolean(exactBakedTextureRecord);
  const bakedTextureIsReady = Boolean(loadedBakedTexture);
  const canPreviewProjectedLayers =
    !bakedTextureIsReady && livePreviewProjectedLayers.length > 0 && (displayMode === 'flat' || displayMode === 'pbr');

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
        const bakedTexture = visibleStackIsBaked ? loadedBakedTexture ?? existingBakedTexture : loadedUvTexture;
        if (bakedTexture) child.userData.bakedTexture = bakedTexture;
        const previousMaterial = child.material;
        if (displayMode === 'pbr' && !projectedLayerInput) {
          child.material = createPbrPreviewMaterial(originalMaterial, selected, bakedTexture);
          disposeGeneratedMaterialTree(previousMaterial);
          continue;
        }
        const projectedMaterial = projectedLayerInput
          ? await createProjectedLayerStackMaterial({
              ...projectedLayerInput,
              ...getPreviewMaterialBase(originalMaterial),
              ...(loadedUvTexture ? { baseTexture: loadedUvTexture } : {}),
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
  const effectiveEnvironmentPreset =
    displayMode === 'pbr' && environmentPreset === 'color' ? 'studio' : environmentPreset;

  const displayLightBoost = displayMode === 'flat' ? 1.35 : 1;
  const pbrLightScale = (displayMode === 'pbr' ? pbrEnvironmentIntensity / 0.3 : 1) * exposure * displayLightBoost;
  const ambientIntensity =
    (effectiveEnvironmentPreset === 'dark' ? 0.38 : effectiveEnvironmentPreset === 'soft' ? 0.46 : 0.5) *
    pbrLightScale;
  const keyIntensity =
    (effectiveEnvironmentPreset === 'dark' ? 1.05 : effectiveEnvironmentPreset === 'soft' ? 1.12 : 1.22) *
    pbrLightScale;
  const fillIntensity = (effectiveEnvironmentPreset === 'dark' ? 0.18 : 0.26) * pbrLightScale;
  return (
    <group onPointerMissed={() => selectObject(undefined)}>
      <ambientLight intensity={ambientIntensity} />
      <hemisphereLight args={['#fff0e8', '#302640', 0.82]} />
      <directionalLight position={[3.5, 5.2, 2.8]} intensity={keyIntensity} castShadow />
      <directionalLight position={[-4.5, 2.2, -3.5]} intensity={fillIntensity} />
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
