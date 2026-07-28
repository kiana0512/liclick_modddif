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
  objectId?: string;
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
    liclickPrompt?: string;
    textureMapPrompt?: string;
    localRepaintPrompt?: string;
    mode?: 'visible' | 'upscale';
    upscaleStrength?: number;
  };
};

export type BakeAssetReference = {
  name: string;
  url: string;
  relativePath?: string;
  mimeType?: string;
};

export type BakeDraftSettings = {
  engine: 'substance-designer';
  qualityPreset: 'preview' | 'production';
  resolution: number;
  frontalDistance: number;
  rearDistance: number;
  projectionMode: 'distance' | 'cage';
  cageInflation: number;
  matchMode: 'always' | 'by-name';
  sampling: string;
  padding: number;
  normalOrientation: 'directx' | 'opengl';
  device: 'gpu' | 'cpu';
  udim: number;
  hitStrategy: 'inward' | 'closest-from-source';
  ignoreBackfaces: boolean;
  enabledChannels: Array<
    | 'baseColor'
    | 'normal'
    | 'ambientOcclusion'
    | 'curvature'
    | 'worldNormal'
    | 'thickness'
    | 'position'
    | 'roughness'
    | 'metallic'
  >;
};

export type ProjectBakeSetState = {
  objectId: string;
  low?: BakeAssetReference;
  cage?: BakeAssetReference;
  color?: BakeAssetReference;
  normalMap?: BakeAssetReference;
  roughness?: BakeAssetReference;
  metallic?: BakeAssetReference;
  ignoreProjectColor?: boolean;
  settings?: BakeDraftSettings;
  lastJobId?: string;
};

export type ProjectBakeWorkspace = {
  version: 1;
  activeStage?: 'assets' | 'alignment' | 'bake' | 'check' | 'pbr' | 'publish';
  selectedObjectId?: string;
  bakeSets: Record<string, ProjectBakeSetState>;
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
  bakeWorkspace?: ProjectBakeWorkspace;
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
