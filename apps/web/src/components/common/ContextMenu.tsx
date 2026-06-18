import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MoreVertical } from 'lucide-react';
import { cn } from './cn';

export type ContextMenuItem = {
  id: string;
  label: string;
  tone?: 'default' | 'danger';
  onSelect: () => void;
};

export function ContextMenu({
  items,
  label = 'Open menu',
  className,
}: {
  items: ContextMenuItem[];
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, []);

  return (
    <div ref={rootRef} className={cn('relative', className)} onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        aria-label={label}
        onClick={() => setOpen((current) => !current)}
        className="grid h-8 w-8 place-items-center rounded-full text-white/72 transition hover:bg-black/34 hover:text-white"
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-40 min-w-40 rounded-md border border-white/10 bg-[#1d1d1d] p-1 shadow-[0_18px_45px_rgba(0,0,0,0.5)]">
          {items.map((item) => (
            <button
              type="button"
              key={item.id}
              onClick={() => {
                item.onSelect();
                setOpen(false);
              }}
              className={cn(
                'block w-full rounded px-3 py-2 text-left text-sm transition hover:bg-white/10',
                item.tone === 'danger' ? 'text-rose-200 hover:text-rose-100' : 'text-white/86 hover:text-white',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ModalShell({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/56 px-4 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-white/12 bg-[#151515] p-4 shadow-[0_24px_70px_rgba(0,0,0,0.56)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
