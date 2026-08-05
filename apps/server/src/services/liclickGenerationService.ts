import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { callAtlasToolJson, parseJsonFromOutput } from '../auth/atlasAuthService.js';

type ReferenceInput = {
  id?: string;
  name?: string;
  url: string;
};

export type GenerateImageInput = {
  clientGenerationId?: string;
  projectId?: string;
  workflow?: 'liclick' | 'texture-map';
  prompt: string;
  model?: string;
  aspectRatio?: 'auto' | '1:1' | '4:3' | '3:4' | '3:2' | '2:3' | '16:9' | '9:16';
  imageSize?: 'auto' | '1K' | '2K' | '4K';
  count?: number;
  references?: ReferenceInput[];
};

export type EditImageInput = {
  clientEditId?: string;
  projectId?: string;
  image: string;
  mask: string;
  prompt: string;
  references?: string[];
  mode?: 'local_repaint' | 'image_edit';
  strength?: number;
  seed?: number;
  extra?: Record<string, unknown>;
};

export type LiclickAtlasContext = {
  atlasHomeDir?: string;
};

type UploadedReference = {
  referenceId?: string;
  assetId: string;
};

type LiclickImageParam = {
  data: string;
  type: 'image';
};

const uploadedImageAssetCache = new Map<string, Promise<string>>();
const maxUploadedImageAssetCacheEntries = 128;

export type LiclickImageTaskResult = {
  status: string;
  resultUrl?: string;
  resultUrls?: string[];
  terminalWithoutResult?: boolean;
  raw: unknown;
};

export type LiclickImageSubmission = {
  id: string;
  status: 'running' | 'succeeded';
  resultUrl?: string;
  resultUrls?: string[];
  taskId?: string;
  workspaceId?: string;
  model: string;
  extraParams: Record<string, unknown>;
  uploadedReferences: UploadedReference[];
  raw: unknown;
};

function trimOutput(text: string) {
  return text.trim().replace(/\s+/g, ' ').slice(0, 1200);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function findField(value: unknown, keys: string[]): string {
  if (!value) return '';
  if (typeof value === 'string') {
    const normalized = value.replace(/\\"/g, '"');
    for (const key of keys) {
      const match = normalized.match(new RegExp(`${key}["'\\s]*[:：]\\s*["']?([^"',\\s\\\\]+)`, 'i'));
      if (match?.[1]) return match[1];
    }
    return '';
  }
  if (typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const direct = record[key];
    if (typeof direct === 'string' && direct) return direct;
  }
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = findField(item, keys);
        if (found) return found;
      }
    } else if (child && typeof child === 'object') {
      const found = findField(child, keys);
      if (found) return found;
    }
  }
  return '';
}

function findUrls(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === 'string') {
    const normalized = value.replace(/\\\//g, '/');
    return [...normalized.matchAll(/(?:https?:\/\/|data:image\/)[^\s"'<>]+/g)].map(
      (match) => match[0],
    );
  }
  if (Array.isArray(value)) return value.flatMap((item) => findUrls(item));
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const prioritized = Object.entries(record)
      .filter(([key]) => /url|image|download|result|output/i.test(key))
      .flatMap(([, child]) => findUrls(child));
    const rest = Object.entries(record)
      .filter(([key]) => !/url|image|download|result|output/i.test(key))
      .flatMap(([, child]) => findUrls(child));
    return [...prioritized, ...rest];
  }
  return [];
}

const knownImageAssetHosts = new Set([
  'ai-assets.lilithgames.com',
  'tsh-aiteam-prod-all.oss-accelerate.aliyuncs.com',
]);

function sanitizeResultUrl(value: string) {
  return value
    .trim()
    .replace(/\\\//g, '/')
    .replace(/[)\]}>）】》」』，。；、！？：,.;!?:]+$/gu, '');
}

