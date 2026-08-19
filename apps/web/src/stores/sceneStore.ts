import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type * as THREE from 'three';
import type { ModelLoadResult } from '@/engine/loaders/modelImportTypes';
import { getBoundingBoxForObject } from '@/engine/scene/boundingBoxUtils';
import type { SerializedCamera } from '@/types/capture';
import type { Layer } from '@/types/layer';
import type {
  DisplayMode,
  ModelBoundingBox,
  ProjectionMode,
  SceneObject,
  Transform,
} from '@/types/model';

export type TransformMode = 'select' | 'translate' | 'rotate' | 'scale';
export type PaintToolMode =
  | 'none'
  | 'brush'
  | 'eraser'
  | 'inpaint-add'
  | 'inpaint-subtract'
  | 'inpaint-apply';

export type LocalRepaintProjectionSource = {
  imageUrl: string;
  /** Original server/project URL used by autosave without data-URL readback. */
  persistentImageUrl?: string;
  /** Background source staging must not switch tools without an explicit click. */
  autoActivate?: boolean;
  allowedMaskUrl: string;
  depthUrl?: string;
  depthEncoding?: 'linear-view';
  normalUrl?: string;
  objectId?: string;
  objectMatrixWorld?: number[];
  camera: SerializedCamera;
  generationId?: string;
  captureId?: string;
  name?: string;
  targetLayerId?: string;
  targetLayerType?: 'projected' | 'uv';
  targetLayerName?: string;
};

export type PaintMaskSettings = {
  brushSize: number;
};

export type LocalRepaintBrushSettings = {
  brushSize: number;
  brushOpacity: number;
};

export const MIN_PAINT_MASK_BRUSH_SIZE = 0.1;
export const DEFAULT_PAINT_MASK_BRUSH_SIZE = 10;
export const MAX_PAINT_MASK_BRUSH_SIZE = 60;

export type PaintToolSettings = {
  brushSize: number;
  brushHardness: number;
  eraserSize: number;
  eraserHardness: number;
  color: string;
};

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
    subscribeChange?: (listener: () => void) => () => void;
  };
};

export type PaintMaskCapture = (options?: {
  aspect?: number;
  camera?: THREE.Camera;
}) => Promise<string | undefined>;

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
  paintMaskResetRevision: number;
  paintMaskInvertRevision: number;
  paintMaskDataUrl?: string;
  paintMaskHasContent: boolean;
  paintMaskCapture?: PaintMaskCapture;
  localRepaintProjectionSource?: LocalRepaintProjectionSource;
  localRepaintPreviewLayer?: Layer;
  paintMaskSettings: PaintMaskSettings;
  localRepaintBrushSettings: LocalRepaintBrushSettings;
  paintToolSettings: PaintToolSettings;
  importSettings: ImportSettings;
  importWarnings: string[];
  restoreCameraRequest?: { camera: SerializedCamera; nonce: number };
  setObjects: (objects: SceneObject[]) => void;
  setImportedModel: (model: ModelLoadResult, object: SceneObject) => void;
  restoreImportedModels: (models: ModelLoadResult[], activeObjectId?: string) => void;
  setActiveImportedModel: (objectId: string) => void;
  clearImportedModel: () => void;
  renameObject: (objectId: string, name: string) => void;
  deleteObject: (objectId: string) => void;
  arrangeImportedModels: () => void;
  setAllObjectsVisible: (visible: boolean) => void;
  setViewportRuntime: (runtime: ViewportRuntime) => void;
  selectObject: (objectId?: string) => void;
  setDisplayMode: (mode: DisplayMode) => void;
  setProjectionMode: (mode: ProjectionMode) => void;
  setTransformMode: (mode: TransformMode) => void;
  setPaintTool: (mode: PaintToolMode) => void;
  markPaintMaskChanged: () => void;
  setPaintMaskDataUrl: (dataUrl?: string, hasContent?: boolean) => void;
  setPaintMaskCapture: (capture?: PaintMaskCapture) => void;
  setLocalRepaintProjectionSource: (source?: LocalRepaintProjectionSource) => void;
  setLocalRepaintPreviewLayer: (layer?: Layer) => void;
  setPaintMaskSettings: (settings: Partial<PaintMaskSettings>) => void;
  setLocalRepaintBrushSettings: (settings: Partial<LocalRepaintBrushSettings>) => void;
  setPaintToolSettings: (settings: Partial<PaintToolSettings>) => void;
  clearPaintMask: () => void;
  invertPaintMask: () => void;
  setImportSettings: (settings: Partial<ImportSettings>) => void;
  setOrbitControlsEnabled: (enabled: boolean) => void;
  updateObjectTransform: (
    objectId: string,
    transform: Transform,
    boundingBox?: ModelBoundingBox,
  ) => void;
  toggleObjectVisibility: (objectId: string) => void;
  requestCameraRestore: (camera: SerializedCamera) => void;
};

