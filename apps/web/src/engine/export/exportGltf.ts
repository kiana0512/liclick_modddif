import { GLTFExporter } from 'three-stdlib';
import type { ModelExportInput } from './exportTypes';
import { downloadBlob, getExportFilename } from './exportUtils';
import { prepareTexturedModelExport } from './texturedExportUtils';

export async function exportModelGlb(input: ModelExportInput) {
  const exporter = new GLTFExporter();
  const { root } = await prepareTexturedModelExport(input);
  const result = await exporter.parseAsync(root, { binary: true, onlyVisible: true, embedImages: true });
  const buffer = result instanceof ArrayBuffer ? result : JSON.stringify(result);
  const blob = new Blob([buffer], { type: 'model/gltf-binary' });
  downloadBlob(blob, getExportFilename(input.project.name, input.target, 'glb'));
}
