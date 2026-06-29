import { getWorkspaceApiBase } from './workspaceApiBase';

const workspaceApiBase = getWorkspaceApiBase(import.meta.env.VITE_LICLICK_WORKSPACE_API);

export interface ImageEditProvider {
  editImage(params: {
    image: Blob | File;
    mask: Blob | File;
    prompt: string;
    references?: (Blob | File)[];
    mode?: 'local_repaint' | 'image_edit';
    strength?: number;
    seed?: number;
    extra?: Record<string, unknown>;
  }): Promise<{
    outputImage: Blob;
    raw?: unknown;
  }>;
}

async function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read image edit blob.'));
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl: string) {
  const [header, encoded] = dataUrl.split(',');
  const mime = header?.match(/^data:([^;]+)/)?.[1] ?? 'image/png';
  const binary = atob(encoded ?? '');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mime });
}

export class LiClickImageEditProvider implements ImageEditProvider {
  constructor(private readonly baseUrl = workspaceApiBase) {}

  async editImage(params: Parameters<ImageEditProvider['editImage']>[0]) {
    const response = await fetch(`${this.baseUrl}/api/liclick/edit-image`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        image: await blobToDataUrl(params.image),
        mask: await blobToDataUrl(params.mask),
        prompt: params.prompt,
        references: await Promise.all((params.references ?? []).map(blobToDataUrl)),
        mode: params.mode ?? 'local_repaint',
        strength: params.strength,
        seed: params.seed,
        extra: params.extra,
      }),
    });
    const payload = (await response.json().catch(() => undefined)) as
      | { outputImage?: string; raw?: unknown; error?: string }
      | undefined;
    if (!response.ok || !payload?.outputImage) {
      throw new Error(payload?.error ?? `Liclick image edit failed: ${response.status}`);
    }
    return {
      outputImage: dataUrlToBlob(payload.outputImage),
      raw: payload.raw,
    };
  }
}

export const liclickImageEditProvider = new LiClickImageEditProvider();
