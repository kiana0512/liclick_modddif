export type WorkspaceProjectSettings = {
  resolution: '1K' | '2K' | '4K' | '8K';
  displayMode: string;
  projectionMode: string;
  colorManagement: 'srgb' | 'linear';
  imageGeneration?: {
    model: string;
    aspectRatio: string;
    imageSize: string;
    count: number;
    prompt?: string;
    liclickPrompt?: string;
    textureMapPrompt?: string;
    mode?: 'visible' | 'upscale';
    upscaleStrength?: number;
  };
};

export type WorkspaceProject = {
  id: string;
  name: string;
  folderId?: string | null;
  createdAt: string;
  updatedAt: string;
  thumbnail: string;
  objects: unknown[];
  references: unknown[];
  captures: unknown[];
  generations: unknown[];
  layers: unknown[];
  bakedTextures: unknown[];
  settings: WorkspaceProjectSettings;
  currentMode?: string;
  activeObjectId?: string;
  activeLayerId?: string;
  workspaceVersion: string;
  assetManifest?: Record<string, string[]>;
  workspaceName?: string;
  workspaceMode?: string;
  lastSavedAt?: string;
  dirty?: boolean;
};

export type ProjectSummary = {
  id: string;
  name: string;
  folderId?: string | null;
  createdAt: string;
  updatedAt: string;
  thumbnail: string;
  local: boolean;
  slug: string;
  localPath?: string;
  status?: 'local';
};
