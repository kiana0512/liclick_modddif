import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  buildQwen3VlPlusRequest,
  buildQwenLocalRepaintSelectionContext,
  buildPromptPolishAtlasArgs,
  buildPromptPolishMessage,
  detectLocalRepaintImplicitRemoveSelectionIntent,
  detectLocalRepaintNoTextIntent,
  ensureLocalRepaintImplicitRemovalConstraint,
  ensureLocalRepaintNoTextConstraint,
  ensureLocalRepaintMaskScope,
  getLocalRepaintPromptFormatIssues,
  normalizeLocalRepaintPrompt,
  normalizeQwen3VlPlusImage,
  parsePolishedPrompt,
  polishPrompt,
  validateLocalRepaintPrompt,
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
assert.match(localMessage, /100至180词，2至3段/);
assert.match(localMessage, /第三张为与 Image 1 像素对齐的独立蒙版/);
assert.match(localMessage, /先确认选区真正覆盖的部件/);
assert.match(localMessage, /在图二寻找同一部件/);
assert.match(localMessage, /真正的浅色材料及金属高光不因颜色而被删除/);
assert.match(localMessage, /图二对应部件、第四张干净局部和图一选区边界外的真实表面共同确定目标外观/);
assert.match(localMessage, /完整替换选区内的白灰 clay\/primer\/flat placeholder\/untextured surface/);
assert.match(localMessage, /不得仅凭用户说“修缝”就发明 brushed steel、clean metal、new weld bead、chamfer/);
assert.match(localMessage, /不要在最终提示词输出像素坐标或包围盒/);
assert.doesNotMatch(localMessage, /limit automatic diagnosis/);

const noTextMessage = buildPromptPolishMessage({
  prompt: '没有文字',
  context: 'local-repaint',
  objectName: 'industrial cutter',
  hasMask: true,
});
assert.equal(detectLocalRepaintNoTextIntent('没有文字'), true);
assert.equal(detectLocalRepaintNoTextIntent('不让它出现文字'), true);
assert.equal(detectLocalRepaintImplicitRemoveSelectionIntent('去除，保留黄色旧材质'), true);
assert.equal(detectLocalRepaintNoTextIntent('去除，保留黄色旧材质'), false);
assert.equal(detectLocalRepaintNoTextIntent('修复文字错位'), false);
assert.match(noTextMessage, /明确的“蒙版内不生成文字”任务/);
assert.match(noTextMessage, /不得迁移进蒙版/);
const implicitRemovalMessage = buildPromptPolishMessage({
  prompt: '去除，保留黄色旧材质',
  context: 'local-repaint',
  objectName: 'industrial cutter',
  hasMask: true,
});
assert.match(implicitRemovalMessage, /不是专门去文字/);
assert.match(implicitRemovalMessage, /错误材质图案、贴花、色块、污斑/);
assert.match(implicitRemovalMessage, /不得从图二复制任何部件或图案到蒙版/);

const guardedImplicitRemovalPrompt = ensureLocalRepaintImplicitRemovalConstraint(
  'Restore the selected control panel with its knobs and buttons. Preserve the yellow paint outside the mask unchanged.',
  '去除，保留原始周边黄色材质',
);
assert.doesNotMatch(guardedImplicitRemovalPrompt, /Restore the selected control panel/);
assert.match(guardedImplicitRemovalPrompt, /every selected material pattern/);
assert.match(guardedImplicitRemovalPrompt, /nearest unmasked ring/);
assert.match(guardedImplicitRemovalPrompt, /same continuous parent surface/);
assert.match(guardedImplicitRemovalPrompt, /Remove all enclosed contours/);
assert.match(guardedImplicitRemovalPrompt, /no object-like boundary/);
assert.equal(
  ensureLocalRepaintImplicitRemovalConstraint('Repair the seam.', '修复接缝'),
  'Repair the seam.',
);

const contradictoryNoTextPrompt =
  'Restore the yellow painted panel. Preserve the original CUT-BOT stencil lettering exactly and keep the label readable. Keep the camera and every area outside the mask unchanged.';