function isLikelyImageResultUrl(value: string) {
  if (/^data:image\//i.test(value)) return true;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (knownImageAssetHosts.has(parsed.hostname.toLowerCase())) return true;
    return /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|svg|tiff?|webp)$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

const resultContextKeys = new Set([
  'artifact',
  'artifacts',
  'downloadurl',
  'downloadurls',
  'generatedimage',
  'generatedimages',
  'imageurl',
  'imageurls',
  'images',
  'output',
  'outputs',
  'outputimage',
  'outputimages',
  'outputurl',
  'outputurls',
  'result',
  'results',
  'resultimage',
  'resultimages',
  'resulturl',
  'resulturls',
]);

function normalizePayloadKey(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isExcludedUrlContext(key: string) {
  return /^(?:doc|docs|documentation|help|input|prompt|reference|request|source|status|task|workspace)/.test(
    normalizePayloadKey(key),
  );
}

function hasResultUrlLanguage(text: string) {
  return /结果|下载(?:地址|链接)?|图片地址|图像地址|输出(?:图片|图像|地址|链接)?|生成(?:的)?(?:图片|图像)|\b(?:result|download|output|generated\s+image|image\s+url)\b/i.test(
    text,
  );
}

function consistsOnlyOfAnImageUrl(text: string, urls: string[]) {
  let remainder = text;
  for (const url of urls) remainder = remainder.replace(url, '');
  return (
    remainder
      .replaceAll('[', '')
      .replaceAll(']', '')
      .replace(/[\s"'`(){}<>（）【】《》「」『』，。；、！？：,.;!?:_-]+/gu, '') === ''
  );
}

function collectResultImageUrls(
  value: unknown,
  path: string[] = [],
  seen: Set<unknown> = new Set(),
  depth = 0,
): string[] {
  if (depth > 12 || value === undefined || value === null) return [];
  if (typeof value === 'string') {
    const embedded = parseEmbeddedJson(value);
    if (embedded !== undefined && embedded !== value) {
      return collectResultImageUrls(embedded, path, seen, depth + 1);
    }
    const discovered = findUrls(value);
    const imageUrls = discovered
      .map(sanitizeResultUrl)
      .filter((url) => url.length > 0 && isLikelyImageResultUrl(url));
    if (imageUrls.length === 0) return [];
    const hasExcludedContext = path.some(isExcludedUrlContext);
    const hasResultContext = path.some((key) => resultContextKeys.has(normalizePayloadKey(key)));
    const isDirectOutputText =
      path.length === 0 || path.some((key) => normalizePayloadKey(key) === 'content');
    if (hasExcludedContext) return [];
    if (
      hasResultContext ||
      hasResultUrlLanguage(value) ||
      (isDirectOutputText && consistsOnlyOfAnImageUrl(value, discovered))
    ) {
      return imageUrls;
    }
    return [];
  }
  if (typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectResultImageUrls(item, path, seen, depth + 1));
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    collectResultImageUrls(child, [...path, key], seen, depth + 1),
  );
}

function findUniqueImageUrls(value: unknown) {
  return [...new Set(collectResultImageUrls(value))];
}

function hasNegatedTerminalLanguage(text: string) {
  return /尚未(?:成功|完成)|还未(?:成功|完成)|未(?:成功|完成)|没有(?:成功|完成)|完成后|完成度|\b(?:not|isn't|isnt|is\s+not|still\s+not)\s+(?:yet\s+)?(?:succeed(?:ed)?|success(?:ful)?|complete(?:d)?|done|finish(?:ed)?)\b/i.test(
    text,
  );
}

function isTerminalSuccessStatus(status: string) {
  if (hasNegatedTerminalLanguage(status)) return false;
  return /\b(?:succeed(?:ed)?|success(?:ful)?|complete(?:d)?|done|finish(?:ed)?)\b|生成(?:任务)?(?:已)?(?:成功|完成)|任务(?:已)?完成|^(?:已完成|完成|已成功|成功)$/i.test(
    status.trim(),
  );
}

function parseEmbeddedJson(value: string): unknown | undefined {
  const trimmed = value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function collectAtlasPayloadCandidates(
  value: unknown,
  seen: Set<unknown> = new Set(),
  depth = 0,
): unknown[] {
  if (depth > 8 || value === undefined || value === null) return [];
  if (typeof value === 'string') {
    const candidates: unknown[] = [value];
    const parsed = parseEmbeddedJson(value);
    if (parsed !== undefined && parsed !== value) {
      candidates.push(...collectAtlasPayloadCandidates(parsed, seen, depth + 1));
    }
    return candidates;
  }
  if (typeof value !== 'object') return [value];
  if (seen.has(value)) return [];
  seen.add(value);

  const candidates: unknown[] = [value];
  const record = value as Record<string, unknown>;
  for (const key of ['structuredContent', 'result']) {
    if (record[key] !== undefined) {
      candidates.push(...collectAtlasPayloadCandidates(record[key], seen, depth + 1));
    }
  }
  if (Array.isArray(record.content)) {
    for (const item of record.content) {
      candidates.push(...collectAtlasPayloadCandidates(item, seen, depth + 1));
      if (item && typeof item === 'object' && 'text' in item) {
        candidates.push(
          ...collectAtlasPayloadCandidates((item as Record<string, unknown>).text, seen, depth + 1),
        );
      }
    }
  }
  return candidates;
}

function normalizeAtlasPayload(value: unknown): unknown {
  const candidates = collectAtlasPayloadCandidates(value);
  if (candidates.length <= 1) return candidates[0] ?? value;
  return {
    original: value,
    normalized: candidates.slice(1),
  };
}

function isEmptyObject(value: unknown): value is Record<string, never> {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length === 0,
  );
}

function parseAtlasPayload(stdout: string) {
  const raw = stdout.trim();
  if (!raw) return {};
  const directlyParsed = parseEmbeddedJson(raw);
  if (directlyParsed !== undefined) return normalizeAtlasPayload(directlyParsed);

  try {
    const parsed = parseJsonFromOutput(stdout);
    if (isEmptyObject(parsed) && raw !== '{}') return normalizeAtlasPayload(raw);
    return normalizeAtlasPayload(parsed);
  } catch {
    return normalizeAtlasPayload(raw);
  }
}

function collectAtlasText(value: unknown, seen: Set<unknown> = new Set(), depth = 0): string[] {
  if (depth > 10 || value === undefined || value === null) return [];
  if (typeof value === 'string') return [value];
  if (typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectAtlasText(item, seen, depth + 1));
  }
  return Object.values(value as Record<string, unknown>).flatMap((child) =>
    collectAtlasText(child, seen, depth + 1),
  );
}

function isTerminalSuccessPayload(value: unknown, status: string) {
  if (isTerminalSuccessStatus(status)) return true;
  return collectAtlasText(value).some(
    (text) =>
      isTerminalSuccessStatus(text) ||
      (!hasNegatedTerminalLanguage(text) &&
        /(?:图片|图像)?生成(?:任务)?(?:已)?(?:成功|完成)(?!后)|任务(?:已)?完成(?!后)|(?:image\s+generation|generation\s+task|task)\s+(?:succeeded|successful|completed|finished|done)|^\s*(?:succeeded|successful|completed|finished|done)\s*$/i.test(
          text,
        )),
  );
}

export function parseLiclickImageTaskPayload(value: unknown): LiclickImageTaskResult {
  const payload = normalizeAtlasPayload(value);
  const status = findField(payload, ['status']);
  if (/failed|failure|error|cancel(?:led|ed)?|失败|错误|取消/i.test(status)) {
    throw new Error(
      findField(payload, ['err_msg', 'error', 'message']) || '莉刻图片生成任务失败。',
    );
  }
  const urls = findUniqueImageUrls(payload);
  return {
    status,
    resultUrl: urls[0],
    resultUrls: urls,
    terminalWithoutResult: urls.length === 0 && isTerminalSuccessPayload(payload, status),
    raw: payload,
  };
}

export function parseLiclickImageTaskOutput(stdout: string): LiclickImageTaskResult {
  return parseLiclickImageTaskPayload(parseAtlasPayload(stdout));
}

function findTaskId(value: unknown) {
  const direct = findField(value, ['task_id', 'taskId', 'request_id', 'requestId']);
  if (direct) return direct;
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? {});
  return text.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/)?.[0] ?? '';
}

