import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const [panel, textureMapPrompts, workerClient, worker] = await Promise.all([
  fs.readFile(path.join(root, 'src/components/panels/GeneratePanel.tsx'), 'utf8'),
  fs.readFile(path.join(root, 'src/engine/generation/textureMapPrompts.ts'), 'utf8'),
  fs.readFile(
    path.join(root, 'src/engine/generation/singleViewTextureCompletionWorker.ts'),
    'utf8',
  ),
  fs.readFile(path.join(root, 'src/workers/singleViewTextureCompletion.worker.ts'), 'utf8'),
]);

assert.match(
  panel,
  /!isMultiviewRequest\s*&&\s*!usesRemoteSingleView\s*&&\s*hasVisibleTextureLayerCandidate\(objectId\)/,
  'existing-texture completion must be limited to GPT single-view generation',
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
  /capture:\s*\{[\s\S]*?\.\.\.view\.capture,[\s\S]*?colorUrl: singleViewCompletion!\.imageUrl![\s\S]*?\}/,
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
  'partial coverage must select the white-model completion prompt',
);
assert.match(
  panel,
  /referenceIds: \[modelViewReference\.id, materialReference\.id\][\s\S]*?referenceImages: \[modelViewReference, materialReference\]/,
  'Atlas must still receive exactly the guide and material reference',
);
assert.match(textureMapPrompts, /图一中已经具有颜色、纹理和材质的区域属于锁定内容/);
assert.match(
  textureMapPrompts,
  /原始像素边界就是不可跨越的硬蒙版[\s\S]*?不得少填、内切、侵蚀、缩小、挖空或产生透明缺口[\s\S]*?不得越界、外扩/,
  'completion must fill only the original white-model mask without shrinking or expanding it',
);
assert.match(
  textureMapPrompts,
  /所有“顺滑”只允许发生在白模硬蒙版内部[\s\S]*?不得移动、圆整、修正或重新绘制白模边界、物体外轮廓及真实部件边界/,
  'low-poly smoothing must remain an interior material operation and never reshape the silhouette',
);
assert.match(textureMapPrompts, /输出应接近用于3D投影的Base Color \/ Albedo/);

assert.match(worker, /inferProjectionGapMask\(currentPixels, targetMask, 1\)/);
assert.match(worker, /minimumVisiblePixels = Math\.max\(64, Math\.round\(objectPixelCount \* 0\.0005\)\)/);
assert.match(worker, /compositePixels\[offset\] = clayPixels\.data\[offset\]/);
assert.doesNotMatch(worker, /completionMaskBlob|maskToImageData/);
assert.doesNotMatch(worker, /white|gray|grey.*threshold/i, 'coverage must not use a white/grey color heuristic');

assert.match(workerClient, /new Worker\([\s\S]*?singleViewTextureCompletion\.worker\.ts/);
assert.match(workerClient, /createRegisteredObjectUrl\(event\.data\.compositeBlob\)/);
assert.doesNotMatch(workerClient, /completionMaskBlob|completionMaskUrl/);
assert.match(
  await fs.readFile(path.join(root, 'src/engine/capture/captureCurrentView.ts'), 'utf8'),
  /forceEmptyProjectionHatch[\s\S]*?showEmptyProjectionHatch/,
  'coverage capture must force the renderer-owned hatch independently from viewport UI state',
);

console.log('Single-view texture completion regression checks passed.');
