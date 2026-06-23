import type * as THREE from 'three';
import type { SerializedCamera } from '@/types/capture';

export type CaptureResolution = 1024 | 2048 | 4096;

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
  framing?: 'current' | 'fit-object';
  colorMode?: 'viewport' | 'clay-target';
  fillRatio?: number;
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
