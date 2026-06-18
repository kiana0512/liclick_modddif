import { ContactShadows, Environment, MeshReflectorMaterial } from '@react-three/drei';
import { useMemo } from 'react';
import * as THREE from 'three';
import { useSceneStore } from '@/stores/sceneStore';
import { Grid } from './Grid';
import { SelectionOutline } from './SelectionOutline';

function DemoModel() {
  const displayMode = useSceneStore((state) => state.displayMode);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const selectObject = useSceneStore((state) => state.selectObject);
  const selected = selectedObjectId === 'object-demo-capsule';

  const material = useMemo(() => {
    if (displayMode === 'normal') {
      return new THREE.MeshNormalMaterial();
    }
    if (displayMode === 'wire') {
      return new THREE.MeshStandardMaterial({
        color: '#c4b5fd',
        wireframe: true,
        roughness: 0.8,
        metalness: 0.1,
      });
    }
    if (displayMode === 'flat') {
      return new THREE.MeshBasicMaterial({ color: '#d8b4fe' });
    }
    return new THREE.MeshStandardMaterial({
      color: '#b9a3ff',
      roughness: 0.42,
      metalness: 0.18,
      emissive: selected ? '#3b0764' : '#000000',
      emissiveIntensity: selected ? 0.45 : 0,
    });
  }, [displayMode, selected]);

  return (
    <group onClick={(event) => {
      event.stopPropagation();
      selectObject('object-demo-capsule');
    }}>
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

export function SceneRoot() {
  const selectObject = useSceneStore((state) => state.selectObject);

  return (
    <group onPointerMissed={() => selectObject(undefined)}>
      <ambientLight intensity={0.45} />
      <directionalLight position={[3, 4, 2]} intensity={1.5} castShadow />
      <Environment preset="city" />
      <Grid />
      <DemoModel />
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
