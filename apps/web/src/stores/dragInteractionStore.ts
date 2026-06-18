import { create } from 'zustand';

export type ActiveDragType = 'none' | 'panel' | 'model-file' | 'asset-file';

type DragInteractionStore = {
  activeDragType: ActiveDragType;
  draggingPanelId?: string;
  isPanelDragging: boolean;
  isFileDragging: boolean;
  startPanelDrag: (panelId: string) => void;
  startFileDrag: (dragType: Exclude<ActiveDragType, 'none' | 'panel'>) => void;
  clearDrag: () => void;
};

export const useDragInteractionStore = create<DragInteractionStore>((set) => ({
  activeDragType: 'none',
  draggingPanelId: undefined,
  isPanelDragging: false,
  isFileDragging: false,
  startPanelDrag: (draggingPanelId) =>
    set({
      activeDragType: 'panel',
      draggingPanelId,
      isPanelDragging: true,
      isFileDragging: false,
    }),
  startFileDrag: (activeDragType) =>
    set({
      activeDragType,
      draggingPanelId: undefined,
      isPanelDragging: false,
      isFileDragging: true,
    }),
  clearDrag: () =>
    set({
      activeDragType: 'none',
      draggingPanelId: undefined,
      isPanelDragging: false,
      isFileDragging: false,
    }),
}));
