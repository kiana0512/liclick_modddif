import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildQwen3VlPlusRequest,
  buildQwenLocalRepaintDiagnosisRequest,
  buildPromptPolishAtlasArgs,
  buildPromptPolishMessage,
  getLocalRepaintPromptFormatIssues,
  normalizeLocalRepaintPrompt,
  normalizeQwen3VlPlusImage,
  parsePolishedPrompt,
  polishPrompt,
  validateLocalRepaintPrompt,
  validateLocalRepaintDiagnosis,
} from '../dist/services/promptPolishService.js';
import { serverConfig } from '../dist/config.js';

const localMessage = buildPromptPolishMessage({
  prompt: 'remove the old label and restore the yellow painted metal',
  context: 'local-repaint',
  objectName: 'industrial cutter',
  referenceNames: ['reference.png'],
  hasMask: true,
});
assert.match(localMessage, /FLUX\.2 Klein/);
assert.match(localMessage, /remove the old label/);
assert.match(localMessage, /industrial cutter/);
assert.match(localMessage, /exactly four paragraphs/);
assert.match(localMessage, /independent mask defines the complete editable region/);
assert.match(localMessage, /Image 1 is the clean current effect with no mask-preview overlay/);
assert.match(localMessage, /Image 2 supplies only relevant structure/);
assert.match(localMessage, /For text edits, specify exact spelling/);
assert.doesNotMatch(localMessage, /limit automatic diagnosis/);
assert.doesNotMatch(localMessage, /[\u3400-\u9fff]/);

for (const prompt of ['', '   \n\t']) {
  const emptyMessage = buildPromptPolishMessage({
    prompt,
    context: 'local-repaint',
    hasMask: true,
  });
  assert.doesNotMatch(emptyMessage, /limit automatic diagnosis/);
  assert.doesNotMatch(emptyMessage, /then restore the corresponding content from Image 2/);
  assert.match(emptyMessage, /exactly four paragraphs/);
  assert.match(emptyMessage, /130 to 220 English words/);
}

const currentEffectDataUrl = 'data:image/png;base64,AQ==';
const referenceDataUrl = 'data:image/webp;base64,Ag==';
const maskDataUrl = 'data:image/png;base64,Aw==';
const multimodalRequest = buildQwen3VlPlusRequest({
  prompt: 'restore the masked label',
  context: 'local-repaint',
  hasMask: true,
  currentEffectImage: { name: 'current.png', dataUrl: currentEffectDataUrl },
  referenceImage: { name: 'reference.webp', dataUrl: referenceDataUrl },
  maskImage: { name: 'mask.png', dataUrl: maskDataUrl },
});
assert.equal(multimodalRequest.model, 'qwen3-vl-plus');
assert.equal(multimodalRequest.messages[0].role, 'system');
assert.match(multimodalRequest.messages[0].content, /FLUX\.2 Klein/);
const multimodalContent = multimodalRequest.messages[1].content;
assert.deepEqual(
  multimodalContent.filter((part) => part.type === 'image_url').map((part) => part.image_url.url),
  [currentEffectDataUrl, referenceDataUrl, maskDataUrl],
);
assert.match(multimodalContent[0].text, /clean current effect with no mask-preview overlay/);
assert.match(multimodalContent[0].text, /original independent edit mask without dilation/);
const diagnosisRequest = buildQwenLocalRepaintDiagnosisRequest({
  prompt: '',
  context: 'local-repaint',
  hasMask: true,
  currentEffectImage: { name: 'current.png', dataUrl: currentEffectDataUrl },
  referenceImage: { name: 'reference.webp', dataUrl: referenceDataUrl },
  maskImage: { name: 'mask.png', dataUrl: maskDataUrl },
});
assert.doesNotMatch(diagnosisRequest.messages[0].content, /FLUX\.2 Klein|exactly four paragraphs/);
assert.match(diagnosisRequest.messages[0].content, /只输出一句简短中文修复要求/);
assert.match(diagnosisRequest.messages[0].content, /文字的重复、扭曲、缺笔或错位/);
assert.match(diagnosisRequest.messages[0].content, /保留真实焊缝/);
assert.match(diagnosisRequest.messages[0].content, /无法辨认时不得猜测/);
assert.deepEqual(diagnosisRequest.messages[1].content.slice(1), multimodalContent.slice(1));
assert.equal(diagnosisRequest.max_tokens, 512);
for (const value of [
  '修复接缝',
  '修复面板下方的接缝和色差。',
  '修复标牌文字的重影与错位。',
  '未发现明确异常，保留现有外观。',
])
  assert.equal(validateLocalRepaintDiagnosis(value), true);
