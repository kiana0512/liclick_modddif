import { OrthographicCamera, PerspectiveCamera } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { applySerializedCamera } from '@/engine/projection/ProjectionCamera';
import { fitCameraToBoundingBox } from '@/engine/scene/fitCameraToObject';
import { tupleFromVector } from '@/engine/scene/boundingBoxUtils';
import { useWorkspaceLayoutStore } from '@/components/workspace/workspaceLayoutStore';
import { useSceneStore } from '@/stores/sceneStore';
import type { ModelBoundingBox } from '@/types/model';
import { BlenderOrbitControls } from './BlenderOrbitControls';

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
  const importedModel = useSceneStore((state) => state.importedModel);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const importSettings = useSceneStore((state) => state.importSettings);
  const restoreCameraRequest = useSceneStore((state) => state.restoreCameraRequest);
  const setViewportRuntime = useSceneStore((state) => state.setViewportRuntime);
  const workspaceMode = useWorkspaceLayoutStore((state) => state.mode);
  const controlsRef = useRef<BlenderOrbitControls | null>(null);
  const orbitTargetKeyRef = useRef<string>();
  const { gl, scene, camera, size } = useThree();

  useEffect(() => {
    if (!(camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera)) return;
    const controls = new BlenderOrbitControls(camera, gl.domElement);
    controlsRef.current = controls;
    return () => {
      controls.dispose();
      if (controlsRef.current === controls) controlsRef.current = null;
    };
  }, [camera, gl.domElement]);

  useEffect(() => {
    if (!(camera instanceof THREE.OrthographicCamera)) return;
    camera.left = size.width / -2;
    camera.right = size.width / 2;
    camera.top = size.height / 2;
    camera.bottom = size.height / -2;
    camera.updateProjectionMatrix();
  }, [camera, size.height, size.width]);

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
    const controls = controlsRef.current;
    if (!controls || importedModels.length === 0) return;
    const targetModels =
      workspaceMode === 'scene' || workspaceMode === 'export'
        ? importedModels
        : [
            (selectedObjectId
              ? importedModels.find((model) => model.objectId === selectedObjectId)
              : importedModel) ?? importedModels[0],
          ];
    const targetObjects = targetModels.map((model) => model.group);
    const boundingBox = getCombinedBoundingBox(targetObjects);
    if (!boundingBox) return;
    const targetKey = `${workspaceMode}:${targetModels.map((model) => model.objectId).join('|')}`;
    if (orbitTargetKeyRef.current === targetKey) return;
    orbitTargetKeyRef.current = targetKey;

    const nextTarget = new THREE.Vector3().fromArray(boundingBox.center);
    const delta = nextTarget.clone().sub(controls.target);
    if (delta.lengthSq() < 0.000001) return;
    camera.position.add(delta);
    controls.target.copy(nextTarget);
    controls.update();
  }, [camera, importedModel, importedModels, selectedObjectId, workspaceMode]);

  useEffect(() => {
    if (!restoreCameraRequest) return;
    applySerializedCamera(camera, restoreCameraRequest.camera);
    controlsRef.current?.target.fromArray(restoreCameraRequest.camera.target);
    orbitTargetKeyRef.current = undefined;
    controlsRef.current?.update();
  }, [camera, restoreCameraRequest]);

  return (
    <>
      {projectionMode === 'perspective' ? (
        <PerspectiveCamera makeDefault position={[3.2, 2.4, 4]} fov={45} />
      ) : (
        <OrthographicCamera makeDefault position={[3.2, 2.4, 4]} zoom={90} />
      )}
    </>
  );
}
