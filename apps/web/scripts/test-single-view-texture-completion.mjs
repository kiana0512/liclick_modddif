/* global AbortController */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { projectionGapMaskFromAlpha } from '../src/engine/projection/projectionCoverageContract.mjs';

const root = path.resolve(import.meta.dirname, '..');
const [panel, textureMapPrompts, workerClient, worker] = await Promise.all([
  fs.readFile(path.join(root, 'src/components/panels/GeneratePanel.tsx'), 'utf8'),
  fs.readFile(path.join(root, 'src/engine/generation/textureMapPrompts.ts'), 'utf8'),
  fs.readFile(
    path.join(root, 'src/engine/localRepaint/generationInputWorker.ts'),
    'utf8',
  ),
  fs.readFile(path.join(root, 'src/workers/localRepaintGenerationInput.worker.ts'), 'utf8'),
]);

assert.match(
  panel,
  /!isMultiviewRequest\s*&&\s*hasVisibleTextureLayerCandidate\(objectId\)/,
  'existing-texture inspection must be shared by GPT and remote single-view generation',
);
assert.match(
  panel,
  /captureCurrentColorPreview\(\{[\s\S]*?colorMode: 'flat-target-coverage'[\s\S]*?cameraSnapshot: singleViewCameraSnapshot/,
  'the current BaseColor effect must use the frozen single-view camera',
);
assert.match(
  panel,
  /prepareSingleViewTextureCompletion\(\{[\s\S]*?currentEffectUrl:[\s\S]*?clayPreviewUrl:[\s\S]*?objectMaskUrl:/,
  'the guide must combine current effect, clay and the exact object silhouette',
);
assert.match(
  panel,
  /capture:\s*\{[\s\S]*?\.\.\.view\.capture,[\s\S]*?colorUrl: completionGuideUrl[\s\S]*?\}/,
  'the generated guide must replace only the Atlas input image',
);
assert.doesNotMatch(
  panel,
  /maskUrl: singleViewCompletion!\.completionMaskUrl!/,
  'the local gap mask must not crop the full Atlas result or its projection',
);
assert.match(
  panel,
  /texturePrompt = texturePromptBuilders!\.buildTextureMapCompletionPrompt\(prompt\)/,
  'GPT partial coverage must select the white-model completion prompt',
);
assert.match(
  panel,
  /usesRemoteSingleViewInpaint = singleViewCompletion\.hasVisibleTexture[\s\S]*?generateSingleViewInpaint\([\s\S]*?mask:\s*\{[\s\S]*?completion-mask\.png[\s\S]*?completionMaskDataUrl/,
  'remote partial coverage must route the fused image and RGB gap mask to single-view inpaint',
);
assert.match(
  panel,
  /if \(usesRemoteSingleView && singleViewCompletion\.uncoveredPixelCount === 0\)[\s\S]*?当前视角已经全部有贴图/,
  'fully covered remote views must not overwrite existing texture',
);
assert.match(
  panel,
  /return modelviewClient\.generateSingleView\([\s\S]*?white-model\.png/,
  'remote all-clay views must retain the full-generation endpoint and original white image',
);
const panelAst = ts.createSourceFile('GeneratePanel.tsx', panel, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let submitView;
let handleReference;
let submitRemoteView;
function findSubmitView(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'submitGptTextureView') submitView = node;
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'handleGeneratePairedMultiview') handleReference = node;
  if (ts.isArrowFunction(node) && node.parameters[0]?.getText(panelAst).includes('capture, generationId, modelViewReference, pendingGeneration')) submitRemoteView = node;
  ts.forEachChild(node, findSubmitView);
}
findSubmitView(panelAst);
assert.ok(submitRemoteView, 'The actual per-view submit callback must exist');
const remoteSubmitJs = ts.transpileModule(`const submit = ${submitRemoteView.getText(panelAst)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
for (const inpaint of [false, true]) for (const normalUrl of ['same-camera-normal', undefined]) {
  const calls = [];
  const signal = new AbortController().signal;
  const scope = {
    signal, throwIfTexturePipelineCancelled() {}, usesRemoteSingleView: true,
    currentSingleViewEffectUrl: 'frozen-current-effect-with-coverage',
    usesRemoteSingleViewInpaint: inpaint, currentProject: { id: 'project' }, object: { id: 'object' },
    materialReference: { id: 'reference', url: 'reference-bytes' }, referenceGroupId: () => 'group',
    singleViewCompletion: { completionMaskUrl: 'unchanged-expanded-mask' }, urlToDataUrl: async url => url,
    modelviewClient: { ...Object.fromEntries(['generateSingleView', 'generateSingleViewInpaint'].map(name =>
      [name, async (input, options) => { calls.push({ name, input, options }); return 'result'; }])),
      prepareResultBlend: async (current, capture, blendSignal) => {
        assert.equal(blendSignal, signal);
        return { version: 1, currentImage: { dataUrl: current }, objectMask: { dataUrl: capture.maskUrl }, camera: capture.camera };
      },
    },
  };
  const submit = new Function(...Object.keys(scope), `${remoteSubmitJs}; return submit;`)(...Object.values(scope));
  const camera = { projection: 'orthographic', projectionMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1] };
  const input = { capture: { id: 'capture', colorUrl: 'unchanged-whitefill', normalUrl, maskUrl: 'frozen-object-mask', camera },
    generationId: 'generation', modelViewReference: { id: 'view' } };
  if (!normalUrl) {
    await assert.rejects(submit(input), /法线图不可用/);
    assert.equal(calls.length, 0);
    continue;
  }
  assert.equal(await submit(input), 'result');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, inpaint ? 'generateSingleViewInpaint' : 'generateSingleView');
  assert.deepEqual(calls[0].input.normalImage, { path: 'capture-normal.png', dataUrl: normalUrl });
  assert.equal(calls[0].input.image.dataUrl, 'unchanged-whitefill');
  assert.equal(calls[0].input.mask?.dataUrl, inpaint ? 'unchanged-expanded-mask' : 'frozen-object-mask');
  if (inpaint) {
    assert.equal(calls[0].input.resultBlend.currentImage.dataUrl, 'frozen-current-effect-with-coverage');
    assert.equal(calls[0].input.resultBlend.objectMask.dataUrl, 'frozen-object-mask');
    assert.deepEqual(calls[0].input.resultBlend.camera, camera);
    assert.equal(calls[0].input.resultBlend.version, 1);
  } else assert.equal(calls[0].input.resultBlend, undefined);
  assert.equal(calls[0].input.prompt, undefined);
  assert.equal(calls[0].options.signal, signal);
}
assert.ok(submitView, 'The shared GPT submission helper must exist.');
const submitJs = ts.transpileModule(submitView.getText(panelAst), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const optionsSource = await fs.readFile(path.join(root, 'src/engine/generation/gptTextureModels.ts'), 'utf8');
const optionsJs = ts.transpileModule(optionsSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const optionExports = {};
new Function('exports', optionsJs)(optionExports);
const submitScope = { createLiclickApiClient: () => ({ generateTextureSingleView: (request) => request }),
  currentProject: { id: 'project' }, objects: [], resolution: '4K', imageSize: 'auto', imageModel: 'gpt-image-2.5-flare',
  aspectRatio: 'auto', textureGptQuality: 'max', textureGptModel: 'gpt-image-2.5-flare',
  getGptTextureRequestParameters: optionExports.getGptTextureRequestParameters };
const submit = new Function(...Object.keys(submitScope), `${submitJs}; return submitGptTextureView;`)(...Object.values(submitScope));
const guide = { id: 'guide' }, material = { id: 'material' }, capture = { objectId: 'object' };
const request = submit('generation', 'completion prompt', guide, material, capture);
assert.deepEqual(request.referenceIds, ['guide', 'material']);
assert.deepEqual(request.referenceImages, [guide, material], 'Atlas receives exactly the guide then material reference.');
assert.equal(request.capture, capture);
assert.equal(request.count, 1);
assert.equal(request.imageSize, '2K', 'A 4K viewport requests 2K GPT output, independent of the old auto image setting');
assert.equal(request.resolution, '4K', 'The project/UV resolution is not downgraded');
assert.equal(request.aspectRatio, '1:1');
assert.equal(request.quality, 'max');
assert.equal(request.model, 'gpt-image-2.5-flare');
assert.match(panel, /return submitGptTextureViewWithSilhouetteRetry\(\s*pendingGeneration,\s*modelViewReference,\s*materialReference,\s*capture,\s*signal/);
assert.match(textureMapPrompts, /只在图一指定的待补全区域绘制材质，不重新生成物体/);
assert.match(
  textureMapPrompts,
  /只修改图一中的白模、Clay、Primer或指定待补全区域/,
  'completion must fill every unfinished white-model region',
);
assert.match(
  textureMapPrompts,
  /外轮廓、内部孔洞、零件边界、遮挡关系、视图数量和排版必须严格不变/,
  'low-poly smoothing must remain an interior material operation and never reshape the silhouette',
);
assert.match(
  textureMapPrompts,
  /轮廓对齐优先于材质表现/,
);
assert.match(
  textureMapPrompts,
  /已经贴好的纹理区域保持不变，不对整张图重新调色、打光或去光照。保留原有背景及透明区域/,
  'single-view and multiview GPT2 generation must preserve every pixel outside white-model regions',
);
assert.match(
  textureMapPrompts,
  /图二只提供材质固有颜色、颜色分区、纹理颗粒、图案、文字、锈迹、污渍、掉漆和磨损/,
  'the material completion must preserve the reference-specific appearance rather than a generic category material',
);
assert.doesNotMatch(
  textureMapPrompts,
  /以参考图一为目标视角，将参考图二的材质外观迁移到图一对应的可见表面/,
  'the old whole-surface fallback prompt must not remain',
);

assert.ok(handleReference, 'The reference action must exist.');
const handleReferenceJs = ts.transpileModule(pipelineTraceDisabled(handleReference.getText(panelAst)), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
for (const lighting of [false, true]) {
  for (const outcome of ['success', 'failure', 'cancelled']) {
    const progress = [], active = [], toasts = [], inputs = [];
    const locks = new Set();
    const reference = { id: lighting ? 'multi' : 'single' };
    const updateProgress = () => {};
    const scope = {
      isMultiviewReference: () => lighting, workflowSubmissionLocked: false,
      submitLocksRef: { current: locks }, notifyWorkflowOperationLocked: () => assert.fail('Unexpected lock'),
      setSubmissionActive: value => active.push(value),
      setTexturePipelineProgress: value => progress.push(value), setGenerateNotice: () => {},
      updateTexturePipelineProgress: updateProgress,
      generatePairedMultiviewReference: async (input, onProgress) => {
        inputs.push(input);
        assert.equal(onProgress, updateProgress);
        assert.equal(locks.has('single'), true);
        if (outcome !== 'success') throw new Error(outcome);
      },
      waitForBrowserPaint: async () => {}, pushToast: toast => toasts.push(toast),
      isGenerationCancellation: error => error.message === 'cancelled',
      getUserFacingGenerationError: error => error.message, multiviewGenerationFailureFallback: 'failed',
    };
    const handle = new Function(...Object.keys(scope), `${handleReferenceJs}; return handleGeneratePairedMultiview;`)(...Object.values(scope));
    await handle(reference);
    assert.deepEqual(inputs, [reference]);
    assert.deepEqual(progress, [{ active: true, progress: 4,
      label: lighting ? '准备光照处理' : '准备多视图参考' }, undefined]);
    assert.deepEqual(active, [true, false]);
    assert.equal(locks.size, 0, 'Success, failure and cancellation must all clear the shared CTA lock');
    assert.deepEqual(toasts.map(toast => toast.tone), outcome === 'cancelled' ? [] : [outcome === 'success' ? 'success' : 'error']);
  }
}
assert.match(
  panel,
  /onProgress\?\.\(16, '提交多视图参考'\)[\s\S]*?onProgress\?\.\(32, lighting \? '光照处理中' : '生成多视图参考'\)[\s\S]*?onProgress\?\.\(88, '保存多视图参考'\)[\s\S]*?onProgress\?\.\(100, '多视图参考已就绪'\)/,
  'paired multiview generation must publish monotonic submission, generation and persistence phases',
);
assert.match(
  panel,
  /backgroundSize: `\$\{textureActionProgress\.progress\}% 100%, 100% 100%`[\s\S]*?`\$\{compactTextureProgressButtonLabel\(textureActionProgress\.label\)\} · \$\{Math\.round\(textureActionProgress\.progress\)\}%`/,
  'the bottom texture CTA must keep the shared progress fill and percentage while compacting only verbose workflow labels',
);

assert.match(worker, /projectionGapMaskFromAlpha\(currentPixels, targetMask\)/);
assert.doesNotMatch(worker, /inferProjectionGapMask/, 'new captures must not infer coverage from artwork RGB');
assert.match(worker, /texturedPixelCount >= Math\.max\(64, Math\.round\(objectPixelCount \* 0\.0005\)\)/);
assert.match(worker, /compositeEdgeRadius = 0/);
for (const policy of [
  /Math\.round\(24 \* scale\)/,
  /Math\.round\(64 \* scale\)/,
  /Math\.round\(dimension \* 0\.25\)/,
  /Math\.round\(dilation \* 0\.2\)/,
]) {
  assert.match(worker, policy, 'remote completion must match local repaint mask expansion policy');
}
assert.match(worker, /const result = boxBlur\(dilateMask\(core/);
assert.match(worker, /const submittedMask = expand\(samplingCore, samplingBounds, dilationRadius, featherRadius\)/);
assert.match(worker, /if \(core\[index\]\) result\[index\] = 255/);
assert.match(worker, /pixels\[offset\] = value[\s\S]*?pixels\[offset \+ 3\] = 255/);
assert.match(worker, /submittedMaskBlob/);
assert.doesNotMatch(worker, /(?:white|gray|grey).*threshold/i, 'coverage must not use a white/grey color heuristic');

const expansionCoreSource = `${worker.slice(
  worker.indexOf('type MaskBounds'),
  worker.indexOf('self.onmessage'),
)}\nexport { getMaskBounds, dilateMask, boxBlur };`;
const expansionCoreCompiled = ts.transpileModule(expansionCoreSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const expansionModule = { exports: {} };
new Function('exports', 'module', expansionCoreCompiled)(
  expansionModule.exports,
  expansionModule,
);
const { getMaskBounds, dilateMask, boxBlur } = expansionModule.exports;
const testWidth = 9;
const testHeight = 9;
const testCoreMask = new Uint8Array(testWidth * testHeight);
testCoreMask[4 * testWidth + 4] = 255;
const testCoreBounds = getMaskBounds(testCoreMask, testWidth, testHeight);
const testDilatedMask = dilateMask(
  testCoreMask,
  testWidth,
  testHeight,
  2,
  testCoreBounds,
);
assert.equal(testDilatedMask[2 * testWidth + 2], 255, 'the submitted mask must grow outward');
assert.equal(testDilatedMask[1 * testWidth + 1], 0, 'mask expansion must stay bounded');
const testFeatheredMask = boxBlur(
  testDilatedMask,
  testWidth,
  testHeight,
  1,
  { minX: 2, minY: 2, maxX: 6, maxY: 6 },
);
assert(
  testFeatheredMask[4 * testWidth + 1] > 0 &&
    testFeatheredMask[4 * testWidth + 1] < 255,
  'the expanded mask must include a non-binary feather band',
);
testFeatheredMask[4 * testWidth + 4] = 255;
assert.equal(testFeatheredMask[4 * testWidth + 4], 255, 'the original gap must remain fully editable');

assert.match(workerClient, /new Worker\([\s\S]*?localRepaintGenerationInput\.worker\.ts/);
assert.match(workerClient, /mode: 'single'/);
assert.match(workerClient, /createRegisteredObjectUrl\(result\.compositeBlob\)/);
assert.match(workerClient, /completionMaskUrl:[\s\S]*?createRegisteredObjectUrl\(result\.submittedMaskBlob\)/);
assert.match(
  await fs.readFile(path.join(root, 'src/engine/capture/captureCurrentView.ts'), 'utf8'),
  /forceEmptyProjectionHatch[\s\S]*?showEmptyProjectionHatch/,
  'coverage capture must enable renderer-owned alpha independently from viewport UI state',
);

// Execute the actual client preparation, including native bitmap arity.
// Array.map supplies (value, index, array); Web APIs must not receive those extras.
const preparationSource = workerClient.slice(
  workerClient.indexOf('async function prepareWorkerInput'),
  workerClient.indexOf('export async function prepareLocalRepaintGenerationInput'),
);
const preparationJs = ts.transpileModule(preparationSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
for (const mode of ['local', 'single']) {
  const blobs = new Map(['effect', 'clay', 'mask'].map((name) => [name, new Blob([name])]));
  const pending = new Map();
  const bitmaps = [];
  const posts = [];
  const prepare = new Function(
    'Worker', 'OffscreenCanvas', 'createImageBitmap', 'readImageBlob',
    'pendingRequests', 'getWorker',
    `let nextRequestId = 1; ${preparationJs}; return prepareWorkerInput;`,
  )(
    class {}, class {},
    async (...args) => {
      assert.equal(args.length, 1, 'createImageBitmap receives only its source, never map index/array');
      assert.ok([...blobs.values()].includes(args[0]));
      const bitmap = { source: args[0], width: 2048, height: 2048, close() {} };
      bitmaps.push(bitmap);
      return bitmap;
    },
    async (url) => blobs.get(url), pending,
    () => ({ postMessage(payload, { transfer }) {
      posts.push(payload);
      assert.deepEqual(transfer, [payload.currentEffect, payload.inputMask, ...(payload.clayPreview ? [payload.clayPreview] : [])]);
      assert.equal(payload.currentEffect.source, blobs.get('effect'));
      assert.equal(payload.clayPreview?.source, mode === 'single' ? blobs.get('clay') : undefined);
      assert.equal(payload.inputMask.source, blobs.get('mask'));
      pending.get(payload.id).resolve({ id: payload.id, mode: payload.mode });
    } }),
  );
  assert.deepEqual(await prepare({ mode, currentEffectUrl: 'effect', clayPreviewUrl: mode === 'single' ? 'clay' : undefined, maskUrl: 'mask' }), { id: 1, mode });
  assert.equal(bitmaps.length, mode === 'single' ? 3 : 2);
  assert.equal(posts.length, 1, 'One complete input reaches the Worker; ModelView no longer decodes clay');
}

// Execute the production Worker: remote white input must preserve authored
// pixels and byte-identical dilation, while the legacy GPT guide stays clay.
class PixelCanvas {
  constructor(width, height) { Object.assign(this, { width, height }); }
  getContext() { return {
    clearRect() {}, drawImage: image => { this.data = image.data; },
    getImageData: () => ({ data: this.data, width: this.width, height: this.height }),
    putImageData: image => { this.data = image.data; },
  }; }
  async convertToBlob() { return new Blob([this.data]); }
}
const runtime = { postMessage(value) { this.result = value; } };
new Function('self', 'OffscreenCanvas', 'ImageData', 'projectionGapMaskFromAlpha',
  ts.transpileModule(worker.replace(/^import[^\n]+\n/gm, '').replace(/export \{\};?/, ''),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText,
)(runtime, PixelCanvas, class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } }, projectionGapMaskFromAlpha);
const width = 128, height = 128;
const effect = new Uint8ClampedArray(width * height * 4);
const clay = new Uint8ClampedArray(effect.length);
const objectPixels = new Uint8ClampedArray(effect.length);
for (let i = 0; i < width * height; i++) {
  const x = i % width, y = Math.floor(i / width);
  const inside = x >= 8 && x < 120 && y >= 8 && y < 120;
  const gap = inside && x >= 45 && x < 85 && y >= 45 && y < 85;
  effect.set([i % 173, i % 131, i % 83, gap ? 0 : 255], i * 4);
  clay.set([123, 124, 125, 255], i * 4);
  objectPixels.set([inside ? 255 : 0, inside ? 255 : 0, inside ? 255 : 0, 255], i * 4);
}
let released = 0;
const bitmap = data => ({ data, width, height, close() { released++; } });
async function runWhite(whiteFill, fullObject = false, pixels = effect) {
  await runtime.onmessage({ data: { id: 42, mode: 'single', whiteFill, fullObject,
    currentEffect: bitmap(pixels), inputMask: bitmap(objectPixels),
    ...(whiteFill ? {} : { clayPreview: bitmap(clay) }),
  } });
  assert.equal(runtime.result.error, undefined);
  return runtime.result;
}
const legacy = await runWhite(false);
const remote = await runWhite(true);
assert.equal(released, 5, 'Remote white input releases two bitmaps, legacy GPT three');
assert.equal(remote.uncoveredPixelCount, 1600);
assert.equal(remote.hasVisibleTexture, true);
assert.deepEqual(await remote.submittedMaskBlob.arrayBuffer(), await legacy.submittedMaskBlob.arrayBuffer(),
  'Remote expansion and feathering must be byte-identical to the previous completion mask');
const output = new Uint8Array(await remote.compositeBlob.arrayBuffer());
for (let i = 0; i < width * height; i++) {
  const expected = !objectPixels[i * 4] ? [0, 0, 0, 255]
    : effect[i * 4 + 3] < 255 ? [255, 255, 255, 255] : [...effect.subarray(i * 4, i * 4 + 4)];
  assert.deepEqual([...output.subarray(i * 4, i * 4 + 4)], expected);
}
const allWhite = await runWhite(true, true);
assert.equal(allWhite.hasVisibleTexture, false);
const fullPixels = new Uint8Array(await allWhite.compositeBlob.arrayBuffer());
for (let i = 0; i < width * height; i++) assert.deepEqual([...fullPixels.subarray(i * 4, i * 4 + 4)],
  objectPixels[i * 4] ? [255, 255, 255, 255] : [0, 0, 0, 255]);
const covered = await runWhite(true, false, clay);
assert.equal(covered.uncoveredPixelCount, 0);
assert.equal(covered.compositeBlob, undefined, 'Covered views must be skipped rather than regenerated');
console.log('Single-view completion: remote white/black pixels, unchanged RGB expanded mask, full/partial/covered inputs and legacy GPT passed.');
import { pipelineTraceDisabled } from './pipeline-trace-test-build.mjs';
