import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';
import { CameraController } from '../src/engine/viewport/CameraController';
import { useSceneStore } from '../src/stores/sceneStore';
import { useWorkspaceLayoutStore } from '../src/components/workspace/workspaceLayoutStore';
import { serializeCamera } from '../src/engine/projection/ProjectionCamera';

export async function run() {
  const check = (ok: boolean, message: string) => { if (!ok) throw new Error(message); };
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame); };
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshNormalMaterial()));
  const model = { objectId: 'projection-fixture', group };
  useWorkspaceLayoutStore.setState({ mode: 'texture' });
  useSceneStore.setState({ importedModels: [model], importedModel: model, selectedObjectId: model.objectId,
    projectionMode: 'perspective', restoreCameraRequest: undefined } as never);
  const host = document.createElement('div'); host.style.cssText = 'width:960px;height:640px'; document.body.append(host);
  const root = createRoot(host);
  root.render(<StrictMode><Canvas><CameraController /><primitive object={group} /></Canvas></StrictMode>);
  await settle();
  const runtime = () => useSceneStore.getState().viewport!;
  check(!!runtime()?.controls, 'Camera controller mounted');
  const configure = () => {
    const { camera, controls } = runtime();
    controls!.target.set(0.3, 0.7, -0.5);
    camera.position.copy(controls!.target).add(new THREE.Vector3(4, 3, 7));
    camera.up.set(0, -1, 0); controls!.update();
  };
  configure();
  const capture = () => {
    const { camera, controls } = runtime();
    const target = controls!.target.clone();
    const offset = new THREE.Vector3(.4, .2, 0).applyQuaternion(camera.quaternion);
    const point = target.clone().add(offset).project(camera);
    return { target, up: camera.up.clone(), direction: camera.getWorldDirection(new THREE.Vector3()), point };
  };
  const compare = (expected: ReturnType<typeof capture>) => {
    const current = capture();
    for (const key of ['target', 'up', 'direction'] as const) check(current[key].distanceTo(expected[key]) < 1e-7, `${key} jumped`);
    check(Math.abs(current.point.x - expected.point.x) < 1e-7 && Math.abs(current.point.y - expected.point.y) < 1e-7, 'Screen scale jumped');
  };
  let toggles = 0;
  const toggle = async () => {
    const state = useSceneStore.getState();
    state.setProjectionMode(state.projectionMode === 'perspective' ? 'orthographic' : 'perspective');
    await settle(); toggles++;
  };
  const expected = capture();
  for (let i = 0; i < 10; i++) { await toggle(); compare(expected); }
  await toggle();
  (runtime().camera as THREE.OrthographicCamera).zoom *= 2;
  (runtime().camera as THREE.OrthographicCamera).updateProjectionMatrix();
  const zoomed = capture(); await toggle(); compare(zoomed);
  const snapshot = serializeCamera(runtime().camera, 1.5, runtime().controls!.target);
  useSceneStore.getState().requestCameraRestore(snapshot); await settle();
  configure(); const afterRestore = capture();
  await toggle(); compare(afterRestore); await toggle(); compare(afterRestore);
  // An explicit restore arriving with a mode change must still take effect.
  useSceneStore.getState().setProjectionMode('orthographic'); await settle();
  useSceneStore.getState().setProjectionMode('perspective');
  useSceneStore.getState().requestCameraRestore(snapshot); await settle();
  check(runtime().camera.position.distanceTo(new THREE.Vector3().fromArray(snapshot.position)) < 1e-7, 'Explicit restore lost');
  // Resize in orthographic mode, then switch using the new viewport dimensions.
  await toggle(); host.style.height = '800px';
  await new Promise(resolve => setTimeout(resolve, 200)); await settle();
  const resized = capture(); await toggle(); compare(resized);
  root.unmount(); group.traverse(object => { if (object instanceof THREE.Mesh) { object.geometry.dispose(); object.material.dispose(); } });
  host.remove();
  return { toggles, strictMode: true, scaleAndTargetPreserved: true, staleRestoreIgnored: true, explicitRestoreApplied: true, resize: true };
}
