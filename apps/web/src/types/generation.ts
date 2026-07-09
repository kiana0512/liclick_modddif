import type { Capture } from './capture';
import type { SceneObject } from './model';
import type { ReferenceImage } from './project';

export type GenerationMode = 'single' | 'multiview' | 'inpaint' | 'normal';
export type GenerationStatus = 'idle' | 'queued' | 'running' | 'succeeded' | 'failed';
export type TextureGenerationStyle = 'realistic' | 'albedo';
export type GenerationWorkflow = 'liclick' | 'texture-map';

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
  negativePrompt?: string;
  referenceIds: string[];
  referenceImages?: ReferenceImage[];
  workflow?: GenerationWorkflow;
  capture?: Capture;
  object?: SceneObject;
  resolution?: '1K' | '2K' | '4K' | '8K';
  textureMode?: TextureGenerationStyle;
  visibleOnly: boolean;
  upscale: boolean;
};
