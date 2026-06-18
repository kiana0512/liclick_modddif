import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { DockSide, PanelId, WorkspaceMode, WorkspacePanelState } from './workspacePanelTypes';

export const defaultWorkspacePanels: WorkspacePanelState[] = [
  { id: 'segments', title: 'Segments', dock: 'left', order: 10, collapsed: true, visible: true, mode: 'texture' },
  { id: 'quickMask', title: 'Quick Mask', dock: 'left', order: 20, collapsed: true, visible: true, mode: 'texture' },
  { id: 'objects', title: 'Objects', dock: 'left', order: 30, collapsed: true, visible: true, mode: 'texture' },
  { id: 'generate', title: 'Generate', dock: 'left', order: 40, collapsed: false, visible: true, mode: 'texture' },
  { id: 'references', title: 'References', dock: 'left', order: 50, collapsed: true, visible: true, mode: 'texture' },
  {
    id: 'layerAdjustments',
    title: 'Layer Adjustments',
    dock: 'right',
    order: 10,
    collapsed: false,
    visible: true,
    mode: 'texture',
  },
  { id: 'viewport', title: 'Viewport', dock: 'right', order: 20, collapsed: false, visible: true, mode: 'texture' },
  { id: 'layers', title: 'Layers', dock: 'right', order: 30, collapsed: false, visible: true, mode: 'texture' },
  {
    id: 'objectTransform',
    title: 'Object Transform',
    dock: 'right',
    order: 40,
    collapsed: true,
    visible: false,
    mode: 'texture',
  },
  {
    id: 'normalVisualizer',
    title: 'Normal Visualizer',
    dock: 'left',
    order: 10,
    collapsed: false,
    visible: true,
    mode: 'normal',
  },
  {
    id: 'normalGeneration',
    title: 'Normal Generation',
    dock: 'right',
    order: 10,
    collapsed: true,
    visible: true,
    mode: 'normal',
  },
  { id: 'export', title: 'Export', dock: 'right', order: 10, collapsed: false, visible: true, mode: 'export' },
];

type WorkspaceLayoutStore = {
  mode: WorkspaceMode;
  dockDensity: 'compact' | 'normal';
  panels: WorkspacePanelState[];
  setDockDensity: (dockDensity: 'compact' | 'normal') => void;
  togglePanelCollapsed: (panelId: PanelId) => void;
  setPanelCollapsed: (panelId: PanelId, collapsed: boolean) => void;
  showPanel: (panelId: PanelId) => void;
  hidePanel: (panelId: PanelId) => void;
  movePanel: (panelId: PanelId, dock: DockSide, order: number) => void;
  reorderPanel: (panelId: PanelId, dock: DockSide, beforePanelId?: PanelId) => void;
  resetWorkspaceLayout: () => void;
  setMode: (mode: WorkspaceMode) => void;
};

function updatePanel(
  panels: WorkspacePanelState[],
  panelId: PanelId,
  patch: Partial<WorkspacePanelState>,
) {
  return panels.map((panel) => (panel.id === panelId ? { ...panel, ...patch } : panel));
}

export const useWorkspaceLayoutStore = create<WorkspaceLayoutStore>()(
  persist(
    (set) => ({
      mode: 'texture',
      dockDensity: 'normal',
      panels: defaultWorkspacePanels,
      setDockDensity: (dockDensity) => set({ dockDensity }),
      togglePanelCollapsed: (panelId) =>
        set((state) => ({
          panels: state.panels.map((panel) =>
            panel.id === panelId ? { ...panel, collapsed: !panel.collapsed } : panel,
          ),
        })),
      setPanelCollapsed: (panelId, collapsed) =>
        set((state) => ({ panels: updatePanel(state.panels, panelId, { collapsed }) })),
      showPanel: (panelId) => set((state) => ({ panels: updatePanel(state.panels, panelId, { visible: true }) })),
      hidePanel: (panelId) => set((state) => ({ panels: updatePanel(state.panels, panelId, { visible: false }) })),
      movePanel: (panelId, dock, order) =>
        set((state) => ({ panels: updatePanel(state.panels, panelId, { dock, order }) })),
      reorderPanel: (panelId, dock, beforePanelId) =>
        set((state) => {
          const movingPanel = state.panels.find((panel) => panel.id === panelId);
          if (!movingPanel) return state;
          const withoutMoving = state.panels.filter((panel) => panel.id !== panelId);
          const targetDockPanels = withoutMoving
            .filter((panel) => panel.dock === dock)
            .sort((a, b) => a.order - b.order);
          const insertIndex = beforePanelId
            ? Math.max(
                0,
                targetDockPanels.findIndex((panel) => panel.id === beforePanelId),
              )
            : targetDockPanels.length;
          const nextDockPanels = [
            ...targetDockPanels.slice(0, insertIndex),
            { ...movingPanel, dock },
            ...targetDockPanels.slice(insertIndex),
          ].map((panel, index) => ({ ...panel, order: (index + 1) * 10 }));
          const nextDockIds = new Set(nextDockPanels.map((panel) => panel.id));
          return {
            panels: [
              ...withoutMoving.filter((panel) => panel.dock !== dock && !nextDockIds.has(panel.id)),
              ...nextDockPanels,
            ],
          };
        }),
      resetWorkspaceLayout: () => set({ mode: 'texture', panels: defaultWorkspacePanels }),
      setMode: (mode) =>
        set((state) => ({
          mode,
          panels: state.panels.map((panel) => {
            if (mode === 'texture') {
              if (
                panel.id === 'generate' ||
                panel.id === 'layerAdjustments' ||
                panel.id === 'viewport' ||
                panel.id === 'layers'
              ) {
                return { ...panel, collapsed: false };
              }
              if (
                panel.id === 'segments' ||
                panel.id === 'quickMask' ||
                panel.id === 'objects' ||
                panel.id === 'references' ||
                panel.id === 'objectTransform'
              ) {
                return { ...panel, collapsed: true };
              }
            }
            if (mode === 'normal') {
              if (panel.id === 'normalVisualizer') return { ...panel, collapsed: false };
              if (panel.id === 'normalGeneration') return { ...panel, collapsed: true };
            }
            if (mode === 'segments') {
              if (panel.id === 'quickMask') return { ...panel, collapsed: false };
              if (panel.id === 'segments') return { ...panel, collapsed: true };
            }
            return panel;
          }),
        })),
    }),
    {
      name: 'liclick-workspace-layout-v1',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ mode: state.mode, dockDensity: state.dockDensity, panels: state.panels }),
    },
  ),
);
