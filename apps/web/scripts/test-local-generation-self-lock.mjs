import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [editorPage, generatePanel, textureMapPrompts, liclickGenerationService] = await Promise.all([
  readFile(path.join(root, 'src/routes/EditorPage.tsx'), 'utf8'),
  readFile(path.join(root, 'src/components/panels/GeneratePanel.tsx'), 'utf8'),
  readFile(path.join(root, 'src/engine/generation/textureMapPrompts.ts'), 'utf8'),
  readFile(path.join(root, '../server/src/services/liclickGenerationService.ts'), 'utf8'),
]);
const progressStatusSource = generatePanel.slice(
  generatePanel.indexOf('function GenerationProgressStatus'),
  generatePanel.indexOf('function hasVisibleTextureLayerCandidate'),
);

assert.match(
  textureMapPrompts,
  /最终物体的外轮廓、剪影像素边界、位置、尺寸、比例、朝向、相机和透视，必须与图一的白模完全一致/,
  'The texture prompt must treat the source silhouette as immutable pixel-level registration.',
);
assert.match(
  textureMapPrompts,
  /只修改图一中的白色、浅灰色、Clay、Primer或无纹理区域/,
  'The texture prompt must completely replace every unfinished white-model region.',
);
assert.match(
  textureMapPrompts,
  /白模内部的三角面灰度、多边形色块、硬法线明暗和Flat Shading不是材质/,
  'The texture prompt must reject low-poly shading artifacts as material evidence.',
);
assert.match(
  textureMapPrompts,
  /“内部平滑”只表示材质连续，绝不表示可以平滑或改变外轮廓/,
  'Material smoothing must not be interpreted as permission to reshape the target silhouette.',
);
assert.match(
  textureMapPrompts,
  /图二只提供材质外观[\s\S]*?图二不提供几何、轮廓、位置、比例、相机、构图或光照/,
  'The material reference must not influence geometry or composition.',
);
assert.match(
  textureMapPrompts,
  /图一中已经具有材质的区域必须保留原始颜色、纹理、光影和细节，不得重绘、调色、重新照明、锐化或模糊/,
  'Existing material pixels must be absolutely locked.',
);
assert.match(
  textureMapPrompts,
  /`\$\{textureMapPrompt\}\\n\\n用户补充材质要求：\$\{trimmedPrompt\}`/,
  'User material requirements must remain appended after the shared main template.',
);
assert.doesNotMatch(
  textureMapPrompts,
  /以参考图一为目标视角，将参考图二的材质外观迁移到图一对应的可见表面/,
  'The retired whole-surface prompt must not remain as a fallback.',
);
assert.match(
  liclickGenerationService,
  /hasPurposeBuiltTextureConstraint =[\s\S]*?basePrompt\.includes\('【绝对第一优先级：轮廓配准】'\)[\s\S]*?basePrompt\.includes\(materialConstraint\) \|\| hasPurposeBuiltTextureConstraint/,
  'The server must not append the legacy whole-image lighting constraint to the scoped shared template.',
);
assert.match(
  generatePanel,
  /await import\('@\/engine\/generation\/textureMapPrompts'\)/,
  'Texture prompts must be loaded only when local generation is submitted.',
);

