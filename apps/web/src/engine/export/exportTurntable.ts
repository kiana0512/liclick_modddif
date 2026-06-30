import * as THREE from 'three';
import {
  PROJECTED_LAYER_MATERIAL_USER_DATA_KEY,
  type ProjectedLayerProjectionData,
} from '@/engine/projection/ProjectedLayerMaterial';
import type { TurntableExportInput } from './exportTypes';
import { downloadBlob, getExportFilename } from './exportUtils';

export function canRecordTurntable() {
  return typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement !== 'undefined';
}

function getMaterialList(material: THREE.Material | THREE.Material[]) {
  return Array.isArray(material) ? material : [material];
}

function syncProjectedLayerMaterialProjection(root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  const currentObjectMatrixInverse = root.matrixWorld.clone().invert();

  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const material of getMaterialList(object.material)) {
      const projectionData = material.userData[
        PROJECTED_LAYER_MATERIAL_USER_DATA_KEY
      ] as ProjectedLayerProjectionData | undefined;
      if (!projectionData?.layers?.length) continue;
      const shaderMaterial = material as THREE.ShaderMaterial;
      if (!shaderMaterial.uniforms) continue;

      for (const layer of projectionData.layers) {
        const matrixDelta = layer.objectMatrixWorld
          ? new THREE.Matrix4().fromArray(layer.objectMatrixWorld).multiply(currentObjectMatrixInverse)
          : new THREE.Matrix4();
        const normalDelta = new THREE.Matrix3().getNormalMatrix(matrixDelta);
        const matrixUniform = shaderMaterial.uniforms[layer.objectMatrixDeltaUniform];
        const normalUniform = shaderMaterial.uniforms[layer.objectNormalDeltaUniform];
        if (matrixUniform?.value instanceof THREE.Matrix4) {
          matrixUniform.value.copy(matrixDelta);
        } else if (matrixUniform) {
          matrixUniform.value = matrixDelta;
        }
        if (normalUniform?.value instanceof THREE.Matrix3) {
          normalUniform.value.copy(normalDelta);
        } else if (normalUniform) {
          normalUniform.value = normalDelta;
        }
      }
    }
  });
}

export async function exportTurntableWebm(input: TurntableExportInput) {
  if (!canRecordTurntable()) throw new Error('This browser does not support MediaRecorder.');

  const durationMs = input.durationMs ?? 5000;
  const canvas = input.viewport.gl.domElement;
  const stream = canvas.captureStream(30);
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : 'video/webm';
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks: Blob[] = [];
  const originalRotationY = input.root.rotation.y;

  await new Promise<void>((resolve, reject) => {
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onerror = () => reject(new Error('Turntable recording failed.'));
    recorder.onstop = () => resolve();
    recorder.start();

    const startedAt = performance.now();
    const step = (time: number) => {
      const progress = Math.min(1, (time - startedAt) / durationMs);
      input.root.rotation.y = originalRotationY + progress * Math.PI * 2;
      input.root.updateMatrixWorld(true);
      syncProjectedLayerMaterialProjection(input.root);
      input.viewport.gl.render(input.viewport.scene, input.viewport.camera);
      if (progress < 1) {
        requestAnimationFrame(step);
        return;
      }
      input.root.rotation.y = originalRotationY;
      input.root.updateMatrixWorld(true);
      syncProjectedLayerMaterialProjection(input.root);
      input.viewport.gl.render(input.viewport.scene, input.viewport.camera);
      recorder.stop();
      stream.getTracks().forEach((track) => track.stop());
    };
    requestAnimationFrame(step);
  });

  downloadBlob(new Blob(chunks, { type: mimeType }), getExportFilename(input.project.name, 'turntable', 'webm'));
}
