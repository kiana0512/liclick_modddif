import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const editor = await readFile(new URL('../src/routes/EditorPage.tsx', import.meta.url), 'utf8');
const generatePanel = await readFile(
  new URL('../src/components/panels/GeneratePanel.tsx', import.meta.url),
  'utf8',
);
const objectsPanel = await readFile(
  new URL('../src/components/panels/ObjectsPanel.tsx', import.meta.url),
  'utf8',
);
const layersPanel = await readFile(
  new URL('../src/components/panels/LayersPanel.tsx', import.meta.url),
  'utf8',
);
const referencePicker = await readFile(
  new URL('../src/components/panels/ReferenceImagePicker.tsx', import.meta.url),
  'utf8',
);
const userMenu = await readFile(
  new URL('../src/components/auth/UserMenu.tsx', import.meta.url),
  'utf8',
);

assert.match(
  editor,
  /const generationConflictLocked =\s*localImageGenerationRunning \|\| projectGenerationRunning \|\| generatePanelTaskState\.running;/,
  'Every project image-generation channel must participate in the conflict guard.',
);
assert.match(
  editor,
  /const modelMutationLocked = editorTaskRunning \|\| generationConflictLocked;/,
  'Model mutation must remain blocked for local repaint as well as ordinary generation.',
);
assert.match(editor, /window\.addEventListener\('beforeunload', warnBeforeUnload\)/);
assert.match(editor, /生图任务进行中/);
assert.match(editor, /任务完成前无法执行“\{generationConflictDialog\.action\}”/);
assert.match(editor, /max-w-\[360px\]/);
assert.doesNotMatch(editor, /activeConflictObjectName|activeConflictReferenceName/);
assert.match(editor, /setCancelActiveGenerationRequestKey\(\(key\) => key \+ 1\)/);
assert.match(editor, /showGenerationConflict\('返回项目列表'\)/);
assert.match(editor, /showGenerationConflict\('进入 UV 工作区'\)/);
assert.match(editor, /showGenerationConflict\('进入烘焙工作区'\)/);
assert.match(editor, /showGenerationConflict\('进入拓扑工作区'\)/);

for (const action of ['切换当前模型', '切换模型显隐', '删除模型', '复制模型', '排列模型']) {
  assert.ok(objectsPanel.includes(`onMutationLocked?.('${action}')`), `${action} must be guarded.`);
}
for (const action of ['删除图层', '合并图层', '编辑图层图片']) {
  assert.ok(layersPanel.includes(`blockMutation('${action}')`), `${action} must be guarded.`);
}
for (const action of ['导入参考图', '切换参考图', '复制参考图', '删除参考图']) {
  assert.ok(referencePicker.includes(`blockMutation('${action}')`), `${action} must be guarded.`);
}

assert.match(generatePanel, /cancelActiveGenerationRequestKey\?: number/);
assert.match(
  generatePanel,
  /const result = await updateLatestProject\([\s\S]*?\.\.\.latest,[\s\S]*?objects,[\s\S]*?layers,[\s\S]*?references,[\s\S]*?generations,[\s\S]*?captures,[\s\S]*?settings: project\.settings,[\s\S]*?\},[\s\S]*?5,[\s\S]*?\);/,
  'Generation submission must merge texture-owned state into the latest server revision.',
);
assert.doesNotMatch(
  generatePanel,
  /saveWorkspaceProject\(savedProjectSnapshot\)/,
  'Generation submission must not replace the server document with a stale editor snapshot.',
);
assert.doesNotMatch(
  generatePanel,
  /error\.message\.includes\('stale project snapshot'\)/,
  'Conflict recovery must not depend on one English server error string.',
);
assert.match(
  generatePanel,
  /if \(activeWorkflowGeneration\) \{[\s\S]*setCancelConfirmGeneration\(activeWorkflowGeneration\);[\s\S]*return;[\s\S]*if \(snapshotPreparing && texturePipelineAbortControllerRef\.current\)/,
  'The shared dialog must hand off to the existing cancellation confirmation.',
);
assert.match(userMenu, /退出登录可能导致任务进度或结果丢失/);
assert.match(userMenu, /解除莉刻账号可能导致任务轮询或结果获取失败/);

console.log('Generation conflict guard regression checks passed.');
