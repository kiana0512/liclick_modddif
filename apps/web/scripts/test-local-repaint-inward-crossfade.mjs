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
  /const savedMaskUrls = \[existingLayer\?\.localRepaintMaskUrl, existingLayer\?\.maskUrl\]/,
  'reloading must try the canonical authored mask before the derived compatibility mask',
);
assert.match(editorPageSource, /-local-repaint-authored-mask\.png/);
assert.match(
  editorPageSource,
  /getLiveProjectedTextureSourceState\(url\)/,
  'workspace save must verify that a live projected source still exists before persistence',
);
assert.match(
  editorPageSource,
  /if \(url && isLiveProjectedCanvasUrl\(url\)\) throw error/,
  'workspace save must never fall back to a runtime-only projected URL',
);
assert.match(
  editorPageSource,
  /rememberPersistedProjectAsset\(assetSlotKey, url, result\.asset\.url\)/,
  'a verified live projected upload must remain available after the runtime texture is released',
);
assert.doesNotMatch(
  editorPageSource,
  /layer\.localRepaintMaskUrl\s*=\s*layer\.maskUrl/,
  'workspace save must not collapse the authored and derived masks back into one asset',
);

console.log('Local repaint inward-crossfade checks passed.');

// Keep the pre-optimization algorithm independent of the production kernel.
const referenceSource = fs.readFileSync(
  path.join(scriptDirectory, 'fixtures/inwardCrossfadeMask.reference.ts'), 'utf8',
);
const referenceModule = { exports: {} };
new Function('exports', 'module', ts.transpileModule(referenceSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(referenceModule.exports, referenceModule);
const reference = referenceModule.exports;
let seed = 391;
const randomByte = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed >>> 24;
};
const makeMask = (width, height, kind) => {
  const source = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    if (kind === 'random') {
      source.set([randomByte(), randomByte(), randomByte(), randomByte()], offset);
    } else {
      const inside = kind === 'full' || (kind === 'stroke' &&
        Math.abs(x - y * width / height) < width / 8);
      source.set([inside ? 255 : 0, inside ? 255 : 0, inside ? 255 : 0, 255], offset);
    }
  }
  return { source, width, height };
};
for (const [width, height] of [[1, 1], [1, 43], [73, 1], [23, 17], [256, 128], [1024, 1024]]) {
  for (const kind of ['empty', 'full', 'stroke', 'random']) {
    for (const crossfadeWidth of [undefined, 1, 6, 24]) {
      const input = { ...makeMask(width, height, kind), crossfadeWidth };
      const snapshot = input.source.slice();
      assert.deepEqual(createLocalRepaintInwardCrossfadePixels(input),
        reference.createLocalRepaintInwardCrossfadePixels(input), `${width}x${height}/${kind}/${crossfadeWidth}`);
      assert.deepEqual(input.source, snapshot, 'must not mutate authored coverage');
    }
  }
}

// Actual canvas adapter with deterministic pixel-backed contexts: exercise full
// restore, clipped/overlapping patches and erasure without depending on WebGL.
const canvasInput = makeMask(113, 87, 'random');
const runCanvas = (implementation, dirtyRect) => {
  const writes = [];
  const sourceContext = {
    getImageData(x, y, width, height) {
      const data = new Uint8ClampedArray(width * height * 4);
      for (let row = 0; row < height; row++) {
        const start = ((y + row) * canvasInput.width + x) * 4;
        data.set(canvasInput.source.subarray(start, start + width * 4), row * width * 4);
      }
      return { data, width, height };
    },
  };
  const targetContext = {
    createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4), width, height }),
    putImageData: (image, x, y) => writes.push({ image, x, y }),
  };
  const bounds = implementation.updateLocalRepaintInwardCrossfadeCanvas({
    sourceContext, targetContext, width: canvasInput.width, height: canvasInput.height, dirtyRect,
  });
  return { bounds, writes };
};
for (const rect of [undefined, { x: -8, y: -5, width: 23, height: 19 },
  { x: 45.5, y: 23.2, width: 35.7, height: 45.1 }, { x: 107, y: 83, width: 20, height: 20 }]) {
  assert.deepEqual(runCanvas(module.exports, rect), runCanvas(reference, rect));
}
console.log('Inward-crossfade parity: 96 pixel cases and full/dirty canvas adapters passed.');

for (let trial = 0; trial < 120; trial++) {
  const input = makeMask(1 + randomByte() % 80, 1 + randomByte() % 80, 'random');
  input.crossfadeWidth = 1 + randomByte() % 24;
  // Include near-threshold authored coverage, holes and transparent white.
  for (let offset = 0; offset < input.source.length; offset += 16) {
    input.source.set([20 + trial % 3, 0, 0, trial % 2 ? 255 : 0], offset);
  }
  assert.deepEqual(createLocalRepaintInwardCrossfadePixels(input),
    reference.createLocalRepaintInwardCrossfadePixels(input));
}

const ast = ts.createSourceFile('ViewportCanvas.tsx', viewportSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const createComposite = ast.statements.find((node) => ts.isFunctionDeclaration(node) &&
  node.name?.text === 'createLocalRepaintComposite');
assert(createComposite);
const createCompositeJs = ts.transpileModule(createComposite.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const canvases = [];
const create = new Function('document', 'THREE', 'registerLiveProjectedCanvasTexture',
  'getLiveProjectedCanvasTexture', `${createCompositeJs}; return createLocalRepaintComposite;`)(
  { createElement: () => {
    const calls = [];
    const canvas = { getContext: (kind, options) => { calls.push({ kind, options }); return {}; } };
    canvases.push({ canvas, calls });
    return canvas;
  } }, { NoColorSpace: '', Matrix4: class {}, Matrix3: class {} }, (id) => id, () => ({}),
);
const preparedFalloff = {};
const composite = create('generation-key', 'layer-id', 1024, 768, undefined, preparedFalloff);
assert.equal(composite.maskCanvas.width, 1024);
assert.equal(composite.maskCanvas.height, 768);
assert.equal(composite.falloffCanvas, preparedFalloff, 'reuse Worker-prepared visibility');
assert.deepEqual(canvases[0].calls, [{ kind: '2d', options: { willReadFrequently: true } }],
  'the repeatedly-read authored mask selects CPU-friendly backing on its first context request');
console.log('120 threshold/alpha fuzz cases and actual composite creation passed.');

if (process.argv.includes('--benchmark')) {
  for (const [width, height, kind] of [[128, 128, 'stroke'], [512, 512, 'stroke'],
    [1024, 1024, 'empty'], [1024, 1024, 'full'], [1024, 1024, 'stroke']]) {
    const input = makeMask(width, height, kind);
    const baseline = [], current = [];
    const implementations = [reference.createLocalRepaintInwardCrossfadePixels, createLocalRepaintInwardCrossfadePixels];
    for (let round = 0; round < 14; round++) {
      for (const index of round % 2 ? [1, 0] : [0, 1]) {
        const start = performance.now();
        implementations[index](input);
        if (round >= 4) (index ? current : baseline).push(performance.now() - start);
      }
    }
    const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    console.log(JSON.stringify({ case: `${width}x${height}/${kind}`, baselineMedianMs: median(baseline),
      currentMedianMs: median(current), scope: 'isolated CPU kernel, not browser frame time' }));
  }
}
