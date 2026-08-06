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
  /**
   * Texture reference images are stored as a durable single-view/multiview
   * pair. Legacy projects omit these fields and are treated as one
   * single-view group per image.
   */
  referenceGroupId?: string;
  referenceRole?: 'single-view' | 'multi-view';
  derivedFromReferenceId?: string;
  referenceSource?: 'uploaded' | 'generated';
  generationId?: string;
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

export type ProjectPipelineStage = 'texture' | 'retopology' | 'uv' | 'bake';

/**
 * Describes how a stage revision received its primary input. Pipeline revisions
 * are append-only checkpoints; this value records provenance rather than an
 * editable UI mode.
 */
export type ProjectPipelineRevisionSourceMode =
  | 'project'
  | 'handoff'
  | 'manual'
  | 'processing-job'
  | 'system';

export type ProjectPipelineRevisionStatus =
  | 'draft'
  | 'queued'
  | 'running'
  | 'ready'
  | 'failed'
  | 'cancelled'
  | 'stale';

export type ProjectPipelineAssetKind =
  | 'model'
  | 'high-model'
  | 'low-model'
  | 'uv-model'
  | 'base-color'
  | 'normal'
  | 'roughness'
  | 'metallic'
  | 'cage'
  | 'report'
  | 'other';

/** A durable, immutable asset reference used by one pipeline checkpoint. */
export type ProjectPipelineAssetReference = Readonly<BakeAssetReference & {
  id: string;
  kind: ProjectPipelineAssetKind;
  objectId?: string;
  sourceRevisionId?: string;
  sha256?: string;
  sizeBytes?: number;
}>;

export type ProjectPipelineSettingValue =
  | string
  | number
  | boolean
  | null
  | readonly ProjectPipelineSettingValue[]
  | { readonly [key: string]: ProjectPipelineSettingValue };

/**
 * A published pipeline revision is never edited in place. A later checkpoint
 * is appended and points back to the revision it was derived from.
 */
export type ProjectPipelineRevision = {
  readonly id: string;
  readonly stage: ProjectPipelineStage;
  readonly sourceMode: ProjectPipelineRevisionSourceMode;
  readonly parentRevisionId?: string;
  readonly inputAssets: readonly ProjectPipelineAssetReference[];
  readonly outputAssets: readonly ProjectPipelineAssetReference[];
  readonly settings: Readonly<Record<string, ProjectPipelineSettingValue>>;
  readonly status: ProjectPipelineRevisionStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
};

export type ProjectPipelineState = {
  readonly version: 1;
  readonly revisions: readonly ProjectPipelineRevision[];
  /**
   * Staleness is an overlay so an upstream rerun never rewrites downstream
   * revision history. A new downstream revision naturally becomes the latest
   * usable checkpoint without deleting the older stale entry.
   */
  readonly staleRevisionIds?: readonly string[];
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
  dehighlightBaseColor?: boolean;
  dehighlightStrength?: number;
  generateRoughnessFromBakedBaseColor?: boolean;
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
  /** Bake-only high-poly asset. It is deliberately separate from Project.objects. */
  high?: BakeAssetReference;
  /** Serializable preview metadata for the bake-only high-poly asset. */
  highObject?: SceneObject;
  low?: BakeAssetReference;
  cage?: BakeAssetReference;
  color?: BakeAssetReference;
  normalMap?: BakeAssetReference;
  roughness?: BakeAssetReference;
  metallic?: BakeAssetReference;
  normal?: BakeAssetReference;
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

export type TextureBakeHandoff = {
  objectId: string;
  lowModel?: {
    name: string;
    url: string;
    mimeType?: string;
    file?: File;
  };
  baseColor?: {
    name: string;
    imageUrl: string;
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
  bakeWorkspace?: ProjectBakeWorkspace;
  /** Optional, append-only state for the texture -> retopology -> UV -> bake flow. */
  pipeline?: ProjectPipelineState;
  workspaceName?: string;
  workspaceMode?: WorkspaceMode;
  folderId?: string | null;
  currentMode?: string;
  activeObjectId?: string;
  activeLayerId?: string;
  workspaceVersion?: string;
  lastSavedAt?: string;
  dirty?: boolean;
  /** Transient save intent; the workspace server removes these objects and then clears this list. */
  deletedObjectIds?: string[];
  assetManifest?: AssetManifest;
  settings: ProjectSettings;
};
