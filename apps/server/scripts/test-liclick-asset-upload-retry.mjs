import assert from 'node:assert/strict';
import {
  isRetryableAtlasAssetUploadError,
  retryAtlasAssetUpload,
} from '../dist/services/liclickGenerationService.js';

assert.equal(isRetryableAtlasAssetUploadError(new Error('Atlas gateway HTTP 502: upstream connect error')), true);
assert.equal(isRetryableAtlasAssetUploadError(new Error('backend tools/call failed')), true);
assert.equal(isRetryableAtlasAssetUploadError(new Error('生成服务暂时异常，请稍后重试。')), true);
assert.equal(isRetryableAtlasAssetUploadError(new Error('Atlas gateway HTTP 400: invalid arguments')), false);
assert.equal(isRetryableAtlasAssetUploadError(new Error('LICLICK_PERSONAL_ACCOUNT_REQUIRED')), false);

{
  let attempts = 0;
  const waits = [];
  const result = await retryAtlasAssetUpload(
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('Atlas gateway HTTP 502: upstream connect error');
      return 'asset-ok';
    },
    {
      wait: async (delayMs) => waits.push(delayMs),
    },
  );
  assert.equal(result, 'asset-ok');
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [1_000, 2_000]);
}

{
  let attempts = 0;
  await assert.rejects(
    retryAtlasAssetUpload(
      async () => {
        attempts += 1;
        throw new Error('Atlas gateway HTTP 401: unauthorized');
      },
      { wait: async () => undefined },
    ),
    /401/,
  );
  assert.equal(attempts, 1);
}

{
  let attempts = 0;
  await assert.rejects(
    retryAtlasAssetUpload(
      async () => {
        attempts += 1;
        throw new Error('backend tools/call failed');
      },
      { maximumAttempts: 3, wait: async () => undefined },
    ),
    /tools\/call failed/,
  );
  assert.equal(attempts, 3);
}

console.log('liclick asset upload retry regression passed');
