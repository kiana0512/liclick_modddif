import type { ReactNode } from 'react';
import { cn } from '@/components/common/cn';
import { useDragInteractionStore } from '@/stores/dragInteractionStore';
import type { PanelId } from './workspacePanelTypes';
import { WorkspacePanelBody } from './WorkspacePanelBody';
import { WorkspacePanelHeader } from './WorkspacePanelHeader';

type WorkspacePanelProps = {
  title: string;
  id: PanelId;
  collapsed: boolean;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  onToggleCollapsed: () => void;
};

export function WorkspacePanel({
  title,
  id,
  collapsed,
  actions,
  children,
  className,
  onToggleCollapsed,
}: WorkspacePanelProps) {
  const draggingPanelId = useDragInteractionStore((state) => state.draggingPanelId);
  const isDragging = draggingPanelId === id;

  return (
    <section
      className={cn(
        'overflow-hidden rounded-lg border border-white/30 bg-black/88 shadow-[0_16px_46px_rgba(0,0,0,0.44)] backdrop-blur-sm transition-[border,box-shadow,opacity,transform]',
        isDragging &&
          'z-40 scale-[1.01] cursor-grabbing border-liclick-pink/55 opacity-80 shadow-[0_0_0_1px_rgba(238,77,214,0.28),0_20px_58px_rgba(158,90,255,0.35)]',
        className,
      )}
    >
      <WorkspacePanelHeader
        title={title}
        panelId={id}
        collapsed={collapsed}
        actions={actions}
        onToggleCollapsed={onToggleCollapsed}
      />
      <div
        className={cn(
          'grid transition-[grid-template-rows,opacity] duration-200 ease-out',
          collapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100',
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <WorkspacePanelBody>{children}</WorkspacePanelBody>
        </div>
      </div>
    </section>
  );
}
