import { GLTFExporter } from 'three-stdlib';
import type { ModelExportInput } from './exportTypes';
import { downloadBlob, getExportFilename } from './exportUtils';
import { prepareTexturedModelExport } from './texturedExportUtils';

export async function exportModelGlb(input: ModelExportInput) {
  const exporter = new GLTFExporter();
  const { root, texture } = await prepareTexturedModelExport(input);
  // Li3D atlases are encoded in top-left canvas space. GLTFExporter only
  // converts that image into glTF's bottom-left UV convention when flipY is
  // enabled; leaving it disabled produces a valid GLB with a vertically
  // mismatched texture in DCC tools such as Blender.
  if (texture) texture.flipY = true;
  const result = await exporter.parseAsync(root, { binary: true, onlyVisible: true, embedImages: true });
  const buffer = result instanceof ArrayBuffer ? result : JSON.stringify(result);
  const blob = new Blob([buffer], { type: 'model/gltf-binary' });
  downloadBlob(blob, getExportFilename(input.project.name, input.target, 'glb'));
}
