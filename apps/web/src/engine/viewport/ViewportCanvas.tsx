import { Canvas } from '@react-three/fiber';
import { Suspense, useState, type DragEvent } from 'react';
import { SceneRoot } from './SceneRoot';
import { CameraController } from './CameraController';
import { ViewCube } from './ViewCube';

type ViewportCanvasProps = {
  hasImportedModel: boolean;
  onImportModel: (file: File) => void;
  onOpenImport: () => void;
};

export function ViewportCanvas({ hasImportedModel, onImportModel, onOpenImport }: ViewportCanvasProps) {
  const [isDragging, setIsDragging] = useState(false);

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files.item(0);
    if (file) onImportModel(file);
  }

  return (
    <div
      className="relative h-full w-full"
      onDragOver={(event) => {
        event.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
    >
      <Canvas camera={{ position: [3.2, 2.4, 4], fov: 45, near: 0.1, far: 100 }}>
        <color attach="background" args={['#080914']} />
        <fog attach="fog" args={['#080914', 8, 22]} />
        <Suspense fallback={null}>
          <SceneRoot />
        </Suspense>
        <CameraController />
      </Canvas>
      <ViewCube />
      {!hasImportedModel && (
        <button
          type="button"
          onClick={onOpenImport}
          className="absolute bottom-4 left-4 rounded-md border border-white/10 bg-black/42 px-3 py-2 text-xs text-white/66 backdrop-blur transition hover:bg-white/10 hover:text-white"
        >
          Drop GLB here / Import Model
        </button>
      )}
      {isDragging && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center border-2 border-dashed border-liclick-pink bg-liclick-purple/18 text-lg font-semibold text-white backdrop-blur-sm">
          Drop model to import
        </div>
      )}
    </div>
  );
}
