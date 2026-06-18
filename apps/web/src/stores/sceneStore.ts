import { create } from 'zustand';
import type { DisplayMode, ProjectionMode, SceneObject } from '@/types/model';

type SceneStore = {
  objects: SceneObject[];
  selectedObjectId?: string;
  displayMode: DisplayMode;
  projectionMode: ProjectionMode;
  setObjects: (objects: SceneObject[]) => void;
  selectObject: (objectId?: string) => void;
  setDisplayMode: (mode: DisplayMode) => void;
  setProjectionMode: (mode: ProjectionMode) => void;
};

export const useSceneStore = create<SceneStore>((set) => ({
  objects: [],
  selectedObjectId: undefined,
  displayMode: 'pbr',
  projectionMode: 'perspective',
  setObjects: (objects) =>
    set({
      objects,
      selectedObjectId: objects.find((object) => object.selected)?.id ?? objects[0]?.id,
    }),
  selectObject: (objectId) =>
    set((state) => ({
      selectedObjectId: objectId,
      objects: state.objects.map((object) => ({ ...object, selected: object.id === objectId })),
    })),
  setDisplayMode: (displayMode) => set({ displayMode }),
  setProjectionMode: (projectionMode) => set({ projectionMode }),
}));
