import { Edges } from '@react-three/drei';

export function SelectionOutline() {
  return (
    <>
      <mesh position={[0, 0.72, 0]} scale={1.022}>
        <capsuleGeometry args={[0.65, 1.15, 24, 48]} />
        <meshBasicMaterial transparent opacity={0} />
        <Edges color="#ff9f43" scale={1.02} threshold={15} />
      </mesh>
      <mesh position={[0, -0.1, 0]} scale={[1.58, 0.2, 1.58]}>
        <cylinderGeometry args={[0.55, 0.75, 1, 48]} />
        <meshBasicMaterial transparent opacity={0} />
        <Edges color="#ff9f43" scale={1.02} threshold={15} />
      </mesh>
    </>
  );
}
