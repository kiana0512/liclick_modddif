// GPT25-TEXTURE-GENERATION/1.2.0. LiClick registry verified 2026-09-12.
export const GPT_TEXTURE_MODELS = [
  { value: 'gpt-image-2.5-sunburst', label: 'GPT-Image 2.5 Sunburst' },
  { value: 'gpt-image-2.5-flare', label: 'GPT-Image 2.5 Flare' },
  { value: 'gpt-image-2', label: 'GPT-Image 2' },
] as const;
export type GptTextureModel = typeof GPT_TEXTURE_MODELS[number]['value'];
export function resolveGptTextureModel(value?: string): GptTextureModel {
  return GPT_TEXTURE_MODELS.find((model) => model.value === value)?.value ?? 'gpt-image-2.5-sunburst';
}

export const GPT_TEXTURE_QUALITIES = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '超高' },
  { value: 'max', label: '最高' },
] as const;
export type GptTextureQuality = typeof GPT_TEXTURE_QUALITIES[number]['value'];
export function getGptTextureQualities(model?: string) {
  return model === 'gpt-image-2' ? GPT_TEXTURE_QUALITIES.slice(0, 3) : GPT_TEXTURE_QUALITIES;
}
export function resolveGptTextureQuality(value?: string, model?: string): GptTextureQuality {
  return getGptTextureQualities(model).find((option) => option.value === value)?.value ?? 'high';
}

/** A submitted batch keeps this snapshot; never reads mutable viewport settings. */
export function getGptTextureRequestParameters(resolution: string, quality?: string, model?: string) {
  if (resolution !== '1K' && resolution !== '2K' && resolution !== '4K')
    throw new Error('GPT 生图仅支持 1K、2K、4K，请在顶部选择分辨率。');
  // Generation is capped at 2K; keep the project's 4K UV/display setting intact.
  return { aspectRatio: '1:1' as const, imageSize: resolution === '4K' ? '2K' : resolution,
    quality: resolveGptTextureQuality(quality, model), count: 1 } as const;
}
