import { v4 as uuid } from 'uuid';
import type { GenerateTextureInput, Generation } from '@/types/generation';

const swatches = [
  'linear-gradient(135deg, #ff5ccf, #8b5cf6 52%, #1dd3b0)',
  'linear-gradient(135deg, #f8cdda, #6d5dfc 50%, #ff9f43)',
  'linear-gradient(135deg, #0f172a, #8b5cf6 48%, #f472b6)',
];

function gradientDataUrl(gradient: string, prompt: string) {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="768" height="768" viewBox="0 0 768 768">
      <foreignObject width="768" height="768">
        <div xmlns="http://www.w3.org/1999/xhtml" style="width:768px;height:768px;background:${gradient};display:flex;align-items:end;padding:48px;font-family:Inter,Arial,sans-serif;color:white;">
          <div style="font-size:42px;font-weight:700;line-height:1.05;text-shadow:0 6px 24px rgba(0,0,0,.35);">${prompt || 'Liclick texture concept'}</div>
        </div>
      </foreignObject>
    </svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export async function generateTextureMock(input: GenerateTextureInput): Promise<Generation> {
  await new Promise((resolve) => window.setTimeout(resolve, 500));
  const gradient = swatches[Math.floor(Math.random() * swatches.length)];

  return {
    id: uuid(),
    mode: input.mode,
    prompt: input.prompt,
    referenceIds: input.referenceIds,
    resultUrl: gradientDataUrl(gradient, input.prompt),
    status: 'succeeded',
    metadata: {
      provider: 'mock',
      visibleOnly: input.visibleOnly,
      upscale: input.upscale,
      note: 'Replace with Liclick API Adapter when backend credentials and endpoints are ready.',
    },
  };
}