function clampCount(value?: number) {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(4, Math.floor(value ?? 1)));
}

function dataUrlToBuffer(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;,]+)?(?:;[^,]*)?,(.*)$/);
  if (!match) throw new Error('Invalid reference image data URL.');
  const mime = match[1] ?? 'image/png';
  const isBase64 = dataUrl.slice(0, dataUrl.indexOf(',')).includes(';base64');
  const buffer = isBase64 ? Buffer.from(match[2], 'base64') : Buffer.from(decodeURIComponent(match[2]), 'utf8');
  const ext = mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png';
  return { buffer, ext };
}

function dataUrlToBase64(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;,]+)?(?:;[^,]*)?,(.*)$/);
  if (!match) throw new Error('Invalid image data URL.');
  const isBase64 = dataUrl.slice(0, dataUrl.indexOf(',')).includes(';base64');
  return isBase64 ? match[2] : Buffer.from(decodeURIComponent(match[2]), 'utf8').toString('base64');
}

function buildExtraParams(input: GenerateImageInput, uploadedReferences: UploadedReference[]) {
  const model = input.model || 'gpt-image-2';
  const aspectRatio = input.aspectRatio ?? 'auto';
  const imageSize = input.imageSize ?? 'auto';
  const gptImage2Size = imageSize === 'auto' ? (aspectRatio === 'auto' ? 'auto' : '1K') : imageSize;
  const submitAspectRatio = model === 'gpt-image-2' && aspectRatio === 'auto' && gptImage2Size !== 'auto' ? '1:1' : aspectRatio;
  const referenceImages = uploadedReferences.map((reference) => ({
    asset_id: reference.assetId,
    type: 'image',
  }));
  const extraParams: Record<string, unknown> = {
    name: 'Liclick 3D Texture',
    quality: 'high',
    n: clampCount(input.count),
  };
  if (referenceImages.length > 0) extraParams.reference_images = referenceImages;

  if (model === 'gpt-image-1.5') {
    const sizeMap: Record<string, string> = {
      '1:1': '1024x1024',
      '3:2': '1536x1024',
      '2:3': '1024x1536',
    };
    extraParams.size = sizeMap[aspectRatio] ?? 'auto';
  } else {
    extraParams.aspect_ratio = submitAspectRatio;
    if (model === 'gpt-image-2') {
      extraParams.image_size = gptImage2Size;
    } else if (model === 'nano_banana_2' || model === 'nano_banana_pro') {
      extraParams.image_size = imageSize === 'auto' ? '1K' : imageSize;
    }
  }
  return { model, extraParams };
}

