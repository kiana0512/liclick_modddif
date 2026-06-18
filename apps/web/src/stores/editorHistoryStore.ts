import { create } from 'zustand';
import { useLayerStore } from './layerStore';
import { useProjectStore } from './projectStore';
import { useSceneStore } from './sceneStore';
import type { Layer } from '@/types/layer';
import type { SceneObject } from '@/types/model';

type EditorSnapshot = {
  objects: SceneObject[];
  layers: Layer[];
};

type EditorHistoryStore = {
  past: EditorSnapshot[];
  future: EditorSnapshot[];
  capture: () => void;
  undo: () => void;
  redo: () => void;
  clear: () => void;
};

const maxHistory = 80;

function cloneSnapshot(snapshot: EditorSnapshot): EditorSnapshot {
  return {
    objects: structuredClone(snapshot.objects),
    layers: structuredClone(snapshot.layers),
  };
}

function getSnapshot(): EditorSnapshot {
  return {
    objects: useSceneStore.getState().objects,
    layers: useLayerStore.getState().layers,
  };
}

function applyObjectRuntime(objects: SceneObject[]) {
  const sceneState = useSceneStore.getState();
  const importedModel = sceneState.importedModel;
  if (!importedModel) return;
  const object = objects.find((item) => item.id === importedModel.objectId);
  if (!object) return;
  importedModel.group.visible = object.visible;
  importedModel.group.position.fromArray(object.transform.position);
  importedModel.group.rotation.set(...object.transform.rotation);
  importedModel.group.scale.fromArray(object.transform.scale);
  importedModel.group.updateMatrixWorld(true);
}

function applySnapshot(snapshot: EditorSnapshot) {
  const next = cloneSnapshot(snapshot);
  useSceneStore.getState().setObjects(next.objects);
  useLayerStore.getState().setLayers(next.layers);
  useProjectStore.getState().setProjectObjects(next.objects);
  useProjectStore.getState().setProjectLayers(next.layers);
  applyObjectRuntime(next.objects);
}

export const useEditorHistoryStore = create<EditorHistoryStore>((set, get) => ({
  past: [],
  future: [],
  capture: () => {
    const snapshot = cloneSnapshot(getSnapshot());
    set((state) => ({
      past: [...state.past.slice(-(maxHistory - 1)), snapshot],
      future: [],
    }));
  },
  undo: () => {
    const state = get();
    const previous = state.past.at(-1);
    if (!previous) return;
    const current = cloneSnapshot(getSnapshot());
    set({
      past: state.past.slice(0, -1),
      future: [current, ...state.future].slice(0, maxHistory),
    });
    applySnapshot(previous);
  },
  redo: () => {
    const state = get();
    const next = state.future[0];
    if (!next) return;
    const current = cloneSnapshot(getSnapshot());
    set({
      past: [...state.past, current].slice(-maxHistory),
      future: state.future.slice(1),
    });
    applySnapshot(next);
  },
  clear: () => set({ past: [], future: [] }),
}));
