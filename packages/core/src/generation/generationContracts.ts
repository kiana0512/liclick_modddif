export type AiGenerationProvider = 'mock' | 'liclick';

export type AiGenerationRequest = {
  provider: AiGenerationProvider;
  prompt: string;
  referenceIds: string[];
  captureId?: string;
};
