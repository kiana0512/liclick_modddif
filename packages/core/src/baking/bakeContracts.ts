export type BakeEngineId = 'substance-designer' | 'marmoset-toolbag';

export type BakeMapId = 'baseColor' | 'ambientOcclusion' | 'normal';

export type BakeNormalOrientation = 'directx' | 'opengl';

export type BakeMatchMode = 'always' | 'by-name';

export type BakeProjectionMode = 'distance' | 'cage';

export type BakeComputeDevice = 'gpu' | 'cpu';

export type BakeEngineCapability =
  | 'distance-projection'
  | 'external-cage'
  | 'automatic-cage-estimation'
  | 'match-by-name'
  | 'transferred-color'
  | 'gpu-baking'
  | 'partial-rebake';

export type BakeEngineProfile = {
  id: BakeEngineId;
  name: string;
  shortName: string;
  executableNames: string[];
  capabilities: BakeEngineCapability[];
  supportedMaps: BakeMapId[];
};

export type BakeProjectionSettings = {
  mode: BakeProjectionMode;
  frontalDistance: number;
  rearDistance: number;
  relativeToBoundingBox: boolean;
  ignoreBackfaces: boolean;
  matchMode: BakeMatchMode;
  cageAssetId?: string;
};

export type BakeOutputSettings = {
  resolution: 1024 | 2048 | 4096 | 8192;
  padding: number;
  sampling: '1x1' | '2x2' | '4x4' | '8x8';
  normalOrientation: BakeNormalOrientation;
  uvSet: string;
  udim: number;
  device: BakeComputeDevice;
  maps: BakeMapId[];
};

export type BakeDraftSettings = {
  engine: BakeEngineId;
  projection: BakeProjectionSettings;
  output: BakeOutputSettings;
};

export const bakeEngineProfiles: Record<BakeEngineId, BakeEngineProfile> = {
  'substance-designer': {
    id: 'substance-designer',
    name: 'Adobe Substance 3D Designer',
    shortName: 'Substance Designer',
    executableNames: ['substance3d_baker.exe'],
    capabilities: [
      'distance-projection',
      'external-cage',
      'match-by-name',
      'transferred-color',
      'gpu-baking',
    ],
    supportedMaps: ['baseColor', 'ambientOcclusion', 'normal'],
  },
  'marmoset-toolbag': {
    id: 'marmoset-toolbag',
    name: 'Marmoset Toolbag',
    shortName: 'Marmoset Toolbag',
    executableNames: ['toolbag.exe'],
    capabilities: [
      'distance-projection',
      'external-cage',
      'automatic-cage-estimation',
      'match-by-name',
      'gpu-baking',
      'partial-rebake',
    ],
    supportedMaps: ['ambientOcclusion', 'normal'],
  },
};

export const defaultBakeDraftSettings: BakeDraftSettings = {
  engine: 'substance-designer',
  projection: {
    mode: 'distance',
    frontalDistance: 0.1,
    rearDistance: 0.1,
    relativeToBoundingBox: true,
    ignoreBackfaces: false,
    matchMode: 'always',
  },
  output: {
    resolution: 4096,
    padding: 16,
    sampling: '4x4',
    normalOrientation: 'directx',
    uvSet: 'UV0',
    udim: 1001,
    device: 'gpu',
    maps: ['baseColor', 'ambientOcclusion', 'normal'],
  },
};
