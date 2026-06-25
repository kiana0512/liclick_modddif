import { OBJExporter } from 'three-stdlib';
import type { ModelExportInput } from './exportTypes';
import { createZipBlob } from './exportZip';
import { downloadBlob, getExportFilename } from './exportUtils';
import { EXPORT_BASECOLOR_MATERIAL_NAME, prepareTexturedModelExport } from './texturedExportUtils';

function createMtl(textureFilename: string) {
  return [
    `newmtl ${EXPORT_BASECOLOR_MATERIAL_NAME}`,
    'Ka 1.000 1.000 1.000',
    'Kd 1.000 1.000 1.000',
    'Ks 0.000 0.000 0.000',
    'd 1.000',
    'illum 2',
    `map_Kd ${textureFilename}`,
    '',
  ].join('\n');
}

export async function exportModelObj(input: ModelExportInput) {
  const exporter = new OBJExporter();
  const { root, textureBlob, textureFilename } = await prepareTexturedModelExport(input);
  const objFilename = getExportFilename(input.project.name, input.target, 'obj');
  const mtlFilename = getExportFilename(input.project.name, input.target, 'mtl');
  const output = exporter.parse(root);
  if (textureBlob && textureFilename) {
    const objWithMtl = `mtllib ${mtlFilename}\n${output}`;
    const zip = await createZipBlob([
      { path: objFilename, data: objWithMtl },
      { path: mtlFilename, data: createMtl(textureFilename) },
      { path: textureFilename, data: textureBlob },
    ]);
    downloadBlob(zip, getExportFilename(input.project.name, `${input.target}_obj_textured`, 'zip'));
    return;
  }
  const blob = new Blob([output], { type: 'text/plain;charset=utf-8' });
  downloadBlob(blob, objFilename);
}
