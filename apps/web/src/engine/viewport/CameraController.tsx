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
import {
  getWorkspaceCameraTransition,
  isStrictModelAppend,
} from './cameraFramingPolicy';
import { BlenderOrbitControls } from './BlenderOrbitControls';
import {
  markViewportInteractionActivity,
  markViewportInteractionEnd,
  markViewportInteractionStart,
} from './viewportInteractionState';

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
  const importedModelIdsRef = useRef<Set<string>>(new Set());
  const workspaceModeRef = useRef(workspaceMode);
  const { gl, scene, camera, size } = useThree();

  useEffect(() => {
    if (!(camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera)) return;
    const controls = new BlenderOrbitControls(
      camera,
      gl.domElement,
      markViewportInteractionActivity,
    );
    const canvas = gl.domElement;
    let pointerActive = false;
    const handlePointerDown = () => {
      if (pointerActive) return;
      pointerActive = true;
      markViewportInteractionStart();
    };
    const handlePointerMove = () => {
      if (pointerActive) markViewportInteractionActivity();
    };
    const handlePointerUp = () => {
      if (!pointerActive) return;
      pointerActive = false;
      markViewportInteractionEnd();
    };
    canvas.addEventListener('pointerdown', handlePointerDown, { passive: true });
    canvas.addEventListener('pointermove', handlePointerMove, { passive: true });
    window.addEventListener('pointerup', handlePointerUp, { passive: true });
    window.addEventListener('pointercancel', handlePointerUp, { passive: true });
    controlsRef.current = controls;
    orbitTargetKeyRef.current = undefined;
    importedModelIdsRef.current = new Set();
    return () => {
      controls.dispose();
      if (pointerActive) markViewportInteractionEnd();
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
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
    const controls = controlsRef.current;
    const currentModelIds = new Set(importedModels.map((model) => model.objectId));
    const previousModelIds = importedModelIdsRef.current;
    const previousWorkspaceMode = workspaceModeRef.current;
    workspaceModeRef.current = workspaceMode;
    const modelSetUnchanged =
      previousModelIds.size === currentModelIds.size &&
      [...previousModelIds].every((objectId) => currentModelIds.has(objectId));
    const cameraTransition = getWorkspaceCameraTransition(
      previousWorkspaceMode,
      workspaceMode,
      modelSetUnchanged,
    );
    const isAppendingModels = isStrictModelAppend(previousModelIds, currentModelIds);
    importedModelIdsRef.current = currentModelIds;
    if (!controls || importedModels.length === 0) {
      if (importedModels.length === 0) orbitTargetKeyRef.current = undefined;
      return;
    }
    const isSceneWorkspace = workspaceMode === 'scene' || workspaceMode === 'export';
    if (isSceneWorkspace && !importSettings.autoFitCamera) return;
    const selectedModel =
      (selectedObjectId
        ? importedModels.find((model) => model.objectId === selectedObjectId)
        : importedModel) ?? importedModels[0];
    const targetModels = isSceneWorkspace ? importedModels : [selectedModel];
    const targetObjects = targetModels.map((model) => model.group);
    const boundingBox = getCombinedBoundingBox(targetObjects);
    if (!boundingBox) return;
    const targetKey = `${camera.uuid}:${workspaceMode}:${targetModels
      .map((model) => model.objectId)
      .join('|')}`;
    // Switching into texture mode is the deliberate focus action: the selected
    // model becomes the only visible model and receives a fresh camera fit.
    // Other workspace-only changes preserve the user's current orbit and mark
    // that framing as accepted for the new mode.
    if (cameraTransition === 'preserve') {
      orbitTargetKeyRef.current = targetKey;
      return;
    }
    if (cameraTransition !== 'focus-selected' && orbitTargetKeyRef.current === targetKey) return;
    // Additional imports are positioned beside the existing scene without
    // pulling the camera away from the user's composition. Entering texture
    // mode is the one exception because focusing the selected model is explicit.
    if (isAppendingModels && cameraTransition !== 'focus-selected') {
      orbitTargetKeyRef.current = targetKey;
      return;
    }
    orbitTargetKeyRef.current = targetKey;
    fitCameraToBoundingBox(
      {
        gl,
        scene,
        camera,
        controls: {
          target: controls.target,
          update: controls.update,
          setEnabled: (enabled) => {
            controls.enabled = enabled;
          },
        },
      },
      boundingBox,
    );
  }, [
    camera,
    gl,
    importedModel,
    importedModels,
    importSettings.autoFitCamera,
    scene,
    selectedObjectId,
    workspaceMode,
  ]);

  useEffect(() => {
    if (!restoreCameraRequest) return;
    applySerializedCamera(camera, restoreCameraRequest.camera);
    // Serialized captures do not include camera.up. Reset it before controls
    // rebuild the look-at quaternion so a previous pole crossing cannot leak a
    // rolled orbit basis into the restored view.
    camera.up.set(0, 1, 0);
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
