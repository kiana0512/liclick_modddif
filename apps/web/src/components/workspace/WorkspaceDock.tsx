import { useState } from 'react';
import { cn } from '@/components/common/cn';
import { useDragInteractionStore } from '@/stores/dragInteractionStore';
import { useWorkspaceLayoutStore } from './workspaceLayoutStore';
import type { DockSide, PanelId, WorkspacePanelDefinition } from './workspacePanelTypes';
import { WorkspacePanel } from './WorkspacePanel';

type WorkspaceDockProps = {
  side: DockSide;
  panels: WorkspacePanelDefinition[];
  compactHidden?: boolean;
  onRequestOpen?: () => void;
};

export function WorkspaceDock({ side, panels, compactHidden, onRequestOpen }: WorkspaceDockProps) {
  const [isDropTarget, setIsDropTarget] = useState(false);
  const mode = useWorkspaceLayoutStore((state) => state.mode);
  const togglePanelCollapsed = useWorkspaceLayoutStore((state) => state.togglePanelCollapsed);
  const reorderPanel = useWorkspaceLayoutStore((state) => state.reorderPanel);
  const isPanelDragging = useDragInteractionStore((state) => state.isPanelDragging);
  const clearDrag = useDragInteractionStore((state) => state.clearDrag);
  const matchingPanels = panels
    .filter((panel) => panel.visible && (panel.mode === 'all' || panel.mode === mode))
    .sort((a, b) => a.order - b.order);
  const allPanelsCollapsed = matchingPanels.length > 0 && matchingPanels.every((panel) => panel.collapsed);

  if (matchingPanels.length === 0) return null;

  return (
    <aside
      onDragEnter={(event) => {
        if (!isPanelDragging) return;
        event.preventDefault();
        setIsDropTarget(true);
      }}
      onDragOver={(event) => {
        if (!isPanelDragging) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setIsDropTarget(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDropTarget(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setIsDropTarget(false);
        const panelId = event.dataTransfer.getData('application/liclick-panel-id') as PanelId;
        if (panelId) reorderPanel(panelId, side);
        clearDrag();
      }}
      className={cn(
        'pointer-events-none absolute bottom-[var(--workspace-bottom-offset)] z-20 hidden max-h-[calc(100%-var(--workspace-top-offset)-var(--workspace-bottom-offset))] flex-col justify-end rounded-lg border border-transparent transition-[border,background,box-shadow] lg:flex',
        side === 'left' ? 'left-3' : 'right-3',
        side === 'left' && 'w-[var(--dock-left-width)]',
        side === 'right' && 'w-[var(--dock-right-width)]',
        isPanelDragging && 'pointer-events-auto',
        isDropTarget && 'border-liclick-pink/70 bg-liclick-purple/10 shadow-glow',
        compactHidden && 'lg:flex',
      )}
    >
      <div
        className={cn(
          'pointer-events-auto flex max-h-full flex-col gap-2 overflow-x-hidden rounded-lg p-1 overscroll-contain [scrollbar-gutter:stable]',
          allPanelsCollapsed ? 'overflow-y-visible' : 'overflow-y-auto',
        )}
        onWheel={(event) => {
          if (allPanelsCollapsed) return;
          event.stopPropagation();
        }}
      >
        {matchingPanels.map((panel) => (
          <div
            key={panel.id}
            className="pointer-events-auto"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setIsDropTarget(false);
              const panelId = event.dataTransfer.getData('application/liclick-panel-id') as PanelId;
              if (panelId && panelId !== panel.id) reorderPanel(panelId, side, panel.id);
              clearDrag();
            }}
          >
            <WorkspacePanel
              id={panel.id}
              title={panel.title}
              collapsed={panel.collapsed}
              actions={panel.actions}
              onToggleCollapsed={() => togglePanelCollapsed(panel.id)}
            >
              {panel.content}
            </WorkspacePanel>
          </div>
        ))}
      </div>
      {compactHidden && (
        <button type="button" className="sr-only" onClick={onRequestOpen}>
          Open {side} dock
        </button>
      )}
    </aside>
  );
}