function resetLocalRepaintForObjectChange(
  state: SceneStore,
  nextObjectId: string | undefined,
) {
  if (state.selectedObjectId === nextObjectId) return {};
  return {
    paintTool: 'none' as const,
    paintMaskDataUrl: undefined,
    paintMaskHasContent: false,
    localRepaintProjectionSource: undefined,
    localRepaintPreviewLayer: undefined,
    paintMaskRevision: state.paintMaskRevision + 1,
    paintMaskResetRevision: state.paintMaskResetRevision + 1,
  };
}

function arrangeModelsInCenteredRow(models: ModelLoadResult[], objects: SceneObject[]) {
  const modelWidths = models.map((model) => {
    const boundingBox = getBoundingBoxForObject(model.group);
    return Math.max(boundingBox.size[0], 0.01);
  });
  const modelGaps = modelWidths
    .slice(0, -1)
    .map((width, index) =>
      Math.max(0.45, Math.min(1.2, Math.max(width, modelWidths[index + 1]) * 0.18)),
    );
  const rowWidth =
    modelWidths.reduce((total, width) => total + width, 0) +
    modelGaps.reduce((total, gap) => total + gap, 0);
  let cursorX = -rowWidth / 2;
  const importedModels = models.map((model, index) => {
    const currentBoundingBox = getBoundingBoxForObject(model.group);
    const width = modelWidths[index];
    const targetCenterX = cursorX + width / 2;
    model.group.position.x += targetCenterX - currentBoundingBox.center[0];
    model.group.position.y -= currentBoundingBox.min[1];
    model.group.position.z -= currentBoundingBox.center[2];
    model.group.updateMatrixWorld(true);
    cursorX += width + (modelGaps[index] ?? 0);
    const boundingBox = getBoundingBoxForObject(model.group);
    return {
      ...model,
      boundingBox,
      importNormalizationTransform: {
        ...model.importNormalizationTransform,
        position: [model.group.position.x, model.group.position.y, model.group.position.z] as [
          number,
          number,
          number,
        ],
      },
    };
  });
  const modelByObjectId = new Map(importedModels.map((model) => [model.objectId, model]));
  return {
    importedModels,
    objects: objects.map((object) => {
      const model = modelByObjectId.get(object.id);
      if (!model) return object;
      return {
        ...object,
        transform: {
          ...object.transform,
          position: [model.group.position.x, model.group.position.y, model.group.position.z] as [
            number,
            number,
            number,
          ],
        },
        boundingBox: model.boundingBox,
        importNormalizationTransform: model.importNormalizationTransform,
      };
    }),
  };
}

