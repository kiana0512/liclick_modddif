import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

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
  /usesRemoteSingleViewInpaint = true[\s\S]*?generateSingleViewInpaint\([\s\S]*?mask:\s*\{[\s\S]*?completion-mask\.png[\s\S]*?completionMaskDataUrl/,
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
  'remote all-clay views must retain the original two-image generation path',
);
const panelAst = ts.createSourceFile('GeneratePanel.tsx', panel, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let submitView;
function findSubmitView(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'submitGptTextureView') submitView = node;
  ts.forEachChild(node, findSubmitView);
}
findSubmitView(panelAst);
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
  aspectRatio: 'auto', textureGptQuality: 'max',
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
assert.match(panel, /return submitGptTextureView\(\s*generationId,\s*pendingGeneration.prompt,\s*modelViewReference,\s*materialReference,\s*capture/);
assert.match(textureMapPrompts, /只在图一上进行材质补全，不重新生成物体/);
assert.match(
  textureMapPrompts,
  /只修改图一中的白色、浅灰色、Clay、Primer或未贴图区域/,
  'completion must fill every unfinished white-model region',
);
assert.match(
  textureMapPrompts,
  /最终外轮廓、内部孔洞、真实部件边界、视图数量和排版必须与图一严格一致/,
  'low-poly smoothing must remain an interior material operation and never reshape the silhouette',
);
assert.match(
  textureMapPrompts,
  /轮廓对齐高于所有其他要求/,
);
assert.match(
  textureMapPrompts,
  /图一中已有材质的区域、背景和透明区域必须保持原始颜色、纹理和光影不变/,
  'single-view and multiview GPT2 generation must preserve every pixel outside white-model regions',
);
assert.match(
  textureMapPrompts,
  /准确参考图二特有的Base Color、颜色变化、纹理颗粒、尺度、方向、粗糙度和磨损；不要只生成普通的同类材质/,
  'the material completion must preserve the reference-specific appearance rather than a generic category material',
);
assert.doesNotMatch(
  textureMapPrompts,
  /以参考图一为目标视角，将参考图二的材质外观迁移到图一对应的可见表面/,
  'the old whole-surface fallback prompt must not remain',
);

assert.match(
  panel,
  /async function handleGeneratePairedMultiview[\s\S]*?setTexturePipelineProgress\(\{ active: true, progress: 4, label: '准备多视图参考' \}\)[\s\S]*?generatePairedMultiviewReference\(singleReference, updateTexturePipelineProgress\)[\s\S]*?setTexturePipelineProgress\(undefined\)/,
  'standalone single-view reference completion must drive and clear the shared CTA progress',
);
assert.match(
  panel,
  /onProgress\?\.\(16, '提交多视图参考'\)[\s\S]*?onProgress\?\.\(32, '生成多视图参考'\)[\s\S]*?onProgress\?\.\(88, '保存多视图参考'\)[\s\S]*?onProgress\?\.\(100, '多视图参考已就绪'\)/,
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
assert.match(worker, /compositeEdgeRadius = isSingleViewCompletion \? 0/);
for (const policy of [
  /Math\.round\(24 \* scale\)/,
  /Math\.round\(64 \* scale\)/,
  /Math\.round\(minimumDimension \* 0\.25\)/,
  /Math\.round\(dilationRadius \* 0\.2\)/,
]) {
  assert.match(worker, policy, 'remote completion must match local repaint mask expansion policy');
}
assert.match(worker, /const dilated = dilateMask\(compositeCore/);
assert.match(worker, /const submittedMask = boxBlur\([\s\S]*?dilated/);
assert.match(worker, /if \(compositeCore\[index\] > 0\) submittedMask\[index\] = 255/);
assert.match(worker, /pixels\[offset\] = value[\s\S]*?pixels\[offset \+ 3\] = 255/);
assert.match(worker, /submittedMaskBlob/);
assert.doesNotMatch(worker, /white|gray|grey.*threshold/i, 'coverage must not use a white/grey color heuristic');

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
      assert.deepEqual(transfer, [payload.currentEffect, payload.clayPreview, payload.inputMask]);
      assert.equal(payload.currentEffect.source, blobs.get('effect'));
      assert.equal(payload.clayPreview.source, blobs.get('clay'));
      assert.equal(payload.inputMask.source, blobs.get('mask'));
      pending.get(payload.id).resolve({ id: payload.id, mode: payload.mode });
    } }),
  );
  assert.deepEqual(await prepare({ mode, currentEffectUrl: 'effect', clayPreviewUrl: 'clay', maskUrl: 'mask' }), { id: 1, mode });
  assert.equal(bitmaps.length, 3);
  assert.equal(posts.length, 1, 'One complete, ordered input triplet reaches the Worker');
}

console.log('Single-view texture completion and local repaint bitmap dispatch regression checks passed.');
