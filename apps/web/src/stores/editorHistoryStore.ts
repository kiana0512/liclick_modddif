import { create } from 'zustand';
import { useLayerStore } from './layerStore';
import { useProjectStore } from './projectStore';
import { useSceneStore } from './sceneStore';
import { useToastStore } from './toastStore';
import type { Layer } from '@/types/layer';
import type { SceneObject } from '@/types/model';

type EditorSnapshot = {
  objects: SceneObject[];
  layers: Layer[];
};

type EditorRuntimeStep = {
  kind: 'runtime';
  label?: string;
  undo: () => void;
  redo: () => void;
};

type EditorSnapshotStep = {
  kind: 'snapshot';
  label?: string;
  snapshot: EditorSnapshot;
};

type EditorHistoryStep = EditorSnapshotStep | EditorRuntimeStep;

type EditorHistoryStore = {
  projectId?: string;
  past: EditorHistoryStep[];
  future: EditorHistoryStep[];
  capture: (label?: string) => void;
  captureRuntime: (step: Omit<EditorRuntimeStep, 'kind'>) => void;
  persistCurrentSnapshot: (projectId?: string) => void;
  restorePersisted: (projectId: string) => void;
  undo: () => void;
  redo: () => void;
  clear: () => void;
};

const maxHistory = 80;
function historyStorageKey(projectId: string) {
  return `liclick-editor-history-v1:${projectId}`;
}

function cloneSnapshot(snapshot: EditorSnapshot): EditorSnapshot {
  return {
    objects: structuredClone(snapshot.objects),
    layers: structuredClone(snapshot.layers),
  };
}

function getCurrentProjectId() {
  return useProjectStore.getState().currentProjectId;
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

function persistHistory(
  projectId: string | undefined,
  past: EditorHistoryStep[],
  future: EditorHistoryStep[],
  current = cloneSnapshot(getSnapshot()),
) {
  void projectId;
  void past;
  void future;
  void current;
}

function describeStep(step: EditorHistoryStep | undefined) {
  return step?.label?.trim() || '编辑操作';
}

function showHistoryToast(kind: 'undo' | 'redo', step: EditorHistoryStep) {
  const isUndo = kind === 'undo';
  useToastStore.getState().pushToast({
    tone: 'info',
    title: isUndo ? '已撤销' : '已恢复',
    description: describeStep(step),
    dedupeKey: `editor-history:${kind}:${Date.now()}`,
  });
}

export const useEditorHistoryStore = create<EditorHistoryStore>((set, get) => ({
  projectId: undefined,
  past: [],
  future: [],
  capture: (label) => {
    const projectId = getCurrentProjectId();
    const snapshot = cloneSnapshot(getSnapshot());
    set((state) => {
      const past = state.projectId === projectId ? state.past : [];
      const nextPast: EditorHistoryStep[] = [...past.slice(-(maxHistory - 1)), { kind: 'snapshot', label, snapshot }];
      persistHistory(projectId, nextPast, []);
      return {
        projectId,
        past: nextPast,
        future: [],
      };
    });
  },
  captureRuntime: (step) => {
    const projectId = getCurrentProjectId();
    set((state) => {
      const past = state.projectId === projectId ? state.past : [];
      const nextPast: EditorHistoryStep[] = [...past.slice(-(maxHistory - 1)), { kind: 'runtime', ...step }];
      persistHistory(projectId, nextPast, []);
      return {
        projectId,
        past: nextPast,
        future: [],
      };
    });
  },
  persistCurrentSnapshot: (projectId = getCurrentProjectId()) => {
    void projectId;
  },
  restorePersisted: (projectId) => {
    set({
      projectId,
      past: [],
      future: [],
    });
  },
  undo: () => {
    const state = get();
    const previous = state.past.at(-1);
    if (!previous) return;
    if (previous.kind === 'runtime') {
      previous.undo();
      set({
        projectId: state.projectId,
        past: state.past.slice(0, -1),
        future: [previous, ...state.future].slice(0, maxHistory),
      });
      persistHistory(state.projectId, state.past.slice(0, -1), [previous, ...state.future].slice(0, maxHistory));
      showHistoryToast('undo', previous);
      return;
    }
    const current: EditorHistoryStep = { kind: 'snapshot', label: previous.label, snapshot: cloneSnapshot(getSnapshot()) };
    const past = state.past.slice(0, -1);
    const future = [current, ...state.future].slice(0, maxHistory);
    set({ projectId: state.projectId, past, future });
    applySnapshot(previous.snapshot);
    persistHistory(state.projectId, past, future);
    showHistoryToast('undo', previous);
  },
  redo: () => {
    const state = get();
    const next = state.future[0];
    if (!next) return;
    if (next.kind === 'runtime') {
      next.redo();
      set({
        projectId: state.projectId,
        past: [...state.past, next].slice(-maxHistory),
        future: state.future.slice(1),
      });
      persistHistory(state.projectId, [...state.past, next].slice(-maxHistory), state.future.slice(1));
      showHistoryToast('redo', next);
      return;
    }
    const current: EditorHistoryStep = { kind: 'snapshot', label: next.label, snapshot: cloneSnapshot(getSnapshot()) };
    const past = [...state.past, current].slice(-maxHistory);
    const future = state.future.slice(1);
    set({ projectId: state.projectId, past, future });
    applySnapshot(next.snapshot);
    persistHistory(state.projectId, past, future);
    showHistoryToast('redo', next);
  },
  clear: () => {
    const projectId = get().projectId;
    if (projectId && typeof window !== 'undefined') window.sessionStorage.removeItem(historyStorageKey(projectId));
    set({ projectId, past: [], future: [] });
  },
}));
