import { OrbitControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { applySerializedCamera } from '@/engine/projection/ProjectionCamera';
import { fitCameraToObject } from '@/engine/scene/fitCameraToObject';
import { useSceneStore } from '@/stores/sceneStore';

export function CameraController() {
  const projectionMode = useSceneStore((state) => state.projectionMode);
  const importedModel = useSceneStore((state) => state.importedModel);
  const importSettings = useSceneStore((state) => state.importSettings);
  const restoreCameraRequest = useSceneStore((state) => state.restoreCameraRequest);
  const setViewportRuntime = useSceneStore((state) => state.setViewportRuntime);
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const { gl, scene, camera } = useThree();

  useEffect(() => {
    setViewportRuntime({
      gl,
      scene,
      camera,
      controls: controlsRef.current
        ? {
            target: controlsRef.current.target,
            update: () => controlsRef.current?.update(),
            setEnabled: (enabled) => {
              if (controlsRef.current) controlsRef.current.enabled = enabled;
            },
          }
        : undefined,
    });
  }, [camera, gl, scene, setViewportRuntime]);

  useEffect(() => {
    if (!importedModel) return;
    if (!importSettings.autoFitCamera) return;
    fitCameraToObject(
      {
        gl,
        scene,
        camera,
        controls: controlsRef.current
          ? {
              target: controlsRef.current.target,
              update: () => controlsRef.current?.update(),
              setEnabled: (enabled) => {
                if (controlsRef.current) controlsRef.current.enabled = enabled;
              },
            }
          : undefined,
      },
      importedModel.group,
    );
  }, [camera, gl, importSettings.autoFitCamera, importedModel, scene]);

  useEffect(() => {
    if (!restoreCameraRequest) return;
    applySerializedCamera(camera, restoreCameraRequest.camera);
    controlsRef.current?.target.fromArray(restoreCameraRequest.camera.target);
    controlsRef.current?.update();
  }, [camera, restoreCameraRequest]);

  return (
    <>
      {projectionMode === 'perspective' ? (
        <PerspectiveCamera makeDefault position={[3.2, 2.4, 4]} fov={45} />
      ) : (
        <OrthographicCamera makeDefault position={[3.2, 2.4, 4]} zoom={90} />
      )}
      <OrbitControls
        ref={controlsRef}
        makeDefault
        enableDamping
        dampingFactor={0.08}
        minDistance={0.3}
        maxDistance={40}
      />
    </>
  );
}