function buildSubmissionPrompt(input: GenerateImageInput, model: string) {
  const prompt = input.prompt.trim();
  const basePrompt =
    prompt ||
    (model === 'nano_banana_2' || model === 'nano_banana_pro' ? '生成一张高质量的参考图。' : '');
  const materialConstraint =
    '贴图生成约束：输出应强调材质贴图本身的颜色、粗糙度、纹理颗粒和细节，避免明显光照、阴影、投影、强高光、镜面反光、环境光渐变或烘焙光影。';
  if (!basePrompt) return materialConstraint;
  return basePrompt.includes(materialConstraint)
    ? basePrompt
    : `${basePrompt}\n\n${materialConstraint}`;
}

function buildImageParam(base64Data: string): LiclickImageParam {
  return {
    // LiClick's image edit UI sends these custom ComfyUI fields as base64 { data, type } entries.
    data: base64Data,
    type: 'image',
  };
}

function buildLocalRepaintTask(input: EditImageInput) {
  const name = `Inpaint_${input.prompt.trim() || 'Local repaint'}`.slice(0, 48);
  const repaintStrength = input.strength ?? input.extra?.strength ?? 1;
  const workspaceId = input.extra?.workspace_id ?? input.extra?.workspaceId;
  const sourceData = dataUrlToBase64(input.image);
  const maskData = dataUrlToBase64(input.mask);
  const params: Record<string, unknown> = {
    name,
    n: 1,
    '需要重绘的图': [buildImageParam(sourceData)],
    '输入图片蒙版': [buildImageParam(maskData)],
    '正向提示': input.prompt,
    '重绘幅度': repaintStrength,
    seed: typeof input.seed === 'number' ? input.seed : -1,
  };
  const task: Record<string, unknown> = {
    request_type: 'single_image',
    backend: 'comfyui',
    pipeline_id: '局部重绘_volcengine',
    params,
    ext_infos: {
      task_type: 'edit',
      edit_type: 'inpaint',
    },
  };
  if (typeof workspaceId === 'string' && workspaceId.trim()) task.workspace_id = workspaceId.trim();
  return {
    task,
    workspaceId: typeof workspaceId === 'string' && workspaceId.trim() ? workspaceId.trim() : undefined,
  };
}

function buildLocalRepaintFallbackPrompt(input: EditImageInput) {
  const prompt = input.prompt.trim() || '重绘蒙版标记区域。';
  return [
    prompt,
    '',
    '局部重绘约束：第一张参考图是原图，第二张参考图是黑白蒙版。只修改蒙版白色区域，黑色区域必须保持原图构图、边缘、材质、光照和颜色不变。输出与原图同构图的一张完整图片。',
  ].join('\n');
}

