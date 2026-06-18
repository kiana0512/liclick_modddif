import { useMemo } from 'react';
import * as THREE from 'three';

function buildGridGeometry(size: number, step: number, majorEvery: number, major: boolean) {
  const half = size / 2;
  const positions: number[] = [];
  const lineCount = Math.floor(size / step);

  for (let index = -lineCount / 2; index <= lineCount / 2; index += 1) {
    const value = index * step;
    const isMajor = Math.abs(index) % majorEvery === 0;
    if (isMajor !== major) continue;

    positions.push(-half, 0, value, half, 0, value);
    positions.push(value, 0, -half, value, 0, half);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

export function Grid() {
  const minorGeometry = useMemo(() => buildGridGeometry(140, 1, 4, false), []);
  const majorGeometry = useMemo(() => buildGridGeometry(140, 1, 4, true), []);

  return (
    <group position={[0, -0.018, 0]} renderOrder={-10}>
      <lineSegments geometry={minorGeometry} frustumCulled={false}>
        <lineBasicMaterial
          color="#302346"
          transparent
          opacity={0.34}
          depthWrite={false}
          toneMapped={false}
        />
      </lineSegments>
      <lineSegments geometry={majorGeometry} frustumCulled={false}>
        <lineBasicMaterial
          color="#d4774c"
          transparent
          opacity={0.78}
          depthWrite={false}
          toneMapped={false}
        />
      </lineSegments>
    </group>
  );
}
