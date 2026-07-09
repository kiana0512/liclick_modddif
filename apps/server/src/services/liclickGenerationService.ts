import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { callAtlasToolJson, parseJsonFromOutput, runAtlas } from '../auth/atlasAuthService.js';

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
    return [...value.matchAll(/(?:https?:\/\/|data:image\/)[^\s"'<>]+/g)].map((match) => match[0]);
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

function isTerminalSuccessStatus(status: string) {
  return /succeed|success|complete|completed|done|finish|finished/i.test(status);
}

function normalizeAtlasPayload(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const structuredResult =
    record.structuredContent &&
    typeof record.structuredContent === 'object' &&
    'result' in record.structuredContent
      ? (record.structuredContent as Record<string, unknown>).result
      : undefined;
  if (typeof structuredResult === 'string') {
    try {
      return JSON.parse(structuredResult) as unknown;
    } catch {
      return structuredResult;
    }
  }
  return value;
}

function parseAtlasPayload(stdout: string) {
  return normalizeAtlasPayload(parseJsonFromOutput(stdout));
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
  return basePrompt ? `${basePrompt}\n\n${materialConstraint}` : materialConstraint;
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
  const urls = findUrls(payload);
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
  tempDir: string,
  atlasContext: LiclickAtlasContext = {},
): Promise<UploadedReference> {
  const args = ['gateway', 'call-tool', '--service', 'liclick', '--tool', 'upload_asset', 'asset_type=image'];
  if (reference.url.startsWith('data:')) {
    const { buffer, ext } = dataUrlToBuffer(reference.url);
    const filePath = path.join(tempDir, `${reference.id ?? randomUUID()}.${ext}`);
    await fs.promises.writeFile(filePath, buffer);
    args.push('--file', `file_path=${filePath}`);
  } else {
    args.push(`url=${reference.url}`);
  }
  args.push('--timeout', '600');
  const upload = await runAtlas(args, 10 * 60 * 1000, false, atlasContext.atlasHomeDir);
  const parsed = parseJsonFromOutput(upload.stdout);
  const assetId = findField(parsed, ['asset_id', 'assetId']) || findField(upload.stdout, ['asset_id', 'assetId']);
  if (!assetId) throw new Error(`参考图上传完成但没有返回 asset_id：${trimOutput(upload.stdout || upload.stderr)}`);
  return { referenceId: reference.id, assetId };
}

export async function pollLiclickImageTask(
  taskId: string,
  atlasContext: LiclickAtlasContext = {},
): Promise<LiclickImageTaskResult> {
  const poll = await runAtlas(
    [
      'gateway',
      'call-tool',
      '--service',
      'liclick',
      '--tool',
      'get_task_status',
      '--args',
      JSON.stringify({ task_id: taskId, task_type: 'image' }),
      '--timeout',
      '120',
    ],
    3 * 60 * 1000,
    false,
    atlasContext.atlasHomeDir,
  );
  const payload = parseAtlasPayload(poll.stdout);
  const status = findField(payload, ['status']);
  if (/failed/i.test(status)) {
    throw new Error(findField(payload, ['err_msg', 'error', 'message']) || '莉刻图片生成任务失败。');
  }
  const urls = findUrls(payload);
  return {
    status,
    resultUrl: urls[0],
    resultUrls: urls,
    terminalWithoutResult: urls.length === 0 && isTerminalSuccessStatus(status),
    raw: payload,
  };
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
    const submit = await runAtlas(
      [
        'gateway',
        'call-tool',
        '--service',
        'liclick',
        '--tool',
        'generate_image',
        '--args',
        JSON.stringify({
          prompt,
          model,
          extra_params: extraParams,
        }),
        '--timeout',
        '180',
      ],
      4 * 60 * 1000,
      false,
      atlasContext.atlasHomeDir,
    );
    const payload = parseAtlasPayload(submit.stdout);
    const urls = findUrls(payload);
    const taskId = findTaskId(payload);
    if (urls.length === 0 && !taskId) {
      const message = findField(payload, ['err_msg', 'error', 'message', 'result']) || trimOutput(submit.stdout || submit.stderr);
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

export async function generateLiclickImage(input: GenerateImageInput, atlasContext: LiclickAtlasContext = {}) {
  const submission = await submitLiclickImageJob(input, atlasContext);
  if (submission.resultUrl || !submission.taskId) return submission;
  const startedAt = Date.now();
  let result: LiclickImageTaskResult | undefined;
  while (Date.now() - startedAt < 5 * 60 * 1000) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    result = await pollLiclickImageTask(submission.taskId, atlasContext);
    if (result.resultUrl) {
      return {
        ...submission,
        status: 'succeeded' as const,
        resultUrl: result.resultUrl,
        resultUrls: result.resultUrls,
        raw: result.raw,
      };
    }
  }
  throw new Error(`等待莉刻图片生成超时：${submission.taskId || trimOutput(JSON.stringify(result?.raw ?? {}))}`);
}
