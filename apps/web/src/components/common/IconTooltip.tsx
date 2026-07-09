import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn';

type IconTooltipProps = {
  label: string;
  description?: string;
  shortcut?: string;
  children: ReactNode;
  side?: 'top' | 'bottom';
  className?: string;
  disabled?: boolean;
};

export function IconTooltip({ label, description, shortcut, children, side = 'top', className, disabled }: IconTooltipProps) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const left = Math.max(12, Math.min(window.innerWidth - 12, rect.left + rect.width / 2));
    setPosition({
      left,
      top: side === 'top' ? rect.top - 8 : rect.bottom + 8,
    });
  }, [side]);

  const show = useCallback(() => {
    updatePosition();
    setOpen(true);
  }, [updatePosition]);

  useEffect(() => {
    if (!open) return undefined;
    updatePosition();
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [open, updatePosition]);

  return (
    <span
      ref={anchorRef}
      className={cn('inline-flex', className)}
      onPointerEnter={show}
      onPointerLeave={() => setOpen(false)}
      onFocus={show}
      onBlur={() => setOpen(false)}
    >
      {children}
      {!disabled && open && typeof document !== 'undefined' && createPortal(
        <span
          className={cn(
            'pointer-events-none fixed z-[10000] w-max max-w-64 rounded-md border border-white/12 bg-black/94 px-2.5 py-1.5 text-left text-[11px] text-white opacity-100 shadow-[0_14px_34px_rgba(0,0,0,0.48)] backdrop-blur',
          )}
          style={{
            left: position.left,
            top: position.top,
            transform: side === 'top' ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
          }}
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
        </span>,
        document.body,
      )}
    </span>
  );
}
