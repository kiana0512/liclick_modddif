import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
// Browser-global fixtures must finish before the next module installs its mocks.
await import('./test-gpt-repaint-normal.mjs');

function load(relative, dependencies = {}) {
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const module = { exports: {} };
  new Function('exports', 'module', 'require', code)(module.exports, module, (name) => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name];
  });
  return module.exports;
}

const { composeGptRepaintGuide } = load('../src/engine/localRepaint/gptGuide.ts');
const current = new Uint8ClampedArray([
  140, 70, 20, 255, // retained texture
  255, 255, 255, 255, // valid white texture must NOT be classified as a gap
  140, 70, 20, 255, // authored selection
  0, 0, 0, 0, // untextured
  80, 40, 10, 254, // partially covered stripe
  8, 8, 16, 255, // background
  120, 90, 50, 255, // low-strength brush selection
]);
const clay = new Uint8ClampedArray(Array.from({ length: 7 }, (_, i) => [180 + i, 180, 170, 255]).flat());
const mask = new Uint8ClampedArray(28);
mask.set([255, 255, 255, 255], 8);
mask.set([1, 1, 1, 255], 24);
const original = current.slice();
const originalMask = mask.slice();
const output = composeGptRepaintGuide(current, clay, mask);
for (const i of [0, 1, 5]) assert.deepEqual(output.slice(i * 4, i * 4 + 4), current.slice(i * 4, i * 4 + 4));
for (const i of [2, 3, 4, 6]) assert.deepEqual(output.slice(i * 4, i * 4 + 4), clay.slice(i * 4, i * 4 + 4));
assert.deepEqual(current, original);
assert.deepEqual(mask, originalMask, 'Guide creation must never expand the authored write mask');
assert.throws(() => composeGptRepaintGuide(current, clay.slice(4), mask), /dimensions/);

const gptOptions = load('../src/engine/generation/gptTextureModels.ts');
const { GPT_TEXTURE_MODELS, resolveGptTextureModel, GPT_TEXTURE_QUALITIES,
  resolveGptTextureQuality, getGptTextureRequestParameters, getGptTextureQualities } = gptOptions;
const { buildGptLocalRepaintRequest } = load('../src/services/gptLocalRepaintRequest.ts', {
  '@/engine/generation/gptTextureModels': gptOptions,
});
const { buildGptRepaintPrompt } = load('../src/engine/localRepaint/gptRepaintPrompt.ts');
assert.equal(resolveGptTextureModel('gpt-image-2'), 'gpt-image-2');
assert.equal(GPT_TEXTURE_MODELS.length, 3);
assert.deepEqual(getGptTextureQualities('gpt-image-2').map(({value}) => value), ['low', 'medium', 'high']);
assert.equal(resolveGptTextureModel(undefined), GPT_TEXTURE_MODELS[0].value);
assert.equal(resolveGptTextureQuality(undefined), 'high');
assert.equal(resolveGptTextureQuality('invalid'), 'high');
assert.throws(() => getGptTextureRequestParameters('8K', 'max'), /仅支持/);
assert.deepEqual(GPT_TEXTURE_QUALITIES.map(({ value }) => value), ['low', 'medium', 'high', 'xhigh', 'max']);
for (const { value: model } of GPT_TEXTURE_MODELS) for (const resolution of ['1K', '2K', '4K']) for (const { value: quality } of GPT_TEXTURE_QUALITIES) {
  const expectedQuality = model === 'gpt-image-2' && ['xhigh', 'max'].includes(quality) ? 'high' : quality;
  const expectedImageSize = resolution === '4K' ? '2K' : resolution;
  assert.equal(resolveGptTextureModel(model), model);
  const capture = { id: 'capture', width: 2048, height: 2048, maskUrl: 'private-authored-mask', camera: {}, depthUrl: 'private-depth' };
  const reference = { id: 'reference', name: 'reference.png', url: 'material-image' };
  const input = buildGptLocalRepaintRequest({ generationId: 'job', projectId: 'project', model,
    prompt: buildGptRepaintPrompt('保持原色', true), capture, reference, guideUrl: 'guide-image', normalUrl: 'normal-image', resolution, quality });
  assert.equal(input.model, model);
  assert.equal(input.workflow, 'local-repaint');
  assert.equal(input.prompt, buildGptRepaintPrompt('保持原色', true));
  assert.deepEqual(input.referenceImages.map((item) => item.url), ['guide-image', 'normal-image', 'material-image']);
  assert.equal(input.referenceImages.length, 3);
  assert.deepEqual(input.pixelExactReferenceIds, ['job-guide', 'job-normal']);
  assert.equal(input.capture.maskUrl, 'private-authored-mask');
  assert.equal(input.mask, undefined);
  assert.equal(input.aspectRatio, '1:1');
  assert.equal(input.imageSize, expectedImageSize);
  assert.equal(input.quality, expectedQuality);
  const textureParams = getGptTextureRequestParameters(resolution, quality, model);
  assert.deepEqual(textureParams, { aspectRatio: '1:1', imageSize: expectedImageSize, quality: expectedQuality, count: 1 });
}

