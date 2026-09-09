import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import * as THREE from 'three';
const server = await createServer({
  configFile: false,
  optimizeDeps: { noDiscovery: true, entries: [] },
  resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
  // One-shot SSR regression: file watching is unnecessary and can exhaust
  // the shared Linux runner's inotify/file-descriptor limits (EMFILE).
  server: { middlewareMode: true, watch: null },
});
try {
  const {
    diffSelectionPixels,
    applySelectionPixelPatches,
    selectionPixelsHaveContent,
    getSelectionConsumptionMaterial,
  } = await server.ssrLoadModule('/src/engine/localRepaint/consumeSelectionMask.ts');
  assert.deepEqual(server.watcher.getWatched(), {}, 'one-shot SSR must not install file watchers');
  const before = new Uint8Array(256 * 256 * 4).fill(255),
    after = before.slice();
  after[4096] = 0;
  after[8193] = 100;
  const patches = diffSelectionPixels(before, after, 256);
  assert.equal(patches.length, 2);
  assert.equal(
    patches.reduce((n, p) => n + p.before.length + p.after.length, 0),
    16,
  );
  applySelectionPixelPatches(after, patches, 'before');
  assert.deepEqual(after, before);
  applySelectionPixelPatches(after, patches, 'after');
  assert.equal(after[4096], 0);
  assert.equal(after[8193], 100);
  assert.equal(diffSelectionPixels(before, before, 256).length, 0);
  assert.throws(() => diffSelectionPixels(before, new Uint8Array(4), 256));
  assert.equal(selectionPixelsHaveContent(new Uint8Array(4), false), false);
  assert.equal(selectionPixelsHaveContent(new Uint8Array([0, 0, 255, 255]), false), false);
  assert.equal(selectionPixelsHaveContent(new Uint8Array([0, 3, 0, 0]), false), true);
  assert.equal(selectionPixelsHaveContent(new Uint8Array(4), true), true);
  const source = new THREE.ShaderMaterial({
    uniforms: {
      transparentProjectionOnly: { value: 1 },
      projectorMatrix: { value: new THREE.Matrix4() },
      maskMap: { value: 'frozen' },
    },
    vertexShader: 'void main() {}',
    fragmentShader: 'void main() {}',
  });
  const consume = getSelectionConsumptionMaterial(source);
  assert.equal(getSelectionConsumptionMaterial(source), consume);
  assert.equal(consume.uniforms.maskMap, source.uniforms.maskMap, 'borrow immutable authorization');
  assert.match(consume.fragmentShader, /repaintFragment\(\);/, 'same actual alpha calculation');
  assert.match(
    consume.fragmentShader,
    /alpha \* front, alpha \* \(1.0 - front\)/,
    'two sides independent',
  );
  let disposed = false;
  consume.addEventListener('dispose', () => {
    disposed = true;
  });
  source.dispose();
  assert.equal(disposed, true);
  const viewport = await readFile(
    new URL('../src/engine/viewport/ViewportCanvas.tsx', import.meta.url),
    'utf8',
  );
  assert.match(
    viewport,
    /strokePaintTool === 'inpaint-apply' &&\s*localRepaintComposite/,
    'erase cannot consume',
  );
  assert.match(viewport, /restoreSelection\?\.\(side\)/, 'same undo step restores both');
  assert.match(
    viewport,
    /undo: \(\) => applyTiles\('before'\),\s*redo: \(\) => applyTiles\('after'\)/,
  );
  const implementation = viewport.slice(
    viewport.indexOf('const consumeRepaintStrokeSelection'),
    viewport.indexOf('const commitStrokeHistory'),
  );
  assert.doesNotMatch(
    implementation,
    /allowedMask|clearPaintMask\(|toDataURL|toBlob/,
    'no frozen mutation, full clear or per-stroke PNG',
  );
  assert.match(
    implementation,
    /restoreInpaintMaskHistoryState\(layer, model, before\)/,
    'failure restores working mask',
  );
  assert.match(
    implementation,
    /if \(!patches.length\) return undefined/,
    'no-op creates no mask history',
  );
  console.log(
    'Repaint selection consumption: sparse history, sided coverage, erase guard, atomic restore and lifecycle passed.',
  );
} finally {
  await server.close();
}