assert.doesNotMatch(
  editorPage,
  /textureGenerationLocked=\{localImageGenerationRunning\}/,
  'The toolbar request bridge must not be passed back to GeneratePanel as its own lock.',
);
assert.doesNotMatch(
  generatePanel,
  /textureGenerationLocked/,
  'GeneratePanel must derive duplicate-submission locking from its actual running task.',
);
assert.match(
  generatePanel,
  /const workflowSubmissionLocked = interactionLocked \|\| panelTaskRunning;/,
  'External exclusive work and an actual panel task may block submission.',
);
assert.match(
  generatePanel,
  /submitLocksRef\.current\.add\('repaint'\)[\s\S]*?setSubmissionActive\(true\)/,
  'Local repaint must still claim its internal synchronous submission lock.',
);
assert.match(
  generatePanel,
  /requestAbortController = new AbortController\(\);[\s\S]*?localRepaintPreparationAbortControllerRef\.current = requestAbortController;[\s\S]*?const preparationSignal = requestAbortController\.signal;[\s\S]*?Promise\.race\(\[[\s\S]*?polishPrompt\([\s\S]*?preparationSignal\.addEventListener\([\s\S]*?'abort'/,
  'Local repaint must expose an abort race before automatic prompt optimization starts.',
);
assert.match(
  generatePanel,
  /localRepaintPreparationCancellable[\s\S]*?setCancelLocalRepaintPreparationConfirmOpen\(true\)[\s\S]*?confirmCancelLocalRepaintPreparation[\s\S]*?controller\.abort\('user-cancelled-local-repaint-preparation'\)/,
  'The shared stop control must confirm and abort local prompt optimization.',
);
assert.match(
  generatePanel,
  /const textureActionProgress =[\s\S]*?isTextureMapTab && texturePipelineProgress\?\.active[\s\S]*?const generateActionRunning =[\s\S]*?Boolean\(textureActionProgress\)[\s\S]*?generateActionRunning \? \([\s\S]*?LoaderCircle[\s\S]*?: generateActionRunning[\s\S]*?t\('generating'\)/,
  'The panel CTA must show the same running state as the dock before the Generation row exists.',
);
assert.match(
  generatePanel,
  /setTexturePreviewMode\('repaint'\);[\s\S]*?setLocalRepaintPreparation\(\{[\s\S]*?detail: '正在准备当前视角'/,
  'The repaint request bridge must reveal preparation content before capture work starts.',
);
assert.match(
  generatePanel,
  /data-local-repaint-preparation="true"/,
  'The repaint preview must expose an immediate accessible preparation state.',
);
assert.match(
  generatePanel,
  /const previewProgressOverlayClassName =[\s\S]{0,160}bg-\[#1b1b1b\]/,
  'Preparation and submitted generation states must share one opaque preview background.',
);
assert.doesNotMatch(
  progressStatusSource,
  /animate-spin|<img|backdrop-blur/,
  'Preview progress states must render text only without imagery, blur, or spinners.',
);
assert.match(
  generatePanel,
  /button2-mask-capture'[\s\S]*?detail: '正在准备当前蒙版'[\s\S]*?button2-view-capture'[\s\S]*?detail: '正在融合当前效果与蒙版预览'/,
  'The immediate preview must follow mask, frozen-view capture and composite preparation phases.',
);
assert.doesNotMatch(
  generatePanel,
  /正在同步当前项目状态|await criticalProjectSavePromise/,
  'Project persistence must stay off the remote-generation submission path.',
);
assert.match(
  generatePanel,
  /const criticalProjectSavePromise = saveCriticalProjectState\([\s\S]*?void criticalProjectSavePromise\.then\([\s\S]*?pendingGeneration = \{/,
  'The detached project snapshot must continue in the background with observed recovery.',
);
assert.doesNotMatch(
  editorPage,
  /preparedSource\.allowedMaskUrl === generationMaskUrl/,
  'An equivalent restored live-mask URL must not force a GPU-resident repaint through cold preparation.',
);
assert.match(
  editorPage,
  /preparedSource\?\.generationId === latestLocalRepaintGeneration\.id[\s\S]*?preparedSource\.objectId === objectId[\s\S]*?isGpuReady\(\)/,
  'Button 3 must recognize the resident source by generation, object, destination and GPU readiness.',
);
assert.match(
  generatePanel,
  /let materialReference = resolveLocalRepaintMaterialReference\(\{[\s\S]*?selectedReferenceIds: referenceStateAtSubmission\.selectedReferenceIds,[\s\S]*?historicalReferenceId:/,
  'Local repaint must resolve the currently selected single-view or multiview reference before historical fallback.',
);
assert.match(
  generatePanel,
  /if \(!isMultiviewReference\(materialReference\)\) \{[\s\S]*?materialReference = await generatePairedMultiviewReference\(materialReference\)/,
  'A selected single-view material reference must be converted while the repaint submission lock is held.',
);

stdout.write('Local generation self-lock regression test passed.\n');
