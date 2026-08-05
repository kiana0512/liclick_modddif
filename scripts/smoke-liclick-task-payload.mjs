import assert from 'node:assert/strict';
import {
  parseLiclickImageTaskOutput,
  parseLiclickImageTaskPayload,
} from '../apps/server/dist/services/liclickGenerationService.js';

const processing = parseLiclickImageTaskPayload({ status: 'Processing' });
assert.equal(processing.status, 'Processing');
assert.equal(processing.resultUrl, undefined);
assert.equal(processing.terminalWithoutResult, false);

const finished = parseLiclickImageTaskPayload({
  status: 'Finished',
  result: [
    'https://example.com/generated/finished.png）。',
    '[重复地址](https://example.com/generated/finished.png).',
  ],
});
assert.equal(finished.resultUrl, 'https://example.com/generated/finished.png');
assert.deepEqual(finished.resultUrls, ['https://example.com/generated/finished.png']);
assert.equal(finished.terminalWithoutResult, false);

const chineseText = parseLiclickImageTaskOutput(
  '图片生成完成，下载地址：https://example.com/generated/chinese.png。',
);
assert.equal(chineseText.resultUrl, 'https://example.com/generated/chinese.png');
assert.equal(chineseText.terminalWithoutResult, false);

const contentText = parseLiclickImageTaskPayload({
  content: [
    {
      type: 'text',
      text: '任务完成，结果：[下载](https://example.com/generated/content.png)，',
    },
  ],
});
assert.equal(contentText.resultUrl, 'https://example.com/generated/content.png');
assert.equal(contentText.terminalWithoutResult, false);

const structuredResult = parseLiclickImageTaskPayload({
  structuredContent: {
    result: JSON.stringify({
      status: 'Finished',
      result_url: 'https://example.com/generated/structured.png。',
    }),
  },
});
assert.equal(structuredResult.status, 'Finished');
assert.equal(structuredResult.resultUrl, 'https://example.com/generated/structured.png');
assert.equal(structuredResult.terminalWithoutResult, false);

const fencedContent = parseLiclickImageTaskPayload({
  content: [
    {
      type: 'text',
      text: `\`\`\`json
{"status":"Finished","output":{"image_url":"https:\\/\\/example.com/generated/fenced.webp；"}}
\`\`\``,
    },
  ],
});
assert.equal(fencedContent.status, 'Finished');
assert.equal(fencedContent.resultUrl, 'https://example.com/generated/fenced.webp');

for (const completedText of ['任务已完成', '已完成', 'Finished']) {
  const completed = parseLiclickImageTaskOutput(completedText);
  assert.equal(completed.resultUrl, undefined);
  assert.equal(completed.terminalWithoutResult, true);
}

for (const pendingText of [
  '任务尚未完成',
  '生成未完成',
  '完成后可下载',
  '完成度 90%',
  'not completed yet',
]) {
  const pending = parseLiclickImageTaskOutput(pendingText);
  assert.equal(pending.resultUrl, undefined);
  assert.equal(pending.terminalWithoutResult, false, pendingText);
}

const unrelatedUrls = parseLiclickImageTaskPayload({
  status: 'Processing',
  task_url: 'https://example.com/tasks/123',
  helpUrl: 'https://example.com/help/generation',
  input_image: 'https://example.com/input/reference.png',
  screenshot: 'https://example.com/docs/screenshot.png',
});
assert.equal(unrelatedUrls.resultUrl, undefined);
assert.deepEqual(unrelatedUrls.resultUrls, []);
assert.equal(unrelatedUrls.terminalWithoutResult, false);

const completedWithoutImage = parseLiclickImageTaskPayload({
  status: 'Finished',
  task_url: 'https://example.com/tasks/123',
  reference_url: 'https://example.com/input/reference.png',
});
assert.equal(completedWithoutImage.resultUrl, undefined);
assert.equal(completedWithoutImage.terminalWithoutResult, true);

const mixedUrls = parseLiclickImageTaskPayload({
  status: 'Finished',
  input: { image_url: 'https://example.com/input/reference.png' },
  output: {
    status_url: 'https://example.com/tasks/123',
    result_url: 'https://example.com/generated/result.png?signature=a%2Fb%3D）。',
  },
});
assert.equal(mixedUrls.resultUrl, 'https://example.com/generated/result.png?signature=a%2Fb%3D');
assert.deepEqual(mixedUrls.resultUrls, [mixedUrls.resultUrl]);

const extensionlessKnownAsset = parseLiclickImageTaskPayload({
  status: 'Finished',
  result_url:
    'https://tsh-aiteam-prod-all.oss-accelerate.aliyuncs.com/ai-assets/prod/image/result?signature=abc%2Fdef',
});
assert.equal(
  extensionlessKnownAsset.resultUrl,
  'https://tsh-aiteam-prod-all.oss-accelerate.aliyuncs.com/ai-assets/prod/image/result?signature=abc%2Fdef',
);

assert.throws(
  () => parseLiclickImageTaskPayload({ status: '失败', message: 'remote generation failed' }),
  /remote generation failed/,
);
assert.throws(() => parseLiclickImageTaskPayload({ status: 'Cancelled' }), /莉刻图片生成任务失败/);

console.log('Liclick task payload smoke passed.');