const guardedNoTextPrompt = ensureLocalRepaintNoTextConstraint(
  contradictoryNoTextPrompt,
  '没有文字',
);
assert.doesNotMatch(guardedNoTextPrompt, /Preserve the original CUT-BOT/);
assert.match(guardedNoTextPrompt, /continuous text-free continuation/);
assert.match(guardedNoTextPrompt, /ignore all such content in the material reference/);
assert.equal(
  ensureLocalRepaintNoTextConstraint('Repair the seam.', '修复接缝'),
  'Repair the seam.',
);

for (const prompt of ['', '   \n\t']) {
  const emptyMessage = buildPromptPolishMessage({
    prompt,
    context: 'local-repaint',
    hasMask: true,
  });
  assert.doesNotMatch(emptyMessage, /limit automatic diagnosis/);
  assert.doesNotMatch(emptyMessage, /then restore the corresponding content from Image 2/);
  assert.match(emptyMessage, /100至180词，2至3段/);
  assert.match(emptyMessage, /用户要求：修补接缝/);
}

const currentEffectDataUrl = 'data:image/png;base64,AQ==';
const referenceDataUrl = 'data:image/webp;base64,Ag==';
const maskDataUrl = 'data:image/png;base64,Aw==';
const selectionCropDataUrl = 'data:image/jpeg;base64,BA==';
const multimodalRequest = buildQwen3VlPlusRequest({
  prompt: 'restore the masked label',
  context: 'local-repaint',
  hasMask: true,
  currentEffectImage: { name: 'current.png', dataUrl: currentEffectDataUrl },
  referenceImage: { name: 'reference.webp', dataUrl: referenceDataUrl },
  maskImage: { name: 'mask.png', dataUrl: maskDataUrl },
  selectionCropImage: { name: 'selected-region-context.jpg', dataUrl: selectionCropDataUrl },
});
assert.equal(multimodalRequest.model, 'qwen3-vl-plus');
assert.equal(multimodalRequest.messages[0].role, 'system');
assert.match(multimodalRequest.messages[0].content, /FLUX\.2 Klein/);
const multimodalContent = multimodalRequest.messages[1].content;
assert.deepEqual(
  multimodalContent.filter((part) => part.type === 'image_url').map((part) => part.image_url.url),
  [currentEffectDataUrl, referenceDataUrl, maskDataUrl, selectionCropDataUrl],
);
assert.match(multimodalContent[0].text, /clean current effect with no mask-preview overlay/);
assert.match(multimodalContent[0].text, /original independent edit mask without dilation/);
assert.match(multimodalContent[0].text, /clean unchanged crop from Image 1/);
const noTextMultimodalRequest = buildQwen3VlPlusRequest({
  prompt: '没有文字',
  context: 'local-repaint',
  hasMask: true,
  currentEffectImage: { name: 'current.png', dataUrl: currentEffectDataUrl },
  referenceImage: { name: 'reference.webp', dataUrl: referenceDataUrl },
  maskImage: { name: 'mask.png', dataUrl: maskDataUrl },
  selectionCropImage: { name: 'selected-region-context.jpg', dataUrl: selectionCropDataUrl },
});
assert.equal(noTextMultimodalRequest.temperature, 0.2);
assert.match(noTextMultimodalRequest.messages[0].content, /不得迁移进蒙版/);
const onePixelPng =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const normalizedVisual = await normalizeQwen3VlPlusImage({
  name: 'mask.png',
  dataUrl: onePixelPng,
});
assert.equal(normalizedVisual.name, 'mask.jpg');
assert.match(normalizedVisual.dataUrl, /^data:image\/jpeg;base64,/);

const selectionCurrentBuffer = await sharp({
  create: { width: 16, height: 12, channels: 3, background: { r: 72, g: 88, b: 104 } },
})
  .png()
  .toBuffer();
const selectionMaskBuffer = await sharp({
  create: { width: 16, height: 12, channels: 3, background: { r: 0, g: 0, b: 0 } },
})
  .composite([
    {
      input: {
        create: { width: 4, height: 3, channels: 3, background: { r: 255, g: 255, b: 255 } },
      },
      left: 6,
      top: 5,
    },
  ])
  .png()
  .toBuffer();
