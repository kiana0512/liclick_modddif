import { create } from 'zustand';
import type * as THREE from 'three';
import type { ModelLoadResult } from '@/engine/loaders/modelImportTypes';
import type { SerializedCamera } from '@/types/capture';
import type { DisplayMode, ModelBoundingBox, ProjectionMode, SceneObject, Transform } from '@/types/model';

export type TransformMode = 'select' | 'translate' | 'rotate' | 'scale';
export type PaintToolMode = 'none' | 'brush' | 'eraser';

export type ImportSettings = {
  normalizeOnImport: boolean;
  groundOnImport: boolean;
  autoFitCamera: boolean;
};

export type ViewportRuntime = {
  gl: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  controls?: {
    target: THREE.Vector3;
    update: () => void;
    setEnabled: (enabled: boolean) => void;
  };
};

type SceneStore = {
  objects: SceneObject[];
  importedModel?: ModelLoadResult;
  viewport?: ViewportRuntime;
  selectedObjectId?: string;
  displayMode: DisplayMode;
  projectionMode: ProjectionMode;
  transformMode: TransformMode;
  paintTool: PaintToolMode;
  paintMaskRevision: number;
  importSettings: ImportSettings;
  importWarnings: string[];
  restoreCameraRequest?: { camera: SerializedCamera; nonce: number };
  setObjects: (objects: SceneObject[]) => void;
  setImportedModel: (model: ModelLoadResult, object: SceneObject) => void;
  clearImportedModel: () => void;
  setViewportRuntime: (runtime: ViewportRuntime) => void;
  selectObject: (objectId?: string) => void;
  setDisplayMode: (mode: DisplayMode) => void;
  setProjectionMode: (mode: ProjectionMode) => void;
  setTransformMode: (mode: TransformMode) => void;
  setPaintTool: (mode: PaintToolMode) => void;
  markPaintMaskChanged: () => void;
  clearPaintMask: () => void;
  setImportSettings: (settings: Partial<ImportSettings>) => void;
  setOrbitControlsEnabled: (enabled: boolean) => void;
  updateObjectTransform: (objectId: string, transform: Transform, boundingBox?: ModelBoundingBox) => void;
  toggleObjectVisibility: (objectId: string) => void;
  requestCameraRestore: (camera: SerializedCamera) => void;
};

export const useSceneStore = create<SceneStore>((set, get) => ({
  objects: [],
  importedModel: undefined,
  viewport: undefined,
  selectedObjectId: undefined,
  displayMode: 'pbr',
  projectionMode: 'perspective',
  transformMode: 'select',
  paintTool: 'none',
  paintMaskRevision: 0,
  importSettings: {
    normalizeOnImport: true,
    groundOnImport: true,
    autoFitCamera: true,
  },
  importWarnings: [],
  restoreCameraRequest: undefined,
  setObjects: (objects) =>
    set({
      objects,
      selectedObjectId: objects.find((object) => object.selected)?.id ?? objects[0]?.id,
    }),
  setImportedModel: (model, object) =>
    set({
      importedModel: model,
      objects: [object],
      selectedObjectId: object.id,
      importWarnings: model.warnings,
    }),
  clearImportedModel: () =>
    set({
      importedModel: undefined,
      objects: [],
      selectedObjectId: undefined,
      importWarnings: [],
    }),
  setViewportRuntime: (viewport) => set({ viewport }),
  selectObject: (objectId) =>
    set((state) => ({
      selectedObjectId: objectId,
      objects: state.objects.map((object) => ({ ...object, selected: object.id === objectId })),
    })),
  setDisplayMode: (displayMode) => set({ displayMode }),
  setProjectionMode: (projectionMode) => set({ projectionMode }),
  setTransformMode: (transformMode) => set({ transformMode, paintTool: 'none' }),
  setPaintTool: (paintTool) => set({ paintTool, transformMode: 'select' }),
  markPaintMaskChanged: () => set((state) => ({ paintMaskRevision: state.paintMaskRevision + 1 })),
  clearPaintMask: () => set((state) => ({ paintMaskRevision: state.paintMaskRevision + 1 })),
  setImportSettings: (settings) =>
    set((state) => ({ importSettings: { ...state.importSettings, ...settings } })),
  setOrbitControlsEnabled: (enabled) => get().viewport?.controls?.setEnabled(enabled),
  updateObjectTransform: (objectId, transform, boundingBox) =>
    set((state) => ({
      objects: state.objects.map((object) =>
        object.id === objectId
          ? {
              ...object,
              transform,
              userTransform: transform,
              boundingBox: boundingBox ?? object.boundingBox,
            }
          : object,
      ),
      importedModel:
        state.importedModel?.objectId === objectId && boundingBox
          ? { ...state.importedModel, boundingBox }
          : state.importedModel,
    })),
  toggleObjectVisibility: (objectId) =>
    set((state) => {
      const objects = state.objects.map((object) =>
        object.id === objectId ? { ...object, visible: !object.visible } : object,
      );
      if (state.importedModel?.objectId === objectId) {
        state.importedModel.group.visible = objects.find((object) => object.id === objectId)?.visible ?? true;
      }
      return { objects };
    }),
  requestCameraRestore: (camera) =>
    set({ restoreCameraRequest: { camera, nonce: (get().restoreCameraRequest?.nonce ?? 0) + 1 } }),
}));
