import type { Object3D } from 'three';
import type { ModelExportInput } from './exportTypes';

export function slugifyExportName(value: string | undefined) {
  const slug = (value ?? 'liclick-project')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'liclick-project';
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function getExportFilename(projectName: string | undefined, suffix: string, extension: string) {
  return `${slugifyExportName(projectName)}_${suffix}.${extension}`;
}

export function getExportRoot(input: ModelExportInput): Object3D {
  input.importedModel.group.updateMatrixWorld(true);
  if (input.target === 'object') {
    const selected =
      input.selectedObjectId && input.importedModel.objectId === input.selectedObjectId
        ? input.importedModel.group
        : undefined;
    if (!selected) throw new Error('No selected object is available for export.');
    return selected;
  }
  return input.importedModel.group;
}

export function isEditorOnlyExportObject(object: Object3D) {
  return Boolean(
    object.userData.liclickPaintOverlay ||
      object.userData.liclickViewportHelper ||
      object.userData.liclickSelectionGlow ||
      object.userData.liclickWireframeOverlay ||
      object.userData.liclickInpaintMaskOverlay ||
      object.userData.liclickPaintStrokePreview,
  );
}

export function cloneExportRoot(input: ModelExportInput): Object3D {
  const root = getExportRoot(input).clone(true);
  const editorOnlyObjects: Object3D[] = [];
  root.traverse((object) => {
    if (object !== root && isEditorOnlyExportObject(object)) editorOnlyObjects.push(object);
  });
  // Remove helpers after traversal. Removing children during traverse mutates
  // the array being iterated and can leave an adjacent overlay in the export.
  editorOnlyObjects.forEach((object) => object.removeFromParent());
  root.updateMatrixWorld(true);
  return root;
}
