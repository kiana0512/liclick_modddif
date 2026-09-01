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
assert.doesNotMatch(
  exportMenu,
  /\bCheck\b|\bX\b/,
  'export capability rows must not render supported or unsupported status icons',
);
assert.match(
  exportMenu,
  /disabled:text-white\/30/,
  'unsupported export capabilities must remain visible with muted text',
);

console.log('Automatic UV merge color export regression checks passed.');
