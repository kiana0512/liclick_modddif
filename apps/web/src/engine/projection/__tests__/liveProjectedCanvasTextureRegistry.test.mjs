import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getLiveProjectedCanvasState,
  getLiveProjectedCanvasTexture,
  getLiveProjectedTextureBlob,
  getLiveProjectedTextureSourceState,
  registerLiveProjectedCanvasTexture,
  registerLiveProjectedImageTexture,
} from '../liveProjectedCanvasTextureRegistry.ts';

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
