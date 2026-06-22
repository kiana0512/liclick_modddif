import type { ReactNode } from 'react';
import { cn } from '@/components/common/cn';

type WorkspacePanelBodyProps = {
  children: ReactNode;
  className?: string;
};

export function WorkspacePanelBody({ children, className }: WorkspacePanelBodyProps) {
  return <div className={cn('scrollbar-none max-h-[calc(100vh-168px)] overflow-y-auto p-2', className)}>{children}</div>;
}
