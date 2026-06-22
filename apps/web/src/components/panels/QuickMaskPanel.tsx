import { Info, Minus, Scan, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/components/common/cn';
import { useT } from '@/stores/i18nStore';

export function QuickMaskPanel() {
  const t = useT();

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-2">
        <MaskToolButton active title={t('maskAdd')}>
          <Scan className="h-5 w-5" />
        </MaskToolButton>
        <MaskToolButton title={t('maskSubtract')}>
          <Minus className="h-5 w-5" />
        </MaskToolButton>
        <MaskToolButton title={t('delete')}>
          <Trash2 className="h-5 w-5" />
        </MaskToolButton>
      </div>
      <button
        type="button"
        className="h-12 w-full rounded-md bg-gradient-to-r from-liclick-pink to-liclick-purple text-base font-semibold text-white shadow-glow transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-55"
        disabled
      >
        {t('isolate')}
      </button>
    </div>
  );
}

export function QuickMaskPanelActions() {
  const t = useT();
  return (
    <button
      type="button"
      className="grid h-7 w-7 place-items-center rounded text-white transition hover:bg-liclick-pink/18 hover:text-liclick-pink"
      title={t('quickMask')}
      aria-label={t('quickMask')}
    >
      <Info className="h-4 w-4" />
    </button>
  );
}

function MaskToolButton({
  active,
  title,
  children,
}: {
  active?: boolean;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className={cn(
        'grid h-11 place-items-center rounded-md border border-white/24 bg-black/34 text-white transition hover:border-liclick-pink/70 hover:text-liclick-pink',
        active && 'border-liclick-pink bg-liclick-pink/14 text-liclick-pink shadow-glow',
      )}
    >
      {children}
    </button>
  );
}
