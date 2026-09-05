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
  'GPT partial coverage must select the white-model completion prompt',
);
assert.match(
  panel,
  /usesRemoteSingleViewInpaint = true[\s\S]*?generateSingleViewInpaint\([\s\S]*?mask:\s*\{[\s\S]*?completion-mask\.png[\s\S]*?completionMaskDataUrl/,
  'remote partial coverage must route the fused image and RGB gap mask to single-view inpaint',
);
assert.match(
  panel,
  /if \(singleViewCompletion\.uncoveredPixelCount === 0\)[\s\S]*?当前视角已经全部有贴图/,
  'fully covered remote views must not overwrite existing texture',
);
assert.match(
  panel,
  /return modelviewClient\.generateSingleView\([\s\S]*?white-model\.png/,
  'remote all-clay views must retain the original two-image generation path',
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
  /backgroundSize: `\$\{textureActionProgress\.progress\}% 100%, 100% 100%`[\s\S]*?`\$\{textureActionProgress\.label\} · \$\{Math\.round\(textureActionProgress\.progress\)\}%`/,
  'the bottom texture CTA must render the shared progress fill and percentage',
);

assert.match(worker, /inferProjectionGapMask\(currentPixels, targetMask, 1\)/);
assert.match(worker, /minimumVisiblePixels = Math\.max\(64, Math\.round\(objectPixelCount \* 0\.0005\)\)/);
assert.match(worker, /compositePixels\[offset\] = clayPixels\.data\[offset\]/);
assert.match(worker, /completionMaskPixels\[offset\] = maskValue/);
assert.match(worker, /completionMaskPixels\[offset \+ 3\] = 255/);
assert.match(worker, /completionMaskBlob/);
assert.doesNotMatch(worker, /white|gray|grey.*threshold/i, 'coverage must not use a white/grey color heuristic');

assert.match(workerClient, /new Worker\([\s\S]*?singleViewTextureCompletion\.worker\.ts/);
assert.match(workerClient, /createRegisteredObjectUrl\(event\.data\.compositeBlob\)/);
assert.match(workerClient, /completionMaskUrl:[\s\S]*?createRegisteredObjectUrl\(event\.data\.completionMaskBlob\)/);
assert.match(
  await fs.readFile(path.join(root, 'src/engine/capture/captureCurrentView.ts'), 'utf8'),
  /forceEmptyProjectionHatch[\s\S]*?showEmptyProjectionHatch/,
  'coverage capture must force the renderer-owned hatch independently from viewport UI state',
);

console.log('Single-view texture completion regression checks passed.');
