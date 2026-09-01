import { stripVTControlCharacters } from 'node:util';
import { runAtlas } from '../auth/atlasAuthService.js';
import { serverConfig } from '../config.js';
import sharp from 'sharp';

export type PromptPolishContext = 'general' | 'local-repaint';

export type PromptPolishInput = {
  prompt: string;
  context: PromptPolishContext;
  modelName?: string;
  objectName?: string;
  referenceNames?: string[];
  hasMask?: boolean;
  currentEffectImage?: PromptPolishImageInput;
  maskImage?: PromptPolishImageInput;
  referenceImage?: PromptPolishImageInput;
};

export type PromptPolishImageInput = {
  name: string;
  dataUrl: string;
};

const maxPromptPolishImageBytes = 16 * 1024 * 1024;
const allowedPromptPolishImageTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);

const statusLinePattern = /^(?:Skill版本|请求ID|会话ID|正在分析|处理中|已完成|完成)\s*[:：.….]*/i;
const atlasMetadataLinePattern = /^_?Skill版本\s*[:：].*(?:请求ID|会话ID)/i;

function clipped(value: string | undefined, maxLength: number, fallback: string) {
  return (value?.trim() || fallback).slice(0, maxLength);
}

function buildGeneralMessage(input: PromptPolishInput) {
  const modelName = clipped(input.modelName, 120, '当前图片生成模型');
  return [
    '你是莉刻图片生成提示词智能润色助手。',
    `请将下面的原始提示词扩写并优化为更完整、清晰、适合“${modelName}”图片生成的提示词。`,
    '必须保留原意和原始语言，不要添加解释、标题、Markdown 或代码块，只返回润色后的提示词正文。',
    '不要捏造用户没有表达的文字、品牌、人物身份或敏感信息。',
    '',
    '<原始提示词>',
    input.prompt,
    '</原始提示词>',
  ].join('\n');
}

function buildLocalRepaintMessage(input: PromptPolishInput) {
  const objectName = clipped(input.objectName, 160, 'the selected 3D object');
  const hasMask = input.hasMask !== false;
  const maskLocation = hasMask
    ? `第三张独立蒙版的白色区域与 Image 1 像素对齐，定位在 ${objectName} 上；黑色区域受保护。`
    : `没有独立蒙版；仅处理用户在 ${objectName} 上明确指定的区域。`;

  return `你是 FLUX.2 Klein 局部图像编辑提示词转换器。你的任务是把用户意图和选区视觉证据转成具体、简洁的英文编辑指令。

输入：Image 1 为待编辑全图；Image 2 为完整参考图（可能为多视图）；第三张为与 Image 1 像素对齐的独立蒙版，白色编辑、黑色保护。若还附有选区局部放大图，它仅帮助看清 Image 1，不是新的参考视角，不能改变最终构图。
用户要求：${input.prompt}
选区定位信息：${maskLocation}

在内部完成定位和判断，不输出分析：将蒙版的实际形状按像素坐标对应到图一，结合局部放大图辨认每个被选中的表面。先确认选区真正覆盖的部件，不以旁边显眼的机身、文字或其他物体替代。然后在图二寻找同一部件，用有用的参考视角交叉核对其材质和功能结构。参考未展示或不清楚的细节，不得猜测。

优先级：用户意图；图一的相机、构图、轮廓、部件位置和遮挡；图二对应部件的真实结构、配色、材质；图一选区周围的光照、色调和磨损。图一选区内异常外观不能作为目标。局部几何预览只辅助理解朝向与形状，其浅色底色、亮度分布、斑块轮廓和投影裂线不得成为成品材质的依据；真正的浅色材料及金属高光不因颜色而被删除。

明确区分同一表面上的非物理纹理边缝与真实装配边界。修缝时恢复表面连续性，同时保留开口、槽道、零件分隔、必要的装配间隙、焊缝、清晰硬边和接触阴影，不将独立零件熔成一体。材质恢复必须覆盖选区内全部受影响的表面：按各自材质写明合适的底色和中间调、粗糙度、随朝向变化的高光、纹理方向与尺度、凹处阴影及合理磨损。不是简单给旧斑块染色，不沿蒙版轮廓产生新结构。

输出最终英文提示词，100至180词，2至3段。只输出提示词，不输出标题、分析、Markdown、列表、坐标、图像编号以外的工作流术语或参数。
第一句明确实际部件与目标动作/材质，随后限定只修改独立蒙版选区。主体用肯定句描述完成后的具体表面和部件关系，说明从 Image 2 的对应部件借鉴什么、如何保持 Image 1 的视角。不要堆砌“白模、白色块、灰色块、占位”等否定词；用明确目标外观替代。不要一律给物体变成金属，不更改未要求变化的配色；不要凭空指定文字、品牌、光源方向或零件。结尾保护 Image 1 的物体身份、相机、构图、背景和蒙版外内容。无需机械凑成四段，不要求“全部像素重采样”。
删除、添加、替换或文字任务按照用户明确意图处理；被遮罩不等于需要删除。用户未填写时仅修复有证据的问题，无明确问题则保持外观。`;
}

