import { OrthographicCamera, PerspectiveCamera } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useRef } from 'react';
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
import { switchCameraProjection } from './switchCameraProjection';
import {
  markViewportInteractionActivity,
  markViewportInteractionEnd,
  markViewportInteractionStart,
} from './input';

function getCombinedBoundingBox(objects: THREE.Object3D[]): ModelBoundingBox | undefined {
  const box = new THREE.Box3();
  for (const object of objects) {
    object.updateMatrixWorld(true);
    box.expandByObject(object);
  }
  if (box.isEmpty()) return undefined;
  return {
    min: tupleFromVector(box.min),
    max: tupleFromVector(box.max),
    center: tupleFromVector(box.getCenter(new THREE.Vector3())),
    size: tupleFromVector(box.getSize(new THREE.Vector3())),
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
  const appliedRestoreRef = useRef<typeof restoreCameraRequest>();
  const orbitTargetKeyRef = useRef<string>();
  const importedModelIdsRef = useRef<Set<string>>(new Set());
  const workspaceModeRef = useRef(workspaceMode);
  const { gl, scene, camera } = useThree();

  useFrame((_, deltaSeconds) => {
    controlsRef.current?.updateWheelTransition(deltaSeconds);
  });

  // Drei updates the orthographic frustum in its child layout effect, including
  // resize, before this parent hands over the current view.
  useLayoutEffect(() => {
    if (!(camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera)) return;
    const controls = new BlenderOrbitControls(
      camera,
      gl.domElement,
      markViewportInteractionActivity,
    );
    const previous = controlsRef.current;
    if (previous) {
      controls.target.copy(previous.target);
      switchCameraProjection(previous.camera, camera, controls.target);
    }
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
    const listeners = [
      [canvas, 'pointerdown', handlePointerDown],
      [canvas, 'pointermove', handlePointerMove],
      [window, 'pointerup', handlePointerUp],
      [window, 'pointercancel', handlePointerUp],
    ] as const;
    listeners.forEach(([element, type, listener]) => element.addEventListener(type, listener, { passive: true }));
    controlsRef.current = controls;
    setViewportRuntime({ gl, scene, camera, controls: {
      target: controls.target,
      update: controls.update,
      setEnabled: (enabled) => { controls.enabled = enabled; },
      subscribeChange: (listener) => controls.subscribeChange(listener),
    } });
    return () => {
      controls.dispose();
      if (pointerActive) markViewportInteractionEnd();
      listeners.forEach(([element, type, listener]) => element.removeEventListener(type, listener));
      // Retain the disposed control's final camera/target until its replacement
      // inherits them. dispose() has already removed all input/frame listeners.
    };
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
    const targetKey = `${workspaceMode}:${targetModels
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
    // A selection-only change in scene mode preserves framing. Do not walk
    // every model hierarchy just to discard the bounds at the guards above.
    const boundingBox = getCombinedBoundingBox(targetModels.map((model) => model.group));
    if (!boundingBox) return;
    orbitTargetKeyRef.current = targetKey;
    // The layout effect has already published this camera's controls.
    fitCameraToBoundingBox(useSceneStore.getState().viewport!, boundingBox);
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
    if (!restoreCameraRequest || appliedRestoreRef.current === restoreCameraRequest) return;
    // A restore can arrive with a projection-mode change. Wait for its camera,
    // then consume it once so later manual toggles cannot replay the old view.
    const cameraMode = camera instanceof THREE.OrthographicCamera ? 'orthographic' : 'perspective';
    if (cameraMode !== restoreCameraRequest.camera.type) return;
    appliedRestoreRef.current = restoreCameraRequest;
    applySerializedCamera(camera, restoreCameraRequest.camera);
    // Serialized captures do not include camera.up. Reset it before controls
    // rebuild the look-at quaternion so a previous pole crossing cannot leak a
    // rolled orbit basis into the restored view.
    camera.up.set(0, 1, 0);
    controlsRef.current?.target.fromArray(restoreCameraRequest.camera.target);
    controlsRef.current?.update();
  }, [camera, restoreCameraRequest]);

  return projectionMode === 'perspective' ? (
    <PerspectiveCamera makeDefault position={[3.2, 2.4, 4]} fov={45} />
  ) : (
    <OrthographicCamera makeDefault position={[3.2, 2.4, 4]} zoom={90} />
  );
}
