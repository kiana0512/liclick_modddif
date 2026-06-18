import type { ViewportExportInput } from './exportTypes';
import { downloadBlob, getExportFilename } from './exportUtils';

export async function exportViewportSnapshot(input: ViewportExportInput) {
  input.viewport.gl.render(input.viewport.scene, input.viewport.camera);
  const canvas = input.viewport.gl.domElement;
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => (result ? resolve(result) : reject(new Error('Could not encode viewport snapshot.'))), 'image/png');
  });
  downloadBlob(blob, getExportFilename(input.project.name, 'viewport', 'png'));
}