const selectionCurrentDataUrl = `data:image/png;base64,${selectionCurrentBuffer.toString('base64')}`;
const selectionMaskDataUrl = `data:image/png;base64,${selectionMaskBuffer.toString('base64')}`;
const selectionContext = await buildQwenLocalRepaintSelectionContext(
  { name: 'selection-current.png', dataUrl: selectionCurrentDataUrl },
  { name: 'selection-mask.png', dataUrl: selectionMaskDataUrl },
);
assert.match(selectionContext.selectionCropImage.dataUrl, /^data:image\/jpeg;base64,/);
assert.match(selectionContext.maskLocationDescription, /x=6\.\.9、y=5\.\.7/);
assert.match(selectionContext.maskLocationDescription, /真正编辑范围仍以第三张蒙版为准/);

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

const validLocalPrompt = `Repair the exposed conveyor chute and inner feed opening by removing the false seam and restoring their weathered steel finish, modifying only the region defined by the independent mask. Use Image 2 to recover the corresponding chute walls, recessed channel, and attachment junctions while transforming them into Image 1's exact low-angle perspective, scale, orientation, and occlusion.

Rebuild each selected surface with continuous dark aged steel, consistent edge thickness, recessed shadows, brushed wear, rust speckling, grime, and directional highlights that follow its surface normal. Preserve genuine rail separations, the feed opening, contact gaps, hard structural edges, and the nearby yellow painted housing; remove only nonphysical projection seams, pale residue, texture breaks, and misaligned patches without fusing distinct components.

The repaired chute should look mechanically coherent and naturally integrated, with matching sharpness, roughness, reflections, and wear scale. Preserve Image 1's object identity, geometry, silhouette, camera, composition, background, lighting, and every detail outside the independent mask unchanged.`;
function withEnglishWordCount(prompt, target) {
  const count = (prompt.match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*/g) ?? []).length;
  assert.ok(count <= target, `Fixture already exceeds requested word count ${target}`);
  const filler = Array.from({ length: target - count }, (_, index) => `detail${index + 1}`).join(
    ' ',
  );
  return `${prompt.replace(/[.!?]\s*$/, '')} ${filler}.`;
}
const slightlyOverTargetLocalPrompt = withEnglishWordCount(validLocalPrompt, 183);
const overlongLocalPrompt = withEnglishWordCount(validLocalPrompt, 201);
const validLocalPromptWithoutScope = validLocalPrompt.replace(
  'modifying only the region defined by the independent mask',
  'while preserving its current placement',
);
assert.equal(validateLocalRepaintPrompt(validLocalPrompt, true), true);
assert.equal(
  validateLocalRepaintPrompt(slightlyOverTargetLocalPrompt, true),
  true,
  'A small overshoot above the 180-word target must not reject an otherwise valid repair',
);
assert.equal(
  validateLocalRepaintPrompt(
    validLocalPrompt.replace(
      'modifying only the region defined by the independent mask',
      'restricting edits to within the independent mask',
    ),
    true,
  ),
  true,
  'Common explicit mask-scope language must be accepted',
);
assert.ok(getLocalRepaintPromptFormatIssues(validLocalPromptWithoutScope).includes('masked_scope'));
const enforcedScopePrompt = ensureLocalRepaintMaskScope(validLocalPromptWithoutScope, true);
assert.match(
  enforcedScopePrompt.split(/\n\s*\n/)[0],
  /Confine all edits to the independent mask region/,
);
assert.equal(validateLocalRepaintPrompt(enforcedScopePrompt, true), true);
assert.equal(
  ensureLocalRepaintMaskScope(validLocalPrompt, true),
  validLocalPrompt,
  'Do not duplicate an existing explicit scope requirement',
);
assert.equal(validateLocalRepaintPrompt(validLocalPrompt.replace(/\n\n/g, '\n'), true), false);
assert.equal(validateLocalRepaintPrompt(`中文 ${validLocalPrompt}`, true), false);

