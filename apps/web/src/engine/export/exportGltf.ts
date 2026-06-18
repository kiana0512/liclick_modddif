import { GLTFExporter } from 'three-stdlib';
import type { ModelExportInput } from './exportTypes';
import { downloadBlob, getExportFilename, getExportRoot } from './exportUtils';

export async function exportModelGlb(input: ModelExportInput) {
  const exporter = new GLTFExporter();
  const root = getExportRoot(input).clone(true);
  const result = await exporter.parseAsync(root, { binary: true, onlyVisible: true });
  const buffer = result instanceof ArrayBuffer ? result : JSON.stringify(result);
  const blob = new Blob([buffer], { type: 'model/gltf-binary' });
  downloadBlob(blob, getExportFilename(input.project.name, input.target, 'glb'));
}
