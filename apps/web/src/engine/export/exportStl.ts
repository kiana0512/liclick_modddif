import { STLExporter } from 'three-stdlib';
import type { ModelExportInput } from './exportTypes';
import { cloneExportRoot, downloadBlob, getExportFilename } from './exportUtils';

export function exportModelStl(input: ModelExportInput) {
  const exporter = new STLExporter();
  const output = exporter.parse(cloneExportRoot(input), { binary: false });
  const blob = new Blob([output], { type: 'model/stl' });
  downloadBlob(blob, getExportFilename(input.project.name, input.target, 'stl'));
}
