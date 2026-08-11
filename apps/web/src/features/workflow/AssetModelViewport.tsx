import { OrbitControls } from '@react-three/drei';
import { Canvas, useThree } from '@react-three/fiber';
import { Box, LoaderCircle, Rotate3D } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { loadModelFromFile } from '@/engine/loaders/loadModelFromFile';
import {
  frameVisiblePreviewObject,
  repairConcaveFbxPreview,
} from './repairFbxPreviewGeometry';

export type AssetModelPreviewSource = {
  key: string;
  file: File;
  label: string;
  kind: 'high' | 'result';
};

export type AssetModelPreviewStats = {
  meshes: number;
  vertices: number;
  triangles: number;
};

function collectPreviewStats(root: THREE.Object3D): AssetModelPreviewStats {
  let meshes = 0;
  let vertices = 0;
  let triangles = 0;
  root.traverseVisible((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    meshes += 1;
    const positionCount = child.geometry?.attributes.position?.count ?? 0;
    vertices += positionCount;
    triangles += Math.floor((child.geometry?.index?.count ?? positionCount) / 3);
  });
  return { meshes, vertices, triangles };
}

function disposePreviewObject(root: THREE.Object3D) {
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry?.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => material?.dispose());
  });
}

function preparePreviewObject(root: THREE.Object3D) {
  repairConcaveFbxPreview(root);
  root.traverseVisible((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const sourceMaterials = Array.isArray(child.material) ? child.material : [child.material];
    sourceMaterials.forEach((material) => material?.dispose());
    child.material = new THREE.MeshStandardMaterial({
      color: '#aeb5c1',
      roughness: 0.7,
      metalness: 0.04,
    });
  });
}

function PreviewCamera({ bounds }: { bounds: THREE.Box3 }) {
  const { camera, size } = useThree();

  useLayoutEffect(() => {
    if (!(camera instanceof THREE.PerspectiveCamera) || bounds.isEmpty()) return;
    const center = bounds.getCenter(new THREE.Vector3());
    const dimensions = bounds.getSize(new THREE.Vector3());
    const radius = Math.max(dimensions.length() * 0.5, 0.25);
    const verticalFov = THREE.MathUtils.degToRad(camera.fov);
    const aspect = Math.max(size.width / Math.max(size.height, 1), 0.01);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov * 0.5) * aspect);
    const limitingFov = Math.max(0.1, Math.min(verticalFov, horizontalFov));
    const distance = (radius / Math.sin(limitingFov * 0.5)) * 1.12;
    const direction = new THREE.Vector3(0.72, 0.42, 1).normalize();

    camera.position.copy(center).addScaledVector(direction, distance);
    camera.near = Math.max(0.005, distance - radius * 2.5);
    camera.far = Math.max(100, distance + radius * 20);
    camera.lookAt(center);
    camera.updateProjectionMatrix();
  }, [bounds, camera, size.height, size.width]);

  return null;
}

export function AssetModelViewport({
  source,
  onStats,
}: {
  source?: AssetModelPreviewSource;
  onStats?: (stats?: AssetModelPreviewStats) => void;
}) {
  const [object, setObject] = useState<THREE.Group>();
  const [objectBounds, setObjectBounds] = useState<THREE.Box3>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    let loadedRoot: THREE.Group | undefined;
    let sourceUrl: string | undefined;
    setObject(undefined);
    setObjectBounds(undefined);
    setError(undefined);
    onStats?.(undefined);
    if (!source) {
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    void loadModelFromFile(source.file, {
      normalize: true,
      ground: true,
      targetMaxDimension: 3,
    })
      .then((loaded) => {
        loadedRoot = loaded.root;
        sourceUrl = loaded.sourceUrl;
        const stats = collectPreviewStats(loaded.root);
        preparePreviewObject(loaded.root);
        const framedBounds = frameVisiblePreviewObject(loaded.root);
        if (cancelled) {
          disposePreviewObject(loaded.root);
          URL.revokeObjectURL(loaded.sourceUrl);
          return;
        }
        setObject(loaded.root);
        setObjectBounds(framedBounds);
        onStats?.(stats);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : '模型预览加载失败。');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      if (loadedRoot) disposePreviewObject(loadedRoot);
      if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    };
  }, [source, onStats]);

  const controlsTarget = useMemo(
    () => objectBounds?.getCenter(new THREE.Vector3()).toArray() ?? ([0, 0, 0] as [number, number, number]),
    [objectBounds],
  );

  return (
    <div className="relative h-full min-h-[480px] overflow-hidden bg-[#0b0d15]">
      <Canvas
        dpr={[1, 1.5]}
        camera={{ position: [4.8, 3.2, 5.8], fov: 34, near: 0.01, far: 100 }}
        gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
        onCreated={({ gl }) => {
          gl.setClearColor('#0b0d15', 1);
          gl.outputColorSpace = THREE.SRGBColorSpace;
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.05;
        }}
      >
        <hemisphereLight args={['#ffffff', '#252a39', 2.1]} />
        <directionalLight position={[5, 7, 5]} intensity={2.4} />
        <directionalLight position={[-4, 2, -3]} intensity={0.9} color="#9fb8ff" />
        <gridHelper args={[24, 48, '#2d3341', '#171b27']} position={[0, -0.01, 0]} />
        {object ? <primitive key={source?.key} object={object} dispose={null} /> : null}
        {objectBounds ? <PreviewCamera bounds={objectBounds} /> : null}
        <OrbitControls
          key={source?.key}
          makeDefault
          target={controlsTarget}
          enableDamping
          dampingFactor={0.08}
          minDistance={0.2}
          maxDistance={40}
        />
      </Canvas>

      {!source && !loading ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="text-center text-white/28">
            <Box className="mx-auto h-9 w-9 stroke-[1.25]" />
            <p className="mt-4 text-sm font-medium text-white/42">导入高模后在这里预览</p>
          </div>
        </div>
      ) : null}
      {loading ? (
        <div className="absolute inset-0 grid place-items-center bg-[#0b0d15]/92">
          <div className="text-center text-white/42">
            <LoaderCircle className="mx-auto h-7 w-7 animate-spin text-blue-200/72" />
            <p className="mt-3 text-sm">正在加载模型预览…</p>
          </div>
        </div>
      ) : null}
      {error ? (
        <div className="absolute inset-0 grid place-items-center bg-[#0b0d15]/92 px-10 text-center text-sm leading-6 text-rose-100/62">
          {error}
        </div>
      ) : null}
      {source && !loading && !error ? (
        <div className="pointer-events-none absolute left-1/2 top-4 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-white/10 bg-black/45 px-3 py-2 text-xs text-white/62 backdrop-blur-md">
          <Rotate3D className="h-3.5 w-3.5 text-blue-200/72" />
          <span>{source.kind === 'result' ? '拓扑结果' : '高模预览'}</span>
          <span className="max-w-56 truncate text-white/32">{source.label}</span>
        </div>
      ) : null}
    </div>
  );
}