assert.ok((overlongLocalPrompt.match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*/g) ?? []).length > 180);
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
assert.equal(validateLocalRepaintPrompt(validLocalPrompt.replace('Rebuild', '**Rebuild**')), false);
// Live Qwen reproduced a short Chinese fragment inside otherwise English prose.
const mixedLanguagePrompt = validLocalPrompt.replace('yellow painted', 'yellow过渡 painted');
assert.deepEqual(getLocalRepaintPromptFormatIssues(mixedLanguagePrompt), [
  'non_english_descriptive_text',
]);
assert.equal(normalizeLocalRepaintPrompt(mixedLanguagePrompt), mixedLanguagePrompt);
assert.deepEqual(
  getLocalRepaintPromptFormatIssues(validLocalPrompt.replace('Rebuild', '**Rebuild**')),
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
  prompt: 'repair the selected panel and restore the yellow painted metal',
  context: 'local-repaint',
  hasMask: true,
  currentEffectImage: { name: 'current.png', dataUrl: selectionCurrentDataUrl },
  referenceImage: { name: 'reference.png', dataUrl: onePixelPng },
  maskImage: { name: 'mask.png', dataUrl: selectionMaskDataUrl },
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
    assert.equal(
      calls[0].body.messages[1].content.filter((part) => part.type === 'image_url').length,
      4,
      'Production prompt conversion must include the clean selected-region context crop',
    );
    assert.match(calls[0].body.messages[0].content, /选区包围盒为 x=6\.\.9、y=5\.\.7/);
  }
  for (const noncanonical of [
    overlongLocalPrompt,
    mixedLanguagePrompt,
    validLocalPrompt.replace('Rebuild', '**Rebuild**'),
    'Please repair the seam.',
    validLocalPrompt.replace(/\n\n/g, ' '),
  ]) {
    const { result, calls } = await invokeWithReplies([noncanonical]);
    const source = typeof noncanonical === 'string' ? noncanonical : noncanonical.content;
    assert.equal(
      await result,
      ensureLocalRepaintMaskScope(normalizeLocalRepaintPrompt(parsePolishedPrompt(source)), true),
    );
    assert.equal(
      calls.length,
      1,
      'Presentation-style deviations are advisory and must not trigger format repair',
    );
  }
  const liveRepairWithoutScope = slightlyOverTargetLocalPrompt.replace(
    'modifying only the region defined by the independent mask',
    'while preserving its current placement',
  );
  const observedLiveRepair = await invokeWithReplies([liveRepairWithoutScope]);
  assert.equal(
    await observedLiveRepair.result,
    ensureLocalRepaintMaskScope(liveRepairWithoutScope, true),
  );
  assert.equal(
    observedLiveRepair.calls.length,
    1,
    'The observed 183-word response must pass without format repair or user-facing failure',
  );
  const implicitRemoval = await invokeWithReplies([contradictoryNoTextPrompt], {
    ...localInput,
    prompt: '去除，保留黄色旧材质',
  });
  const implicitRemovalResult = await implicitRemoval.result;
  assert.doesNotMatch(implicitRemovalResult, /Preserve the original CUT-BOT/);
  assert.match(implicitRemovalResult, /every selected material pattern/);
  assert.match(implicitRemovalResult, /nearest unmasked ring/);
  assert.doesNotMatch(implicitRemovalResult, /continuous text-free continuation/);
  assert.equal(implicitRemoval.calls[0].body.temperature, 0.2);
  for (const prompt of ['', '  \n\t', '修补接缝', '  修复划痕  ']) {
    const input = { ...localInput, prompt };
    const { result, calls } = await invokeWithReplies([validLocalPrompt], input);
    assert.equal(await result, validLocalPrompt);
    assert.equal(input.prompt, prompt);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.messages[1].content.filter((part) => part.type === 'image_url').length, 4);
    const message = calls[0].body.messages[0].content;
    assert.ok(message.includes('用户要求：' + (prompt.trim() || '修补接缝')));
    assert.doesNotMatch(message, /diagnosis|用户未填写时/);
    if (prompt.includes('划痕')) assert.doesNotMatch(message, /用户要求：修补接缝/);
  }
  for (const finishReason of ['length', 'content_filter']) {
    const incompleteDefault = await invokeWithReplies([{ content: validLocalPrompt, finish_reason: finishReason }], { ...localInput, prompt: '' });
    await assert.rejects(incompleteDefault.result, /PROMPT_POLISH_QWEN_INCOMPLETE/);
    assert.equal(incompleteDefault.calls.length, 1);
  }
  const emptyDefault = await invokeWithReplies([''], { ...localInput, prompt: '' });
  await assert.rejects(emptyDefault.result, /PROMPT_POLISH_EMPTY_RESULT/);
  const failedConversion = await invokeWithReplies([500], { ...localInput, prompt: '' });
  await assert.rejects(failedConversion.result, /PROMPT_POLISH_QWEN_HTTP_500/);
  assert.equal(failedConversion.calls.length, 1);
  const emptyConversion = await invokeWithReplies(['']);
  await assert.rejects(emptyConversion.result, /PROMPT_POLISH_EMPTY_RESULT/);
  assert.equal(emptyConversion.calls.length, 1);
  for (const finishReason of ['length', 'content_filter']) {
    const incomplete = await invokeWithReplies([
      { content: validLocalPrompt, finish_reason: finishReason },
    ]);
    await assert.rejects(incomplete.result, /PROMPT_POLISH_QWEN_INCOMPLETE/);
    assert.equal(incomplete.calls.length, 1);
  }
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
// Terminal decorations must be removed without changing prompt text or paragraph boundaries.
for (const decorated of [
  `\u001b[32m${validLocalPrompt}\u001b[0m`,
  `\u009b32m${validLocalPrompt}\u009b0m`,
  `\u001b]0;prompt-polish\u0007${validLocalPrompt}`,
  `\u001b]8;;https://example.invalid/reference\u0007${validLocalPrompt}\u001b]8;;\u0007`,
]) {
  assert.equal(parsePolishedPrompt(decorated), validLocalPrompt);
}
const plainPrompt =
  '修复接缝和色差，保留 CUT-BOT。\n\nKeep [labels], a/b and https://example.invalid/a/b unchanged.';
