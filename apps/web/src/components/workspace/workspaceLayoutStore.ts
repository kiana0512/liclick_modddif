import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { DockSide, PanelId, WorkspaceMode, WorkspacePanelState } from './workspacePanelTypes';

export const defaultWorkspacePanels: WorkspacePanelState[] = [
  { id: 'objects', title: 'Objects', dock: 'left', order: 5, collapsed: false, visible: true, mode: 'all' },
  { id: 'generate', title: 'Generate', dock: 'left', order: 40, collapsed: true, visible: true, mode: 'texture' },
  { id: 'viewport', title: 'Viewport', dock: 'right', order: 20, collapsed: true, visible: true, mode: 'all' },
  { id: 'referenceImages', title: 'Reference Images', dock: 'right', order: 30, collapsed: false, visible: true, mode: 'scene' },
  {
    id: 'objectTransform',
    title: 'Object Transform',
    dock: 'right',
    order: 35,
    collapsed: true,
    visible: false,
    mode: 'scene',
  },
  { id: 'layers', title: 'Layers', dock: 'right', order: 30, collapsed: true, visible: true, mode: 'texture' },
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

type PersistedWorkspaceLayoutState = Pick<
  WorkspaceLayoutStore,
  'mode' | 'dockDensity' | 'panels'
>;

const workspaceModes = new Set<WorkspaceMode>(['scene', 'texture', 'normal', 'export']);
const defaultPanelById = new Map(defaultWorkspacePanels.map((panel) => [panel.id, panel]));

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * Keep layouts saved before the segments workspace was removed usable.
 *
 * Deleted panels are discarded while the mask painting engine remains
 * available to local repair tools and keyboard shortcuts.
 */
export function migrateWorkspaceLayoutState(
  persistedState: unknown,
): PersistedWorkspaceLayoutState {
  const stored = isRecord(persistedState) ? persistedState : {};
  const storedPanels = Array.isArray(stored.panels) ? stored.panels : [];
  const migratedPanels = storedPanels.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.id !== 'string') return [];
    if (candidate.id === 'segments' || candidate.id === 'quickMask') return [];
    const fallback = defaultPanelById.get(candidate.id as WorkspacePanelState['id']);
    if (!fallback) return [];
    let mode = fallback.mode;
    if (candidate.mode === 'all') mode = 'all';
    else if (candidate.mode === 'segments') mode = 'texture';
    else if (
      typeof candidate.mode === 'string' &&
      workspaceModes.has(candidate.mode as WorkspaceMode)
    ) {
      mode = candidate.mode as WorkspaceMode;
    }
    return [
      {
        ...fallback,
        ...candidate,
        id: fallback.id,
        title: typeof candidate.title === 'string' ? candidate.title : fallback.title,
        dock: candidate.dock === 'left' || candidate.dock === 'right' ? candidate.dock : fallback.dock,
        order: typeof candidate.order === 'number' ? candidate.order : fallback.order,
        collapsed:
          typeof candidate.collapsed === 'boolean' ? candidate.collapsed : fallback.collapsed,
        visible: typeof candidate.visible === 'boolean' ? candidate.visible : fallback.visible,
        mode,
      } satisfies WorkspacePanelState,
    ];
  });
  const migratedIds = new Set(migratedPanels.map((panel) => panel.id));
  const panels = [
    ...migratedPanels,
    ...defaultWorkspacePanels
      .filter((panel) => !migratedIds.has(panel.id))
      .map((panel) => ({ ...panel })),
  ];
  const storedMode = stored.mode === 'segments' ? 'texture' : stored.mode;

  return {
    mode:
      typeof storedMode === 'string' && workspaceModes.has(storedMode as WorkspaceMode)
        ? (storedMode as WorkspaceMode)
        : 'scene',
    dockDensity: stored.dockDensity === 'compact' ? 'compact' : 'normal',
    panels,
  };
}

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
      mode: 'scene',
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
      resetWorkspaceLayout: () => set({ mode: 'scene', panels: defaultWorkspacePanels }),
      setMode: (mode) => set({ mode }),
    }),
    {
      name: 'liclick-workspace-layout-v2',
      version: 3,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ mode: state.mode, dockDensity: state.dockDensity, panels: state.panels }),
      migrate: (persistedState) => migrateWorkspaceLayoutState(persistedState),
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...migrateWorkspaceLayoutState(persistedState),
      }),
    },
  ),
);
