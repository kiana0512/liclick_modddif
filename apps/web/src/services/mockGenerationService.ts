import { v4 as uuid } from 'uuid';
import type { GenerateTextureInput, Generation } from '@/types/generation';

const swatches = [
  'linear-gradient(135deg, #ff5ccf, #8b5cf6 52%, #1dd3b0)',
  'linear-gradient(135deg, #f8cdda, #6d5dfc 50%, #ff9f43)',
  'linear-gradient(135deg, #0f172a, #8b5cf6 48%, #f472b6)',
];

function gradientDataUrl(gradient: string, prompt: string, captureId?: string) {
  const safePrompt = prompt.replace(/[<>&]/g, '');
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="768" height="768" viewBox="0 0 768 768">
      <foreignObject width="768" height="768">
        <div xmlns="http://www.w3.org/1999/xhtml" style="width:768px;height:768px;background:${gradient};display:flex;align-items:end;padding:48px;font-family:Inter,Arial,sans-serif;color:white;">
          <div>
            <div style="font-size:42px;font-weight:700;line-height:1.05;text-shadow:0 6px 24px rgba(0,0,0,.35);">${safePrompt || 'Liclick texture concept'}</div>
            <div style="margin-top:18px;font-size:18px;opacity:.78;">capture ${captureId?.slice(0, 8) ?? 'none'}</div>
          </div>
        </div>
      </foreignObject>
    </svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export async function generateTextureMock(input: GenerateTextureInput): Promise<Generation> {
  await new Promise((resolve) => window.setTimeout(resolve, 500));
  const gradient = swatches[Math.floor(Math.random() * swatches.length)];
  const generationId = uuid();

  return {
    id: generationId,
    mode: input.mode,
    prompt: input.prompt,
    negativePrompt: input.negativePrompt,
    referenceIds: input.referenceIds,
    captureId: input.capture?.id,
    resultUrl: gradientDataUrl(gradient, input.prompt, input.capture?.id),
    status: 'succeeded',
    metadata: {
      provider: 'mock',
      generationId,
      captureId: input.capture?.id,
      objectId: input.object?.id,
      resolution: input.resolution,
      textureMode: input.textureMode ?? 'realistic',
      visibleOnly: input.visibleOnly,
      upscale: input.upscale,
      note: 'Replace with Liclick API Adapter when backend credentials and endpoints are ready.',
    },
  };
}