assert.equal(parsePolishedPrompt(plainPrompt), plainPrompt);
assert.equal(parsePolishedPrompt(''), '');
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
  /const promptFingerprint = JSON\.stringify\(\{[\s\S]*?prompt: requestPrompt,[\s\S]*?promptTemplatePolicy: LOCAL_REPAINT_PROMPT_TEMPLATE_POLICY/,
  'Every local repaint prompt fingerprint must include the conversion template policy',
);
assert.match(
  visualInputSource,
  /return prompt\.trim\(\) \|\| '修补接缝'/,
);
assert.match(
  visualInputSource,
  /LOCAL_REPAINT_PROMPT_TEMPLATE_POLICY = 'qwen-to-klein-default-seam-v9'/,
);
assert.match(panelSource, /activeReferences\.find\(\(reference\) =>/);
assert.match(panelSource, /currentEffectImage: visualInputs\?\.currentEffectImage/);
assert.match(routeSource, /segments\[2\] === 'prompt-polish'/);
assert.match(routeSource, /promptPolishUsers\.has\(user\.id\)/);
assert.match(routeSource, /PROMPT_POLISH_VISUAL_INPUT_REQUIRED/);
assert.match(routeSource, /PROMPT_POLISH_INCOMPLETE_RESULT/);
assert.doesNotMatch(routeSource, /智能润色返回的格式不符合要求/);
assert.match(promptPolishServiceSource, /qwen3VlPlusApiKey/);
assert.match(promptPolishServiceSource, /buildQwen3VlPlusRequest/);
assert.match(
  promptPolishServiceSource,
  /Image 1 \(the clean current effect with no mask-preview overlay\)/,
);
assert.match(promptPolishServiceSource, /buildQwenLocalRepaintSelectionContext/);
assert.match(promptPolishServiceSource, /clean unchanged crop from Image 1/);
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
assert.doesNotMatch(panelSource, /auto-diagnosis|留空则自动分析/);
assert.match(panelSource, /const \[localRepaintPrompt, setLocalRepaintPrompt\] = useState\(''\)/);
const resolverBody = visualInputSource.match(/export function resolveLocalRepaintUserPrompt\(prompt: string\) \{([\s\S]*?)\n\}/)[1];
const resolveRequest = new Function('prompt', resolverBody);
for (const value of ['', ' \n\t', '\u3000']) assert.equal(resolveRequest(value), '修补接缝');
assert.equal(resolveRequest(' 修复划痕 '), '修复划痕');
assert.match(panelSource, /polishPrompt\(\{\s*prompt: requestPrompt,/);
assert.doesNotMatch(promptPolishServiceSource, /buildQwenAutomaticLocalRepaintRequest|buildQwenLocalRepaintDiagnosisRequest|needsDiagnosis/);
