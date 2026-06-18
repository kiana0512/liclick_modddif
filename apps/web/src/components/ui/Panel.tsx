import type { ReactNode } from 'react';
import { cn } from '@/components/common/cn';

type PanelProps = {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
};

export function Panel({ title, action, children, className }: PanelProps) {
  return (
    <section className={cn('space-y-2', className)} aria-label={title}>
      {action && <div className="flex justify-end">{action}</div>}
      {children}
    </section>
  );
}
