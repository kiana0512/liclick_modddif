import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(
  scriptDirectory,
  '../src/engine/localRepaint/inwardCrossfadeMask.ts',
);
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: sourcePath,
}).outputText;
const module = { exports: {} };
new Function('exports', 'module', compiled)(module.exports, module);
const { createLocalRepaintInwardCrossfadePixels } = module.exports;

const width = 25;
const height = 25;
const sourcePixels = new Uint8ClampedArray(width * height * 4);
for (let y = 3; y <= 21; y += 1) {
  for (let x = 3; x <= 21; x += 1) {
    const offset = (y * width + x) * 4;
    sourcePixels.set([255, 255, 255, 255], offset);
  }
}
const sourceSnapshot = sourcePixels.slice();
const derived = createLocalRepaintInwardCrossfadePixels({
  source: sourcePixels,
  width,
  height,
  crossfadeWidth: 6,
});
const weightAt = (x, y) => derived[(y * width + x) * 4];

assert.deepEqual(sourcePixels, sourceSnapshot, 'the authored brush mask must remain untouched');
assert.equal(weightAt(2, 12), 0, 'outside the repaint footprint remains fully projected');
assert.equal(weightAt(3, 12), 0, 'the repaint outline begins with zero repaint opacity');
assert.ok(weightAt(4, 12) > 0, 'opacity must start increasing just inside the outline');
assert.ok(
  weightAt(5, 12) > weightAt(4, 12),
  'the local repaint weight must increase monotonically toward the core',
);
assert.equal(weightAt(10, 12), 255, 'the repaint core must remain fully opaque');
assert.equal(weightAt(12, 12), 255, 'the narrow transition must not dim the whole layer');

for (let x = 2; x <= 10; x += 1) {
  const localRepaintWeight = weightAt(x, 12);
  const lowerProjectionWeight = 255 - localRepaintWeight;
  assert.equal(
    localRepaintWeight + lowerProjectionWeight,
    255,
    'the two stack contributions must be complementary',
  );
}

const viewportSource = fs.readFileSync(
  path.resolve(scriptDirectory, '../src/engine/viewport/ViewportCanvas.tsx'),
  'utf8',
);
const editorPageSource = fs.readFileSync(
  path.resolve(scriptDirectory, '../src/routes/EditorPage.tsx'),
  'utf8',
);
assert.match(viewportSource, /maskUrl:\s*composite\.blendMaskUrl/);
assert.match(viewportSource, /localRepaintMaskUrl:\s*composite\.maskUrl/);
assert.match(
  viewportSource,
  /existingLayer\?\.localRepaintMaskUrl\s*\?\?\s*existingLayer\?\.maskUrl/,
  'reloading must restore the canonical authored mask rather than the derived stack mask',
);
assert.match(editorPageSource, /-local-repaint-authored-mask\.png/);
assert.doesNotMatch(
  editorPageSource,
  /layer\.localRepaintMaskUrl\s*=\s*layer\.maskUrl/,
  'workspace save must not collapse the authored and derived masks back into one asset',
);

console.log('Local repaint inward-crossfade checks passed.');
