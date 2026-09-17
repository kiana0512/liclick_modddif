import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { reconcileRepaintWorkflowGuide } from '../src/components/editor/localRepaintWorkflowGuide.ts';

const sourceRoot = new URL('../src/', import.meta.url);
const [editorPage, generatePanel, bottomToolDock, sceneStore, viewportCanvas] = await Promise.all([
  readFile(new URL('routes/EditorPage.tsx', sourceRoot), 'utf8'),
  readFile(new URL('components/panels/GeneratePanel.tsx', sourceRoot), 'utf8'),
  readFile(new URL('components/editor/BottomToolDock.tsx', sourceRoot), 'utf8'),
  readFile(new URL('stores/sceneStore.ts', sourceRoot), 'utf8'),
  readFile(new URL('engine/viewport/ViewportCanvas.tsx', sourceRoot), 'utf8'),
]);

assert.match(
  generatePanel,
  /onRequestLocalImageGeneration\?: \(\) => void/,
  'the panel CTA must expose the shared EditorPage generation request boundary',
);
assert.match(
  generatePanel,
  /if \(displayedTexturePreviewMode === 'repaint'\) \{\s*if \(onRequestLocalImageGeneration\) \{[\s\S]*?onRequestLocalImageGeneration\(\);\s*return;/,
  'the panel repaint CTA must use the same request bridge as the bottom workflow button',
);
assert.match(
  editorPage,
  /onRequestLocalImageGeneration=\{handleLocalImageGenerationFromToolbar\}/,
  'both UI entry points must converge on one owner for tool suspension and task state',
);
assert.match(
  editorPage,
  /<GeneratePanel[\s\S]*?workspaceActive=\{isActive\}/,
  'the retained texture editor must pass its route activity into the generation panel',
);
assert.equal(
  [...generatePanel.matchAll(/workspaceActive &&\s*portalRoot &&/g)].length,
  3,
  'all generation-panel portals must stay hidden while the retained editor is inactive',
);
assert.match(
  editorPage,
  /if \(!useSceneStore\.getState\(\)\.paintMaskHasContent\) \{[\s\S]*dedupeKey: 'local-repaint-mask-required',[\s\S]*return;[\s\S]*setLocalRepaintGenerationPresentationActive\(true\)/,
  'the shared UI boundary must reject an empty mask before changing generation presentation state',
);
assert.match(
  generatePanel,
  /\{ succeeded: true; generationId: string \}/,
  'a successful local generation settlement must carry its exact generation id',
);
assert.match(
  generatePanel,
  /lastCompletedLocalRepaintGenerationIdRef\.current = completedGeneration\.id/,
  'the completion payload must be bound to the returned task instead of list ordering',
);
assert.match(
  editorPage,
  /preferredLocalRepaintGenerationIdRef\.current = result\.generationId/,
  'EditorPage must retain the exact generation selected for the next repaint activation',
);
assert.match(
  editorPage,
  /selectPreferredLocalRepaintGeneration\(\s*generations,\s*matchesUsableLocalRepaintGeneration,\s*preferredGenerationId,\s*\)/,
  'brush activation must pass the settled generation to the shared deterministic selector',
);
const applyToolLifecycle = bottomToolDock.slice(
  bottomToolDock.indexOf('setWorkflowGuide((previous) => reconcileRepaintWorkflowGuide'),
  bottomToolDock.indexOf('function toggleMenu'),
);
assert.doesNotMatch(
  applyToolLifecycle,
  /clearPaintMask\(\)/,
  'entering the repaint apply brush must hide presentation without deleting the live mask',
);
assert.match(
  bottomToolDock,
  /description="请先绘制蒙版；每次提交都会锁定当前蒙版，运行期间不可重复提交。"/,
  'the workflow tooltip must communicate that local generation requires a mask',
);
assert.match(
  bottomToolDock,
  /onPaintToolChange\('none'\);[\s\S]*onTransformModeChange\('select'\);[\s\S]*setPaintMaskPresentationVisible\(false\)/,
  'the orbit selector must leave paint mode and hide only the mask presentation',
);
assert.match(
  sceneStore,
  /paintTool === 'inpaint-add' \|\| paintTool === 'inpaint-subtract'[\s\S]*\? true[\s\S]*state\.paintMaskPresentationVisible/,
  'returning to either mask brush must restore mask presentation',
);
assert.match(
  bottomToolDock,
  /onPaintToolChange\(isMaskPaintTool \? paintTool : 'inpaint-add'\)/,
  'clicking the highlighted mask step must reassert the current tool instead of swallowing recovery',
);
assert.match(
  sceneStore,
  /const isMaskTool =[\s\S]*paintToolActivationRevision = isMaskTool[\s\S]*state\.paintToolActivationRevision \+ 1/,
  'each mask-tool activation must publish a fresh ephemeral viewport command token',
);
assert.match(
  viewportCanvas,
  /rearmPaintMaskInputSessionRef\.current\(\);[\s\S]*?syncInpaintMaskProjection\(model\)/,
  'the viewport must close orphaned input before rebuilding the selected-mask presentation',
);
assert.match(
  viewportCanvas,
  /isPaintingRef\.current[\s\S]*?finishPaintStroke\(undefined, 'pointercancel'\)[\s\S]*?setViewportPaintPointer\(canvas\)/,
  'mask-session recovery must handle both an orphaned live stroke and stale pointer ownership',
);
assert.match(
  viewportCanvas,
  /isInpaintMode,[\s\S]*paintToolActivationRevision,[\s\S]*shouldShowInpaintMask/,
  'repeated activation must rerun the mask projection/overlay synchronization effect',
);
assert.match(
  viewportCanvas,
  /shouldShowColorPaintOverlays &&\s*paintMaskPresentationVisible &&/,
  'the viewport mask must honor its independent presentation flag',
);

console.log('Local generation entry alignment regression checks passed.');

let guide = { step: 'generate', running: false, successKey: 0, paintTool: 'inpaint-add' };
const updateGuide = (patch) => {
  guide = reconcileRepaintWorkflowGuide(guide, { ...guide, ...patch });
  return guide.step;
};
assert.equal(updateGuide({ running: true, paintTool: 'none' }), 'none', 'Side-panel start clears the dock generation pulse');
assert.equal(updateGuide({ successKey: 1 }), 'repaint', 'Success before unlock/GPU readiness must remain pending');
assert.equal(updateGuide({}), 'repaint', 'A still-running notification must not consume pending success');
assert.equal(updateGuide({ running: false, paintTool: 'inpaint-add' }), 'repaint', 'Tool restore cannot override success');
assert.equal(updateGuide({}), 'repaint', 'Later GPU readiness renders the same pending guide');
assert.equal(updateGuide({ paintTool: 'inpaint-apply' }), 'none', 'Entering the apply brush acknowledges the guide');
assert.equal(updateGuide({ paintTool: 'inpaint-add' }), 'generate', 'A new mask cycle can guide generation again');
assert.equal(updateGuide({ running: true, paintTool: 'none' }), 'none');
assert.equal(updateGuide({ running: false }), 'none', 'Failure/cancellation without a success key must not suggest applying an old result');
assert.equal(updateGuide({ running: true }), 'none');
assert.equal(updateGuide({ running: false, successKey: 2 }), 'repaint', 'Second successful round transfers the pulse again');
guide = { ...guide, step: 'none' }; // Explicit apply/queue click acknowledges it.
assert.equal(updateGuide({}), 'none', 'Rerenders after an explicit acknowledgement must not relight the brush');
assert.match(bottomToolDock, /repaintGuideActive &&\s*localRepaintReady &&\s*!localImageGenerationRunning/,
  'Pending guidance remains visually gated until the brush is ready and generation has stopped');
console.log('Local repaint workflow guide timing regression checks passed.');
