import type { Capture } from '@/types/capture';
import type { Generation } from '@/types/generation';
import type { Layer } from '@/types/layer';
import type { SceneObject } from '@/types/model';
import type { Project } from '@/types/project';
import type { ModelLoadResult } from '@/engine/loaders/modelImportTypes';
import { useGenerationStore } from '@/stores/generationStore';
import { useLayerStore } from '@/stores/layerStore';
import {
  clearPendingProjectObjectDeletions,
  IMMEDIATE_PROJECT_SAVE_EVENT,
  useProjectStore,
} from '@/stores/projectStore';
import { useSceneStore } from '@/stores/sceneStore';

export const OBJECT_RUNTIME_RESTORE_REQUEST_EVENT =
  'liclick:object-runtime-restore-request';

type GenerationSnapshot = {
  generations: Generation[];
  currentGeneration?: Generation;
  lastCapture?: Capture;
  isGenerating: boolean;
};

type ObjectDeletionSnapshot = {
  objectId: string;
  project: Project;
  objects: SceneObject[];
  layers: Layer[];
  activeObjectId?: string;
  activeLayerId?: string;
  deletedRuntimeModel?: ModelLoadResult;
  generation: GenerationSnapshot;
};

export type ObjectDeletionTransaction = {
  undo: () => void;
  redo: () => void;
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function dispatchWindowEvent(eventName: string) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(eventName));
}

function applyObjectTransform(model: ModelLoadResult, object: SceneObject) {
  model.group.visible = object.visible;
  model.group.position.fromArray(object.transform.position);
  model.group.rotation.set(...object.transform.rotation);
  model.group.scale.fromArray(object.transform.scale);
  model.group.updateMatrixWorld(true);
}

function deleteSnapshotObject(snapshot: ObjectDeletionSnapshot) {
  const layerStore = useLayerStore.getState();
  layerStore.setLayers(
    layerStore.layers.filter((layer) => layer.objectId !== snapshot.objectId),
  );
  useGenerationStore.getState().deleteObjectData(snapshot.objectId);
  useSceneStore.getState().deleteObject(snapshot.objectId);
  useProjectStore.getState().deleteProjectObject(snapshot.objectId);
  const scene = useSceneStore.getState();
  useProjectStore.getState().updateCurrentProject({
    objects: scene.objects,
    activeObjectId: scene.selectedObjectId,
  });
  dispatchWindowEvent(IMMEDIATE_PROJECT_SAVE_EVENT);
}

function restoreSnapshotObject(snapshot: ObjectDeletionSnapshot) {
  const projectStore = useProjectStore.getState();
  const currentProject = projectStore.getCurrentProject();
  const currentDeletedObjectIds = currentProject?.deletedObjectIds ?? [];
  const deletedObjectIds = Array.from(
    new Set([
      ...(snapshot.project.deletedObjectIds ?? []),
      ...currentDeletedObjectIds,
    ]),
  ).filter((objectId) => objectId !== snapshot.objectId);

  // A completed delete save may have advanced the server CAS token while the
  // user was pressing undo. Restore the deleted data without rolling that
  // concurrency token or the newest verified asset manifest backwards.
  const restoredProject: Project = {
    ...clone(snapshot.project),
    revision: currentProject?.revision ?? snapshot.project.revision,
    assetManifest: currentProject?.assetManifest ?? snapshot.project.assetManifest,
    lastSavedAt: currentProject?.lastSavedAt ?? snapshot.project.lastSavedAt,
    deletedObjectIds,
    dirty: true,
    updatedAt: new Date().toISOString(),
  };

  clearPendingProjectObjectDeletions(snapshot.project.id, [snapshot.objectId]);
  projectStore.replaceCurrentProject(restoredProject);

  const objects = clone(snapshot.objects);
  const sceneStore = useSceneStore.getState();
  sceneStore.setObjects(objects, snapshot.activeObjectId);
  const runtimeByObjectId = new Map(
    useSceneStore
      .getState()
      .importedModels.map((model) => [model.objectId, model] as const),
  );
  if (snapshot.deletedRuntimeModel) {
    runtimeByObjectId.set(snapshot.objectId, snapshot.deletedRuntimeModel);
  }
  const restoredModels = objects.flatMap((object) => {
    const model = runtimeByObjectId.get(object.id);
    if (!model) return [];
    applyObjectTransform(model, object);
    return [model];
  });
  sceneStore.restoreImportedModels(restoredModels, snapshot.activeObjectId);

  const layers = clone(snapshot.layers);
  useLayerStore.getState().setLayers(layers);
  useLayerStore.setState({
    activeProjectedLayerId:
      snapshot.activeLayerId && layers.some((layer) => layer.id === snapshot.activeLayerId)
        ? snapshot.activeLayerId
        : undefined,
  });
  useGenerationStore.setState(clone(snapshot.generation));

  const restoredRuntimeIds = new Set(restoredModels.map((model) => model.objectId));
  const requiresSourceReload = objects.some(
    (object) => object.format !== 'primitive' && !restoredRuntimeIds.has(object.id),
  );
  if (requiresSourceReload) {
    dispatchWindowEvent(OBJECT_RUNTIME_RESTORE_REQUEST_EVENT);
  }
  dispatchWindowEvent(IMMEDIATE_PROJECT_SAVE_EVENT);
}

export function createObjectDeletionTransaction(
  objectId: string,
): ObjectDeletionTransaction | undefined {
  const project = useProjectStore.getState().getCurrentProject();
  const scene = useSceneStore.getState();
  if (!project || !scene.objects.some((object) => object.id === objectId)) return undefined;

  const layer = useLayerStore.getState();
  const generation = useGenerationStore.getState();
  const objects = clone(scene.objects);
  const layers = clone(layer.layers);
  const snapshot: ObjectDeletionSnapshot = {
    objectId,
    project: clone({
      ...project,
      objects,
      layers,
      generations: generation.generations,
      activeObjectId: scene.selectedObjectId,
      activeLayerId: layer.activeProjectedLayerId,
    }),
    objects,
    layers,
    activeObjectId: scene.selectedObjectId,
    activeLayerId: layer.activeProjectedLayerId,
    deletedRuntimeModel: scene.importedModels.find((model) => model.objectId === objectId),
    generation: clone({
      generations: generation.generations,
      currentGeneration: generation.currentGeneration,
      lastCapture: generation.lastCapture,
      isGenerating: generation.isGenerating,
    }),
  };

  return {
    undo: () => restoreSnapshotObject(snapshot),
    redo: () => deleteSnapshotObject(snapshot),
  };
}
