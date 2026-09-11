import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import * as THREE from 'three';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
const server = await createServer({
  root: fileURLToPath(new URL('../../../../', import.meta.url)),
  logLevel: 'silent',
  server: { middlewareMode: true, watch: { ignored: () => true } },
});
after(() => server.close());
const {
  getLiveProjectedCanvasState,
  getLiveProjectedCanvasTexture,
  getLiveProjectedTexture,
  getLiveProjectedTextureBlob,
  getLiveProjectedTextureSourceState,
  markLiveProjectedCanvasTextureUpdated,
  registerLiveProjectedCanvasTexture,
  registerLiveProjectedImageTexture,
} = await server.ssrLoadModule('/src/engine/projection/liveProjectedCanvasTextureRegistry.ts');

test('repeated reads of a multi-layer live stack do not dirty unchanged GPU sources', () => {
  const entries = Array.from({ length: 8 }, (_, layer) => {
    const imageUrl = registerLiveProjectedImageTexture(`read-image-${layer}`, { width: 1024, height: 1024 }, THREE.SRGBColorSpace);
    const maskUrls = ['raw', 'blend'].map((kind) =>
      registerLiveProjectedCanvasTexture(`read-${kind}-${layer}`, { width: 1024, height: 1024 }),
    );
    return [imageUrl, ...maskUrls].map((url, index) => {
      const colorSpace = index === 0 ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      const texture = getLiveProjectedTexture(url, colorSpace);
      return { url, colorSpace, texture, version: texture.version, sourceVersion: texture.source.version };
    });
  }).flat();
  for (let pass = 0; pass < 60; pass += 1) {
    for (const { url, colorSpace, texture } of entries) {
      assert.equal(getLiveProjectedTexture(url, colorSpace, { flipY: false }), texture);
      if (texture.isCanvasTexture) assert.equal(getLiveProjectedCanvasTexture(url), texture);
    }
  }
  for (const { texture, version, sourceVersion } of entries) {
    assert.equal(texture.version, version);
    assert.equal(texture.source.version, sourceVersion);
  }
});

test('content writes, backing replacement and changed sampling still request uploads', async () => {
  let encodes = 0;
  const canvas = { width: 64, height: 64, toBlob: (callback) => { encodes += 1; callback(new Blob(['mask'])); } };
  const url = registerLiveProjectedCanvasTexture('write-contract', canvas);
  const texture = getLiveProjectedCanvasTexture(url);
  let version = texture.version;
  const png = await getLiveProjectedTextureBlob(url);
  getLiveProjectedCanvasTexture(url);
  assert.equal(await getLiveProjectedTextureBlob(url), png);
  assert.equal(encodes, 1);
  markLiveProjectedCanvasTextureUpdated(url);
  assert.equal(texture.version, ++version);
  assert.notEqual(await getLiveProjectedTextureBlob(url), png);
  assert.equal(encodes, 2);
  markLiveProjectedCanvasTextureUpdated(url, { upload: false });
  getLiveProjectedCanvasTexture(url);
  assert.equal(texture.version, version, 'persistence-only invalidation must not re-upload on read');
  assert.equal(getLiveProjectedCanvasState(url).revision, 2);
  await getLiveProjectedTextureBlob(url);
  assert.equal(encodes, 3);
  registerLiveProjectedCanvasTexture('write-contract', canvas);
  assert.equal(texture.version, ++version, 'registration remains an explicit publication');
  const replacement = { width: 128, height: 128 };
  registerLiveProjectedCanvasTexture('write-contract', replacement);
  assert.equal(texture.version, ++version);
  assert.equal(texture.image, replacement);
  assert.equal(getLiveProjectedCanvasState(url).revision, 3);
  getLiveProjectedCanvasTexture(url, THREE.SRGBColorSpace, { flipY: true });
  assert.equal(texture.version, ++version);
  getLiveProjectedCanvasTexture(url, THREE.SRGBColorSpace, { flipY: true });
  assert.equal(texture.version, version);
  for (const [key, value] of [
    ['wrapS', THREE.RepeatWrapping], ['wrapT', THREE.RepeatWrapping],
    ['minFilter', THREE.NearestFilter], ['magFilter', THREE.NearestFilter], ['generateMipmaps', true],
  ]) {
    texture[key] = value;
    getLiveProjectedCanvasTexture(url, THREE.SRGBColorSpace, { flipY: true });
    assert.equal(texture.version, ++version, `repair ${key} must re-upload`);
    assert.notEqual(texture[key], value);
  }
});

