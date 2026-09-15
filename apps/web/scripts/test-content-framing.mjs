import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as contracts from '../../../packages/contracts/dist/index.js';
const source = readFileSync(
  new URL('../src/engine/generation/contentFraming.ts', import.meta.url),
  'utf8',
);
const module = { exports: {} };
new Function(
  'module',
  'exports',
  'require',
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
)(module, module.exports, () => contracts);
const { findContentFraming, restoredFrameLayout, validateFramedSilhouette } = module.exports;
function coverage(width, height, rect, normal = false) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = rect.y; y < rect.y + rect.h; y++)
    for (let x = rect.x; x < rect.x + rect.w; x++)
      data.set(normal ? [0, 120, 255, 255] : [255, 255, 255, 255], (y * width + x) * 4);
  return { width, height, data };
}
for (const rect of [
  { x: 15, y: 25, w: 170, h: 49 },
  { x: 60, y: 5, w: 30, h: 190 },
  { x: 0, y: 0, w: 220, h: 220 },
  { x: 90, y: 100, w: 1, h: 1 },
]) {
  const frame = findContentFraming(coverage(220, 220, rect));
  assert.ok(frame.left < rect.x && frame.top < rect.y);
  assert.ok(
    frame.left + frame.width > rect.x + rect.w && frame.top + frame.height > rect.y + rect.h,
  );
  assert.ok(Math.max(frame.width / frame.height, frame.height / frame.width) <= 3);
  assert.equal(frame.width, frame.height);
  assert.deepEqual(contracts.generationFramingRatio(frame), { width: 1, height: 1 });
  const border = Math.max(2, Math.ceil(Math.max(rect.w, rect.h) * 0.01));
  assert.equal(frame.width, Math.max(rect.w, rect.h) + 2 * border);
  assert.equal(frame.outputWidth, frame.outputHeight);
  for (const scale of [1, 2, 3]) {
    const layout = restoredFrameLayout(
      { ...frame, version: 1 },
      frame.width * scale,
      frame.height * scale,
    );
    for (const [x, y] of [
      [0, 0],
      [rect.x, rect.y],
      [rect.x + rect.w, rect.y + rect.h],
      [220, 220],
    ]) {
      assert.ok(
        Math.abs(
          (layout.left + ((x - frame.left) * layout.patchWidth) / frame.width) / layout.width -
            x / 220,
        ) < 1e-10,
      );
      assert.ok(
        Math.abs(
          (layout.top + ((y - frame.top) * layout.patchHeight) / frame.height) / layout.height -
            y / 220,
        ) < 1e-10,
      );
    }
    assert.ok(
      layout.patchWidth >= frame.width * scale && layout.patchHeight >= frame.height * scale,
    );
  }
  assert.deepEqual(findContentFraming(coverage(220, 220, rect, true), true), frame);
}
const exact = {
  version: 1,
  sourceWidth: 2048,
  sourceHeight: 2048,
  left: 40,
  top: 100,
  width: 1710,
  height: 1470,
};
assert.deepEqual(contracts.generationOutputSize(69, 100, '1K'), { width: 848, height: 1232 });
assert.throws(() => contracts.generationOutputSize(0, 1, '2K'));
for (const [w, h, ow, oh] of [
  [1507, 597, 3248, 1296],
  [1742, 593, 3504, 1200],
  [1740, 593, 3504, 1200],
  [1514, 617, 3216, 1312],
  [1478, 859, 2688, 1568],
  [1472, 958, 2544, 1648],
]) {
  assert.deepEqual(contracts.generationOutputSize(w, h, '2K'), { width: ow, height: oh });
  assert.doesNotThrow(() => restoredFrameLayout({ ...exact, width: w, height: h }, ow, oh));
}
for (const imageSize of ['1K', '2K', '4K']) {
  for (const rect of [
    { x: 60, y: 30, w: 150, h: 60 },
    { x: 80, y: 10, w: 70, h: 170 },
    { x: 0, y: 0, w: 220, h: 220 },
  ]) {
    const f = findContentFraming(coverage(220, 220, rect), false, imageSize);
    assert.equal(f.version, 2);
    assert.ok(f.ratioWidth <= 100 && f.ratioHeight <= 100);
    assert.equal(f.width * f.outputHeight, f.height * f.outputWidth);
    assert.ok(f.cropBounds.left >= f.left && f.cropBounds.top >= f.top);
    assert.ok(f.cropBounds.left + f.cropBounds.width <= f.left + f.width);
    const l = restoredFrameLayout(f, f.outputWidth, f.outputHeight);
    assert.equal(l.patchWidth, f.outputWidth);
    assert.equal(l.patchHeight, f.outputHeight);
    const s = f.outputWidth / f.width;
    assert.ok(Math.abs(l.left - f.left * s) <= 0.5);
    assert.ok(Math.abs(l.top - f.top * s) <= 0.5);
    assert.throws(() => restoredFrameLayout(f, f.outputWidth + 16, f.outputHeight), /比例/);
    const box = {
      x: Math.round((rect.x - f.left) * s),
      y: Math.round((rect.y - f.top) * s),
      w: Math.round(rect.w * s),
      h: Math.round(rect.h * s),
    };
    const pixels = coverage(f.outputWidth, f.outputHeight, box);
    let checkpoints = 0;
    await validateFramedSilhouette(f, pixels, async () => {
      checkpoints++;
    });
    assert.ok(checkpoints > 0);
    await assert.rejects(
      () =>
        validateFramedSilhouette(f, pixels, async () => {
          throw new Error('cancel');
        }),
      /cancel/,
    );
    const changed = coverage(f.outputWidth, f.outputHeight, { ...box, w: Math.floor(box.w / 2) });
    await assert.rejects(() => validateFramedSilhouette(f, changed), /轮廓/);
    await assert.rejects(
      () =>
        validateFramedSilhouette(
          f,
          coverage(f.outputWidth, f.outputHeight, { x: 0, y: 0, w: 0, h: 0 }),
        ),
      /轮廓/,
    );
  }
}
assert.deepEqual(contracts.generationFramingRatio(exact), { width: 57, height: 49 });
assert.throws(() => restoredFrameLayout(exact, 2048, 2048), /比例/);
assert.doesNotThrow(() => restoredFrameLayout(exact, 1711, 1470));
const bottomFrame = { ...exact, left: 25, top: 253, width: 1998, height: 1542 };
const roundedBottom = restoredFrameLayout(bottomFrame, 2336, 1792);
assert.equal(roundedBottom.patchWidth, 2336);
assert.equal(roundedBottom.patchHeight, 1792);
assert.ok(Number.isInteger(roundedBottom.left) && Number.isInteger(roundedBottom.top));
assert.ok(roundedBottom.left >= 0 && roundedBottom.top >= 0);
assert.ok(roundedBottom.left + 2336 <= roundedBottom.width);
assert.ok(roundedBottom.top + 1792 <= roundedBottom.height);
assert.throws(() => restoredFrameLayout(bottomFrame, 2416, 1792), /比例/);
assert.throws(() => restoredFrameLayout(bottomFrame, 2335, 1792), /比例/);
assert.throws(() => findContentFraming(coverage(10, 10, { x: 0, y: 0, w: 0, h: 0 })), /轮廓/);
assert.throws(() => restoredFrameLayout({ ...exact, width: 10, height: 10 }, 2048, 2048), /安全/);
for (const change of [
  { version: 2 },
  { width: 0 },
  { height: NaN },
  { left: Infinity },
  { width: 30001 },
  { height: 1 },
  { left: 2048 },
])
  assert.throws(() => contracts.validateGenerationFraming({ ...exact, ...change }));
