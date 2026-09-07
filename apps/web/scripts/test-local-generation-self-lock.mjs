import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [editorPage, generatePanel, textureMapPrompts] = await Promise.all([
  readFile(path.join(root, 'src/routes/EditorPage.tsx'), 'utf8'),
  readFile(path.join(root, 'src/components/panels/GeneratePanel.tsx'), 'utf8'),
  readFile(path.join(root, 'src/engine/generation/textureMapPrompts.ts'), 'utf8'),
]);
const progressStatusSource = generatePanel.slice(
  generatePanel.indexOf('function GenerationProgressStatus'),
  generatePanel.indexOf('function hasVisibleTextureLayerCandidate'),
);

assert.match(
  textureMapPrompts,
  /参考图一是唯一的目标画布和空间定位依据[\s\S]*?外轮廓、内部孔洞、真实部件边界、遮挡关系和裁切范围不变/,
  'The texture prompt must treat the source silhouette as immutable pixel-level registration.',
);
assert.match(
  textureMapPrompts,
  /必须完整替换这些区域，不得残留白膜、灰块、透明缺口、硬边、光晕或明显的补丁边界/,
  'The texture prompt must completely replace every unfinished white-model region.',
);
assert.match(
  textureMapPrompts,
  /忽略白模区域中由低模拓扑、三角面、硬法线、Flat Shading或白膜光照产生的折线、块状明暗和多边形色块/,
  'The texture prompt must reject low-poly shading artifacts as material evidence.',
);
assert.match(
  textureMapPrompts,
  /属于同一连续曲面的区域应跨越多边形边界自然、顺滑地延续材质[\s\S]*?不得改变真实几何位置或外轮廓/,
  'Material smoothing must not be interpreted as permission to reshape the target silhouette.',
);
assert.match(
  textureMapPrompts,
  /输出应接近用于3D投影的Base Color \/ Albedo[\s\S]*?不增加方向性阴影、环境遮蔽、接触阴影、强高光、镜面反射、边缘光或大范围明暗渐变/,
  'The texture prompt must request projection-ready material with subdued lighting.',
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
