import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/components/panels/ReferenceGroupPicker.tsx', import.meta.url),
  'utf8',
);

assert.match(
  source,
  /onClick=\{\(\) => \{\s*if \(selected\) \{\s*setPreviewReference\(reference\);\s*return;\s*\}\s*selectReference\(reference\);\s*\}\}/,
  'reference thumbnail should select on first click and preview the selected reference on the next click',
);
assert.doesNotMatch(
  source,
  /selectReference\(reference\);\s*setPreviewReference\(reference\)/,
  'switching references must not unexpectedly open the large preview',
);
assert.match(
  source,
  /selected\s*\? `再次单击预览\$\{role === 'multi-view'/,
  'reference thumbnail tooltip should describe the select-then-preview behavior',
);

console.log('reference selection and preview regression passed');