function parseImageSubmissionResult(
  submit: { stdout: string },
  fallbackMessage: string,
): Pick<LiclickImageSubmission, 'id' | 'status' | 'resultUrl' | 'resultUrls' | 'taskId' | 'raw'> {
  const payload = parseAtlasPayload(submit.stdout);
  const error = findAtlasError(payload);
  if (error) throw new Error(error);
  const urls = findUniqueImageUrls(payload);
  const taskId = findTaskId(payload);
  if (urls.length === 0 && !taskId) {
    const message = findField(payload, ['err_msg', 'error', 'message', 'result']) || trimOutput(submit.stdout);
    throw new Error(message || fallbackMessage);
  }
  return {
    id: taskId || `liclick-edit-${Date.now()}`,
    status: urls.length > 0 ? 'succeeded' : 'running',
    resultUrl: urls[0],
    resultUrls: urls,
    taskId,
    raw: payload,
  };
}

function findAtlasError(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') {
    return /(^|\s)(错误|error|HTTPStatusError|Bad Request|Failed):/i.test(value) || /HTTPStatusError|Bad Request/i.test(value)
      ? trimOutput(value)
      : '';
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAtlasError(item);
      if (found) return found;
    }
    return '';
  }
  if (typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  if (record.isError === true) {
    return findField(value, ['err_msg', 'error', 'message', 'result']) || trimOutput(JSON.stringify(value));
  }
  for (const key of ['err_msg', 'error', 'message']) {
    const child = record[key];
    if (typeof child === 'string' && /错误|error|HTTPStatusError|Bad Request|failed/i.test(child)) return trimOutput(child);
  }
  for (const child of Object.values(record)) {
    const found = findAtlasError(child);
    if (found) return found;
  }
  return '';
}

