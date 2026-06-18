import type { TurntableExportInput } from './exportTypes';
import { downloadBlob, getExportFilename } from './exportUtils';

export function canRecordTurntable() {
  return typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement !== 'undefined';
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
      input.viewport.gl.render(input.viewport.scene, input.viewport.camera);
      if (progress < 1) {
        requestAnimationFrame(step);
        return;
      }
      input.root.rotation.y = originalRotationY;
      input.root.updateMatrixWorld(true);
      input.viewport.gl.render(input.viewport.scene, input.viewport.camera);
      recorder.stop();
      stream.getTracks().forEach((track) => track.stop());
    };
    requestAnimationFrame(step);
  });

  downloadBlob(new Blob(chunks, { type: mimeType }), getExportFilename(input.project.name, 'turntable', 'webm'));
}
