import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';

const root = path.resolve(import.meta.dirname, '..');
const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
globalThis.window = { localStorage: globalThis.localStorage, dispatchEvent: () => true };
const server = await createServer({ root, appType: 'custom', logLevel: 'silent',
  server: { middlewareMode: true, watch: { ignored: () => true } } });
const layer = (id, extra = {}) => ({ id, name: id, type: 'projected', objectId: 'a',
  imageUrl: `/${id}.png`, visible: true, opacity: 1, blendMode: 'normal', order: 0,
  createdAt: '2026-09-09', ...extra });
try {
  const { prepareUvMergeConsumption } = await server.ssrLoadModule('/src/engine/layers/uvMergeConsumption.ts');
  const { useLayerStore } = await server.ssrLoadModule('/src/stores/layerStore.ts');
  const original = [layer('keep'), layer('paint', { replacementTargetLayerId: 'draft' }),
    layer('draft', { type: 'uv', role: 'local-repaint-draft', visible: false }),
    layer('source'), layer('hidden', { visible: false }), layer('other', { objectId: 'b' })];
  const snapshot = globalThis.structuredClone(original);
  const input = { sourceLayerIds: ['paint', 'source', 'other'], objectId: 'a' };
  const plan = prepareUvMergeConsumption(original, input);
  assert.deepEqual(plan.layers.map((item) => item.id), ['keep', 'hidden', 'other']);
  assert.equal(plan.insertIndex, 1);
  assert.deepEqual(original, snapshot, 'Consumption must not mutate the undo snapshot.');
  const shared = prepareUvMergeConsumption([...original, layer('unmerged', { replacementTargetLayerId: 'draft' })], input);
  assert(shared.layers.some((item) => item.id === 'draft'), 'Keep destinations still owned by another result.');
  const target = prepareUvMergeConsumption(original, { ...input, targetUvLayerId: 'source' });
  assert(target.layers.some((item) => item.id === 'source'));
  assert.deepEqual(prepareUvMergeConsumption(original, { sourceLayerIds: ['missing'] }).layers, original);

  useLayerStore.setState({ layers: original, activeProjectedLayerId: 'paint' });
  const merged = useLayerStore.getState().mergeLayersIntoUvLayer({ ...input, imageUrl: '/verified-merged.png', role: 'merged-uv' });
  const after = useLayerStore.getState().layers;
  assert.deepEqual(after.map((item) => item.id), ['keep', merged.id, 'hidden', 'other']);
  assert.equal(useLayerStore.getState().activeProjectedLayerId, merged.id);
  assert.equal(merged.visible, true);
  assert.deepEqual(after.map((item) => item.order), [0, 1, 2, 3]);
  assert.equal(after.find((item) => item.id === 'hidden').visible, false);
  assert.deepEqual(original, snapshot);
  // The existing history system restores snapshots. Sources and their mask
  // assets remain recoverable; no physical file or generation is deleted.
  useLayerStore.getState().setLayers(snapshot);
  assert.deepEqual(useLayerStore.getState().layers.map((item) => item.id), snapshot.map((item) => item.id));
  useLayerStore.getState().setLayers(after);
  const second = useLayerStore.getState().mergeLayersIntoUvLayer({ sourceLayerIds: ['keep', merged.id],
    targetUvLayerId: merged.id, objectId: 'a', imageUrl: '/verified-second.png', role: 'merged-uv' });
  assert.equal(second.id, merged.id);
  assert.deepEqual(useLayerStore.getState().layers.map((item) => item.id), [merged.id, 'hidden', 'other']);

  const editor = readFileSync(path.join(root, 'src/routes/EditorPage.tsx'), 'utf8');
  const commit = editor.slice(editor.indexOf('const layersBeforeMerge ='), editor.indexOf('setProjectLayers(useLayerStore.getState().layers);', editor.indexOf('const layersBeforeMerge =')));
  assert.match(commit, /removedLayerIds.has\(sceneState.localRepaintProjectionSource\?\.targetLayerId/);
  assert.match(commit, /retireLocalRepaintSession\(\)/);
  const retire = editor.slice(editor.indexOf('const retireLocalRepaintSession ='), editor.indexOf('}, []);', editor.indexOf('const retireLocalRepaintSession =')));
  assert.match(retire, /localRepaintToolRequestRevisionRef.current \+= 1/);
  assert.match(retire, /setLocalRepaintProjectionSource\(undefined\)/);
  assert.match(retire, /setLocalRepaintPreviewLayer\(undefined\)/);
  const shader = readFileSync(path.join(root, 'src/engine/projection/ProjectedLayerMaterial.ts'), 'utf8');
  assert.match(shader, /useUvOverlayMap \* step\(0.0001, uvOverlayOpacity\)/);
  assert.match(shader, /float emptyHatch = step\(0.5, showEmptyProjectionHatch\) \* \(1.0 - step\(1.5, showEmptyProjectionHatch\)\)/,
    'UV presence must not force diagnostic stripes back into normal projection preview.');
  assert.match(shader, /1.0 - baseTextureAlpha \* surfaceMask/,
    'UV coverage capture must account for the retained authored base.');
  assert.match(shader.slice(shader.indexOf('const uvOverlayFragmentShader =')), /gl_FragDepthEXT = gl_FragCoord.z;/,
    'UV base must explicitly write the same geometric depth as a live repaint, including MSAA.');
  process.stdout.write('UV merge consumption, shared targets, snapshot restore and UV preview parity passed.\n');
} finally { await server.close(); }
