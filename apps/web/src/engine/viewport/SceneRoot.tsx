import { ContactShadows, Environment, MeshReflectorMaterial } from '@react-three/drei';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { createDisplayModeMaterial, createProjectedLayerMaterial } from '@/engine/projection/ProjectedLayerMaterial';
import { useLayerStore } from '@/stores/layerStore';
import { useSceneStore } from '@/stores/sceneStore';
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
              camera: activeProjectedLayer.camera,
              objectId: model.objectId,
              opacity: activeProjectedLayer.opacity,
              visible: activeProjectedLayer.visible,
              depthTest: false,
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
          child.material = originalMaterial ?? createDisplayModeMaterial(displayMode, selected);
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

  return (
    <group onPointerMissed={() => selectObject(undefined)}>
      <ambientLight intensity={0.45} />
      <directionalLight position={[3, 4, 2]} intensity={1.5} castShadow />
      <Environment preset="city" />
      <Grid />
      {importedModel ? <ImportedModel /> : <DemoModel />}
      <ObjectTransformControls />
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.04, 0]}>
        <planeGeometry args={[18, 18]} />
        <MeshReflectorMaterial
          color="#0b0d18"
          mirror={0}
          roughness={0.82}
          metalness={0.05}
          blur={[500, 80]}
          mixBlur={0.5}
          mixStrength={0.15}
        />
      </mesh>
      <ContactShadows position={[0, -0.02, 0]} opacity={0.35} scale={8} blur={2.4} />
    </group>
  );
}