for (const value of [
  '',
  '修复',
  '修复接缝。修复色差。',
  '修复接缝\n修复色差',
  '# 修复接缝',
  '{"问题":"修复接缝"}',
  '修复' + '接缝'.repeat(61),
])
  assert.equal(validateLocalRepaintDiagnosis(value), false);

const onePixelPng =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const normalizedVisual = await normalizeQwen3VlPlusImage({
  name: 'mask.png',
  dataUrl: onePixelPng,
});
assert.equal(normalizedVisual.name, 'mask.jpg');
assert.match(normalizedVisual.dataUrl, /^data:image\/jpeg;base64,/);

const generalMessage = buildPromptPolishMessage({
  prompt: 'rusted blue steel',
  context: 'general',
  modelName: 'GPT Image 2',
});
assert.match(generalMessage, /GPT Image 2/);
assert.match(generalMessage, /保留原意和原始语言/);
assert.doesNotMatch(generalMessage, /FLUX\.2 Klein/);
assert.doesNotMatch(generalMessage, /limit automatic diagnosis/);
assert.doesNotMatch(
  buildPromptPolishAtlasArgs({
    prompt: 'rusted blue steel',
    context: 'general',
  }).join(' '),
  /--file/,
);

const validLocalPrompt = `Edit only the white masked region. Treat the mask strictly as an editable boundary rather than visible white content, and keep every unmasked pixel protected.

Completely remove the old printed label, its ink, edge discoloration, contact shadows, and all remaining fragments from the masked panel. Reconstruct the exposed base as continuous aged yellow painted metal with the same shallow surface relief, fine scratches, dust, and worn finish visible around the mask.

Fit the reconstruction to Image 1's panel geometry, curvature, perspective, surface direction, and structural borders. Match the surrounding yellow tone, rough metallic response, directional lighting, soft shadows, reflections, texture scale, rust specks, abrasion, dirt, and sharpness without seams, halos, hard edges, blur, color steps, repeated texture, or perspective errors.

The completed region should read as an authentic uninterrupted section of the original weathered panel with no evidence that a label was ever present. Do not introduce new text, logos, shapes, holes, raised parts, or unrelated damage, and preserve Image 1's original geometry, silhouette, object identity, camera angle, perspective, composition, background, and all content outside the mask unchanged.`;
assert.equal(validateLocalRepaintPrompt(validLocalPrompt, true), true);
assert.equal(validateLocalRepaintPrompt(validLocalPrompt.replace(/\n\n/g, '\n'), true), false);
assert.equal(validateLocalRepaintPrompt(`中文 ${validLocalPrompt}`, true), false);

const longSentence =
  'Preserve carefully observed directional abrasion, subtle oxidation, accumulated dust, uneven paint fading, tiny impact marks, and realistic industrial surface variation throughout this reconstruction.';
const overlongLocalPrompt = validLocalPrompt
  .split(/\n\n/)
  .map((paragraph) => `${paragraph} ${longSentence}`)
  .join('\n\n');
assert.ok((overlongLocalPrompt.match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*/g) ?? []).length > 220);
const normalizedLocalPrompt = normalizeLocalRepaintPrompt(overlongLocalPrompt);
assert.equal(
  normalizedLocalPrompt,
  overlongLocalPrompt,
  'Never discard intent-bearing sentences to fit the word budget',
);
assert.equal(validateLocalRepaintPrompt(normalizedLocalPrompt, true), false);
assert.ok(
  getLocalRepaintPromptFormatIssues(normalizedLocalPrompt).some((issue) =>
    issue.startsWith('word_count='),
  ),
);
assert.equal(
  normalizeLocalRepaintPrompt(validLocalPrompt.replace(/\n\n/g, '\n')),
  validLocalPrompt,
);
assert.equal(
  normalizeLocalRepaintPrompt(validLocalPrompt.replace(/\n/g, '\r\n')),
  validLocalPrompt,
);
assert.equal(
  normalizeLocalRepaintPrompt(
    validLocalPrompt
      .split('\n\n')
      .map((p, i) => `${i + 1}. ${p}`)
      .join('\n'),
  ),
  validLocalPrompt,
);
assert.equal(validateLocalRepaintPrompt(`${validLocalPrompt} Unfinished instruction`), false);
assert.equal(
  validateLocalRepaintPrompt(validLocalPrompt.replace('Reconstruct', '**Reconstruct**')),
  false,
);
// Live Qwen reproduced a short Chinese fragment inside otherwise English prose.
const mixedLanguagePrompt = validLocalPrompt.replace('yellow tone', 'yellow过渡 tone');
assert.deepEqual(getLocalRepaintPromptFormatIssues(mixedLanguagePrompt), [
  'non_english_descriptive_text',
]);
assert.equal(normalizeLocalRepaintPrompt(mixedLanguagePrompt), mixedLanguagePrompt);
assert.deepEqual(
  getLocalRepaintPromptFormatIssues(validLocalPrompt.replace('Reconstruct', '**Reconstruct**')),
  ['markdown_formatting'],
);

