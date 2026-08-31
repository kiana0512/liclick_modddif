import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import * as THREE from 'three';

const sourceRoot = new URL('../src/', import.meta.url);
const [sessionLayer, generatePanel, editorPage, viewportCanvas, bottomToolDock] = await Promise.all(
  [
    readFile(new URL('engine/localRepaint/sessionLayer.ts', sourceRoot), 'utf8'),
    readFile(new URL('components/panels/GeneratePanel.tsx', sourceRoot), 'utf8'),
    readFile(new URL('routes/EditorPage.tsx', sourceRoot), 'utf8'),
    readFile(new URL('engine/viewport/ViewportCanvas.tsx', sourceRoot), 'utf8'),
    readFile(new URL('components/editor/BottomToolDock.tsx', sourceRoot), 'utf8'),
  ],
);

assert.match(sessionLayer, /preserveActiveProjection\?: boolean/);
assert.match(
  sessionLayer,
  /if \(!input\.preserveActiveProjection && !sourceOwnsTarget\)/,
  'passive layer creation must not tear down the visible repaint projection',
);
assert.match(sessionLayer, /preserveActiveLayer\?: boolean/);
assert.match(
  generatePanel,
  /ensureLocalRepaintSessionLayer\(undefined,\s*\{[\s\S]*?preserveActiveProjection: true,[\s\S]*?preserveActiveLayer: true/,
  'starting a generation must retain the visible repaint layer',
);
assert.match(
  generatePanel,
  /ensureLocalRepaintSessionLayer\(completedGeneration\.id,\s*\{[\s\S]*?preserveActiveProjection: true,[\s\S]*?preserveActiveLayer: true/,
  'generation writeback must retain the previous repaint layer',
);
assert.match(
  editorPage,
  /generationId: latestLocalRepaintGeneration\.id,\s*preserveActiveProjection: true,\s*preserveActiveLayer: true/,
  'idle preparation must not steal renderer ownership',
);
assert.match(editorPage, /visibleProjectionSource\.targetLayerId !== currentTarget\.id/);
assert.match(
  sessionLayer,
  /!item\.generationId && !item\.imageUrl && !claimedTargetIds\.has\(item\.id\)/,
  'an empty target already owned by an in-flight generation must not be rebound',
);
assert.match(
  viewportCanvas,
  /localRepaintProjectedPublishRequestsRef = useRef\(\s*new Map<string, \(\) => Promise<void>>\(\)/,
  'deferred repaint publication must keep one request slot per source',
);
assert.match(
  viewportCanvas,
  /localRepaintProjectedPublishRevisionsRef\.current\.get\(publishSourceKey\)/,
  'latest-wins cancellation must be scoped to the current source',
);
assert.doesNotMatch(
  viewportCanvas,
  /localRepaintProjectedPublishRequestRef\b/,
  'a component-wide request slot can cancel an unrelated in-flight repaint task',
);
assert.match(
  viewportCanvas,
  /activeLayerIdBeforePublish[\s\S]*?setActiveLayer\(activeLayerIdBeforePublish\)/,
  'a delayed publication must preserve the layer selected by a newer task',
);
assert.match(
  viewportCanvas,
  /previewOwnsOverlay\s*&&\s*\(sceneState\.paintTool === 'none'[\s\S]*?sceneState\.paintTool === 'inpaint-add'[\s\S]*?sceneState\.paintTool === 'inpaint-subtract'/,
  'closing the mask tool must keep the resident local repaint GPU preview visible',
);
assert.ok(
  (viewportCanvas.match(/const previewOwnsOverlay =/g) ?? []).length >= 4,
  'every overlay activation and resident-rebind path must preserve renderer ownership',
);
assert.match(
  viewportCanvas,
  /syncLocalRepaintGpuOverlayBinding\(currentOverlay, \{[\s\S]*?composite\.hasContent &&[\s\S]*?previewOwnsOverlay \|\|[\s\S]*?!hasPersistedLayer/,
  'reusing a resident GPU program must not hide the owning repaint layer',
);
assert.match(
  viewportCanvas,
  /previewOwnsComposite\s*&&\s*\(sceneStateAtCommit\.paintTool === 'none'[\s\S]*?sceneStateAtCommit\.paintTool === 'inpaint-add'[\s\S]*?sceneStateAtCommit\.paintTool === 'inpaint-subtract'/,
  'a deferred publish must not fade the repaint while the mask tool is toggled closed',
);
assert.match(
  viewportCanvas,
  /sceneState\.paintTool === 'inpaint-apply' \|\|\s*sceneState\.paintTool === 'none' \|\|\s*stillEditingLocalRepaintMask/,
  'the completed repaint composite must stay warm after a second mask-button click',
);
assert.match(
  bottomToolDock,
  /if \(!isMaskPaintTool\) \{\s*onPaintToolChange\('inpaint-add'\)/,
  'the mask button must select the mask tool idempotently',
);
assert.doesNotMatch(
  bottomToolDock,
  /onPaintToolChange\(willSelectMaskTool \? 'inpaint-add' : 'none'\)/,
  'a repeated mask-button click must not unload the active repaint presentation',
);

const sceneRoot = await readFile(new URL('engine/viewport/SceneRoot.tsx', sourceRoot), 'utf8');
const idleGate = sceneRoot.slice(
  sceneRoot.indexOf('const isViewportInteractionBusy = () =>'),
  sceneRoot.indexOf('const precompileProjectedMaterial ='),
);
assert.doesNotMatch(
  idleGate,
  /paintTool === 'inpaint-(?:add|subtract)'/,
  'a selected mask brush must not starve resident publication while the pointer is idle',
);
assert.match(
  idleGate,
  /isSharedViewportInteractionBusy\(\)/,
  'actual pointer interactions must still defer uploads and compilation',
);
assert.match(
  viewportCanvas,
  /await releasePreviousPreview\(\)/,
  'switching sources must wait for the old layer to become resident',
);
assert.match(
  viewportCanvas,
  /releasePreviousPreview\(\)\.then/,
  'clearing a source must also wait for resident handoff',
);

const server = await createServer({
  root: fileURLToPath(new URL('../', import.meta.url)),
  logLevel: 'silent',
  server: { middlewareMode: true },
});
try {
  const {
    getTransientLocalRepaintLayerId,
    isLocalRepaintLayerResident,
    waitForLocalRepaintResidentHandoff,
  } = await server.ssrLoadModule('/src/engine/viewport/localRepaintResidentHandoff.ts');
  assert.equal(getTransientLocalRepaintLayerId('A', []), 'A');
  assert.equal(
    getTransientLocalRepaintLayerId('A', [{ id: 'A', contentRevision: 1 }]),
    undefined,
    'first published row must become resident even when the live marker still has no revision',
  );
  assert.equal(getTransientLocalRepaintLayerId('B', [{ id: 'A' }]), 'B');
  assert.equal(getTransientLocalRepaintLayerId(undefined, [{ id: 'A' }]), undefined);

  const group = new THREE.Group();
  const material = new THREE.ShaderMaterial();
  const geometry = new THREE.BoxGeometry();
  const body = new THREE.Mesh(geometry, material);
  group.add(body);
  assert.equal(isLocalRepaintLayerResident(group, 'A'), false);
  material.userData.liclickProjectedLayerStackState = { bindings: [{ layerId: 'A' }] };
  const overlay = new THREE.Mesh(geometry, new THREE.ShaderMaterial());
  overlay.userData.liclickPaintOverlay = true;
  group.add(overlay);
  assert.equal(
    isLocalRepaintLayerResident(group, 'A'),
    true,
    'transparent twin must not count as a background mesh',
  );
  assert.equal(isLocalRepaintLayerResident(group, 'B'), false);
  const secondMesh = new THREE.Mesh(geometry, overlay.material);
  group.add(secondMesh);
  assert.equal(
    isLocalRepaintLayerResident(group, 'A'),
    false,
    'partially assigned materials cannot release the old overlay',
  );
  secondMesh.removeFromParent();
  material.userData.liclickDisposedMaterial = true;
  assert.equal(isLocalRepaintLayerResident(group, 'A'), false);
  assert.equal(isLocalRepaintLayerResident(new THREE.Group(), 'A'), false);

  let frames = 0;
  let now = 0;
  const input = {
    ready: () => frames >= 3,
    cancelled: () => false,
    now: () => now,
    nextFrame: async () => {
      frames += 1;
      now += 16;
    },
  };
  assert.equal(await waitForLocalRepaintResidentHandoff(input), true);
  assert.equal(frames, 3, 'pending handoff must yield frames instead of busy-spinning');
  frames = 0;
  assert.equal(
    await waitForLocalRepaintResidentHandoff({ ...input, cancelled: () => true }),
    false,
  );
  assert.equal(frames, 0, 'superseded source must not wait or publish');
  assert.equal(
    await waitForLocalRepaintResidentHandoff({
      ...input,
      ready: () => false,
      cancelled: () => frames >= 1,
    }),
    false,
  );
  frames = 0;
  assert.equal(
    await waitForLocalRepaintResidentHandoff({
      ...input,
      ready: () => false,
      nextFrame: async () => {
        frames += 1;
        now += 5000;
      },
    }),
    false,
  );
  assert.equal(
    frames,
    2,
    'failed material preparation must time out without blanking the old layer',
  );
  geometry.dispose();
  material.dispose();
  overlay.material.dispose();
} finally {
  await server.close();
}
console.log('Local repaint layer retention regression checks passed.');
