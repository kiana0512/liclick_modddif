import { ContactShadows, Environment } from '@react-three/drei';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import {
  createDisplayModeMaterial,
  createPbrPreviewMaterial,
  createProjectedLayerMaterial,
} from '@/engine/projection/ProjectedLayerMaterial';
import { useLayerStore } from '@/stores/layerStore';
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
  const activeProjectedLayerId = useLayerStore((state) => state.activeProjectedLayerId);

  const activeProjectedLayer = layers.find(
    (layer) =>
      layer.id === activeProjectedLayerId &&
      layer.type === 'projected' &&
      layer.visible &&
      layer.imageUrl &&
      layer.camera,
  );

  useEffect(() => {
    if (!importedModel) return;
    let cancelled = false;
    const model = importedModel;

    async function applyMaterials() {
      const selected = selectedObjectId === model.objectId;
      const projectedMaterial =
        displayMode === 'pbr' && activeProjectedLayer?.camera
          ? await createProjectedLayerMaterial({
              layerId: activeProjectedLayer.id,
              imageUrl: activeProjectedLayer.imageUrl,
              maskUrl: activeProjectedLayer.maskUrl,
              depthUrl: activeProjectedLayer.depthUrl,
              camera: activeProjectedLayer.camera,
              objectId: model.objectId,
              opacity: activeProjectedLayer.opacity,
              visible: activeProjectedLayer.visible,
              depthTest: true,
              hue: (activeProjectedLayer.adjustments?.hue ?? 0) / 100,
              saturation: (activeProjectedLayer.adjustments?.saturation ?? 0) / 100,
              lightness: (activeProjectedLayer.adjustments?.lightness ?? 0) / 100,
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
        const originalMaterial = child.userData.originalMaterial as THREE.Material | THREE.Material[] | undefined;
        const bakedTexture = child.userData.bakedTexture as THREE.Texture | undefined;
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
  }, [activeProjectedLayer, displayMode, importedModel, selectedObjectId]);

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
  const environmentPreset = useSettingsStore((state) => state.environmentPreset);

  const environment = environmentPreset === 'dark' || environmentPreset === 'color' ? undefined : 'studio';
  const ambientIntensity = environmentPreset === 'dark' ? 0.38 : environmentPreset === 'soft' ? 0.46 : 0.5;
  const keyIntensity = environmentPreset === 'dark' ? 1.05 : environmentPreset === 'soft' ? 1.12 : 1.22;
  const fillIntensity = environmentPreset === 'dark' ? 0.18 : 0.26;
  const rimIntensity = environmentPreset === 'dark' ? 0.14 : 0.2;

  return (
    <group onPointerMissed={() => selectObject(undefined)}>
      <ambientLight intensity={ambientIntensity} />
      <hemisphereLight args={['#fff0e8', '#302640', 0.82]} />
      <directionalLight position={[3.5, 5.2, 2.8]} intensity={keyIntensity} castShadow />
      <directionalLight position={[-4.5, 2.2, -3.5]} intensity={fillIntensity} />
      <directionalLight position={[0, 3.2, -5]} intensity={rimIntensity} />
      {environment && <Environment preset={environment} environmentIntensity={environmentPreset === 'soft' ? 0.22 : 0.3} />}
      <Grid />
      {importedModel ? <ImportedModel /> : <DemoModel />}
      <ObjectTransformControls />
      <ContactShadows position={[0, -0.02, 0]} opacity={0.22} scale={8} blur={2.4} />
    </group>
  );
}