const routes = readFileSync(new URL('../../server/src/routes/liclick.ts', import.meta.url), 'utf8');
assert.ok(
  (routes.match(/framing: job.input.framing/g) ?? []).length === 3,
  'Submission, poll and list recovery all retain crop coordinates',
);
const panel = readFileSync(
  new URL('../src/components/panels/GeneratePanel.tsx', import.meta.url),
  'utf8',
);
assert.match(panel, /!workspaceResultUrl && job.framing && resultUrl === job.resultUrl/);
console.log(
  'Content framing: geometry bounds, border, custom 57:49, 3:1 cap, exact inverse UV, result validation and recovery passed.',
);

// Actual API orchestration with isolated image/HTTP fixtures (no remote task).
function evaluate(code, deps) {
  const m = { exports: {} };
  new Function(
    'module',
    'exports',
    'require',
    ts.transpileModule(code, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
  )(m, m.exports, (name) => {
    assert.ok(name in deps, name);
    return deps[name];
  });
  return m.exports;
}
let prepared = 0,
  restores = 0,
  requests = 0,
  reply;
const oldFetch = globalThis.fetch,
  oldWindow = globalThis.window;
globalThis.window = { setTimeout, clearTimeout };
globalThis.fetch = async (_url, init) => {
  requests++;
  if (init.body) {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.framing, exact);
    assert.equal(body.references[0].url, 'cropped-guide');
  }
  return { ok: true, json: async () => reply };
};
const clientModule = evaluate(
  readFileSync(new URL('../src/services/liclickApiClient.ts', import.meta.url), 'utf8'),
  {
    './liclickTransport': {
      resolveLiclickTransport: async () => ({
        baseUrl: 'https://fixture.invalid',
        credentials: 'include',
      }),
    },
    './generationErrorMessage': { getUserFacingGenerationError: (m) => m },
    './referenceImagePreprocessor': { prepareReferenceForAtlas: async (r) => r },
    '@/utils/mapWithConcurrency': {
      mapWithConcurrency: async (items, _limit, fn) => {
        const output = [];
        for (const i of items) output.push(await fn(i));
        return output;
      },
    },
    '@/engine/generation/contentFramingImages': {
      prepareContentFraming: async () => {
        prepared++;
        return {
          framing: exact,
          references: [{ id: 'guide', name: 'guide', url: 'cropped-guide' }],
          exactIds: ['guide'],
        };
      },
      restoreContentFraming: async (url, frame, signal) => {
        signal?.throwIfAborted();
        restores++;
        assert.deepEqual(frame, exact);
        return 'restored:' + url;
      },
    },
  },
);
try {
  const client = clientModule.createLiclickApiClient();
  const input = {
    mode: 'single',
    workflow: 'texture-map',
    model: 'gpt-image-2.5-sunburst',
    capture: { id: 'capture' },
    referenceIds: ['guide'],
  };
  reply = {
    id: 'job',
    status: 'succeeded',
    resultUrl: 'remote',
    resultUrls: ['remote'],
    framing: exact,
  };
  const immediate = await client.generateTextureSingleView(input);
  assert.equal(immediate.resultUrl, 'restored:remote');
  assert.equal(immediate.metadata.framingRestored, true);
  assert.equal(restores, 1);
  reply = { id: 'job', status: 'running', framing: exact };
  await client.generateTextureSingleView(input);
  assert.equal(restores, 1);
  reply = { id: 'job', status: 'succeeded', resultUrl: 'remote', framing: exact };
  const polled = await client.getGenerationJob('job');
  assert.equal(polled.resultUrl, 'restored:remote');
  assert.equal((await clientModule.restoreFramedJobResult(polled)).resultUrl, 'restored:remote');
  assert.equal(restores, 2, 'Never apply the crop twice');
  reply = { jobs: [{ id: 'job', status: 'succeeded', resultUrl: 'remote', framing: exact }] };
  const jobs = await client.listGenerationJobs('project');
  assert.equal(restores, 2, 'Listing historical jobs must not decode every image');
  assert.equal((await clientModule.restoreFramedJobResult(jobs[0])).resultUrl, 'restored:remote');
  const old = { resultUrl: 'legacy' };
  assert.equal(await clientModule.restoreFramedJobResult(old), old);
  const abort = new globalThis.AbortController();
  abort.abort();
  const previous = requests;
  await assert.rejects(() => client.generateTextureSingleView({ ...input, signal: abort.signal }));
  assert.equal(requests, previous);
  assert.equal(prepared, 2);
} finally {
  globalThis.fetch = oldFetch;
  globalThis.window = oldWindow;
}
console.log(
  'Framing API: exact payload, immediate/polled results, lazy history recovery, no double restore and cancellation passed.',
);