test('keeps resident texture identity when a stable live canvas URL changes backing canvas', () => {
  const firstCanvas = { width: 64, height: 64 };
  const secondCanvas = { width: 64, height: 64 };
  const url = registerLiveProjectedCanvasTexture('resident-mask-test', firstCanvas);
  const residentTexture = getLiveProjectedCanvasTexture(url);

  assert.ok(residentTexture);
  assert.equal(getLiveProjectedCanvasState(url)?.revision, 0);

  const sameUrl = registerLiveProjectedCanvasTexture('resident-mask-test', secondCanvas);
  const refreshedTexture = getLiveProjectedCanvasTexture(sameUrl);

  assert.equal(sameUrl, url);
  assert.equal(refreshedTexture, residentTexture);
  assert.equal(refreshedTexture?.image, secondCanvas);
  assert.equal(getLiveProjectedCanvasState(url)?.canvas, secondCanvas);
  assert.equal(getLiveProjectedCanvasState(url)?.revision, 1);
});

test('resized eraser masks reallocate GPU storage once, without changing resident texture identity', () => {
  for (const access of ['publish', 'canvas-read', 'texture-read', 'registration']) {
    const canvas = { width: 1, height: 1 };
    const url = registerLiveProjectedCanvasTexture(`resize-${access}`, canvas);
    const texture = getLiveProjectedCanvasTexture(url);
    const source = texture.source;
    let disposals = 0;
    texture.addEventListener('dispose', () => { disposals += 1; });
    const version = texture.version;
    canvas.width = canvas.height = 2048;
    if (access === 'publish') markLiveProjectedCanvasTextureUpdated(url);
    if (access === 'canvas-read') getLiveProjectedCanvasTexture(url);
    if (access === 'texture-read') getLiveProjectedTexture(url);
    if (access === 'registration') registerLiveProjectedCanvasTexture(`resize-${access}`, canvas);
    assert.equal(disposals, 1, access);
    assert.equal(texture.version, version + 1, access);
    assert.equal(getLiveProjectedCanvasTexture(url), texture);
    assert.equal(texture.source, source);
    assert.equal(texture.image, canvas);
    for (let i = 0; i < 50; i += 1) {
      markLiveProjectedCanvasTextureUpdated(url);
      getLiveProjectedTexture(url);
    }
    assert.equal(disposals, 1, 'same-size strokes and reads must not reallocate storage');
    canvas.height = 1024;
    markLiveProjectedCanvasTextureUpdated(url, { upload: false });
    assert.equal(disposals, 2, 'a one-axis resize must also discard incompatible storage');
    const replacement = { width: 4096, height: 2048 };
    registerLiveProjectedCanvasTexture(`resize-${access}`, replacement);
    assert.equal(disposals, 3);
    assert.equal(getLiveProjectedTexture(url), texture);
    assert.equal(texture.image, replacement);
  }
});

test('exposes decoded live images to baking and persistence consumers', async () => {
  const previousHtmlImageElement = globalThis.HTMLImageElement;
  class TestImageElement {
    naturalWidth = 64;
    naturalHeight = 32;
    width = 64;
    height = 32;
  }
  globalThis.HTMLImageElement = TestImageElement;
  const image = new TestImageElement();
  const url = registerLiveProjectedImageTexture('bake-image-test', image);
  const sourceState = getLiveProjectedTextureSourceState(url);

  assert.equal(sourceState?.source, image);
  assert.equal(sourceState?.revision, 0);

  const previousDocument = globalThis.document;
  let drawnSource;
  globalThis.document = {
    createElement(tagName) {
      assert.equal(tagName, 'canvas');
      return {
        width: 0,
        height: 0,
        getContext(kind) {
          assert.equal(kind, '2d');
          return {
            drawImage(source) {
              drawnSource = source;
            },
          };
        },
        toBlob(callback, type) {
          callback(new Blob(['png'], { type }));
        },
      };
    },
  };

  try {
    const blob = await getLiveProjectedTextureBlob(url);
    assert.equal(drawnSource, image);
    assert.equal(blob?.type, 'image/png');
  } finally {
    globalThis.document = previousDocument;
    globalThis.HTMLImageElement = previousHtmlImageElement;
  }
});
