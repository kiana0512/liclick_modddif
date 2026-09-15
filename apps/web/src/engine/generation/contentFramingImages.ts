import type { GenerationFraming } from '@liclick/contracts';
import type { LiclickGenerateTextureSingleViewInput } from '@/services/liclickApiClient';
import { urlToDataUrl } from '@/services/workspaceApiClient';
import { blobToDataUrl, urlToImageData } from '@/engine/localRepaint/imageUtils';
import { findContentFraming, restoredFrameLayout } from './contentFraming';

async function load(url: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const dataUrl = await urlToDataUrl(url);
  signal?.throwIfAborted();
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    const finish = (error?: unknown) => {
      image.onload = image.onerror = null;
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(image);
    };
    const abort = () => {
      finish(signal?.reason ?? new Error('已取消'));
      image.src = '';
    };
    image.onload = () => finish();
    image.onerror = () => finish(new Error('无法读取生成图片。'));
    signal?.addEventListener('abort', abort, { once: true });
    image.src = dataUrl;
  });
}

async function encode(canvas: HTMLCanvasElement) {
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('生成图片编码失败。'))), 'image/png'),
  );
  return blobToDataUrl(blob);
}

export async function prepareContentFraming(input: LiclickGenerateTextureSingleViewInput) {
  const capture = input.capture!;
  const normal = input.workflow === 'local-repaint';
  const coverageUrl = normal ? capture.normalUrl : capture.maskUrl;
  if (!coverageUrl) throw new Error('缺少模型轮廓，未提交生成任务。');
  const coverage = await urlToImageData(await urlToDataUrl(coverageUrl), undefined, undefined, {
    cooperative: true,
    signal: input.signal,
  });
  if (coverage.width !== capture.width || coverage.height !== capture.height)
    throw new Error('模型轮廓与截图尺寸不一致。');
  const framing = findContentFraming(coverage, normal);
  const references = [...(input.referenceImages ?? [])];
  const alignedCount = normal ? 2 : 1;
  if (references.length < alignedCount) throw new Error('缺少生成引导图。');
  for (let index = 0; index < alignedCount; index++) {
    const image = await load(references[index].url, input.signal);
    if (image.naturalWidth !== capture.width || image.naturalHeight !== capture.height)
      throw new Error('生成引导图与模型轮廓未对齐。');
    const canvas = document.createElement('canvas');
    canvas.width = framing.width;
    canvas.height = framing.height;
    try {
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('无法创建裁切画布。');
      // Integer translation only: no resize, no colour/alpha replacement, same crop for both guides.
      ctx.drawImage(image, -framing.left, -framing.top);
      references[index] = {
        ...references[index],
        width: framing.width,
        height: framing.height,
        url: await encode(canvas),
      };
      input.signal?.throwIfAborted();
    } finally {
      canvas.width = canvas.height = 0;
    }
  }
  return { framing, references, exactIds: references.slice(0, alignedCount).map((r) => r.id) };
}

export async function restoreContentFraming(
  url: string,
  framing: GenerationFraming,
  signal?: AbortSignal,
) {
  const image = await load(url, signal);
  const layout = restoredFrameLayout(framing, image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = layout.height;
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建回贴画布。');
    ctx.drawImage(image, layout.left, layout.top, layout.patchWidth, layout.patchHeight);
    const result = await encode(canvas);
    signal?.throwIfAborted();
    return result;
  } finally {
    canvas.width = canvas.height = 0;
  }
}
