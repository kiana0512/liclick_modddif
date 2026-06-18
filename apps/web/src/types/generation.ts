export type GenerationMode = 'single' | 'multiview' | 'inpaint' | 'normal';
export type GenerationStatus = 'idle' | 'queued' | 'running' | 'succeeded' | 'failed';

export type Generation = {
  id: string;
  mode: GenerationMode;
  prompt: string;
  negativePrompt?: string;
  referenceIds: string[];
  captureId?: string;
  resultUrl?: string;
  status: GenerationStatus;
  metadata: Record<string, unknown>;
};

export type GenerateTextureInput = {
  mode: GenerationMode;
  prompt: string;
  referenceIds: string[];
  visibleOnly: boolean;
  upscale: boolean;
};
