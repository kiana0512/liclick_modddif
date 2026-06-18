import type { Capture } from './capture';
import type { Generation } from './generation';
import type { Layer } from './layer';
import type { DisplayMode, ProjectionMode, SceneObject } from './model';

export type ReferenceImage = {
  id: string;
  name: string;
  url: string;
  width: number;
  height: number;
  isPrimary: boolean;
};

export type ProjectSettings = {
  resolution: '1K' | '2K' | '4K';
  displayMode: DisplayMode;
  projectionMode: ProjectionMode;
  colorManagement: 'srgb' | 'linear';
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
  settings: ProjectSettings;
};
