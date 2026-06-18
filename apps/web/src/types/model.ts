export type ModelFormat = 'glb' | 'gltf' | 'fbx' | 'obj' | 'primitive';

export type Transform = {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
};

export type ImportNormalizationTransform = {
  position: [number, number, number];
  scale: [number, number, number];
  targetMaxDimension: number;
  grounded: boolean;
  normalized: boolean;
};

export type MaterialSlot = {
  id: string;
  name: string;
  baseColor?: string;
};

export type ModelBoundingBox = {
  min: [number, number, number];
  max: [number, number, number];
  center: [number, number, number];
  size: [number, number, number];
};

export type SceneObject = {
  id: string;
  name: string;
  type: 'mesh' | 'group' | 'camera' | 'light';
  sourcePath?: string;
  format: ModelFormat;
  materialSlots: MaterialSlot[];
  uvSets: string[];
  boundingBox?: ModelBoundingBox;
  originalBoundingBox?: ModelBoundingBox;
  importNormalizationTransform?: ImportNormalizationTransform;
  userTransform?: Transform;
  childMeshCount?: number;
  warnings?: string[];
  transform: Transform;
  visible: boolean;
  selected: boolean;
};

export type DisplayMode = 'pbr' | 'flat' | 'normal' | 'wire';

export type ProjectionMode = 'perspective' | 'orthographic';
