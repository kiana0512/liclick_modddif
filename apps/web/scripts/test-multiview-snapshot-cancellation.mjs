import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const panel = await readFile(
  new URL('../src/components/panels/GeneratePanel.tsx', import.meta.url),
  'utf8',
);
const editor = await readFile(new URL('../src/routes/EditorPage.tsx', import.meta.url), 'utf8');

assert.match(
  panel,
  /const texturePipelineAbortControllerRef = useRef<AbortController>/,
  'the texture pipeline must own a cancellation token before remote generations exist',
);
assert.match(
  panel,
  /const canCancelGeneration = Boolean\([\s\S]*snapshotPreparing[\s\S]*texturePipelineAbortControllerRef\.current/,
  'the stop button must be visible while multiview snapshots are being prepared',
);
assert.match(
  panel,
  /function isTextureSnapshotProgressLabel\(label: string\)[\s\S]*多视\(\?:图\|角\)快照/,
  'the snapshot stage detector must recognize the current “多视图快照” progress copy',
);
assert.match(
  panel,
  /async function getTextureMapMultiviewCaptures\([\s\S]*?views: CameraViewItem\[\],[\s\S]*?signal\?: AbortSignal,[\s\S]*?\)[\s\S]*throwIfTexturePipelineCancelled\(signal\)[\s\S]*await captureTextureMapCameraView[\s\S]*throwIfTexturePipelineCancelled\(signal\)/,
  'snapshot capture must observe cancellation before and after each GPU capture',
);
assert.match(
  panel,
  /await handleTextureMapMultiviewGenerate\([\s\S]*pipelineAbortController\.signal/,
  'the pipeline cancellation token must reach the snapshot stage',
);
assert.match(
  panel,
  /controller\.abort\('user-cancelled-multiview-snapshot'\)/,
  'confirming snapshot cancellation must abort the active pipeline',
);
assert.match(
  panel,
  /不会继续向远端提交纹理生图任务/,
  'the confirmation dialog must explain that cancellation prevents remote submission',
);
assert.match(
  panel,
  /\(cancelConfirmGeneration \|\|[\s\S]*?cancelTextureSnapshotConfirmOpen \|\|[\s\S]*?cancelLocalRepaintPreparationConfirmOpen \|\|[\s\S]*?cancelContentAwareRepairConfirmOpen\)[\s\S]*?终止莉刻生图[\s\S]*?丢弃本次等待结果？[\s\S]*?终止并丢弃/,
  'snapshot and final repair cancellation must use the same confirmation surface as every submitted generation',
);
assert.match(
  editor,
  /contentAwareRepairTaskTokenRef\.current = taskToken;[\s\S]*?setContentAwareRepairTaskActive\(true\);[\s\S]*?silentForeground/,
  'silent multiview content-aware fill must expose a cancellable task before it is scheduled',
);
assert.match(
  editor,
  /contentAwareRepairActive=\{contentAwareRepairTaskActive\}[\s\S]*?contentAwareRepairCancelling=\{contentAwareRepairCancelling\}[\s\S]*?onCancelContentAwareRepair=\{interruptContentAwareRepair\}/,
  'the final multiview fill cancellation state must reach the shared GeneratePanel stop control',
);
assert.doesNotMatch(panel, /停止本次快照任务？|>终止快照</);

console.log('Multiview snapshot cancellation regression checks passed.');
