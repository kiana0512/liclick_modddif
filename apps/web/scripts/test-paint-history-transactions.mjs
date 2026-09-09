import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setImmediate } from 'node:timers';
import ts from 'typescript';
import { createServer } from 'vite';

const server = await createServer({
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true, watch: { ignored: () => true } },
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
try {
  const { PaintHistoryBoundary } = await server.ssrLoadModule(
    '/src/engine/paint/paintHistoryBoundary.ts',
  );
  const { stageRefinedStrokeHistory } = await server.ssrLoadModule(
    '/src/engine/paint/refineStrokeHistory.ts',
  );
  const boundary = new PaintHistoryBoundary();
  const stateStore = (state) => ({ getState: () => state });
  const layers = [{ id: 'layer', contentRevision: 1 }];
  const layerStore = stateStore({
    layers,
    updateLayer: (id, patch) =>
      Object.assign(
        layers.find((v) => v.id === id),
        patch,
      ),
  });
  const sceneStore = stateStore({ objects: [] });
  const projectStore = stateStore({ currentProjectId: 'test-project', setProjectLayers() {} });
  const toasts = [];
  const create = (factory) => {
    let state;
    const set = (patch) => {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
    };
    state = factory(set, () => state);
    return { getState: () => state };
  };
  // Execute the actual history store, with only its app/React dependencies replaced.
  const source = fs
    .readFileSync('src/stores/editorHistoryStore.ts', 'utf8')
    .replace(/^import .*;\r?\n/gm, '');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  new Function(
    'exports',
    'create',
    'useLayerStore',
    'useSceneStore',
    'useProjectStore',
    'useToastStore',
    'paintHistoryBoundary',
    js,
  )(
    exports,
    create,
    layerStore,
    sceneStore,
    projectStore,
    stateStore({ pushToast: (v) => toasts.push(v) }),
    boundary,
  );
  const history = exports.useEditorHistoryStore.getState;
  let pixels = 0;
  const commit = (before, after) => {
    const ready = deferred();
    let restore;
    history().captureRuntime({
      label: `stroke-${after}`,
      undo: () => restore('before'),
      redo: () => restore('after'),
    });
    boundary.track(
      ready.promise.then(() => {
        pixels = after;
        restore = (side) => {
          pixels = side === 'before' ? before : after;
        };
      }),
    );
    return ready;
  };
  const a = commit(0, 1),
    b = commit(1, 2),
    c = commit(2, 3);
  assert.equal(
    history().past.length,
    3,
    'Pointer-up reserves each stroke before decoding finishes',
  );
  history().undo();
  history().undo();
  history().redo();
  assert.equal(boundary.busy, true);
  assert.equal(toasts.length, 0, 'Do not claim undo before pixels are ready');
  a.resolve();
  b.resolve();
  c.resolve();
  await tick();
  assert.equal(pixels, 2);
  assert.equal(history().past.length, 2);
  assert.equal(history().future.length, 1);
  assert.deepEqual(
    toasts.map((t) => t.title),
    ['已撤销', '已撤销', '已恢复'],
  );
  assert.equal(boundary.busy, false);
  history().redo();
  assert.equal(pixels, 3, 'Ready history stays synchronous');
  history().undo();
  const d = commit(2, 4);
  d.resolve();
  await tick();
  assert.equal(
    history().future.length,
    0,
    'A new stroke branches once, not on delayed publication',
  );
  history().undo();
  assert.equal(pixels, 2);
  const releaseGesture = deferred();
  boundary.track(releaseGesture.promise);
  history().undo();
  assert.equal(pixels, 2, 'Undo during pointer contact waits for the stroke boundary');
  releaseGesture.resolve();
  await tick();
  assert.equal(pixels, 1);
  const failure = deferred();
  const discard = history().captureRuntime({
    undo() {
      throw Error('failed stroke');
    },
    redo() {},
  });
  boundary.track(failure.promise.then(discard));
  history().undo();
  failure.resolve();
  await tick();
  assert.equal(
    pixels,
    0,
    'Failed commits remove their reserved entry without corrupting other history',
  );
  const old = deferred();
  boundary.track(old.promise);
  let staleAction = false;
  boundary.run(() => {
    staleAction = true;
  });
  history().restorePersisted('new-project');
  let newAction = false;
  boundary.run(() => {
    newAction = true;
  });
  old.resolve();
  await tick();
  assert.equal(staleAction, false);
  assert.equal(newAction, true);

  // Execute Viewport's real paint applyTiles callback; the mock models canvas pixels and GPU uploads.
  const viewport = fs.readFileSync('src/engine/viewport/ViewportCanvas.tsx', 'utf8');
  const file = ts.createSourceFile(
    'viewport.tsx',
    viewport,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let commitNode, historyCommitNode, restoreNode, groupRegionsNode;
  const find = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'commitPaintStroke')
      commitNode = node;
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'commitStrokeHistory')
      historyCommitNode = node;
    if (ts.isFunctionDeclaration(node) && node.name?.getText(file) === 'groupPaintHistoryRegions')
      groupRegionsNode = node;
    ts.forEachChild(node, find);
  };
  find(file);
  assert.ok(groupRegionsNode, 'Paint history snapshot grouping helper must exist');
  const groupingExports = {};
  const groupingJs = ts.transpileModule(
    `${groupRegionsNode.getText(file)}\nexports.groupPaintHistoryRegions = groupPaintHistoryRegions;`,
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    },
  ).outputText;
  new Function('exports', groupingJs)(groupingExports);
  const { groupPaintHistoryRegions } = groupingExports;
  const historyTileSize = 256;
  const diagonalTiles = Array.from({ length: 16 }, (_, index) => ({
    x: index * historyTileSize,
    y: index * historyTileSize,
    width: historyTileSize,
    height: historyTileSize,
  }));
  const diagonalGroups = groupPaintHistoryRegions(diagonalTiles);
  assert.equal(diagonalGroups.length, 16, 'Sparse diagonal tiles must not allocate one 4K union');
  assert.equal(
    diagonalGroups.reduce((sum, group) => sum + group.bounds.width * group.bounds.height, 0),
    diagonalTiles.length * historyTileSize * historyTileSize,
    'Sparse history storage must contain only touched tile pixels',
  );
  const denseTiles = Array.from({ length: 12 }, (_, index) => ({
    x: (index % 4) * historyTileSize,
    y: Math.floor(index / 4) * historyTileSize,
    width: historyTileSize,
    height: historyTileSize,
  }));
  const denseGroups = groupPaintHistoryRegions(denseTiles);
  assert.deepEqual(
    denseGroups.map((group) => group.bounds),
    [{ x: 0, y: 0, width: historyTileSize * 4, height: historyTileSize * 3 }],
    'Dense tiles should retain the single fast shared-snapshot path',
  );
  assert.deepEqual(
    [...denseGroups[0].regionIndexes].sort((left, right) => left - right),
    denseTiles.map((_, index) => index),
    'Grouped snapshots must preserve every original tile mapping',
  );
  const findRestore = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'applyTiles')
      restoreNode = node.initializer;
    ts.forEachChild(node, findRestore);
  };
  findRestore(commitNode);
  const commitSource = historyCommitNode.initializer.getText(file);
  assert.match(
    commitSource,
    /scheduleIdleInpaintArchive\(draft\.layer, draft\.inpaintHistoryModel\)/,
    'Mask history keeps the live projector authoritative and archives after pointer-up',
  );
  assert.doesNotMatch(
    commitSource,
    /currentProjectionHasContentRef\.current\s*=\s*false/,
    'A deferred or failed archive must not discard the live mask authority',
  );
  assert.match(
    commitSource,
    /capturePaintHistoryRegions\(beforeCanvas, touchedBounds\)/,
    'Local repaint history captures grouped before snapshots for touched tiles',
  );
  assert.match(
    commitSource,
    /capturePaintHistoryRegions\(composite\.maskCanvas, touchedBounds\)/,
    'Local repaint history captures grouped after snapshots for touched tiles',
  );
  assert.doesNotMatch(
    commitSource,
    /copyCanvasRect\(beforeCanvas, bounds\)/,
    'Local repaint history must not allocate a canvas per touched tile',
  );
  const paintCommitSource = commitNode.initializer.getText(file);
  assert.match(
    viewport,
    /recordPaintStrokeDirtyRegion\(strokeDraftRef\.current, layer, bounds\)/,
    'Every brush/eraser segment must record its own touched history tiles',
  );
  assert.match(
    paintCommitSource,
    /draft\.historyTileKeys && draft\.historyTileKeys\.size > 0[\s\S]*?draft\.historyTileKeys[\s\S]*?: getPaintHistoryTileKeys/,
    'Paint history must prefer the exact segment tile set over the full-stroke UV union',
  );
  assert.match(
    paintCommitSource,
    /draft\.paintOperation === 'eraser'[\s\S]*?await capturePaintHistoryRegionsAsync\(layer\.paintCanvas, touchedBounds\)/,
    'Eraser history must move cold canvas readback off the main thread',
  );
  const canvas = (value) => {
    const result = { value, width: 1, height: 1 };
    result.context = {
      clearRect() {
        result.value = 0;
      },
      drawImage(image) {
        result.value = image.value;
      },
      fillRect() {
        result.value = 1;
      },
    };
    return result;
  };
  const base = canvas(0),
    live = canvas(0),
    replacementLive = canvas(0);
  const layer = {
    layerId: 'layer',
    target: 'projected-mask',
    assetUrl: 'live:base',
    paintContext: base.context,
    paintTexture: {},
    liveResultCanvas: live,
    liveResultContext: live.context,
    liveResultUrl: 'live:preview',
    liveResultTexture: {},
  };
  const active = {
    ...layer,
    liveResultCanvas: replacementLive,
    liveResultContext: replacementLive.context,
    liveResultTexture: {},
  };
  const historyTiles = [
    {
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      before: { canvas: canvas(1), sourceX: 0, sourceY: 0, width: 1, height: 1 },
      after: { canvas: canvas(0), sourceX: 0, sourceY: 0, width: 1, height: 1 },
    },
  ];
  const uploaded = [],
    marked = [];
  let cancelled = 0, promoted = 0;
  const bindings = {
    projectedEraserBatchesRef: { current: new Map() },
    projectedEraserCommit: { model: { group: {} } },
    layer,
    layerRef: { current: active },
    historyTiles,
    historyStroke: { refined: true },
    cancelProjectedEraserBatch() {
      cancelled += 1;
    },
    markLiveProjectedCanvasTextureUpdated: (url) => marked.push(url),
    scheduleTextureUpdate: (texture) => uploaded.push(texture),
    useLayerStore: layerStore,
    useProjectStore: projectStore,
    promoteProjectedEraserMaskToResidentMaterial() {
      promoted += 1;
    },
    scheduleProjectedEraserRefinement() {},
  };
  const restoreJs = ts.transpileModule(`const restore = ${restoreNode.getText(file)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const restore = new Function(...Object.keys(bindings), `${restoreJs}; return restore;`)(
    ...Object.values(bindings),
  );
  restore('before');
  assert.equal(
    base.value * live.value,
    1,
    'Undo restores visible pixels, not just the backing canvas',
  );
  assert.equal(
    replacementLive.value,
    1,
    'A reopened runtime for the same layer is neutralized too',
  );
  assert.equal(layers[0].maskUrl, 'live:base');
  assert.ok(uploaded.includes(layer.paintTexture) && uploaded.includes(layer.liveResultTexture));
  assert.ok(marked.includes('live:base') && marked.includes('live:preview'));
  restore('after');
  assert.equal(base.value * live.value, 0);
  assert.equal(cancelled, 2);
  assert.equal(promoted, 2, 'Undo and redo both promote the restored full-resolution mask');

  // Numeric tile replay tests real staging with three strokes, overlap, a new UV island, and a brush overwrite.
  const tile = (bounds, before, after) => ({ bounds, before: [before], after: [after] });
  const histories = [[tile(0, 1, 0.8)], [tile(0, 0.8, 0.4)], [tile(0, 0.4, 0.9)]];
  const original = globalThis.structuredClone(histories);
  const staged = await stageRefinedStrokeHistory({
    histories,
    bounds: [0, 1],
    key: String,
    read: (bounds) => [bounds === 0 ? 0.9 : 1],
    copy: (v) => [...v],
    affects: (index, bounds) => bounds === 1 && index === 0,
    apply: (index, v, bounds) => {
      if (index === 0) v[0] *= bounds === 0 ? 0.6 : 0.2;
      if (index === 1) v[0] *= 0.5;
      if (index === 2) v[0] = 0.9;
    },
    yieldWork: tick,
    isCurrent: () => true,
  });
  assert.deepEqual(histories, original, 'Staging never mutates live history');
  assert.equal(staged.updates[1][0].before[0], 0.6, 'Undo B retains refined A');
  assert.equal(staged.updates[1][0].after[0], 0.3, 'Redo B includes A and only B');
  assert.equal(staged.updates[2][0].before[0], 0.3, 'Brush undo returns to both refined erasures');
  assert.deepEqual(
    staged.output.map((t) => t.pixels[0]),
    [0.9, 0.2],
  );
  assert.equal(
    staged.updates[0][1].before[0],
    1,
    'Newly found island belongs to A, not the latest stroke',
  );
  const undone = await stageRefinedStrokeHistory({
    histories: histories.slice(0, 2),
    bounds: [0],
    key: String,
    read: () => [0.8],
    copy: (v) => [...v],
    affects: () => true,
    isApplied: (index) => index === 0,
    apply: (index, v) => {
      v[0] *= index === 0 ? 0.6 : 0.5;
    },
    yieldWork: tick,
    isCurrent: () => true,
  });
  assert.equal(undone.output[0].pixels[0], 0.6, 'Refining while B is undone must display only A');
  assert.equal(
    undone.updates[1][0].before[0],
    0.6,
    'Future B undo checkpoint also retains refined A',
  );
  assert.equal(
    undone.updates[1][0].after[0],
    0.3,
    'Future B redo is rebased without reapplying it now',
  );
  let current = true;
  const cancelledStage = await stageRefinedStrokeHistory({
    histories: [[]],
    bounds: [0, 1, 2, 3, 4],
    key: String,
    read: () => [1],
    copy: (v) => [...v],
    affects: () => true,
    apply: (_i, v) => {
      v[0] = 0;
    },
    yieldWork: async () => {
      current = false;
    },
    isCurrent: () => current,
  });
  assert.equal(
    cancelledStage,
    undefined,
    'Cancellation between chunks publishes neither partial pixels nor history',
  );
  assert.ok(
    viewport.indexOf('const discardHistory =') < viewport.indexOf('const finalizePaintStroke ='),
  );
  console.log(
    'Paint history transactions: ordering, fast undo/redo, gesture boundary, failure, session reset, live GPU reset, per-stroke refinement and cancellation passed.',
  );
} finally {
  await server.close();
}
