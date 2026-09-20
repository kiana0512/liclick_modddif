import type { LiclickGenerateTextureSingleViewInput } from '@/services/liclickApiClient';
import { urlToDataUrl } from '@/services/workspaceApiClient';
import { blobToDataUrl, urlToImageData } from '@/engine/localRepaint/imageUtils';
import { findContentFramingCooperatively, restoredFrameLayout } from './contentFraming';
import { yieldToBrowserTask } from '@/utils/browserScheduling';

export async function load(url: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const dataUrl = await urlToDataUrl(url);
  signal?.throwIfAborted();
  const decoded = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
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
  await decoded.decode?.().catch(() => undefined);
  signal?.throwIfAborted();
  await yieldToBrowserTask();
  signal?.throwIfAborted();
  return decoded;
}

export async function encode(canvas: HTMLCanvasElement) {
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('生成图片编码失败。'))), 'image/png'),
  );
  return blobToDataUrl(blob);
}

export async function prepareContentFraming(input: LiclickGenerateTextureSingleViewInput) {
  const capture = input.capture!;
  const normal = input.workflow === 'local-repaint';
  // GPT-REPAINT-GEOMETRY-FRAMING/1.0.0. Normal guides now have an opaque
  // blue/black backdrop; their alpha is no longer model coverage. Reuse the
  // immutable depth pass already captured/saved before submission. maskUrl in
  // repaint is the author's selection, not the full model silhouette.
  if (normal && capture.depthEncoding !== 'linear-view')
    throw new Error('缺少同视角模型深度轮廓，未提交生成任务。');
  const coverageUrl = normal ? capture.depthUrl : capture.maskUrl;
  if (!coverageUrl) throw new Error('缺少模型轮廓，未提交生成任务。');
  const coverage = await urlToImageData(await urlToDataUrl(coverageUrl), undefined, undefined, {
    cooperative: true,
    signal: input.signal,
  });
  if (coverage.width !== capture.width || coverage.height !== capture.height)
    throw new Error('模型轮廓与截图尺寸不一致。');
  const framing = await findContentFramingCooperatively(coverage, normal ? 'linear-depth' : false, input.imageSize ?? '2K', async () => {
    input.signal?.throwIfAborted();
    await yieldToBrowserTask();
    input.signal?.throwIfAborted();
  });
  restoredFrameLayout(framing, framing.outputWidth!, framing.outputHeight!);
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
      // GPT-CONTENT-FRAMING/2.2.0: the canvas itself is the square crop.
      // Keep source background across its short axis; a second rectangular
      // clip would erase it into transparent bands. Both guides stay aligned.
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
