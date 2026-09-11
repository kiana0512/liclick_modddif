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
  const { persistRuntimeLayerAssets } = await server.ssrLoadModule(
    '/src/services/runtimeLayerAssetPersistence.ts',
  );
  const rgba = new Blob([new Uint8Array([12, 34, 56, 0, 78, 90, 123, 255])], { type: 'image/png' });
  const urls = [0, 1].map((i) => registry.registerLiveUvRenderTarget(`save-${i}`, {
    width: 2, height: 1, toBlob: (done) => done(rgba),
  }, {}));
  const snapshot = { ...project, layers: urls.map((imageUrl, i) => ({
    id: `${UV_REPAINT_LAYER_PREFIX}-${i}`, type: 'uv', role: 'local-repaint-overlay',
    imageUrl, localRepaintSourceUrl: `original-${i}`, visible: i === 0, opacity: 0.7,
    objectId: 'model', contentRevision: i,
  })) };
  let finishCommit;
  registry.trackLiveUvCommit(new Promise((done) => { finishCommit = done; }), urls[0]);
  const stored = new Map();
  const upload = async (blob, filename) => {
    const durable = `https://assets.test/${filename}`;
    stored.set(durable, blob);
    return durable;
  };
  const saving = persistRuntimeLayerAssets(snapshot, upload);
  await Promise.resolve();
  assert.equal(stored.size, 0, 'cross-page save also waits for pending GPU readback');
  finishCommit();
  const saved = await saving;
  assert.equal(stored.size, 2, 'hidden UV layers must also be persisted');
  for (let i = 0; i < 2; i++) {
    assert.equal(snapshot.layers[i].imageUrl, urls[i], 'live editing binding is untouched');
    assert.deepEqual({ ...saved.layers[i], imageUrl: urls[i] }, snapshot.layers[i]);
    assert.deepEqual(await stored.get(saved.layers[i].imageUrl).arrayBuffer(), await rgba.arrayBuffer());
    assert.equal(saved.layers[i].maskUrl, undefined, 'RGBA needs no extra mask');
  }
  const reopened = JSON.parse(JSON.stringify(saved));
  assert.equal(await persistRuntimeLayerAssets(reopened, () => assert.fail('must not reupload')), reopened);
  await assert.rejects(persistRuntimeLayerAssets(snapshot, async () => { throw Error('upload failed'); }), /upload failed/);
  await assert.rejects(persistRuntimeLayerAssets({ ...snapshot, layers: [{ ...snapshot.layers[0],
    imageUrl: 'liclick-live-projected-canvas:missing-after-refresh',
  }] }, () => assert.fail('missing pixels must not fall back to raw generation')), /内存已失效/);
  let racedUrl;
  racedUrl = registry.registerLiveProjectedCanvasTexture('racing-save', { width: 2, height: 1,
    toBlob(done) { registry.markLiveProjectedCanvasTextureUpdated(racedUrl); done(rgba); },
  });
  await assert.rejects(persistRuntimeLayerAssets({ ...snapshot, layers: [{ ...snapshot.layers[0],
    imageUrl: racedUrl,
  }] }, () => assert.fail('mixed paint revision must not upload')), /笔画发生变化/);
  const temporary = URL.createObjectURL(rgba);
  try {
    const blobSaved = await persistRuntimeLayerAssets({ ...snapshot,
      layers: [{ ...snapshot.layers[0], imageUrl: temporary, maskUrl: temporary }],
    }, upload);
    assert.equal(blobSaved.layers[0].imageUrl, blobSaved.layers[0].maskUrl, 'shared URL uploaded once');
  } finally { URL.revokeObjectURL(temporary); }
  const apiSource = await readFile(new URL('../src/services/workspaceApiClient.ts', import.meta.url), 'utf8');
  assert.match(apiSource, /async function saveProjectDirect[\s\S]*?await persistRuntimeLayerAssets[\s\S]*?executeProjectCommand/,
    'both saveProject and updateLatestProject must persist runtime assets before document CAS');
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
  assert.match(
    editor,
    /await flushLiveUvCommits\(\);[\s\S]*const uvSnapshots = new Map/,
    'merge waits for committed UV pixels',
  );
  assert.match(
    editor,
    /getLiveProjectedTextureBlob\(layer.imageUrl\)/,
    'merge resolves live pixels',
  );
  assert.match(
    editor,
    /compositeRgbaUrlUnderWithWebGpu\(\s*mergedRgba,\s*uvSourceUrl,/,
    'Worker consumes snapshot',
  );
  assert.match(
    editor,
    /urlToImageData\(uvSourceUrl, bakeResolution, bakeResolution\)/,
    'CPU consumes same snapshot',
  );
  assert.match(
    editor,
    /temporaryUvSnapshots.forEach\(\(url\) => URL.revokeObjectURL\(url\)\)/,
    'merge releases temporary URLs',
  );
  const engine = await readFile(
    new URL('../src/engine/localRepaint/uvRepaint.ts', import.meta.url),
    'utf8',
  );
  // Exercise the production coordinate adapter in CI without a GPU.
  const scissorBody = engine.match(/function setUvScissor\([^)]*\)\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(scissorBody, 'UV tile scissor must have one physical-pixel adapter');
  const setUvScissor = new Function('renderer', 'bounds', scissorBody);
  assert.equal(
    (engine.match(/setUvScissor\(this\.renderer, (?:tile\.bounds|bounds)\)/g) ?? []).length,
    2,
    'both source and output passes use the same adapter',
  );
  for (const dpr of [1, 1.25, 1.5, 2]) {
    for (const bounds of [
      { x: 256, y: 768, width: 256, height: 256 },
      { x: 512, y: 512, width: 128, height: 128 },
    ]) {
      let physical, enabled;
      setUvScissor(
        {
          getPixelRatio: () => dpr,
          setScissor: (...values) => {
            physical = values.map((v) => Math.round(v * dpr));
          },
          setScissorTest: (value) => {
            enabled = value;
          },
        },
        bounds,
      );
      assert.deepEqual(physical, [bounds.x, bounds.y, bounds.width, bounds.height]);
      assert.equal(enabled, true);
    }
  }
  assert.doesNotMatch(
    engine,
    /请先展开不重叠 UV|countMaterial/,
    'shared UV is explicitly permitted',
  );
  assert.match(
    engine,
    /THREE\.UniformsUtils\.clone\(material\.uniforms\)/,
    'capture source lifetime is owned by the engine',
  );
  assert.match(
    engine,
    /gl_FragDepth = 1\.0 - weight/,
    'strongest visible hit selects shared pixel',
  );
  assert.match(
    engine,
    /render\(this\.compositeScene, input\.camera\)/,
    'one composite per texel avoids repeated shared erase',
  );
  console.log(
    'Native UV: independent RGBA, frozen source, old-layer/selection retention, deletion guard, user settings, save barrier/failure and lazy pipeline passed.',
  );
} finally {
  await server.close();
}