// Exercise the actual multimodal invocation with deterministic upstream replies.
// These tests do not spend Qwen credits or submit a ModelView generation.
const originalFetch = globalThis.fetch;
const originalApiKey = serverConfig.qwen3VlPlusApiKey;
const originalTimeoutFactory = AbortSignal.timeout;
const originalWarn = console.warn;
const warnings = [];
const localInput = {
  prompt: 'remove the old label and restore the yellow painted metal',
  context: 'local-repaint',
  hasMask: true,
  currentEffectImage: { name: 'current.png', dataUrl: onePixelPng },
  referenceImage: { name: 'reference.png', dataUrl: onePixelPng },
  maskImage: { name: 'mask.png', dataUrl: onePixelPng },
};
async function invokeWithReplies(replies, input = localInput) {
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    calls.push({ body: JSON.parse(options.body), signal: options.signal });
    assert.ok(calls.length <= replies.length, 'Unexpected extra upstream request');
    const reply = replies[calls.length - 1];
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'number') return new Response('', { status: reply });
    return Response.json({
      choices: [
        {
          message: { content: reply.content ?? reply },
          finish_reason: reply.finish_reason ?? 'stop',
        },
      ],
    });
  };
  return { result: polishPrompt(input), calls };
}
try {
  serverConfig.qwen3VlPlusApiKey = 'synthetic-test-key';
  console.warn = (...args) => warnings.push(args);
  for (const reply of [validLocalPrompt, validLocalPrompt.replace(/\n\n/g, '\n')]) {
    const { result, calls } = await invokeWithReplies([reply]);
    assert.equal(await result, validLocalPrompt);
    assert.equal(
      calls.length,
      1,
      'Valid or losslessly normalized output must not trigger another Qwen call',
    );
  }
  for (const invalid of [
    overlongLocalPrompt,
    mixedLanguagePrompt,
    validLocalPrompt.replace('Reconstruct', '**Reconstruct**'),
    '',
    'Please repair the seam.',
    validLocalPrompt.replace(/\n\n/g, ' '),
    { content: validLocalPrompt, finish_reason: 'length' },
  ]) {
    const { result, calls } = await invokeWithReplies([invalid, validLocalPrompt]);
    assert.equal(await result, validLocalPrompt);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].signal, calls[1].signal, 'Both attempts share the original deadline');
    assert.deepEqual(
      calls[1].body.messages.slice(0, 2),
      calls[0].body.messages,
      'Repair retains original intent, template and all three images',
    );
    assert.equal(calls[1].body.messages[2].role, 'assistant');
    assert.match(
      calls[1].body.messages[3].content,
      /condense wording instead of dropping requirements/,
    );
    assert.equal(calls[1].body.temperature, 0.2);
    assert.match(calls[1].body.messages[3].content, /Translate any Chinese descriptive words/);
  }
  for (const prompt of ['', '  \n\t']) {
    const diagnosis = '修复控制面板下方的接缝和色差，以及标牌文字的重影。';
    const input = { ...localInput, prompt };
    const { result, calls } = await invokeWithReplies([diagnosis, validLocalPrompt], input);
    assert.equal(await result, validLocalPrompt);
    assert.equal(input.prompt, prompt, 'Do not replace the user-owned blank input');
    assert.equal(calls.length, 2, 'Empty input must diagnose first, then convert');
    assert.doesNotMatch(calls[0].body.messages[0].content, /exactly four paragraphs/);
    assert.match(calls[0].body.messages[1].content[0].text, /一句中文修复要求/);
    assert.ok(calls[1].body.messages[0].content.includes(`User editing request:\n${diagnosis}`));
    assert.match(calls[1].body.messages[0].content, /do not diagnose additional problems/);
    assert.match(
      calls[1].body.messages[0].content,
      /Repair existing text only if the diagnosis explicitly requests it/,
    );
    assert.match(calls[1].body.messages[0].content, /exactly four paragraphs/);
    assert.deepEqual(
      calls[1].body.messages[1].content.slice(1),
      calls[0].body.messages[1].content.slice(1),
    );
    assert.equal(calls[0].signal, calls[1].signal);
  }
  const noDefect = await invokeWithReplies(['未发现明确异常，保留现有外观。', validLocalPrompt], {
    ...localInput,
    prompt: '',
  });
  assert.equal(await noDefect.result, validLocalPrompt);
  assert.match(noDefect.calls[1].body.messages[0].content, /未发现明确异常，保留现有外观。/);
  assert.match(noDefect.calls[1].body.messages[0].content, /without inventing any repairs/);
  const diagnosis = '修复控制面板下方的接缝和色差。';
  const repaired = await invokeWithReplies([diagnosis, 'Too short.', validLocalPrompt], {
    ...localInput,
    prompt: '',
  });
  assert.equal(await repaired.result, validLocalPrompt);
  assert.equal(repaired.calls.length, 3, 'Only the conversion format is retried, not diagnosis');
  assert.ok(repaired.calls.every((call) => call.signal === repaired.calls[0].signal));
  assert.deepEqual(repaired.calls[2].body.messages.slice(0, 2), repaired.calls[1].body.messages);
  for (const invalid of [
    '',
    validLocalPrompt,
    '修复接缝。修复色差。',
    { content: diagnosis, finish_reason: 'length' },
    { content: diagnosis, finish_reason: 'content_filter' },
  ]) {
    const rejected = await invokeWithReplies([invalid], { ...localInput, prompt: '' });
    await assert.rejects(rejected.result, /PROMPT_POLISH_INVALID_LOCAL_REPAINT_DIAGNOSIS/);
    assert.equal(rejected.calls.length, 1, 'Invalid diagnosis must not enter conversion');
  }
  const failedConversion = await invokeWithReplies([diagnosis, 500], { ...localInput, prompt: '' });
  await assert.rejects(failedConversion.result, /PROMPT_POLISH_QWEN_HTTP_500/);
  assert.equal(failedConversion.calls.length, 2);
  const exhausted = await invokeWithReplies(['Too short.', 'Still too short.']);
  await assert.rejects(exhausted.result, /PROMPT_POLISH_INVALID_LOCAL_REPAINT_FORMAT/);
  assert.equal(
    exhausted.calls.length,
    2,
    'Invalid repaired text must fail closed without endless retries',
  );
  for (const status of [401, 429, 500]) {
    const failed = await invokeWithReplies([status]);
    await assert.rejects(failed.result, new RegExp(`PROMPT_POLISH_QWEN_HTTP_${status}`));
    assert.equal(failed.calls.length, 1, 'Transport/auth failures are not format repairs');
  }
  const aborted = await invokeWithReplies([new DOMException('Request aborted', 'TimeoutError')]);
  await assert.rejects(aborted.result, /PROMPT_POLISH_QWEN_TIMEOUT/);
  const tooLong = await invokeWithReplies(['x'.repeat(12_001)]);
  await assert.rejects(tooLong.result, /PROMPT_POLISH_RESULT_TOO_LONG/);
  assert.equal(tooLong.calls.length, 1);
  const forbidden = await invokeWithReplies([validLocalPrompt], {
    ...localInput,
    maskImage: undefined,
  });
  await assert.rejects(forbidden.result, /PROMPT_POLISH_INVALID_VISUAL_INPUT/);
  assert.equal(
    forbidden.calls.length,
    0,
    'Missing visual inputs never fall back to text-only inference',
  );
  AbortSignal.timeout = () => {
    const controller = new AbortController();
    controller.abort(new DOMException('Deadline expired', 'TimeoutError'));
    return controller.signal;
  };
  const expired = await invokeWithReplies([validLocalPrompt]);
  await assert.rejects(expired.result, /PROMPT_POLISH_QWEN_TIMEOUT/);
  assert.equal(expired.calls.length, 0);
  assert.ok(warnings.length > 0);
  assert.doesNotMatch(JSON.stringify(warnings), /synthetic-test-key|base64|old printed label/);
} finally {
  globalThis.fetch = originalFetch;
  serverConfig.qwen3VlPlusApiKey = originalApiKey;
  AbortSignal.timeout = originalTimeoutFactory;
  console.warn = originalWarn;
}

