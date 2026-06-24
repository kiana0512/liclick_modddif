import { ContactShadows } from '@react-three/drei';
import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import {
  createDisplayModeMaterial,
  createPbrPreviewMaterial,
  createProjectedLayerMaterial,
} from '@/engine/projection/ProjectedLayerMaterial';
import { useLayerStore } from '@/stores/layerStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSceneStore } from '@/stores/sceneStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { Grid } from './Grid';
import { ObjectTransformControls } from './ObjectTransformControls';
import { SelectionOutline } from './SelectionOutline';

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
  const [loadedBakedTexture, setLoadedBakedTexture] = useState<THREE.Texture>();

  const visibleProjectedLayers = layers
    .filter(
      (layer) =>
        layer.type === 'projected' &&
        layer.visible &&
        layer.imageUrl &&
        layer.camera &&
        (!layer.objectId || layer.objectId === importedModel?.objectId),
    )
    .sort((a, b) => b.order - a.order);
  const visibleLayerIds = useMemo(() => visibleProjectedLayers.map((layer) => layer.id), [visibleProjectedLayers]);
  const bakedTextureRecord = useMemo(() => {
    if (!project || visibleLayerIds.length === 0) return undefined;
    return project.bakedTextures.find((texture) => {
      const sourceLayerIds = texture.sourceLayerIds ?? [texture.sourceLayerId];
      return (
        sourceLayerIds.length === visibleLayerIds.length &&
        sourceLayerIds.every((layerId, index) => layerId === visibleLayerIds[index]) &&
        visibleProjectedLayers.every((layer) => layer.isBaked && !layer.needsRebake && layer.bakedTextureId === texture.id)
      );
    });
  }, [project, visibleLayerIds, visibleProjectedLayers]);
  const visibleStackIsBaked = Boolean(bakedTextureRecord);
  const previewProjectedLayer = visibleStackIsBaked ? undefined : visibleProjectedLayers[0];
  const canPreviewProjectedLayer = displayMode === 'flat';

  useEffect(() => {
    if (!bakedTextureRecord?.imageUrl) {
      setLoadedBakedTexture(undefined);
      return undefined;
    }
    let cancelled = false;
    const textureLoader = new THREE.TextureLoader();
    textureLoader.loadAsync(bakedTextureRecord.imageUrl).then((texture) => {
      if (cancelled) {
        texture.dispose();
        return;
      }
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
    });
    return () => {
      cancelled = true;
    };
  }, [bakedTextureRecord?.imageUrl]);

  useEffect(() => {
    if (!importedModel) return;
    let cancelled = false;
    const model = importedModel;

    async function applyMaterials() {
      const selected = selectedObjectId === model.objectId;
      model.group.updateMatrixWorld(true);
      const projectedMaterial =
        canPreviewProjectedLayer && previewProjectedLayer?.camera
          ? await createProjectedLayerMaterial({
              layerId: previewProjectedLayer.id,
              imageUrl: previewProjectedLayer.imageUrl,
              maskUrl: previewProjectedLayer.maskUrl,
              depthUrl: previewProjectedLayer.depthUrl,
              camera: previewProjectedLayer.camera,
              objectId: model.objectId,
              objectMatrixWorld: previewProjectedLayer.objectMatrixWorld,
              currentObjectMatrixWorld: model.group.matrixWorld.toArray(),
              opacity: previewProjectedLayer.opacity,
              visible: previewProjectedLayer.visible,
              depthTest: true,
              hue: (previewProjectedLayer.adjustments?.hue ?? 0) / 100,
              saturation: (previewProjectedLayer.adjustments?.saturation ?? 0) / 100,
              lightness: (previewProjectedLayer.adjustments?.lightness ?? 0) / 100,
              useMask: true,
              useDepthCheck: true,
              enableBackfaceCulling: true,
              edgeFeather: 0.035,
              depthBias: 0.025,
            })
          : undefined;

      if (cancelled) {
        projectedMaterial?.dispose();
        return;
      }

      model.group.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        const originalMaterial = (child.userData.sourceMaterial ?? child.userData.originalMaterial) as
          | THREE.Material
          | THREE.Material[]
          | undefined;
        const bakedTexture = visibleStackIsBaked ? loadedBakedTexture : undefined;
        if (bakedTexture) child.userData.bakedTexture = bakedTexture;
        if (displayMode === 'pbr' && !projectedMaterial) {
          child.material = createPbrPreviewMaterial(originalMaterial, selected, bakedTexture);
          return;
        }
        child.material = projectedMaterial ?? createDisplayModeMaterial(displayMode, selected, bakedTexture);
      });
    }

    void applyMaterials();

    return () => {
      cancelled = true;
    };
  }, [
    canPreviewProjectedLayer,
    displayMode,
    importedModel,
    loadedBakedTexture,
    previewProjectedLayer,
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
  const rimIntensity = (effectiveEnvironmentPreset === 'dark' ? 0.14 : 0.2) * pbrLightScale;

  return (
    <group onPointerMissed={() => selectObject(undefined)}>
      <ambientLight intensity={ambientIntensity} />
      <hemisphereLight args={['#fff0e8', '#302640', 0.82]} />
      <directionalLight position={[3.5, 5.2, 2.8]} intensity={keyIntensity} castShadow />
      <directionalLight position={[-4.5, 2.2, -3.5]} intensity={fillIntensity} />
      <directionalLight position={[0, 3.2, -5]} intensity={rimIntensity} />
      <Grid />
      {importedModel ? <ImportedModel /> : <DemoModel />}
      <ObjectTransformControls />
      <ContactShadows position={[0, -0.02, 0]} opacity={0.22} scale={8} blur={2.4} />
    </group>
  );
}
