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
const { findContentFraming, restoredFrameLayout } = module.exports;
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
  for (const scale of [1, 2, 3]) {
    const layout = restoredFrameLayout(frame, frame.width * scale, frame.height * scale);
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
