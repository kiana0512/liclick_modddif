import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createServer } from 'vite';
const { AbortController } = globalThis;

// Execute the production dispatch expression: both reachable modes must keep
// their exact source/mask/depth arguments without retaining the dead fallback.
const panel = await readFile(new URL('../src/components/panels/GeneratePanel.tsx', import.meta.url), 'utf8');
assert.doesNotMatch(panel, /createSubjectFilledPreview/);
const panelAst = ts.createSourceFile('panel.tsx', panel, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let dispatch;
const visit = (node) => {
  if (ts.isVariableDeclaration(node) && node.name.getText(panelAst) === 'previewPromise')
    dispatch = node.initializer.getText(panelAst);
  ts.forEachChild(node, visit);
};
visit(panelAst);
assert.ok(dispatch);
const dispatchJs = ts.transpileModule(`const result = ${dispatch};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
for (const mode of ['capture-mask', 'generated-display']) {
  const calls = [];
  const run = new Function('previewProcessingMode', 'sourceUrl', 'capturePreviewMaskUrl',
    'previewProcessingDepthUrl', 'previewRequest', 'createCaptureMaskedPreview', 'createGeneratedDisplayPreview',
    `${dispatchJs}\nreturn result;`);
  const previewRequest = { signal: new AbortController().signal };
  const result = await run(mode, 'source', 'mask', 'depth', previewRequest,
    async (...args) => { calls.push(['mask', ...args]); return 'masked'; },
    async (...args) => { calls.push(['depth', ...args]); return { fittedUrl: 'fitted' }; });
  assert.equal(result, mode === 'capture-mask' ? 'masked' : 'fitted');
  assert.deepEqual(calls, [mode === 'capture-mask' ? ['mask', 'source', 'mask', previewRequest] : ['depth', 'source', 'depth', previewRequest]]);
}

class TestImageData {
  constructor(dataOrWidth, widthOrHeight, maybeHeight) {
    if (typeof dataOrWidth === 'number') {
      this.width = dataOrWidth;
      this.height = widthOrHeight;
      this.data = new Uint8ClampedArray(this.width * this.height * 4);
      return;
    }
    this.data = dataOrWidth;
    this.width = widthOrHeight;
    this.height = maybeHeight;
  }
}

globalThis.ImageData = TestImageData;

const width = 17;
const height = 9;
const source = new ImageData(width, height);
const mask = new ImageData(width, height);
for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 4;
    const foreground = x >= 7;
    source.data[offset] = foreground ? 190 : x === 6 ? 80 : 12;
    source.data[offset + 1] = foreground ? 160 : x === 6 ? 60 : 10;
    source.data[offset + 2] = foreground ? 120 : x === 6 ? 45 : 16;
    source.data[offset + 3] = 255;
    const coverage = x <= 3 ? 0 : x === 4 ? 64 : x === 5 ? 180 : 255;
    mask.data[offset] = coverage;
    mask.data[offset + 1] = coverage;
    mask.data[offset + 2] = coverage;
    mask.data[offset + 3] = 255;
  }
}
const originalSource = new Uint8ClampedArray(source.data);

const server = await createServer({
  root: fileURLToPath(new URL('../', import.meta.url)),
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true, watch: { ignored: () => true } },
});

try {
  const { applyCapturePreviewMask, applyCaptureProjectionImage } = await server.ssrLoadModule(
    '/src/engine/localRepaint/resultPreviewUtils.ts',
  );
  const output = applyCapturePreviewMask(source, mask);
  const pixel = (x, y) =>
    Array.from(output.data.slice((y * width + x) * 4, (y * width + x) * 4 + 4));

  assert.deepEqual(pixel(3, 4), [0, 0, 0, 0], 'masked background must be fully transparent');
  assert.equal(pixel(5, 4)[3], 180, 'antialiased capture alpha must be preserved');
  assert(
    pixel(5, 4)[0] > 170 && pixel(6, 4)[0] > 170,
    'dark RGB contamination at the silhouette must be replaced from the subject interior',
  );
  assert.deepEqual(
    pixel(12, 4),
    [190, 160, 120, 255],
    'interior material colour must remain unchanged',
  );
  assert.deepEqual(
    source.data,
    originalSource,
    'preview processing must not mutate the generation result',
  );
  assert.throws(
    () => applyCapturePreviewMask(source, new ImageData(width - 1, height)),
    /dimensions must match/,
  );

  const projection = applyCaptureProjectionImage(source, mask);
  const projectionPixel = (x, y) =>
    Array.from(projection.data.slice((y * width + x) * 4, (y * width + x) * 4 + 4));
  assert.equal(projection.width, source.width, 'projection cleanup must preserve capture width');
  assert.equal(projection.height, source.height, 'projection cleanup must preserve capture height');
  assert.equal(
    projectionPixel(3, 4)[3],
    255,
    'projection colour must stay opaque because its capture mask owns coverage',
  );
  assert(
    projectionPixel(3, 4)[0] > 170,
    'clean subject colour must bleed outside the mask to protect filtered edge samples',
  );
  assert.deepEqual(
    projectionPixel(12, 4),
    [190, 160, 120, 255],
    'projection cleanup must preserve interior material colour',
  );
  assert.deepEqual(
    source.data,
    originalSource,
    'projection processing must not mutate the generation result',
  );

  stdout.write('Generation preview and projection edge decontamination regression test passed.\n');
} finally {
  await server.close();
}
