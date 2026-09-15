import assert from 'node:assert/strict';
import { buildExtraParams } from '../dist/services/liclickGenerationService.js';

for (const model of ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare']) {
  for (const [aspectRatio, imageSize] of [['auto', 'auto'], ['1:1', '2K'], ['16:9', '4K']]) {
    const result = buildExtraParams({ model, prompt: 'test', aspectRatio, imageSize, count: 1 },
      [{ assetId: 'guide' }, { assetId: 'material' }]);
    assert.equal(result.model, model);
    assert.equal(result.extraParams.model, model);
    assert.equal(result.extraParams.image_size, imageSize);
    assert.equal(result.extraParams.aspect_ratio, aspectRatio);
    assert.deepEqual(result.extraParams.reference_images, [
      { asset_id: 'guide', type: 'image' }, { asset_id: 'material', type: 'image' },
    ]);
    assert.equal(result.extraParams.mask, undefined);
  }
  assert.throws(() => buildExtraParams({ model, prompt: 'test', aspectRatio: 'auto', imageSize: '2K' }, []), /requires/);
  assert.throws(() => buildExtraParams({ model, prompt: 'test', aspectRatio: '1:1', imageSize: 'auto' }, []), /requires/);
  for (const imageSize of ['1K', '2K', '4K']) for (const quality of ['low', 'medium', 'high', 'xhigh', 'max']) {
    for (const workflow of ['texture-map', 'local-repaint']) {
      const { extraParams } = buildExtraParams({ model, prompt: 'test', workflow, aspectRatio: '1:1', imageSize, quality }, []);
      assert.equal(extraParams.quality, quality);
      assert.equal(extraParams.image_size, imageSize);
      assert.equal(extraParams.aspect_ratio, '1:1');
      assert.equal(extraParams.background, 'transparent');
    }
  }
  assert.throws(() => buildExtraParams({ model, prompt: 'test', quality: 'invalid' }, []), /quality/);
  assert.equal(buildExtraParams({ model, prompt: 'test' }, []).extraParams.quality, 'high');
}
assert.equal(buildExtraParams({ model: 'gpt-image-2', prompt: '', aspectRatio: '1:1' }, []).extraParams.image_size, '1K');
for (const quality of ['low', 'medium', 'high']) for (const workflow of ['texture-map', 'local-repaint']) {
  const {model, extraParams} = buildExtraParams({model:'gpt-image-2', prompt:'test', workflow, quality, imageSize:'2K', aspectRatio:'1:1'}, []);
  assert.equal(model, 'gpt-image-2');
  assert.equal(extraParams.model, model);
  assert.equal(extraParams.quality, quality);
  assert.equal(extraParams.background, 'transparent');
}
for (const quality of ['xhigh', 'max', 'invalid']) {
  assert.throws(() => buildExtraParams({model:'gpt-image-2', prompt:'test', quality}, []), /quality/);
}
for (const model of ['gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare']) {
  for (const workflow of ['texture-map', 'local-repaint']) {
    assert.equal(buildExtraParams({ model, workflow, prompt: 'test', aspectRatio: '1:1', imageSize: '2K' }, [])
      .extraParams.background, 'transparent');
  }
  assert.equal(buildExtraParams({ model, workflow: 'liclick', prompt: 'reference' }, []).extraParams.background, undefined);
}
assert.equal(buildExtraParams({ model: 'nano_banana_2', workflow: 'texture-map', prompt: 'test' }, []).extraParams.background, undefined);
console.log('GPT 2.5 registry parameter contracts and GPT2 compatibility passed (no remote generation).');
import './test-content-framing.mjs';
