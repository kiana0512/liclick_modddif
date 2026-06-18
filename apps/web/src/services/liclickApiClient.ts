import type { GenerateTextureInput, Generation } from '@/types/generation';

export type LiclickApiConfig = {
  baseUrl?: string;
  getAccessToken: () => Promise<string | undefined>;
};

export type LiclickGenerateTextureSingleViewInput = GenerateTextureInput & {
  prompt: string;
  mode: 'single';
};

export type LiclickApiClient = {
  generateTextureSingleView(input: LiclickGenerateTextureSingleViewInput): Promise<Generation>;
  inpaint(input: GenerateTextureInput): Promise<Generation>;
  generateNormal(input: GenerateTextureInput): Promise<Generation>;
  generateMultiview(input: GenerateTextureInput): Promise<Generation>;
};

export function createLiclickApiClient(_config: LiclickApiConfig): LiclickApiClient {
  const notImplemented = async (): Promise<Generation> => {
    throw new Error('Liclick API Adapter is a stub. Use mockGenerationService for MVP phase 2.');
  };

  return {
    generateTextureSingleView: notImplemented,
    inpaint: notImplemented,
    generateNormal: notImplemented,
    generateMultiview: notImplemented,
  };
}
