import type { ReactNode } from 'react';
import { cn } from './cn';

type IconTooltipProps = {
  label: string;
  children: ReactNode;
  side?: 'top' | 'bottom';
  className?: string;
};

export function IconTooltip({ label, children, side = 'top', className }: IconTooltipProps) {
  return (
    <span className={cn('group relative inline-flex', className)}>
      {children}
      <span
        className={cn(
          'pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded bg-black/88 px-2 py-1 text-[11px] font-medium text-white opacity-0 shadow-lg transition group-hover:opacity-100',
          side === 'top' ? 'bottom-full mb-2' : 'top-full mt-2',
        )}
      >
        {label}
      </span>
    </span>
  );
}
