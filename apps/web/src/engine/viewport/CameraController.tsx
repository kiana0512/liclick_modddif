import { OrbitControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { applySerializedCamera } from '@/engine/projection/ProjectionCamera';
import { fitCameraToBoundingBox } from '@/engine/scene/fitCameraToObject';
import { tupleFromVector } from '@/engine/scene/boundingBoxUtils';
import { useSceneStore } from '@/stores/sceneStore';
import type { ModelBoundingBox } from '@/types/model';

function getCombinedBoundingBox(objects: THREE.Object3D[]): ModelBoundingBox | undefined {
  const box = new THREE.Box3();
  let hasObject = false;
  objects.forEach((object) => {
    object.updateMatrixWorld(true);
    const objectBox = new THREE.Box3().setFromObject(object);
    if (objectBox.isEmpty()) return;
    box.union(objectBox);
    hasObject = true;
  });
  if (!hasObject) return undefined;
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  box.getCenter(center);
  box.getSize(size);
  return {
    min: tupleFromVector(box.min),
    max: tupleFromVector(box.max),
    center: tupleFromVector(center),
    size: tupleFromVector(size),
  };
}

export function CameraController() {
  const projectionMode = useSceneStore((state) => state.projectionMode);
  const importedModels = useSceneStore((state) => state.importedModels);
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
    if (importedModels.length === 0) return;
    if (!importSettings.autoFitCamera) return;
    const boundingBox = getCombinedBoundingBox(importedModels.map((model) => model.group));
    if (!boundingBox) return;
    fitCameraToBoundingBox(
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
      boundingBox,
    );
  }, [camera, gl, importSettings.autoFitCamera, importedModels, scene]);

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