// Run the production image adapter with deterministic RGBA canvas fixtures.
const fixtures = new Map();
const canvases = [];
const originalImage = globalThis.Image,
  originalDocument = globalThis.document;
globalThis.Image = class {
  set src(url) {
    this.url = url;
    if (!url) return;
    const pixels = fixtures.get(url);
    this.naturalWidth = pixels.width;
    this.naturalHeight = pixels.height;
    globalThis.queueMicrotask(() => this.onload?.());
  }
  get src() {
    return this.url;
  }
};
globalThis.document = {
  createElement() {
    let clip;
    const canvas = {
      width: 0,
      height: 0,
      pixels: undefined,
      getContext() {
        return {
          beginPath() {},
          rect(x, y, w, h) {
            clip = [x, y, w, h];
          },
          clip() {},
          drawImage(image, dx, dy, dw, dh) {
            const source = fixtures.get(image.src);
            if (dw !== undefined) {
              assert.equal(dw, source.width);
              assert.equal(dh, source.height);
            }
            assert.ok(Number.isInteger(dx) && Number.isInteger(dy));
            const data = new Uint8ClampedArray(canvas.width * canvas.height * 4);
            for (let y = 0; y < canvas.height; y++)
              for (let x = 0; x < canvas.width; x++) {
                if (
                  clip &&
                  (x < clip[0] || y < clip[1] || x >= clip[0] + clip[2] || y >= clip[1] + clip[3])
                )
                  continue;
                const sx = x - dx,
                  sy = y - dy;
                if (sx >= 0 && sy >= 0 && sx < source.width && sy < source.height)
                  data.set(
                    source.data.subarray(
                      (sy * source.width + sx) * 4,
                      (sy * source.width + sx) * 4 + 4,
                    ),
                    (y * canvas.width + x) * 4,
                  );
              }
            canvas.pixels = { width: canvas.width, height: canvas.height, data };
          },
        };
      },
      toBlob(callback) {
        callback(canvas.pixels);
      },
    };
    canvases.push(canvas);
    return canvas;
  },
};
let sequence = 0;
const imageAdapter = evaluate(
  readFileSync(
    new URL('../src/engine/generation/contentFramingImages.ts', import.meta.url),
    'utf8',
  ),
  {
    '@/services/workspaceApiClient': { urlToDataUrl: async (url) => url },
    '@/engine/localRepaint/imageUtils': {
      urlToImageData: async (url) => fixtures.get(url),
      blobToDataUrl: async (pixels) => {
        const url = `encoded-${sequence++}`;
        fixtures.set(url, pixels);
        return url;
      },
    },
    './contentFraming': module.exports,
    '@/utils/browserScheduling': { yieldToBrowserTask: async () => {} },
  },
);
try {
  fixtures.set('normal', coverage(220, 220, { x: 30, y: 70, w: 150, h: 60 }, true));
  const combined = coverage(220, 220, { x: 0, y: 0, w: 220, h: 220 });
  // Nonconstant opaque background proves newly added padding is not copied from the source.
  for (let i = 0; i < combined.data.length; i += 4) combined.data[i] = (i / 4) % 251;
  fixtures.set('combined', combined);
  const capture = { width: 220, height: 220, normalUrl: 'normal', maskUrl: 'author-mask' };
  const references = [
    { id: 'combined', url: 'combined' },
    { id: 'normal', url: 'normal' },
    { id: 'material', url: 'untouched' },
  ];
  const preparedInput = await imageAdapter.prepareContentFraming({
    workflow: 'local-repaint',
    imageSize: '1K',
    capture,
    referenceImages: references,
  });
  assert.deepEqual(preparedInput.exactIds, ['combined', 'normal']);
  assert.equal(preparedInput.references[2], references[2]);
  assert.equal(capture.maskUrl, 'author-mask');
  const f = preparedInput.framing,
    c = f.cropBounds;
  for (let index = 0; index < 2; index++) {
    const actual = fixtures.get(preparedInput.references[index].url),
      sourcePixels = fixtures.get(references[index].url);
    for (let y = 0; y < f.height; y++)
      for (let x = 0; x < f.width; x++) {
        const sx = x + f.left,
          sy = y + f.top;
        const inside =
          sx >= c.left &&
          sy >= c.top &&
          sx < c.left + c.width &&
          sy < c.top + c.height &&
          sx >= 0 &&
          sy >= 0 &&
          sx < 220 &&
          sy < 220;
        for (let channel = 0; channel < 4; channel++)
          assert.equal(
            actual.data[(y * f.width + x) * 4 + channel],
            inside ? sourcePixels.data[(sy * 220 + sx) * 4 + channel] : 0,
          );
      }
  }
  const scale = f.outputWidth / f.width,
    s = f.subject;
  fixtures.set(
    'remote-output',
    coverage(f.outputWidth, f.outputHeight, {
      x: Math.round((s.left - f.left) * scale),
      y: Math.round((s.top - f.top) * scale),
      w: Math.round(s.width * scale),
      h: Math.round(s.height * scale),
    }),
  );
  const restoredUrl = await imageAdapter.restoreContentFraming('remote-output', f);
  assert.equal(
    fixtures.get(restoredUrl).width,
    restoredFrameLayout(f, f.outputWidth, f.outputHeight).width,
  );
  assert.ok(canvases.every((c) => c.width === 0 && c.height === 0));
  const before = canvases.length;
  const abort = new globalThis.AbortController();
  abort.abort();
  await assert.rejects(() => imageAdapter.restoreContentFraming('remote-output', f, abort.signal));
  assert.equal(canvases.length, before);
} finally {
  globalThis.Image = originalImage;
  globalThis.document = originalDocument;
}
console.log(
  'Framing image adapter: byte-exact paired crop, transparent padding, unchanged references/mask, native return and cancellation passed.',
);
