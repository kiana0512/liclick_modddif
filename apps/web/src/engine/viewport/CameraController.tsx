import { OrbitControls, PerspectiveCamera, OrthographicCamera } from '@react-three/drei';
import { useSceneStore } from '@/stores/sceneStore';

export function CameraController() {
  const projectionMode = useSceneStore((state) => state.projectionMode);

  return (
    <>
      {projectionMode === 'perspective' ? (
        <PerspectiveCamera makeDefault position={[3.2, 2.4, 4]} fov={45} />
      ) : (
        <OrthographicCamera makeDefault position={[3.2, 2.4, 4]} zoom={90} />
      )}
      <OrbitControls makeDefault enableDamping dampingFactor={0.08} minDistance={1.5} maxDistance={12} />
    </>
  );
}