export function buildPromptPolishMessage(input: PromptPolishInput) {
  return input.context === 'local-repaint'
    ? buildLocalRepaintMessage(input)
    : buildGeneralMessage(input);
}

function decodePromptPolishImage(input: PromptPolishImageInput | undefined) {
  if (!input || typeof input.dataUrl !== 'string') {
    throw new Error('PROMPT_POLISH_INVALID_VISUAL_INPUT');
  }
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/s.exec(input.dataUrl);
  const mime = match?.[1]?.toLowerCase();
  if (!match || !mime || !allowedPromptPolishImageTypes.has(mime)) {
    throw new Error('PROMPT_POLISH_INVALID_VISUAL_INPUT');
  }
  const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (buffer.byteLength === 0 || buffer.byteLength > maxPromptPolishImageBytes) {
    throw new Error('PROMPT_POLISH_INVALID_VISUAL_INPUT');
  }
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

export async function normalizeQwen3VlPlusImage(
  input: PromptPolishImageInput | undefined,
  options: { quality?: number; chromaSubsampling?: '4:2:0' | '4:4:4' } = {},
): Promise<PromptPolishImageInput> {
  const canonicalDataUrl = decodePromptPolishImage(input);
  const encoded = canonicalDataUrl.slice(canonicalDataUrl.indexOf(',') + 1);
  let jpeg: Buffer;
  try {
    jpeg = await sharp(Buffer.from(encoded, 'base64'), { limitInputPixels: 64 * 1024 * 1024 })
      .rotate()
      .flatten({ background: { r: 0, g: 0, b: 0 } })
      .resize({
        width: 2048,
        height: 2048,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({
        quality: options.quality ?? 85,
        chromaSubsampling: options.chromaSubsampling ?? '4:2:0',
      })
      .toBuffer();
  } catch {
    throw new Error('PROMPT_POLISH_INVALID_VISUAL_INPUT');
  }
  return {
    name: `${input?.name?.replace(/\.[^.]+$/, '') || 'visual-input'}.jpg`,
    dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
  };
}

async function normalizeQwen3VlPlusVisualInputs(
  input: PromptPolishInput,
): Promise<PromptPolishInput> {
  const [currentEffectImage, referenceImage, maskImage] = await Promise.all([
    normalizeQwen3VlPlusImage(input.currentEffectImage, {
      quality: 95,
      chromaSubsampling: '4:4:4',
    }),
    normalizeQwen3VlPlusImage(input.referenceImage),
    normalizeQwen3VlPlusImage(input.maskImage, {
      quality: 100,
      chromaSubsampling: '4:4:4',
    }),
  ]);
  return { ...input, currentEffectImage, referenceImage, maskImage };
}

export function buildPromptPolishAtlasArgs(input: PromptPolishInput) {
  return [
    'gateway',
    'call-a2a',
    '--service',
    'data-analysis',
    '--message',
    buildPromptPolishMessage(input),
    '--timeout',
    '60',
  ];
}

type QwenContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export function buildQwen3VlPlusRequest(
  input: PromptPolishInput,
  model = serverConfig.qwen3VlPlusModel,
) {
  if (input.context !== 'local-repaint') {
    throw new Error('PROMPT_POLISH_QWEN_LOCAL_REPAINT_ONLY');
  }
  const content: QwenContentPart[] = [
    {
      type: 'text',
      text: 'The three visual inputs are ordered as Image 1 (the clean current effect with no mask-preview overlay), Image 2 (the complete selected reference), and the original independent edit mask without dilation. Align the independent mask pixel-for-pixel with Image 1, follow the supplied editing request, and return only the final English prompt.',
    },
    { type: 'image_url', image_url: { url: decodePromptPolishImage(input.currentEffectImage) } },
    { type: 'image_url', image_url: { url: decodePromptPolishImage(input.referenceImage) } },
    { type: 'image_url', image_url: { url: decodePromptPolishImage(input.maskImage) } },
  ];
  return {
    model,
    messages: [
      { role: 'system', content: buildLocalRepaintMessage(input) },
      { role: 'user', content },
    ],
    max_tokens: 4096,
    temperature: 0.6,
  };
}

export function buildQwenLocalRepaintDiagnosisRequest(input: PromptPolishInput) {
  const request = buildQwen3VlPlusRequest(input);
  request.messages[0].content = `你是3D贴图局部修复问题诊断助手，只识别具体问题，不编写生图提示词。
图像顺序：Image 1 是干净当前效果图；Image 2 是完整参考图；第三张是与 Image 1 像素对齐的原始独立蒙版，白色可编辑，黑色保护。
仅判断蒙版白色区域内有视觉证据的问题：人工纹理接缝、突兀色差、纹理断裂、重影、投影引起的重复/拉伸/错位/不合理局部细节，以及已有文字的重复、扭曲、缺笔或错位。保留真实焊缝、面板接缝、开口和零件边界，不能把正常明暗、反射或自然磨损当成缺陷。
参考图只辅助定位和确认异常，不要求恢复全部参考特征，不改变整体配色、不新增零件或重新设计几何。文字异常只修复已有文字；仅在对应参考或原图清楚可辨时指定正确拼写，无法辨认时不得猜测或创造文字、品牌。
只输出一句简短中文修复要求，4至120个字符，以“修复”开头，可用逗号合并多个确定问题，尽可能说明部位，例如“修复控制面板下方的接缝和色差”。示例只说明格式，不代表这些问题一定存在。不要解释、分析过程、标题、列表、JSON、Markdown、英文生图提示词或四段模板。
如果没有明确异常或证据不足，只输出“未发现明确异常，保留现有外观。”`;
  const content = request.messages[1].content as QwenContentPart[];
  content[0] = { type: 'text', text: '请只诊断原始蒙版白色区域的问题，并返回一句中文修复要求。' };
  request.max_tokens = 512;
  request.temperature = 0.2;
  return request;
}

export function validateLocalRepaintDiagnosis(value: string) {
  const sentence = value.trim();
  if (sentence === '未发现明确异常，保留现有外观。') return true;
  return (
    sentence.startsWith('修复') &&
    Array.from(sentence).length >= 4 &&
    Array.from(sentence).length <= 120 &&
    !/[\r\n`#*]/.test(sentence) &&
    !/[。！？!?]/.test(sentence.replace(/[。！？!?]$/, '')) &&
    !/\.\s/.test(sentence)
  );
}

function readQwenMessageContent(payload: unknown) {
  if (!payload || typeof payload !== 'object' || !('choices' in payload)) return '';
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0];
  if (!first || typeof first !== 'object' || !('message' in first)) return '';
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== 'object' || !('content' in message)) return '';
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      part && typeof part === 'object' && 'text' in part && typeof part.text === 'string'
        ? part.text
        : '',
    )
    .filter(Boolean)
    .join('\n');
}

async function invokeQwenChat(
  request: ReturnType<typeof buildQwen3VlPlusRequest>,
  signal: AbortSignal,
) {
  let payload: unknown;
  try {
    signal.throwIfAborted();
    const response = await fetch(`${serverConfig.qwen3VlPlusBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${serverConfig.qwen3VlPlusApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) throw new Error(`PROMPT_POLISH_QWEN_HTTP_${response.status}`);
    payload = await response.json();
    signal.throwIfAborted();
  } catch (error) {
    if (
      signal.aborted ||
      (error instanceof Error && /timeout|aborted/i.test(`${error.name} ${error.message}`))
    ) {
      throw new Error('PROMPT_POLISH_QWEN_TIMEOUT');
    }
    if (error instanceof Error && error.message.startsWith('PROMPT_POLISH_QWEN_HTTP_')) throw error;
    throw new Error('PROMPT_POLISH_QWEN_UNAVAILABLE');
  }
  return payload;
}

async function invokeQwen3VlPlus(input: PromptPolishInput) {
  if (!serverConfig.qwen3VlPlusApiKey) throw new Error('PROMPT_POLISH_QWEN_NOT_CONFIGURED');
  // Diagnosis, conversion and one optional format repair share one deadline
  // and the same normalized images. Manual requests skip diagnosis entirely.
  const signal = AbortSignal.timeout(serverConfig.qwen3VlPlusTimeoutMs);
  const normalizedInput = await normalizeQwen3VlPlusVisualInputs(input);
  const needsDiagnosis = !input.prompt.trim();
  let conversionInput = normalizedInput;
  if (needsDiagnosis) {
    const payload = await invokeQwenChat(
      buildQwenLocalRepaintDiagnosisRequest(normalizedInput),
      signal,
    );
    const diagnosis = readQwenMessageContent(payload).trim();
    const finishReason = (payload as { choices?: Array<{ finish_reason?: string }> } | null)
      ?.choices?.[0]?.finish_reason;
    if (
      !validateLocalRepaintDiagnosis(diagnosis) ||
      finishReason === 'length' ||
      finishReason === 'content_filter'
    )
      throw new Error('PROMPT_POLISH_INVALID_LOCAL_REPAINT_DIAGNOSIS');
    conversionInput = { ...normalizedInput, prompt: diagnosis };
  }
  const request = buildQwen3VlPlusRequest(conversionInput);
  if (needsDiagnosis) {
    request.messages[0].content +=
      '\nThe editing request above is a one-sentence visual diagnosis. Convert only its stated repairs into the final prompt; do not diagnose additional problems or add new editing goals. Use the images to describe the required local materials, perspective and continuity, while preserving valid content and real component boundaries. Repair existing text only if the diagnosis explicitly requests it and the correct characters are supported by readable evidence; never invent words or brands. If the diagnosis reports no clear defect, describe preserving the existing appearance without inventing any repairs.';
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const payload = await invokeQwenChat(request, signal);
    const prompt = normalizeLocalRepaintPrompt(
      parsePolishedPrompt(readQwenMessageContent(payload)),
    );
    if (prompt.length > 12_000) throw new Error('PROMPT_POLISH_RESULT_TOO_LONG');
    const issues = getLocalRepaintPromptFormatIssues(prompt, input.hasMask !== false);
    const finishReason = (payload as { choices?: Array<{ finish_reason?: string }> } | null)
      ?.choices?.[0]?.finish_reason;
    if (finishReason === 'length' || finishReason === 'content_filter')
      issues.push('incomplete_response');
    if (issues.length === 0) return prompt;
    // Log diagnostics only: no prompt text, image data or credentials.
    console.warn('[prompt-polish] invalid local repaint format', { attempt: attempt + 1, issues });
    if (attempt === 1) throw new Error('PROMPT_POLISH_INVALID_LOCAL_REPAINT_FORMAT');
    request.messages.push(
      { role: 'assistant', content: prompt },
      {
        role: 'user',
        content: `Correct only the output format of your previous answer using the original user request and the same three images above. Validation issues: ${issues.join(', ')}. Return only 2 or 3 English paragraphs separated by one blank line and 100 to 180 English words total. The first sentence must identify the actual selected component and its target action or material, then limit editing to the independent mask region. Preserve all requested changes, exact requested text, useful Image 2 evidence, real component boundaries, and unmasked protection; condense wording instead of dropping requirements. Translate any Chinese descriptive words into English, including fragments embedded inside English sentences; do not merely delete them. Remove Markdown formatting such as double asterisks and code fences. Return only the finished prompt, without headings, numbering, Markdown, analysis, or commentary.`,
      },
    );
    request.temperature = 0.2;
  }
  throw new Error('PROMPT_POLISH_INVALID_LOCAL_REPAINT_FORMAT');
}

export function parsePolishedPrompt(stdout: string) {
  return stripVTControlCharacters(stdout)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !statusLinePattern.test(trimmed) && !atlasMetadataLinePattern.test(trimmed);
    })
    .join('\n')
    .trim()
    .replace(/^```(?:text|markdown|md)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .replace(/^(?:润色后的提示词|优化后的提示词|智能润色结果|结果)\s*[:：]\s*/i, '')
    .replace(/^\s*[“"]|[”"]\s*$/g, '')
    .trim();
}

function countEnglishWords(value: string) {
  return value.match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*/g)?.length ?? 0;
}

export function normalizeLocalRepaintPrompt(prompt: string) {
  const normalized = prompt.replace(/\r\n?/g, '\n').trim();
  let paragraphs = normalized.split(/\n\s*\n/);
  // Two or three complete single-line paragraphs are an unambiguous formatting variant.
  // Do not guess paragraph boundaries in prose or delete sentences to hit a budget.
  if (paragraphs.length === 1) {
    const lines = normalized
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (
      (lines.length === 2 || lines.length === 3) &&
      lines.every((line) => /[.!?]["'”’)]?$/.test(line))
    )
      paragraphs = lines;
  }
  if (paragraphs.length !== 2 && paragraphs.length !== 3) return normalized;
  const numbered = paragraphs.every((paragraph, index) =>
    new RegExp(`^\\s*${index + 1}[.)]\\s+`).test(paragraph),
  );
  return paragraphs
    .map((paragraph) =>
      (numbered ? paragraph.replace(/^\s*\d[.)]\s+/, '') : paragraph).replace(/\s+/g, ' ').trim(),
    )
    .join('\n\n');
}

export function getLocalRepaintPromptFormatIssues(prompt: string, hasMask = true) {
  const paragraphs = prompt.trim().split(/\n\s*\n/);
  const wordCount = countEnglishWords(prompt);
  const issues: string[] = [];
  if (paragraphs.length !== 2 && paragraphs.length !== 3)
    issues.push(`paragraph_count=${paragraphs.length}`);
  if (wordCount < 100 || wordCount > 180) issues.push(`word_count=${wordCount}`);
  const firstParagraph = paragraphs[0] ?? '';
  const scopePattern = hasMask
    ? /(?:\bonly\b[^.!?]*\bmask(?:ed)?\b|\bmask(?:ed)?\b[^.!?]*\bonly\b)/i
    : /(?:\bonly\b[^.!?]*\b(?:selected|specified) region\b|\b(?:selected|specified) region\b[^.!?]*\bonly\b)/i;
  if (!scopePattern.test(firstParagraph)) issues.push('masked_scope');
  if (
    paragraphs.some((paragraph) => {
      const count = paragraph.match(/[.!?]["'”’)]?(?=\s|$)/g)?.length ?? 0;
      return count < 1 || !/[.!?]["'”’)]?$/.test(paragraph.trim());
    })
  )
    issues.push('complete_paragraphs');
  if (/[\u3400-\u9fff]/.test(prompt)) issues.push('non_english_descriptive_text');
  if (/```|\*\*|^\s*(?:#|\d+[.)]|[-*+]\s)/m.test(prompt)) issues.push('markdown_formatting');
  return issues;
}

export function validateLocalRepaintPrompt(prompt: string, hasMask = true) {
  return getLocalRepaintPromptFormatIssues(prompt, hasMask).length === 0;
}

export async function polishPrompt(input: PromptPolishInput, atlasHomeDir?: string) {
  const stdout =
    input.context === 'local-repaint'
      ? await invokeQwen3VlPlus(input)
      : (await runAtlas(buildPromptPolishAtlasArgs(input), 75_000, false, atlasHomeDir)).stdout;
  let polishedPrompt = parsePolishedPrompt(stdout);
  if (!polishedPrompt) throw new Error('PROMPT_POLISH_EMPTY_RESULT');
  if (input.context === 'local-repaint') {
    polishedPrompt = normalizeLocalRepaintPrompt(polishedPrompt);
    if (!validateLocalRepaintPrompt(polishedPrompt, input.hasMask !== false)) {
      throw new Error('PROMPT_POLISH_INVALID_LOCAL_REPAINT_FORMAT');
    }
  }
  if (polishedPrompt.length > 12_000) throw new Error('PROMPT_POLISH_RESULT_TOO_LONG');
  return polishedPrompt;
}
