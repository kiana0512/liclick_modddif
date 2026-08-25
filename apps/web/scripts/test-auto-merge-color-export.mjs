import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const editorPage = await readFile(
  new URL('../src/routes/EditorPage.tsx', import.meta.url),
  'utf8',
);
const exportMenu = await readFile(
  new URL('../src/components/editor/ExportMenu.tsx', import.meta.url),
  'utf8',
);

assert.match(
  editorPage,
  /async function autoMergeUvAndExportBaseColor\(\)[\s\S]*resolveBakeUvMergePlan[\s\S]*mergeLayersToUvLayer[\s\S]*exportTextureUrl/,
  'color texture export must resolve and execute the UV merge before downloading',
);
assert.match(
  editorPage,
  /'texture-color': autoMergeUvAndExportBaseColor/,
  'the export menu color action must use the automatic UV merge pipeline',
);
assert.doesNotMatch(
  exportMenu,
  /\{ id: 'texture-normal'/,
  'the normal texture export row must stay hidden',
);

console.log('Automatic UV merge color export regression checks passed.');
