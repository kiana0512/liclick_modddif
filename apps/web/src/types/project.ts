import type { Capture } from './capture';
import type { Generation } from './generation';
import type { Layer } from './layer';
import type { DisplayMode, ProjectionMode, SceneObject } from './model';
import type { BakedTexture } from '@/engine/bake/uvBakeTypes';

export type WorkspaceMode = 'none' | 'file-system-access' | 'download-fallback' | 'local-server';

export type AssetManifest = {
  models: string[];
  references: string[];
  generations: string[];
  captures?: string[];
  layers: string[];
  baked: string[];
};

export type ReferenceImage = {
  id: string;
  name: string;
  url: string;
  width: number;
  height: number;
  isPrimary: boolean;
};

export type ProjectSettings = {
  resolution: '1K' | '2K' | '4K' | '8K';
  displayMode: DisplayMode;
  projectionMode: ProjectionMode;
  colorManagement: 'srgb' | 'linear';
  imageGeneration?: {
    model: string;
    aspectRatio: string;
    imageSize: string;
    count: number;
    prompt?: string;
    mode?: 'visible' | 'upscale';
    upscaleStrength?: number;
  };
};

export type Project = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  thumbnail: string;
  objects: SceneObject[];
  references: ReferenceImage[];
  captures: Capture[];
  generations: Generation[];
  layers: Layer[];
  bakedTextures: BakedTexture[];
  workspaceName?: string;
  workspaceMode?: WorkspaceMode;
  folderId?: string | null;
  currentMode?: string;
  activeObjectId?: string;
  activeLayerId?: string;
  workspaceVersion?: string;
  lastSavedAt?: string;
  dirty?: boolean;
  assetManifest?: AssetManifest;
  settings: ProjectSettings;
};
