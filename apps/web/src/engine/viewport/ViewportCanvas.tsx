import { Canvas } from '@react-three/fiber';
import { Suspense } from 'react';
import { SceneRoot } from './SceneRoot';
import { CameraController } from './CameraController';
import { ViewCube } from './ViewCube';

export function ViewportCanvas() {
  return (
    <div className="relative h-full w-full">
      <Canvas camera={{ position: [3.2, 2.4, 4], fov: 45, near: 0.1, far: 100 }}>
        <color attach="background" args={['#080914']} />
        <fog attach="fog" args={['#080914', 8, 22]} />
        <Suspense fallback={null}>
          <SceneRoot />
        </Suspense>
        <CameraController />
      </Canvas>
      <ViewCube />
      <div className="pointer-events-none absolute bottom-4 left-4 rounded-md border border-white/10 bg-black/42 px-3 py-2 text-xs text-white/56 backdrop-blur">
        Drop GLB here / Import Model
      </div>
    </div>
  );
}
