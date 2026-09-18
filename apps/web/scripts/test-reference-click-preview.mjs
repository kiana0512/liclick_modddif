import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/components/panels/ReferenceGroupPicker.tsx', import.meta.url),
  'utf8',
);

assert.match(
  source,
  /state\?\.status === 'generating' \? '处理中' : role === 'multi-view' \? '去光影处理' : '生成多视图'/,
  'multi-view menu uses the requested delight label without changing single-view or busy labels',
);

assert.match(
  source,
  /onClick=\{\(\) => \{\s*if \(disabled \|\| selected\) \{\s*setPreviewReference\(reference\);\s*return;\s*\}\s*selectReference\(reference\);\s*\}\}/,
  'locked tasks only preview; otherwise unselected references select and selected references preview',
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

const body = source.match(/onClick=\{\(\) => \{(\s*if \(disabled \|\| selected\)[\s\S]*?selectReference\(reference\);)\s*\}\}/)[1];
const click = new Function('disabled','selected','reference','setPreviewReference','selectReference',body);
for (const disabled of [false,true]) for (const selected of [false,true]) {
  const calls=[];
  click(disabled,selected,'ref',r=>calls.push(['preview',r]),r=>calls.push(['select',r]));
  assert.deepEqual(calls,[[disabled || selected ? 'preview' : 'select','ref']]);
}
console.log('reference select-then-preview and locked preview-only regression passed');
