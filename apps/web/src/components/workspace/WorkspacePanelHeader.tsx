import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { DragEvent } from 'react';
import { ChevronDown, ChevronRight, GripVertical } from 'lucide-react';
import { useDragInteractionStore } from '@/stores/dragInteractionStore';
import type { PanelId } from './workspacePanelTypes';

type WorkspacePanelHeaderProps = {
  title: string;
  collapsed: boolean;
  actions?: ReactNode;
  panelId: PanelId;
  onToggleCollapsed: () => void;
};

export function WorkspacePanelHeader({
  title,
  collapsed,
  actions,
  panelId,
  onToggleCollapsed,
}: WorkspacePanelHeaderProps) {
  const Icon = collapsed ? ChevronRight : ChevronDown;
  const [dragEnabled, setDragEnabled] = useState(false);
  const startPanelDrag = useDragInteractionStore((state) => state.startPanelDrag);
  const clearDrag = useDragInteractionStore((state) => state.clearDrag);

  useEffect(() => {
    const updateDragEnabled = () => setDragEnabled(window.matchMedia('(min-width: 1024px)').matches);
    updateDragEnabled();
    window.addEventListener('resize', updateDragEnabled);
    return () => window.removeEventListener('resize', updateDragEnabled);
  }, []);

  function handleDragStart(event: DragEvent<HTMLDivElement>) {
    if (!dragEnabled) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData('application/liclick-panel-id', panelId);
    event.dataTransfer.effectAllowed = 'move';
    startPanelDrag(panelId);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onToggleCollapsed();
  }

  return (
    <div
      role="button"
      tabIndex={0}
      draggable={dragEnabled}
      onClick={onToggleCollapsed}
      onKeyDown={handleKeyDown}
      onDragStart={handleDragStart}
      onDragEnd={clearDrag}
      className="flex min-h-9 cursor-grab items-center gap-1 border-b border-white/24 px-2 py-1.5 transition hover:bg-white/[0.04] active:cursor-grabbing"
      title={collapsed ? 'Expand panel' : 'Collapse panel'}
    >
      <span
        className="grid h-7 w-7 place-items-center rounded text-white/72"
        aria-hidden="true"
      >
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1 truncate text-base font-semibold normal-case tracking-normal text-white/88">
        {title}
      </div>
      <div className="contents" onClick={(event) => event.stopPropagation()}>
        {actions}
      </div>
      <span
        className="grid h-7 w-6 place-items-center rounded text-white/44"
        aria-hidden="true"
      >
        <GripVertical className="h-4 w-4" />
      </span>
    </div>
  );
}
