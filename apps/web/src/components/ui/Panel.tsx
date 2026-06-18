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
    <section className={cn('border-b border-white/10 px-3 py-3', className)}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-white/54">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
