import type { ReactNode } from 'react';
import { cn } from './cn';

type IconTooltipProps = {
  label: string;
  description?: string;
  shortcut?: string;
  children: ReactNode;
  side?: 'top' | 'bottom';
  className?: string;
};

export function IconTooltip({ label, description, shortcut, children, side = 'top', className }: IconTooltipProps) {
  return (
    <span className={cn('group relative inline-flex', className)}>
      {children}
      <span
        className={cn(
          'pointer-events-none absolute left-1/2 z-50 w-max max-w-64 -translate-x-1/2 rounded-md border border-white/12 bg-black/92 px-2.5 py-1.5 text-left text-[11px] text-white opacity-0 shadow-[0_14px_34px_rgba(0,0,0,0.42)] backdrop-blur transition group-hover:opacity-100 group-focus-within:opacity-100',
          side === 'top' ? 'bottom-full mb-2' : 'top-full mt-2',
        )}
      >
        <span className="flex items-center gap-2 whitespace-nowrap font-semibold">
          <span>{label}</span>
          {shortcut && (
            <span className="rounded bg-white/16 px-1.5 py-0.5 text-[10px] font-semibold text-white/76">
              {shortcut}
            </span>
          )}
        </span>
        {description && <span className="mt-1 block max-w-56 whitespace-normal leading-4 text-white/58">{description}</span>}
      </span>
    </span>
  );
}