const clipCalls = [];
const alphaPolicy = load('../src/engine/localRepaint/resultAlphaPolicy.ts', {
  './modelSilhouetteClip': { MODEL_SILHOUETTE_CLIP_VERSION: 2,
    prepareModelClippedRepaint: async (...args) => { clipCalls.push(args); return 'clipped-result'; } },
});
const { prepareCloudRepaintCompletion } = load('../src/engine/localRepaint/cloudCompletion.ts', {
  './resultAlphaPolicy': alphaPolicy,
});
const { prepareRepaintResult, preservesRepaintResultAlpha } = alphaPolicy;
const gptResult = await prepareRepaintResult('original-rgba', 'depth', true);
assert.equal(gptResult.resultUrl, 'original-rgba', 'GPT must preserve original canvas and RGBA bytes');
assert.equal(clipCalls.length, 0, 'GPT must never invoke the inset/opaque conversion');
assert.equal(preservesRepaintResultAlpha(gptResult.metadata), true);
assert.equal(gptResult.metadata.modelSilhouetteClipVersion, undefined);
await assert.rejects(() => prepareRepaintResult('remote-source', 'depth', false), /缺少原图或蒙版/);
const remoteResult = await prepareRepaintResult('remote-source', 'depth', false, undefined, 'original-effect', 'submitted-mask');
assert.equal(remoteResult.resultUrl, 'clipped-result');
assert.equal(remoteResult.metadata.modelSilhouetteClipVersion, 2);
assert.equal(remoteResult.metadata.repaintResultPolicy, 'model-silhouette-submitted-mask-v1');
assert.deepEqual(clipCalls[0], ['remote-source', 'depth', undefined, 'original-effect', 'submitted-mask']);
assert.equal(preservesRepaintResultAlpha({}), false, 'Unversioned legacy jobs keep their old behavior');
assert.equal(preservesRepaintResultAlpha({ modelSilhouetteClipVersion: 1 }), true);
assert.equal(preservesRepaintResultAlpha({ modelSilhouetteClipVersion: 2 }), true);
const abort = new globalThis.AbortController();
abort.abort();
await assert.rejects(() => prepareRepaintResult('raw', 'depth', true, abort.signal), /abort/i);
clipCalls.length = 0;
const generation = { id: 'job', captureId: 'capture', resultUrl: 'raw', metadata: {
  workflow: 'local-repaint', provider: 'liclick-atlas', authoredMaskUrl: 'authored',
} };
await assert.rejects(() => prepareCloudRepaintCompletion(generation, []), /尚未恢复/);
assert.equal(clipCalls.length, 0, 'Missing capture must fail closed without paid resubmission');
const capture = { id: 'capture', depthUrl: 'depth', camera: { test: 1 }, maskUrl: 'authored' };
const restored = await prepareCloudRepaintCompletion(generation, [capture]);
assert.equal(restored.mode, 'inpaint');
assert.equal(restored.metadata.maskUrl, 'authored');
assert.equal(restored.metadata.rawResultUrl, 'raw');
assert.equal(restored.metadata.repaintResultPolicy, 'gpt-source-alpha-v1');
assert.equal(restored.resultUrl, 'raw');
assert.equal(restored.metadata.modelSilhouetteClipVersion, undefined);
assert.equal(await prepareCloudRepaintCompletion(restored, []), restored);
assert.equal(clipCalls.length, 0, 'GPT restoration is idempotent and must never clip');
const oldClipped = { ...generation, metadata: { ...generation.metadata, modelSilhouetteClipVersion: 1 } };
assert.equal(await prepareCloudRepaintCompletion(oldClipped, []), oldClipped, 'Do not rewrite completed old jobs');
const newClipped = { ...generation, metadata: { ...generation.metadata, modelSilhouetteClipVersion: 2 } };
assert.equal(await prepareCloudRepaintCompletion(newClipped, []), newClipped, 'Do not reprocess completed 3px clipped jobs');

const panel = readFileSync(new URL('../src/components/panels/GeneratePanel.tsx', import.meta.url), 'utf8');
assert.match(panel, /getGptTextureRequestParameters\(resolution, textureGptQuality, textureGptModel\)/);
assert.match(panel, /quality: textureGptQuality,\s*resolution,/);
assert.match(panel, /<GptGenerationOptions[\s\S]*?disabled=\{workflowConfigurationLocked \|\| workflowSubmissionLocked\}/);
assert.match(panel, /updateGenerationSettings\(\{ textureGptQuality: resolveGptTextureQuality\(value, textureGptModel\) \}\)/);
const client = readFileSync(new URL('../src/services/liclickApiClient.ts', import.meta.url), 'utf8');
assert.match(client, /quality: input.quality/);
assert.match(panel, /gptGuide: isGptLocalRepaint/);
assert.match(panel, /colorMode: 'flat-target-coverage'/);
assert.match(panel, /prepareReferenceLighting\(currentProject\.id, materialReference, requestAbortController\.signal\)/);
assert.match(panel, /maskUrl: currentPaintMaskDataUrl/);
assert.match(panel, /prepareRepaintResult\(\s*generation.resultUrl, capture.depthUrl, isGptLocalRepaint/);
const editor = readFileSync(new URL('../src/routes/EditorPage.tsx', import.meta.url), 'utf8');
assert.match(editor, /if \(preservesRepaintResultAlpha\(metadata\) && generation.resultUrl\)/);
assert.equal((editor.match(/ignoreSourceAlpha: !preservesRepaintResultAlpha\(latestLocalRepaintGeneration.metadata\)/g) || []).length, 2);
console.log('GPT: clay/texture pixels, aligned guides + optional reference, model selection, prompt and safe recovery passed.');
await import('./test-content-framing.mjs');
