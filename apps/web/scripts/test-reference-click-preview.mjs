import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/components/panels/ReferenceGroupPicker.tsx', import.meta.url),
  'utf8',
);

assert.match(
  source,
  /onClick=\{\(\) => \{\s*if \(selected\) \{\s*setPreviewReference\(reference\);\s*return;\s*\}\s*selectReference\(reference\);\s*\}\}/,
  'an unselected reference should only be selected; the already-selected reference should preview',
);
assert.doesNotMatch(
  source,
  /selectReference\(reference\);\s*setPreviewReference\(reference\)/,
  'selection and preview must not happen in the same click',
);
assert.match(
  source,
  /selected\s*\? `再次单击预览\$\{role === 'multi-view'/,
  'the selected thumbnail tooltip should explain the second-click preview behavior',
);

console.log('reference select-then-preview regression passed');