const parsed = parsePolishedPrompt(
  `正在分析：请稍候\n\n\`\`\`text\n${validLocalPrompt}\n\`\`\`\n完成：ok`,
);
assert.equal(parsed, validLocalPrompt);
assert.equal(
  parsePolishedPrompt(
    `_Skill版本: 2.3.2_ | _请求ID: synthetic_ | _会话ID: synthetic_\n\n${validLocalPrompt}`,
  ),
  validLocalPrompt,
);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, '..', '..', '..');
const panelSource = fs.readFileSync(
  path.join(repositoryRoot, 'apps/web/src/components/panels/GeneratePanel.tsx'),
  'utf8',
);
const routeSource = fs.readFileSync(
  path.join(repositoryRoot, 'apps/server/src/routes/liclick.ts'),
  'utf8',
);
const promptPolishServiceSource = fs.readFileSync(
  path.join(repositoryRoot, 'apps/server/src/services/promptPolishService.ts'),
  'utf8',
);
const visualInputSource = fs.readFileSync(
  path.join(repositoryRoot, 'apps/web/src/services/localRepaintPromptPolishInputs.ts'),
  'utf8',
);
const captureCurrentViewSource = fs.readFileSync(
  path.join(repositoryRoot, 'apps/web/src/engine/capture/captureCurrentView.ts'),
  'utf8',
);
assert.match(panelSource, /data-prompt-polish="true"/);
assert.match(panelSource, /promptValueRef\.current\.value !== snapshot\.value/);
assert.match(panelSource, /context: isLocalRepaintTab \? 'local-repaint' : 'general'/);
assert.match(panelSource, /prepareLocalRepaintPromptPolishInputs/);
assert.match(
  panelSource,
  /const promptFingerprint = JSON\.stringify\(\{[\s\S]*?\.\.\.\(rawUserPrompt \? \{\} : \{ autoDiagnosisPolicy: LOCAL_REPAINT_AUTO_DIAGNOSIS_POLICY \}\)/,
  'Only empty-input prompt fingerprints must invalidate the old diagnosis cache',
);
assert.match(
  visualInputSource,
  /LOCAL_REPAINT_AUTO_DIAGNOSIS_POLICY = 'one-sentence-diagnosis-to-klein-v2'/,
);
assert.match(panelSource, /activeReferences\.find\(\(reference\) =>/);
assert.match(panelSource, /currentEffectImage: visualInputs\?\.currentEffectImage/);
assert.match(routeSource, /segments\[2\] === 'prompt-polish'/);
assert.match(routeSource, /promptPolishUsers\.has\(user\.id\)/);
assert.match(routeSource, /PROMPT_POLISH_VISUAL_INPUT_REQUIRED/);
assert.match(promptPolishServiceSource, /qwen3VlPlusApiKey/);
assert.match(promptPolishServiceSource, /buildQwen3VlPlusRequest/);
assert.match(
  promptPolishServiceSource,
  /Image 1 \(the clean current effect with no mask-preview overlay\)/,
);
assert.match(
  promptPolishServiceSource,
  /input\.context === 'local-repaint'[\s\S]*?invokeQwen3VlPlus/,
);
assert.match(
  promptPolishServiceSource,
  /normalizeQwen3VlPlusImage\(input\.currentEffectImage, \{[\s\S]*?quality: 95,[\s\S]*?chromaSubsampling: '4:4:4'/,
);
assert.match(
  promptPolishServiceSource,
  /normalizeQwen3VlPlusImage\(input\.maskImage, \{[\s\S]*?quality: 100,[\s\S]*?chromaSubsampling: '4:4:4'/,
);
assert.match(visualInputSource, /promptPolishCaptureResolution = 2048/);
assert.match(captureCurrentViewSource, /localRepaintInteractiveCaptureSize = maxCaptureSize/);
assert.doesNotMatch(captureCurrentViewSource, /localRepaintInteractiveCaptureSize = 512/);
assert.match(visualInputSource, /prepareReferenceForPromptPolish/);
assert.match(visualInputSource, /colorMode: 'viewport-clean'/);
assert.match(visualInputSource, /revokeRegisteredObjectUrl\(currentEffectUrl\)/);

console.log('Prompt polish integration tests passed.');
