import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const server = await createServer({
  root,
  logLevel: 'silent',
  server: { middlewareMode: true, watch: { ignored: () => true } },
});
try {
  const { isNativeUvRepaintLayer, UV_REPAINT_LAYER_PREFIX } = await server.ssrLoadModule(
    '/src/engine/localRepaint/uvRepaintState.ts',
  );
  const { publishUvRepaintLayer } = await server.ssrLoadModule(
    '/src/engine/localRepaint/uvRepaintLayer.ts',
  );
  const { useLayerStore } = await server.ssrLoadModule('/src/stores/layerStore.ts');
  const { useProjectStore } = await server.ssrLoadModule('/src/stores/projectStore.ts');
  const registry = await server.ssrLoadModule(
    '/src/engine/projection/liveProjectedCanvasTextureRegistry.ts',
  );
  const project = {
    id: 'uv-contract',
    objects: [],
    layers: [],
    captures: [],
    generations: [],
    references: [],
    bakedTextures: [],
  };
  useProjectStore.setState({ currentProjectId: project.id, projects: [project] });
  const old = {
    id: 'old-projected',
    type: 'projected',
    imageUrl: 'unchanged',
    visible: true,
    order: 0,
  };
  useLayerStore.setState({ layers: [old], activeProjectedLayerId: old.id });
  const id = `${UV_REPAINT_LAYER_PREFIX}-fixture`;
  const source = {
    generationId: 'gen',
    captureId: 'capture',
    imageUrl: 'source',
    rawImageUrl: 'raw',
    allowedMaskUrl: 'frozen-author',
    targetLayerId: 'draft',
    camera: {},
  };
  assert.equal(
    publishUvRepaintLayer({ id, assetUrl: 'rgba', source, objectId: 'model' }),
    false,
    'late readback must not recreate deleted layer',
  );
  assert.equal(
    publishUvRepaintLayer({ id, assetUrl: 'rgba', source, objectId: 'model', initialize: true }),
    true,
  );
  let row = useLayerStore.getState().layers.find((layer) => layer.id === id);
  assert.equal(isNativeUvRepaintLayer(row), true);
  assert.equal(row.localRepaintSourceUrl, 'source');
  assert.equal(row.imageUrl, 'rgba');
  assert.equal(row.maskUrl, undefined);
  assert.equal(row.localRepaintMaskUrl, undefined);
  assert.equal(row.ignoreSourceAlpha, false);
  assert.equal(row.renderedColor, false);
  assert.equal(source.allowedMaskUrl, 'frozen-author');
  assert.equal(useLayerStore.getState().activeProjectedLayerId, old.id);
  assert.equal(
    useLayerStore.getState().layers.find((layer) => layer.id === old.id).imageUrl,
    'unchanged',
  );
  useLayerStore.getState().updateLayer(id, { opacity: 0.4, visible: false });
  publishUvRepaintLayer({ id, assetUrl: 'next-rgba', source, objectId: 'model' });
  row = useLayerStore.getState().layers.find((layer) => layer.id === id);
  assert.equal(row.opacity, 0.4);
  assert.equal(row.visible, false);
  const canvas = {
    width: 4,
    height: 4,
    toBlob(callback) {
      callback(new Blob(['PNG']));
    },
  };
  const texture = {};
  const url = registry.registerLiveUvRenderTarget('contract', canvas, texture);
  let resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  registry.trackLiveUvCommit(pending, url);
  let encoded = false;
  const png = registry.getLiveProjectedTextureBlob(url).then(() => {
    encoded = true;
  });
  await Promise.resolve();
  assert.equal(encoded, false, 'save waits for GPU dirty tiles');
  resolve();
  await png;
  assert.equal(encoded, true);
  registry.trackLiveUvCommit(Promise.reject(Error('readback failed')), url);
  await assert.rejects(registry.flushLiveUvCommits());
  await Promise.resolve();
  await assert.rejects(
    registry.getLiveProjectedTextureBlob(url),
    /读回失败/,
    'failed commit cannot silently save stale image',
  );
  registry.unregisterLiveUvRenderTarget(url, texture);
  await registry.flushLiveUvCommits();
  const viewport = await readFile(
    new URL('../src/engine/viewport/ViewportCanvas.tsx', import.meta.url),
    'utf8',
  );
  assert.match(
    viewport,
    /await import\('@\/engine\/localRepaint\/uvRepaintSession'\)/,
    'new GPU session is lazy',
  );
  assert.match(
    viewport,
    /if \(composite\.nativeUv\) return;/,
    'native layer bypasses legacy per-stroke bake',
  );
  const exporter = await readFile(
    new URL('../src/engine/export/texturedExportUtils.ts', import.meta.url),
    'utf8',
  );
  assert.match(
    exporter,
    /isLocalRepaintUvOverlayLayer\(layer\) && !isNativeUvRepaintLayer\(layer\)/,
    'do not expand native author coverage with legacy export repair',
  );
  const editor = await readFile(new URL('../src/routes/EditorPage.tsx', import.meta.url), 'utf8');
  assert.match(editor, /await flushLiveUvCommits\(\);[\s\S]*const uvSnapshots = new Map/, 'merge waits for committed UV pixels');
  assert.match(editor, /getLiveProjectedTextureBlob\(layer.imageUrl\)/, 'merge resolves live pixels');
  assert.match(editor, /compositeRgbaUrlUnderWithWebGpu\(\s*mergedRgba,\s*uvSourceUrl,/, 'Worker consumes snapshot');
  assert.match(editor, /urlToImageData\(uvSourceUrl, bakeResolution, bakeResolution\)/, 'CPU consumes same snapshot');
  assert.match(editor, /temporaryUvSnapshots.forEach\(\(url\) => URL.revokeObjectURL\(url\)\)/, 'merge releases temporary URLs');
  console.log(
    'Native UV: independent RGBA, frozen source, old-layer/selection retention, deletion guard, user settings, save barrier/failure and lazy pipeline passed.',
  );
} finally {
  await server.close();
}
