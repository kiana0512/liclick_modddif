import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({ root, logLevel: 'silent',
  server: { middlewareMode: true, watch: { ignored: () => true } } });
try {
  const { useLayerStore } = await server.ssrLoadModule('/src/stores/layerStore.ts');
  const { useProjectStore } = await server.ssrLoadModule('/src/stores/projectStore.ts');
  const { getSelectedLocalRepaintLayer } = await server.ssrLoadModule('/src/engine/localRepaint/sessionLayer.ts');
  const { publishUvRepaintLayer } = await server.ssrLoadModule('/src/engine/localRepaint/uvRepaintLayer.ts');
  useProjectStore.setState({ projects: [], currentProjectId: undefined });
  const row = useLayerStore.getState().addEmptyLayer({ objectId: 'model', name: '用户命名' });
  const a = { ...row, imageUrl: 'old-pixels', role: 'merged-uv', opacity: 0.4,
    strength: 0.7, adjustments: { hue: 0.1, saturation: 0.2, lightness: 0.3 } };
  const b = { ...row, id: 'B' };
  const projected = { ...row, id: 'projected', type: 'projected' };
  const hidden = { ...row, id: 'hidden', visible: false };
  const foreign = { ...row, id: 'foreign', objectId: 'other-model' };
  const repairRows = [
    { ...row, id: 'repair-role', role: 'content-aware-underlay' },
    { ...row, id: 'repair-generation', generationId: 'texture-map-content-aware-repair' },
    { ...row, id: 'content-aware-uv-repair-legacy' },
    { ...row, id: 'content-aware-projected-repair-legacy' },
  ];
  const rows = [b, a, projected, hidden, foreign, ...repairRows];
  for (const id of [...rows.map(layer => layer.id), undefined]) {
    useLayerStore.setState({ layers: rows, activeProjectedLayerId: id });
    const before = useLayerStore.getState();
    assert.equal(getSelectedLocalRepaintLayer('model')?.id, [a.id, b.id].includes(id) ? id : undefined);
    assert.equal(useLayerStore.getState(), before, 'lookup must be read-only');
  }
  for (const layer of repairRows) {
    const before = useLayerStore.getState();
    assert.equal(publishUvRepaintLayer({ id: layer.id, objectId: 'model',
      source: { destinationMode: 'selected-uv', targetLayerId: layer.id },
      assetUrl: 'must-not-overwrite', initialize: true }), false);
    assert.equal(useLayerStore.getState(), before, 'repair layer must not be overwritten');
  }
  useLayerStore.setState({ layers: rows, activeProjectedLayerId: a.id });
  const source = { imageUrl: 'new-source', destinationMode: 'selected-uv', targetLayerId: a.id };
  for (const generationId of ['one', 'two']) {
    assert.equal(publishUvRepaintLayer({
      id: a.id, objectId: 'model', source: { ...source, generationId },
      assetUrl: 'composited-pixels', initialize: true,
    }), true);
    const now = useLayerStore.getState().layers.find(layer => layer.id === a.id);
    const { imageUrl, contentRevision, ...properties } = now;
    const original = { ...a };
    delete original.imageUrl;
    assert.deepEqual(properties, original, 'source must not overwrite user metadata or bind a generation');
    assert.equal(imageUrl, 'composited-pixels');
    assert.ok(contentRevision > 0);
    assert.equal(useLayerStore.getState().layers.length, rows.length);
    assert.equal(useLayerStore.getState().activeProjectedLayerId, a.id);
  }
  useLayerStore.setState({ layers: [b] });
  assert.equal(publishUvRepaintLayer({ id: a.id, objectId: 'model', source, assetUrl: 'late', initialize: true }), false);
  assert.deepEqual(useLayerStore.getState().layers, [b], 'late initialization must not resurrect a deleted layer');
  assert.equal(publishUvRepaintLayer({ id: b.id, objectId: 'model', source, assetUrl: 'wrong' }), false);
  assert.equal(getSelectedLocalRepaintLayer('model'), undefined);
  const panel = await readFile(root + '/src/components/panels/GeneratePanel.tsx', 'utf8');
  assert.doesNotMatch(panel, /ensureLocalRepaintSessionLayer|addEmptyLayer/);
  const editor = await readFile(root + '/src/routes/EditorPage.tsx', 'utf8');
  assert.doesNotMatch(editor, /ensureLocalRepaintSessionLayer|collapseLocalRepaintProjectionLayers/);
  assert.match(editor, /<RepaintLayerNotice/);
  assert.match(editor, /captureHistory\('新建局部重绘图层'\)/);
  console.log('Manual repaint: read-only selected target, hidden/foreign/projected rejection, explicit creation gate, reused row/metadata, generation independence and no resurrection passed.');
} finally { await server.close(); }
