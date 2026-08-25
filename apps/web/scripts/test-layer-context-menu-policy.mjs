import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/components/panels/LayersPanel.tsx', import.meta.url),
  'utf8',
);
const menuSource = source.slice(source.indexOf('function LayerMenu('));

for (const removedAction of [
  "t('moveLayerUp')",
  "t('moveLayerDown')",
  "t('clearMask')",
  "t('replaceLayerImage')",
  "t('localRepaintEditLayer')",
]) {
  assert.ok(!menuSource.includes(removedAction), `${removedAction} should not appear in the layer menu`);
}

for (const retainedAction of [
  "t('view')",
  "t('imageEditLayerMenu')",
  "t('duplicate')",
  "t('downloadImage')",
  "t('rename')",
  "t('delete')",
]) {
  assert.ok(menuSource.includes(retainedAction), `${retainedAction} should remain in the layer menu`);
}

console.log('layer context-menu policy regression passed');
