import { STLExporter } from 'three-stdlib';
import type { ModelExportInput } from './exportTypes';
import { downloadBlob, getExportFilename, getExportRoot } from './exportUtils';

export function exportModelStl(input: ModelExportInput) {
  const exporter = new STLExporter();
  const output = exporter.parse(getExportRoot(input).clone(true), { binary: false });
  const blob = new Blob([output], { type: 'model/stl' });
  downloadBlob(blob, getExportFilename(input.project.name, input.target, 'stl'));
}
