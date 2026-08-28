import { ArrowLeft } from 'lucide-react';
import { cn } from '@/components/common/cn';
import { Li3dLogo } from '@/components/common/Li3dLogo';

type BrandMarkProps = {
  compact?: boolean;
  className?: string;
  onBack?: () => void;
  backLabel?: string;
};

export function BrandMark({ compact = false, className, onBack, backLabel }: BrandMarkProps) {
  const icon = (
    <>
      <Li3dLogo
        className={cn(
          'h-12 w-12 object-contain drop-shadow-[0_0_16px_rgba(124,83,246,0.18)] transition duration-150',
          onBack && 'group-hover:scale-75 group-hover:opacity-0 group-focus-visible:scale-75 group-focus-visible:opacity-0',
        )}
      />
      {onBack ? (
        <ArrowLeft
          aria-hidden="true"
          className="absolute h-5 w-5 translate-x-1 opacity-0 transition duration-150 group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100"
        />
      ) : null}
    </>
  );

  return (
    <div className={cn('flex min-w-0 items-center rounded-lg p-0.5', compact && 'sm:px-0.5', className)}>
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          aria-label={backLabel ?? '返回上一页'}
          title={backLabel ?? '返回上一页'}
          className="group relative grid h-12 w-12 shrink-0 place-items-center rounded-lg outline-none transition hover:bg-white/[0.065] focus-visible:bg-white/[0.065] focus-visible:ring-2 focus-visible:ring-white/50 active:scale-[0.94]"
        >
          {icon}
        </button>
      ) : (
        <div className="relative grid h-12 w-12 shrink-0 place-items-center">{icon}</div>
      )}
    </div>
  );
}
