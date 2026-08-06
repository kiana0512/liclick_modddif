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
    localRepaintPrompt?: string;
    mode?: 'visible' | 'upscale';
    upscaleStrength?: number;
  };
};

/**
 * Server-side persistence types deliberately allow additional fields so a
 * newer web client can append pipeline metadata without an older server
 * stripping it while saving the project document.
 */
export type WorkspaceProjectPipelineAssetReference = {
  id?: string;
  kind?: string;
  name?: string;
  url?: string;
  relativePath?: string;
  objectId?: string;
  sourceRevisionId?: string;
  [key: string]: unknown;
};

export type WorkspaceProjectPipelineRevision = {
  id?: string;
  stage?: string;
  inputAssets?: WorkspaceProjectPipelineAssetReference[];
  outputAssets?: WorkspaceProjectPipelineAssetReference[];
  [key: string]: unknown;
};

export type WorkspaceProjectPipeline = {
  version?: number;
  revisions?: WorkspaceProjectPipelineRevision[];
  staleRevisionIds?: string[];
  [key: string]: unknown;
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
  bakeWorkspace?: unknown;
  pipeline?: WorkspaceProjectPipeline;
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
  deletedObjectIds?: string[];
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
