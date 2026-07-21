import type { ReactNode } from 'react';
import { cn } from '@/components/common/cn';

export function WorkflowPanel({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        'rounded-xl border border-white/10 bg-[#151729]/92 shadow-[0_18px_48px_rgba(0,0,0,0.2)]',
        className,
      )}
      aria-label={title}
    >
      <header className="flex min-h-14 items-center justify-between gap-3 border-b border-white/8 px-5 py-4">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold tracking-[-0.01em] text-white/94">{title}</h2>
          {description ? <p className="mt-1 text-xs leading-5 text-white/44">{description}</p> : null}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}
