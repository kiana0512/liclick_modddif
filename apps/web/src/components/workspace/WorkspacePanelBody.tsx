import type { ReactNode } from 'react';
import { cn } from '@/components/common/cn';

type WorkspacePanelBodyProps = {
  children: ReactNode;
  className?: string;
  scrollable?: boolean;
};

export function WorkspacePanelBody({
  children,
  className,
  scrollable = true,
}: WorkspacePanelBodyProps) {
  return (
    <div
      className={cn(
        'p-2',
        scrollable
          ? 'scrollbar-none max-h-[calc(100vh-168px)] overflow-y-auto'
          : 'h-full min-h-0 overflow-hidden',
        className,
      )}
    >
      {children}
    </div>
  );
}
