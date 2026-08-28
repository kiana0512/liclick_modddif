import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/components/panels/LayersPanel.tsx', import.meta.url),
  'utf8',
);
const menuSource = source.slice(source.indexOf('function LayerMenu('));
const eraserPolicySource = await readFile(
  new URL('../src/engine/paint/eraserTargetPolicy.ts', import.meta.url),
  'utf8',
);
const viewportSource = await readFile(
  new URL('../src/engine/viewport/ViewportCanvas.tsx', import.meta.url),
  'utf8',
);

assert.match(
  source,
  /function getLocalRepaintPreviewMaskUrl[\s\S]{0,220}return layer\.localRepaintMaskUrl \|\| layer\.maskUrl;/,
  'local repaint thumbnails must prefer the authored brush mask over the blend mask',
);
assert.match(
  source,
  /if \(isLocalRepaintPreview && !previewMaskUrl\) return null;/,
  'legacy local repaint thumbnails without a mask must not expose the full returned image',
);
assert.match(
  source,
  /该旧局部重绘图层缺少涂绘蒙版，无法显示区域预览。/,
  'the enlarged legacy preview must fail closed when authored coverage is unavailable',
);

for (const removedAction of [
  "t('moveLayerUp')",
  "t('moveLayerDown')",
  "t('replaceLayerImage')",
  "t('localRepaintEditLayer')",
]) {
  assert.ok(!menuSource.includes(removedAction), `${removedAction} should not appear in the layer menu`);
}

for (const retainedAction of [
  "t('view')",
  "t('imageEditLayerMenu')",
  "t('duplicate')",
  "t('contentAwareEditableCopy')",
  "t('downloadImage')",
  "t('clearEraserMask')",
  "t('rename')",
  "t('delete')",
]) {
  assert.ok(menuSource.includes(retainedAction), `${retainedAction} should remain in the layer menu`);
}

assert.match(
  eraserPolicySource,
  /function hasClearableProjectedEraserMask[\s\S]*?layer\.type === 'projected'[\s\S]*?!isLocalRepaintEraserLayer\(layer\)[\s\S]*?layer\.maskSpace === 'uv'[\s\S]*?layer\.eraserAlgorithmVersion === ERASER_ALGORITHM_VERSION/,
  'clear mask must target only versioned ordinary projected-layer eraser keep-masks',
);
assert.match(
  source,
  /dispatchEvent\([\s\S]*?'liclick:clear-projected-eraser-mask'[\s\S]*?maskUrl: undefined[\s\S]*?maskSpace: undefined[\s\S]*?eraserAlgorithmVersion: undefined/,
  'the menu action must cancel the live runtime before removing persistent eraser-mask ownership',
);
assert.match(
  viewportSource,
  /const clearProjectedEraserRuntime[\s\S]*?cancelProjectedEraserBatch\(layerId\)[\s\S]*?disposeUvPaintLayer\(paintLayer\)[\s\S]*?layerRef\.current = undefined[\s\S]*?addEventListener\('liclick:clear-projected-eraser-mask'/,
  'clearing a mask must cancel deferred refinement and discard the stable live canvas session',
);

console.log('layer context-menu policy regression passed');
