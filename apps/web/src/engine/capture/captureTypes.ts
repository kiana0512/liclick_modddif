import type * as THREE from 'three';
import type { SerializedCamera } from '@/types/capture';

export type CaptureResolution = 512 | 1024 | 2048 | 4096 | 8192;

export type CapturePassRequest = {
  gl: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  objectId: string;
  width: number;
  height: number;
  clearColor?: THREE.ColorRepresentation;
  clearAlpha?: number;
};

export type CapturePassOutput = {
  url: string;
  warnings: string[];
};

export type CaptureCurrentViewRequest = {
  objectId: string;
  resolution: CaptureResolution;
  aspect?: number;
  framing?: 'current' | 'fit-object';
  colorMode?: 'viewport' | 'clay-target' | 'target-only' | 'flat-target';
  fillRatio?: number;
  viewDirection?: [number, number, number];
  viewUp?: [number, number, number];
};

export type CaptureNormalPreview = {
  id: string;
  objectId: string;
  camera: SerializedCamera;
  width: number;
  height: number;
  normalUrl: string;
  createdAt: string;
  warnings: string[];
};

export type CaptureColorPreview = {
  width: number;
  height: number;
  colorUrl: string;
  warnings: string[];
};

export type SceneMaterialSnapshot = {
  object: THREE.Object3D;
  visible: boolean;
  material?: THREE.Material | THREE.Material[];
};

export type SerializedCameraInput = {
  camera: THREE.Camera;
  aspect: number;
  target: THREE.Vector3;
};

export type CaptureCameraSnapshot = SerializedCamera;
