import { Grid as DreiGrid } from '@react-three/drei';

export function Grid() {
  return (
    <DreiGrid
      position={[0, -0.02, 0]}
      args={[12, 12]}
      cellSize={0.5}
      cellThickness={0.55}
      cellColor="#8b5cf6"
      sectionSize={2}
      sectionThickness={1.1}
      sectionColor="#ff9f43"
      fadeDistance={18}
      fadeStrength={1}
      infiniteGrid
    />
  );
}
