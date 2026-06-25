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

function ImportedModel() {
  const importedModel = useSceneStore((state) => state.importedModel);
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
  const exactBakedTextureRecord = useMemo(() => {
    const texture = findExactLayerStackTexture(project, visibleProjectedLayers);
    return canUseLayerStackCache(visibleProjectedLayers, texture) ? texture : undefined;
  }, [project, visibleProjectedLayers]);
  const loadedBakedTexture = useLoadedBakedTexture(exactBakedTextureRecord?.imageUrl);
  const visibleStackIsBaked = Boolean(exactBakedTextureRecord);
  const bakedTextureIsReady = Boolean(loadedBakedTexture);
  const canPreviewProjectedLayers =
    !bakedTextureIsReady && visibleProjectedLayers.length > 0 && (displayMode === 'flat' || displayMode === 'pbr');

  useEffect(() => {
    if (!importedModel) return;
    let cancelled = false;
    const model = importedModel;

    async function applyMaterials() {
      const selected = selectedObjectId === model.objectId;
      model.group.updateMatrixWorld(true);
      const projectedMaterial =
        canPreviewProjectedLayers
          ? await createProjectedLayerStackMaterial({
              layers: visibleProjectedLayers.map((layer) => {
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
            })
          : undefined;

      if (cancelled) {
        disposeGeneratedMaterialTree(projectedMaterial);
        return;
      }

      model.group.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        const originalMaterial = (child.userData.sourceMaterial ?? child.userData.originalMaterial) as
          | THREE.Material
          | THREE.Material[]
          | undefined;
        const existingBakedTexture = child.userData.bakedTexture instanceof THREE.Texture ? child.userData.bakedTexture : undefined;
        const bakedTexture = visibleStackIsBaked ? loadedBakedTexture ?? existingBakedTexture : undefined;
        if (bakedTexture) child.userData.bakedTexture = bakedTexture;
        const previousMaterial = child.material;
        if (displayMode === 'pbr' && !projectedMaterial) {
          child.material = createPbrPreviewMaterial(originalMaterial, selected, bakedTexture);
          disposeGeneratedMaterialTree(previousMaterial);
          return;
        }
        child.material = projectedMaterial ?? createDisplayModeMaterial(displayMode, selected, bakedTexture);
        if (previousMaterial !== child.material) disposeGeneratedMaterialTree(previousMaterial);
      });
    }

    void applyMaterials();

    return () => {
      cancelled = true;
    };
  }, [
    canPreviewProjectedLayers,
    displayMode,
    importedModel,
    loadedBakedTexture,
    selectedObjectId,
    visibleProjectedLayers,
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
  const importedModel = useSceneStore((state) => state.importedModel);
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
      {importedModel ? <ImportedModel /> : <DemoModel />}
      <ObjectTransformControls />
      <ContactShadows position={[0, -0.02, 0]} opacity={0.22} scale={8} blur={2.4} />
    </group>
  );
}
