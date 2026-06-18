import { OBJExporter } from 'three-stdlib';
import type { ModelExportInput } from './exportTypes';
import { downloadBlob, getExportFilename, getExportRoot } from './exportUtils';

export function exportModelObj(input: ModelExportInput) {
  const exporter = new OBJExporter();
  const output = exporter.parse(getExportRoot(input).clone(true));
  const blob = new Blob([output], { type: 'text/plain;charset=utf-8' });
  downloadBlob(blob, getExportFilename(input.project.name, input.target, 'obj'));
}
