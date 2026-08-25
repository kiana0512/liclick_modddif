import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getLiveProjectedTextureBlob,
  getLiveProjectedTextureSourceState,
  registerLiveProjectedImageTexture,
} from '../liveProjectedCanvasTextureRegistry.ts';

test('exposes decoded live images to baking and persistence consumers', async () => {
  const image = { naturalWidth: 64, naturalHeight: 32, width: 64, height: 32 };
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
  }
});