export const useSceneStore = create<SceneStore>()(
  persist(
    (set, get) => ({
      objects: [],
      importedModels: [],
      importedModel: undefined,
      viewport: undefined,
      selectedObjectId: undefined,
      displayMode: 'flat',
      projectionMode: 'perspective',
      transformMode: 'select',
      paintTool: 'none',
      paintMaskRevision: 0,
      paintMaskResetRevision: 0,
      paintMaskInvertRevision: 0,
      paintMaskDataUrl: undefined,
      paintMaskHasContent: false,
      paintMaskCapture: undefined,
      localRepaintProjectionSource: undefined,
      localRepaintPreviewLayer: undefined,
      paintMaskSettings: {
        brushSize: DEFAULT_PAINT_MASK_BRUSH_SIZE,
      },
      localRepaintBrushSettings: {
        brushSize: DEFAULT_PAINT_MASK_BRUSH_SIZE,
        brushOpacity: 100,
      },
      paintToolSettings: {
        brushSize: 32,
        brushHardness: 50,
        eraserSize: 42,
        eraserHardness: 50,
        color: '#ffffff',
      },
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
          const importedModels = state.importedModels.filter((model) =>
            objectIds.has(model.objectId),
          );
          const selectedObjectId = objects.find((object) => object.selected)?.id ?? objects[0]?.id;
          return {
            ...resetLocalRepaintForObjectChange(state, selectedObjectId),
            objects,
            importedModels,
            importedModel: importedModels.find((model) => model.objectId === selectedObjectId),
            selectedObjectId,
          };
        }),
      setImportedModel: (model, object) =>
        set((state) => {
          const existingModelIndex = state.importedModels.findIndex(
            (item) => item.objectId === object.id,
          );
          const importedModels =
            existingModelIndex >= 0
              ? state.importedModels.map((item) => (item.objectId === object.id ? model : item))
              : [...state.importedModels, model];
          const nextObject = { ...object, selected: true, visible: object.visible ?? true };
          const hasExistingObject = state.objects.some((item) => item.id === object.id);
          const objects = hasExistingObject
            ? state.objects.map((item) =>
                item.id === object.id ? nextObject : { ...item, selected: false },
              )
            : [...state.objects.map((item) => ({ ...item, selected: false })), nextObject];
          return {
            ...resetLocalRepaintForObjectChange(state, object.id),
            importedModels,
            importedModel: model,
            objects,
            selectedObjectId: object.id,
            importWarnings: model.warnings,
          };
        }),
      restoreImportedModels: (models, requestedActiveObjectId) =>
        set((state) => {
          const activeObjectId =
            (requestedActiveObjectId &&
            models.some((model) => model.objectId === requestedActiveObjectId)
              ? requestedActiveObjectId
              : models[0]?.objectId) ?? state.objects[0]?.id;
          const importedModel = models.find((model) => model.objectId === activeObjectId);
          return {
            ...resetLocalRepaintForObjectChange(state, activeObjectId),
            importedModels: models,
            importedModel,
            selectedObjectId: activeObjectId,
            objects: state.objects.map((object) => ({
              ...object,
              selected: object.id === activeObjectId,
            })),
            importWarnings: importedModel?.warnings ?? [],
          };
        }),
      setActiveImportedModel: (objectId) =>
        set((state) => {
          const importedModel =
            state.importedModels.find((model) => model.objectId === objectId) ??
            state.importedModel;
          return {
            ...resetLocalRepaintForObjectChange(state, objectId),
            importedModel,
            selectedObjectId: objectId,
            objects: state.objects.map((object) => ({
              ...object,
              selected: object.id === objectId,
            })),
            importWarnings: importedModel?.warnings ?? [],
          };
        }),
      clearImportedModel: () =>
        set((state) => ({
          ...resetLocalRepaintForObjectChange(state, undefined),
          importedModels: [],
          importedModel: undefined,
          objects: [],
          selectedObjectId: undefined,
          importWarnings: [],
        })),
      renameObject: (objectId, name) =>
        set((state) => ({
          objects: state.objects.map((object) =>
            object.id === objectId ? { ...object, name } : object,
          ),
          importedModels: state.importedModels.map((model) =>
            model.objectId === objectId ? { ...model, name } : model,
          ),
          importedModel:
            state.importedModel?.objectId === objectId
              ? { ...state.importedModel, name }
              : state.importedModel,
        })),
      deleteObject: (objectId) =>
        set((state) => {
          state.importedModels
            .find((model) => model.objectId === objectId)
            ?.group.removeFromParent();
          const objectsWithoutDeleted = state.objects.filter((object) => object.id !== objectId);
          const selectedObjectId =
            state.selectedObjectId && state.selectedObjectId !== objectId
              ? state.selectedObjectId
              : objectsWithoutDeleted[0]?.id;
          const remainingModels = state.importedModels.filter(
            (model) => model.objectId !== objectId,
          );
          const arranged = arrangeModelsInCenteredRow(remainingModels, objectsWithoutDeleted);
          const importedModels = arranged.importedModels;
          const importedModel = selectedObjectId
            ? importedModels.find((model) => model.objectId === selectedObjectId)
            : undefined;
          const removesLocalRepaint =
            state.localRepaintProjectionSource?.objectId === objectId ||
            state.localRepaintPreviewLayer?.objectId === objectId;

          return {
            objects: arranged.objects.map((object) => ({
              ...object,
              selected: object.id === selectedObjectId,
            })),
            importedModels,
            importedModel,
            selectedObjectId,
            importWarnings: importedModel?.warnings ?? [],
            ...(removesLocalRepaint
              ? {
                  paintTool: 'none' as const,
                  paintMaskDataUrl: undefined,
                  paintMaskHasContent: false,
                  localRepaintProjectionSource: undefined,
                  localRepaintPreviewLayer: undefined,
                  paintMaskResetRevision: state.paintMaskResetRevision + 1,
                }
              : {}),
          };
        }),
      arrangeImportedModels: () =>
        set((state) => {
          const arranged = arrangeModelsInCenteredRow(state.importedModels, state.objects);
          const importedModel = state.selectedObjectId
            ? arranged.importedModels.find((model) => model.objectId === state.selectedObjectId)
            : arranged.importedModels[0];
          return {
            ...arranged,
            importedModel,
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
            ? (state.importedModels.find((model) => model.objectId === objectId) ??
              state.importedModel)
            : state.importedModel;
          return {
            ...resetLocalRepaintForObjectChange(state, objectId),
            importedModel,
            selectedObjectId: objectId,
            objects: state.objects.map((object) => ({
              ...object,
              selected: object.id === objectId,
            })),
            importWarnings: importedModel?.warnings ?? state.importWarnings,
          };
        }),
      setDisplayMode: (displayMode) => set({ displayMode }),
      setProjectionMode: (projectionMode) => set({ projectionMode }),
      setTransformMode: (transformMode) =>
        set((state) =>
          state.transformMode === transformMode && state.paintTool === 'none'
            ? state
            : { transformMode, paintTool: 'none' },
        ),
      setPaintTool: (paintTool) =>
        set((state) =>
          state.paintTool === paintTool && state.transformMode === 'select'
            ? state
            : { paintTool, transformMode: 'select' },
        ),
      markPaintMaskChanged: () =>
        set((state) => ({ paintMaskRevision: state.paintMaskRevision + 1 })),
      setPaintMaskDataUrl: (paintMaskDataUrl, paintMaskHasContent) =>
        set((state) => ({
          paintMaskDataUrl,
          paintMaskHasContent:
            paintMaskHasContent ?? (paintMaskDataUrl ? state.paintMaskHasContent : false),
          paintMaskRevision: state.paintMaskRevision + 1,
        })),
      setPaintMaskCapture: (paintMaskCapture) => set({ paintMaskCapture }),
      setLocalRepaintProjectionSource: (localRepaintProjectionSource) =>
        set({ localRepaintProjectionSource }),
      setLocalRepaintPreviewLayer: (localRepaintPreviewLayer) =>
        set({ localRepaintPreviewLayer }),
      setPaintMaskSettings: (settings) =>
        set((state) => ({
          paintMaskSettings: {
            brushSize: Math.max(
              MIN_PAINT_MASK_BRUSH_SIZE,
              Math.min(
                MAX_PAINT_MASK_BRUSH_SIZE,
                settings.brushSize ?? state.paintMaskSettings.brushSize,
              ),
            ),
          },
        })),
      setLocalRepaintBrushSettings: (settings) =>
        set((state) => ({
          localRepaintBrushSettings: {
            brushSize: Math.max(
              MIN_PAINT_MASK_BRUSH_SIZE,
              Math.min(
                MAX_PAINT_MASK_BRUSH_SIZE,
                settings.brushSize ?? state.localRepaintBrushSettings.brushSize,
              ),
            ),
            brushOpacity: Math.max(
              0,
              Math.min(
                100,
                settings.brushOpacity ?? state.localRepaintBrushSettings.brushOpacity,
              ),
            ),
          },
        })),
      setPaintToolSettings: (settings) =>
        set((state) => ({
          paintToolSettings: {
            brushSize: Math.max(
              0.5,
              Math.min(256, settings.brushSize ?? state.paintToolSettings.brushSize),
            ),
            brushHardness: Math.max(
              0,
              Math.min(100, settings.brushHardness ?? state.paintToolSettings.brushHardness),
            ),
            eraserSize: Math.max(
              0.5,
              Math.min(256, settings.eraserSize ?? state.paintToolSettings.eraserSize),
            ),
            eraserHardness: Math.max(
              0,
              Math.min(100, settings.eraserHardness ?? state.paintToolSettings.eraserHardness),
            ),
            color: settings.color ?? state.paintToolSettings.color,
          },
        })),
      clearPaintMask: () =>
        set((state) => ({
          paintMaskDataUrl: undefined,
          paintMaskHasContent: false,
          paintMaskRevision: state.paintMaskRevision + 1,
          paintMaskResetRevision: state.paintMaskResetRevision + 1,
        })),
      invertPaintMask: () =>
        set((state) => ({
          paintMaskRevision: state.paintMaskRevision + 1,
          paintMaskInvertRevision: state.paintMaskInvertRevision + 1,
        })),
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
        set({
          restoreCameraRequest: { camera, nonce: (get().restoreCameraRequest?.nonce ?? 0) + 1 },
        }),
    }),
    {
      name: 'liclick-viewport-preferences-v1',
      storage: createJSONStorage(() => localStorage),
      version: 2,
      migrate: (persistedState, version) => {
        const preferences = persistedState as Partial<SceneStore>;
        if (version < 2) return { ...preferences, displayMode: 'flat' as const };
        return preferences;
      },
      partialize: (state) => ({
        displayMode: state.displayMode,
        projectionMode: state.projectionMode,
        importSettings: state.importSettings,
      }),
    },
  ),
);
