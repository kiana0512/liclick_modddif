import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import './test-texture-weak-light-prompt.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [editorPage, generatePanel, textureMapPrompts, liclickGenerationService, styles] = await Promise.all([
  readFile(path.join(root, 'src/routes/EditorPage.tsx'), 'utf8'),
  readFile(path.join(root, 'src/components/panels/GeneratePanel.tsx'), 'utf8'),
  readFile(path.join(root, 'src/engine/generation/textureMapPrompts.ts'), 'utf8'),
  readFile(path.join(root, '../server/src/services/liclickGenerationService.ts'), 'utf8'),
  readFile(path.join(root, 'src/styles/globals.css'), 'utf8'),
]);
const progressStatusSource = generatePanel.slice(
  generatePanel.indexOf('function GenerationProgressStatus'),
  generatePanel.indexOf('function hasVisibleTextureLayerCandidate'),
);

assert.match(
  textureMapPrompts,
  /图一是唯一的画布、相机、位置、比例和几何依据/,
  'The texture prompt must treat the source silhouette as immutable pixel-level registration.',
);
assert.match(
  textureMapPrompts,
  /只修改图一中的白模、Clay、Primer或指定待补全区域/,
  'The texture prompt must completely replace every unfinished white-model region.',
);
assert.match(
  textureMapPrompts,
  /不要沿用白模的灰度渐变、三角面明暗或硬法线色块/,
  'The texture prompt must reject low-poly shading artifacts as material evidence.',
);
assert.match(
  textureMapPrompts,
  /不得移动、缩放、旋转、变形、平滑或重建结构[\s\S]*?不要模糊、磨皮/,
  'Material smoothing must not be interpreted as permission to reshape the target silhouette.',
);
assert.match(
  textureMapPrompts,
  /图二只提供材质固有颜色[\s\S]*?不提供形状、构图或照明/,
  'The material reference must not influence geometry or composition.',
);
assert.match(
  textureMapPrompts,
  /已经贴好的纹理区域保持不变，不对整张图重新调色、打光或去光照。保留原有背景及透明区域/,
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
  /hasPurposeBuiltTextureConstraint =[\s\S]*?basePrompt\.includes\('只在图一上进行材质补全，不重新生成物体。'\)[\s\S]*?basePrompt\.includes\(materialConstraint\) \|\| hasPurposeBuiltTextureConstraint/,
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
  /const previewProgressOverlayClassName =\s*'gen-preview-progress'/,
  'Preparation and submitted generation states must share one opaque preview background.',
);
assert.equal((generatePanel.match(/className=\{previewProgressOverlayClassName\}/g) || []).length, 2);
assert.match(styles, /\.gen-preview-progress\s*\{[^}]*@apply[^;]*bg-\[#1b1b1b\]/,
  'The extracted CSS must retain the opaque preview background, not only a class name.');
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
  /\}\) : resolveLocalRepaintMaterialReference\(\{[\s\S]*?selectedReferenceIds: referenceStateAtSubmission\.selectedReferenceIds,[\s\S]*?historicalReferenceId:/,
  'Local repaint must resolve the currently selected single-view or multiview reference before historical fallback.',
);
assert.match(
  generatePanel,
  /if \(!isGptLocalRepaint && materialReference && !isMultiviewReference\(materialReference\)\) \{[\s\S]*?materialReference = await generatePairedMultiviewReference\(materialReference\)/,
  'The original ModelView branch must convert single-view references while holding the repaint lock; GPT must not.',
);

stdout.write('Local generation self-lock regression test passed.\n');
