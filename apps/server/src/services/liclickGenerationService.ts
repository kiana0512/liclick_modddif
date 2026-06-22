import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseJsonFromOutput, runAtlas } from '../auth/atlasAuthService.js';

type ReferenceInput = {
  id?: string;
  name?: string;
  url: string;
};

export type GenerateImageInput = {
  clientGenerationId?: string;
  projectId?: string;
  prompt: string;
  model?: string;
  aspectRatio?: 'auto' | '1:1' | '4:3' | '3:4' | '3:2' | '2:3' | '16:9' | '9:16';
  imageSize?: 'auto' | '1K' | '2K' | '4K';
  count?: number;
  references?: ReferenceInput[];
};

type UploadedReference = {
  referenceId?: string;
  assetId: string;
};

export type LiclickImageTaskResult = {
  status: string;
  resultUrl?: string;
  resultUrls?: string[];
  raw: unknown;
};

export type LiclickImageSubmission = {
  id: string;
  status: 'running' | 'succeeded';
  resultUrl?: string;
  resultUrls?: string[];
  taskId?: string;
  model: string;
  extraParams: Record<string, unknown>;
  uploadedReferences: UploadedReference[];
  raw: unknown;
};

function trimOutput(text: string) {
  return text.trim().replace(/\s+/g, ' ').slice(0, 1200);
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
    return [...value.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((match) => match[0]);
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

function buildExtraParams(input: GenerateImageInput, uploadedReferences: UploadedReference[]) {
  const model = input.model || 'gpt-image-2';
  const aspectRatio = input.aspectRatio ?? 'auto';
  const imageSize = input.imageSize ?? 'auto';
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
    extraParams.aspect_ratio = aspectRatio;
    if (model === 'gpt-image-2') {
      extraParams.image_size = aspectRatio === 'auto' ? 'auto' : imageSize === 'auto' ? '1K' : imageSize;
    } else if (model === 'nano_banana_2' || model === 'nano_banana_pro') {
      extraParams.image_size = imageSize === 'auto' ? '1K' : imageSize;
    }
  }
  return { model, extraParams };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'liclick-generate-'));
  try {
    return await fn(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function uploadReference(reference: ReferenceInput, tempDir: string): Promise<UploadedReference> {
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
  const upload = await runAtlas(args, 10 * 60 * 1000, false);
  const parsed = parseJsonFromOutput(upload.stdout);
  const assetId = findField(parsed, ['asset_id', 'assetId']) || findField(upload.stdout, ['asset_id', 'assetId']);
  if (!assetId) throw new Error(`参考图上传完成但没有返回 asset_id：${trimOutput(upload.stdout || upload.stderr)}`);
  return { referenceId: reference.id, assetId };
}

export async function pollLiclickImageTask(taskId: string): Promise<LiclickImageTaskResult> {
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
    raw: payload,
  };
}

export async function submitLiclickImageJob(input: GenerateImageInput): Promise<LiclickImageSubmission> {
  if (!input.prompt.trim()) throw new Error('请输入图片生成描述。');
  return withTempDir(async (tempDir) => {
    const references = (input.references ?? []).slice(0, 10);
    const uploadedReferences = await Promise.all(references.map((reference) => uploadReference(reference, tempDir)));
    const { model, extraParams } = buildExtraParams(input, uploadedReferences);
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
          prompt: input.prompt.trim(),
          model,
          extra_params: extraParams,
        }),
        '--timeout',
        '180',
      ],
      4 * 60 * 1000,
      false,
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

export async function generateLiclickImage(input: GenerateImageInput) {
  const submission = await submitLiclickImageJob(input);
  if (submission.resultUrl || !submission.taskId) return submission;
  const startedAt = Date.now();
  let result: LiclickImageTaskResult | undefined;
  while (Date.now() - startedAt < 5 * 60 * 1000) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    result = await pollLiclickImageTask(submission.taskId);
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