async function submitLocalRepaintFallback(
  input: EditImageInput,
  tempDir: string,
  atlasContext: LiclickAtlasContext,
  primaryError: string,
): Promise<LiclickImageSubmission> {
  let source: UploadedReference;
  let mask: UploadedReference;
  try {
    source = await uploadReference({ id: 'local-repaint-source', url: input.image }, tempDir, atlasContext);
  } catch (error) {
    throw new Error(`莉刻局部重绘上传原图失败：${errorMessage(error)}`);
  }
  try {
    mask = await uploadReference({ id: 'local-repaint-mask', url: input.mask }, tempDir, atlasContext);
  } catch (error) {
    throw new Error(`莉刻局部重绘上传蒙版失败：${errorMessage(error)}`);
  }

  const workspaceId = input.extra?.workspace_id ?? input.extra?.workspaceId;
  const referenceImages = [source, mask].map((reference) => ({
    asset_id: reference.assetId,
    type: 'image',
  }));
  const extraParams: Record<string, unknown> = {
    name: `Inpaint_${input.prompt.trim() || 'Local repaint'}`.slice(0, 48),
    quality: 'high',
    n: 1,
    aspect_ratio: 'auto',
    image_size: 'auto',
    reference_images: referenceImages,
    local_repaint_fallback: true,
    primary_error: primaryError,
  };
  const submit = await callAtlasToolJson(
    'liclick',
    'generate_image',
    {
      prompt: buildLocalRepaintFallbackPrompt(input),
      model: 'gpt-image-2',
      extra_params: extraParams,
      ...(typeof workspaceId === 'string' && workspaceId.trim() ? { workspace_id: workspaceId.trim() } : {}),
    },
    4 * 60 * 1000,
    atlasContext.atlasHomeDir,
  );
  const parsed = parseImageSubmissionResult(submit, '莉刻局部重绘 fallback 没有返回任务 ID。');
  return {
    ...parsed,
    workspaceId: typeof workspaceId === 'string' && workspaceId.trim() ? workspaceId.trim() : undefined,
    model: 'gpt-image-2',
    extraParams,
    uploadedReferences: [source, mask],
  };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'liclick-generate-'));
  try {
    return await fn(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function uploadReference(
  reference: ReferenceInput,
  _tempDir: string,
  atlasContext: LiclickAtlasContext = {},
): Promise<UploadedReference> {
  const toolArguments: Record<string, unknown> = { asset_type: 'image' };
  let cacheKey: string;
  if (reference.url.startsWith('data:')) {
    const { buffer } = dataUrlToBuffer(reference.url);
    const digest = createHash('sha256').update(buffer).digest('hex');
    cacheKey = `${atlasContext.atlasHomeDir ?? 'default'}:image:${digest}`;
    toolArguments.file_path = reference.url;
  } else {
    cacheKey = `${atlasContext.atlasHomeDir ?? 'default'}:image-url:${reference.url}`;
    toolArguments.url = reference.url;
  }

  let uploadPromise = uploadedImageAssetCache.get(cacheKey);
  if (!uploadPromise) {
    uploadPromise = (async () => {
      const upload = await callAtlasToolJson(
        'liclick',
        'upload_asset',
        toolArguments,
        10 * 60 * 1000,
        atlasContext.atlasHomeDir,
      );
      const parsed = parseJsonFromOutput(upload.stdout);
      const assetId =
        findField(parsed, ['asset_id', 'assetId']) || findField(upload.stdout, ['asset_id', 'assetId']);
      if (!assetId) {
        throw new Error(`参考图上传完成但没有返回 asset_id：${trimOutput(upload.stdout)}`);
      }
      return assetId;
    })();
    uploadedImageAssetCache.set(cacheKey, uploadPromise);
    while (uploadedImageAssetCache.size > maxUploadedImageAssetCacheEntries) {
      const oldestKey = uploadedImageAssetCache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      uploadedImageAssetCache.delete(oldestKey);
    }
  }

  let assetId: string;
  try {
    assetId = await uploadPromise;
  } catch (error) {
    if (uploadedImageAssetCache.get(cacheKey) === uploadPromise) {
      uploadedImageAssetCache.delete(cacheKey);
    }
    throw error;
  }
  return { referenceId: reference.id, assetId };
}

export async function pollLiclickImageTask(
  taskId: string,
  atlasContext: LiclickAtlasContext = {},
): Promise<LiclickImageTaskResult> {
  const poll = await callAtlasToolJson(
    'liclick',
    'get_task_status',
    { task_id: taskId, task_type: 'image' },
    3 * 60 * 1000,
    atlasContext.atlasHomeDir,
  );
  return parseLiclickImageTaskOutput(poll.stdout);
}

export async function submitLiclickImageJob(
  input: GenerateImageInput,
  atlasContext: LiclickAtlasContext = {},
): Promise<LiclickImageSubmission> {
  return withTempDir(async (tempDir) => {
    const references = (input.references ?? []).slice(0, 10);
    const uploadedReferences = await Promise.all(
      references.map((reference) => uploadReference(reference, tempDir, atlasContext)),
    );
    const { model, extraParams } = buildExtraParams(input, uploadedReferences);
    const prompt = buildSubmissionPrompt(input, model);
    const submit = await callAtlasToolJson(
      'liclick',
      'generate_image',
      {
        prompt,
        model,
        extra_params: extraParams,
      },
      4 * 60 * 1000,
      atlasContext.atlasHomeDir,
    );
    const payload = parseAtlasPayload(submit.stdout);
    const urls = findUniqueImageUrls(payload);
    const taskId = findTaskId(payload);
    if (urls.length === 0 && !taskId) {
      const message = findField(payload, ['err_msg', 'error', 'message', 'result']) || trimOutput(submit.stdout);
      throw new Error(message || '莉刻图片生成没有返回任务 ID。');
    }
    return {
      id: taskId || `liclick-image-${Date.now()}`,
      status: urls.length > 0 ? 'succeeded' : 'running',
      resultUrl: urls[0],
      resultUrls: urls,
      taskId,
      model,
      extraParams,
      uploadedReferences,
      raw: payload,
    };
  });
}

export async function submitLiclickImageEdit(
  input: EditImageInput,
  atlasContext: LiclickAtlasContext = {},
): Promise<LiclickImageSubmission> {
  return withTempDir(async (tempDir) => {
    const { task: extraParams, workspaceId } = buildLocalRepaintTask(input);
    let submit;
    try {
      submit = await callAtlasToolJson(
        'liclick',
        'generate_image',
        {
          prompt: input.prompt,
          model: 'comfyui',
          extra_params: extraParams,
          ...(workspaceId ? { workspace_id: workspaceId } : {}),
        },
        4 * 60 * 1000,
        atlasContext.atlasHomeDir,
      );
      const parsed = parseImageSubmissionResult(submit, '莉刻局部重绘没有返回任务 ID。');
      return {
        ...parsed,
        workspaceId,
        model: '局部重绘_volcengine',
        extraParams,
        uploadedReferences: [],
      };
    } catch (error) {
      return submitLocalRepaintFallback(input, tempDir, atlasContext, errorMessage(error));
    }
  });
}
