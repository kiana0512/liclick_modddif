import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const source = await readFile(new URL('../src/engine/export/texturedExportUtils.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('export.ts', source, ts.ScriptTarget.Latest, true);
const functions = ['prepareFbxModelExport', 'getCurrentExportProjectedLayers', 'prepareProjectedLayersForExport', 'isLocalRepaintProjectionLayer'];
const code = ts.transpileModule(ast.statements.filter((node) => functions.includes(node.name?.text)).map((node) => node.getText(ast)).join('\n').replaceAll('export async', 'async'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, optimizeDeps: { noDiscovery: true, entries: [] }, resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } }, server: { middlewareMode: true, watch: { ignored: () => true } } });
try {
  const composition = await server.ssrLoadModule('/src/engine/layers/mergeUvComposition.ts');
  const uv = await server.ssrLoadModule('/src/engine/layers/uvLayerComposition.ts');
  const { resolveBakeUvMergePlan } = await server.ssrLoadModule('/src/features/workflow/selectBakeBaseColor.ts');
  const layer = (id, extra = {}) => ({ id, type: 'projected', visible: true, imageUrl: id, camera: {}, objectId: 'model', opacity: 1, order: 0, ...extra });
  let layers, scene, resolution, bakeCalls, flattened, encoded, revoked, mutate, invalid, revisions, maskOptions;
  const project = { id: 'project', name: 'fixture' };
  const group = { updateMatrixWorld() {}, traverse(cb) { cb({ matrixWorld: { elements: [1] } }); } };
  const importedModel = { objectId: 'model', group };
  const root = {};
  const reset = (rows) => {
    layers = rows; scene = { importedModel }; resolution = '2K'; bakeCalls = []; flattened = []; encoded = []; revoked = []; mutate = undefined; invalid = false; revisions = {}; maskOptions = [];
  };
  const dependencies = {
    flushLiveUvCommits: async () => {},
    ...composition, ...uv, resolveBakeUvMergePlan,
    cloneExportRoot: () => root, getTexturedExportObjectId: () => 'model',
    exportResolutionToSize: { '1K': 1024, '2K': 2048, '4K': 4096, '8K': 8192 },
    useLayerStore: { getState: () => ({ layers }) },
    useSceneStore: { getState: () => scene },
    useProjectStore: { getState: () => ({ getCurrentProject: () => project }) },
    useSettingsStore: { getState: () => ({ resolution }) },
    getLiveProjectedCanvasState: (url) => revisions[url] === undefined ? undefined : { revision: revisions[url] },
    getVisibleProjectedLayerStack: (rows, id) => rows.filter((l) => l.type === 'projected' && l.visible && l.imageUrl && l.camera && (!l.objectId || l.objectId === id)),
    createProjectionMaskedImage: async (url, mask, options) => { maskOptions.push(options); if (url === 'fail-mask') throw Error('mask failed'); return `temporary:${url}`; },
    revokeRegisteredObjectUrl: (url) => revoked.push(url),
    bakeVisibleProjectedLayersToTexture: async (options) => {
      bakeCalls.push(options); mutate?.(); if (invalid) throw Error('bad source image');
      return { imageData: { data: new Uint8ClampedArray([200, 0, 0, 128]) }, canvas: { width: 2048, height: 2048 } };
    },
    blobFromImageAssetUrl: async (url) => url,
    createImageBitmap: async (url) => ({ url, close() {} }),
    document: { createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 200, 255]) }) }) }) },
    ImageData: class { constructor() { this.data = new Uint8ClampedArray(4); } },
    encodeRgbaPngBlob: async (width, height, data) => { encoded.push({ width, height, data: [...data] }); return new Blob(['PNG']); },
    flattenVisibleLayersToBaseColor: async (...args) => { flattened.push(args); return args[1] ?? (args[2].length ? new Blob(['PNG']) : undefined); },
    findImportedBaseColorTexture: () => { throw Error('must not read original model image when merging'); },
    getExportMaterialBaseColor: () => [244, 245, 242],
    getAverageTextureColor: async () => [0.5, 0.5, 0.5], slugifyExportName: (name) => name,
  };
  const prepare = new Function(...Object.keys(dependencies), `${code}; return prepareFbxModelExport;`)(...Object.values(dependencies));
  const run = (target = 'scene') => prepare({ project, importedModel, target });
  for (const target of ['scene', 'object']) {
    reset([layer('projection'), layer('local-repaint-projection-a', { maskUrl: 'mask' }), layer('hidden', { visible: false }), layer('other', { objectId: 'other' })]);
    const original = layers;
    const out = await run(target);
    assert.equal(out.root, root); assert.ok(out.textureBlob); assert.equal(layers, original);
    assert.deepEqual(bakeCalls[0].transientLayers.map((l) => l.id), ['projection', 'local-repaint-projection-a']);
    assert.equal(bakeCalls[0].transientLayers[1].maskUrl, undefined);
    assert.equal(bakeCalls[0].transientLayers[1].ignoreSourceAlpha, false);
    assert.deepEqual(revoked, ['temporary:local-repaint-projection-a']);
    for (const key of ['commitToProject', 'markSourceLayersBaked', 'enableDilation']) assert.equal(bakeCalls[0][key], false);
    assert.equal(bakeCalls[0].skipImageEncoding, true); assert.equal(bakeCalls[0].skipCanvasUpload, true);
    assert.equal(bakeCalls[0].repairMissingUvSeams, true); assert.equal(bakeCalls[0].outputAlpha, 'transparent');
    for (const [key, value] of Object.entries(composition.getMergeUvPostprocessOptions(2048))) assert.equal(bakeCalls[0][key], value);
    assert.equal(flattened[0][0], undefined);
  }
  reset([layer('projection'), layer('merged', { type: 'uv', role: 'merged-uv', uvMergeVersion: 6 }), layer('repair', { type: 'uv', role: 'content-aware-underlay' }), layer('patch', { type: 'uv', role: 'local-repaint-overlay' })]);
  await run();
  const expected = new Uint8ClampedArray([200, 0, 0, 128]);
  composition.compositeRgbaUnderInPlace(expected, new Uint8ClampedArray([0, 0, 200, 255]), 1);
  assert.deepEqual(encoded[0].data, [...expected], 'same deterministic merge source-under pixels');
  assert.deepEqual(flattened[0][2].map((l) => l.id), ['patch'], 'local UV remains final override, merged UV not applied twice');
  reset([layer('merged', { type: 'uv', role: 'merged-uv', uvMergeVersion: 6 })]);
  await run(); assert.equal(bakeCalls.length, 0); assert.equal(flattened[0][2][0].id, 'merged');
  for (const size of ['1K', '2K', '4K', '8K']) {
    reset([layer('projection')]); resolution = size; await run();
    assert.equal(encoded[0].width, dependencies.exportResolutionToSize[size]);
    assert.equal(bakeCalls[0].resolution, encoded[0].width);
  }
  reset([layer('local-repaint-projection-a', { maskUrl: 'mask' })]);
  scene.localRepaintPreviewLayer = layer('local-repaint-projection-a', { imageUrl: 'live', maskUrl: 'mask' });
  await run(); assert.equal(bakeCalls[0].transientLayers.length, 1); assert.equal(bakeCalls[0].transientLayers[0].imageUrl, 'temporary:live');
  for (const target of ['scene', 'object']) for (const ignoreSourceAlpha of [false, true, undefined]) {
    reset([layer('local-repaint-projection-alpha', { maskUrl: 'mask', ignoreSourceAlpha })]);
    await run(target);
    assert.deepEqual(maskOptions, [{ ignoreSourceAlpha: ignoreSourceAlpha ?? true }]);
    assert.equal(bakeCalls[0].transientLayers[0].ignoreSourceAlpha, false, 'flattened coverage is applied once');
    assert.equal(bakeCalls[0].transientLayers[0].maskUrl, undefined);
  }
  for (const change of [() => { layers = [...layers]; }, () => { scene = { ...scene, importedModel: {} }; }, () => { revisions.mask = 2; }]) {
    reset([layer('local-repaint-projection-a', { maskUrl: 'mask' })]); revisions.mask = 1; mutate = change;
    await assert.rejects(run(), /已改变/); assert.equal(revoked.length, 1);
  }
  reset([layer('local-repaint-projection-a', { maskUrl: 'mask' })]); invalid = true;
  await assert.rejects(run(), /临时 UV.*bad source image/); assert.equal(revoked.length, 1);
  reset([layer('local-repaint-projection-a', { maskUrl: 'mask' }), layer('local-repaint-projection-b', { imageUrl: 'fail-mask', maskUrl: 'mask' })]);
  await assert.rejects(run(), /mask failed/); assert.equal(revoked.length, 1); assert.equal(bakeCalls.length, 0);
  const fbx = await readFile(new URL('../src/engine/export/exportFbx.ts', import.meta.url), 'utf8');
  assert.match(fbx, /await prepareFbxModelExport\(input\)/);
  assert.doesNotMatch(fbx, /createImageBitmap|prepareTexturedModelExport/);
  assert.doesNotMatch(code, /addBakedTexture|markLayersBaked|saveBlobAsset|captureHistory|commitExportBakedTexture/);
  const maskSource = await readFile(new URL('../src/engine/projection/createMaskedProjectedImage.ts', import.meta.url), 'utf8');
  const maskAst = ts.createSourceFile('mask.ts', maskSource, ts.ScriptTarget.Latest, true);
  const maskCode = ts.transpileModule(maskAst.statements.find((node) => node.name?.text === 'processMaskedProjectedImageInWorker').getText(maskAst), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const pending = new Map(); let failPost = false;
  const worker = { postMessage(message, transfer) {
    if (failPost) throw Error('post failed');
    const received = globalThis.structuredClone(message, { transfer });
    const request = pending.get(message.id); pending.delete(message.id); request.resolve(received.source);
  } };
  const processMask = new Function('getMaskedProjectedWorker', 'maskedProjectedRequests', `let maskedProjectedRequestId = 0; ${maskCode}; return processMaskedProjectedImageInWorker;`)(() => worker, pending);
  const cached = { width: 1, height: 1, data: new Uint8ClampedArray([11, 22, 33, 44]) };
  for (let i = 0; i < 3; i++) {
    const out = await processMask(cached, cached, 'projection-alpha-only');
    assert.deepEqual([...new Uint8ClampedArray(out.data)], [11, 22, 33, 44]);
    assert.equal(cached.data.byteLength, 4, 'shared image/mask cache survives repeated transfers, including alias');
  }
  failPost = true; await assert.rejects(processMask(cached, cached), /post failed/);
  assert.equal(pending.size, 0, 'failed transfer removes request');
  console.log('FBX temporary UV: both targets, shared merge rules, repaint/masks, ordering, 1K–8K, live snapshot, stale/failure cleanup and no persistence passed.');
} finally { await server.close(); }
