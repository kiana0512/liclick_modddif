import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
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
  importedModels: ModelLoadResult[];
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
  setActiveImportedModel: (objectId: string) => void;
  clearImportedModel: () => void;
  renameObject: (objectId: string, name: string) => void;
  deleteObject: (objectId: string) => void;
  setAllObjectsVisible: (visible: boolean) => void;
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

export const useSceneStore = create<SceneStore>()(
  persist(
    (set, get) => ({
      objects: [],
      importedModels: [],
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
        set((state) => {
          const objectIds = new Set(objects.map((object) => object.id));
          const importedModels = state.importedModels.filter((model) => objectIds.has(model.objectId));
          const selectedObjectId = objects.find((object) => object.selected)?.id ?? objects[0]?.id;
          return {
            objects,
            importedModels,
            importedModel: importedModels.find((model) => model.objectId === selectedObjectId),
            selectedObjectId,
          };
        }),
      setImportedModel: (model, object) =>
        set((state) => {
          const existingModelIndex = state.importedModels.findIndex((item) => item.objectId === object.id);
          const importedModels =
            existingModelIndex >= 0
              ? state.importedModels.map((item) => (item.objectId === object.id ? model : item))
              : [...state.importedModels, model];
          const nextObject = { ...object, selected: true, visible: object.visible ?? true };
          const hasExistingObject = state.objects.some((item) => item.id === object.id);
          const objects = (
            hasExistingObject
              ? state.objects.map((item) => (item.id === object.id ? nextObject : { ...item, selected: false }))
              : [...state.objects.map((item) => ({ ...item, selected: false })), nextObject]
          );
          return {
            importedModels,
            importedModel: model,
            objects,
            selectedObjectId: object.id,
            importWarnings: model.warnings,
          };
        }),
      setActiveImportedModel: (objectId) =>
        set((state) => {
          const importedModel = state.importedModels.find((model) => model.objectId === objectId) ?? state.importedModel;
          return {
            importedModel,
            selectedObjectId: objectId,
            objects: state.objects.map((object) => ({ ...object, selected: object.id === objectId })),
            importWarnings: importedModel?.warnings ?? [],
          };
        }),
      clearImportedModel: () =>
        set({
          importedModels: [],
          importedModel: undefined,
          objects: [],
          selectedObjectId: undefined,
          importWarnings: [],
        }),
      renameObject: (objectId, name) =>
        set((state) => ({
          objects: state.objects.map((object) => (object.id === objectId ? { ...object, name } : object)),
          importedModels: state.importedModels.map((model) =>
            model.objectId === objectId ? { ...model, name } : model,
          ),
          importedModel:
            state.importedModel?.objectId === objectId ? { ...state.importedModel, name } : state.importedModel,
        })),
      deleteObject: (objectId) =>
        set((state) => {
          state.importedModels.find((model) => model.objectId === objectId)?.group.removeFromParent();
          const objectsWithoutDeleted = state.objects.filter((object) => object.id !== objectId);
          const selectedObjectId =
            state.selectedObjectId && state.selectedObjectId !== objectId
              ? state.selectedObjectId
              : objectsWithoutDeleted[0]?.id;
          const importedModels = state.importedModels.filter((model) => model.objectId !== objectId);
          const importedModel = selectedObjectId
            ? importedModels.find((model) => model.objectId === selectedObjectId)
            : undefined;

          return {
            objects: objectsWithoutDeleted.map((object) => ({ ...object, selected: object.id === selectedObjectId })),
            importedModels,
            importedModel,
            selectedObjectId,
            importWarnings: importedModel?.warnings ?? [],
          };
        }),
      setAllObjectsVisible: (visible) =>
        set((state) => {
          state.importedModels.forEach((model) => {
            model.group.visible = visible;
          });
          return {
            objects: state.objects.map((object) => ({ ...object, visible })),
          };
        }),
      setViewportRuntime: (viewport) => set({ viewport }),
      selectObject: (objectId) =>
        set((state) => {
          const importedModel = objectId
            ? state.importedModels.find((model) => model.objectId === objectId) ?? state.importedModel
            : state.importedModel;
          return {
            importedModel,
            selectedObjectId: objectId,
            objects: state.objects.map((object) => ({ ...object, selected: object.id === objectId })),
            importWarnings: importedModel?.warnings ?? state.importWarnings,
          };
        }),
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
          const visible = objects.find((object) => object.id === objectId)?.visible ?? true;
          const importedModel = state.importedModels.find((model) => model.objectId === objectId);
          if (importedModel) importedModel.group.visible = visible;
          return { objects };
        }),
      requestCameraRestore: (camera) =>
        set({ restoreCameraRequest: { camera, nonce: (get().restoreCameraRequest?.nonce ?? 0) + 1 } }),
    }),
    {
      name: 'liclick-viewport-preferences-v1',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        displayMode: state.displayMode,
        projectionMode: state.projectionMode,
        importSettings: state.importSettings,
      }),
    },
  ),
);
