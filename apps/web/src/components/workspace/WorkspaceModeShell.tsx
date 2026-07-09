import type { ReactNode } from 'react';
import { Info } from 'lucide-react';
import { cn } from '@/components/common/cn';

type WorkspaceModeShellProps = {
  title: string;
  description: string;
  children?: ReactNode;
  tone?: 'info' | 'warning';
};

export function WorkspaceModeShell({
  title,
  description,
  children,
  tone = 'info',
}: WorkspaceModeShellProps) {
  return (
    <div
      className={cn(
        'rounded-md border p-3 text-sm leading-5',
        tone === 'warning'
          ? 'border-amber-300/18 bg-amber-400/10 text-amber-50/82'
          : 'border-white/10 bg-white/[0.045] text-white/64',
      )}
    >
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-white/58">
        <Info className="h-3.5 w-3.5 text-liclick-pink" />
        {title}
      </div>
      <div className="mt-2">{description}</div>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}
