import { ArrowLeft } from 'lucide-react';
import { cn } from '@/components/common/cn';

type BrandMarkProps = {
  compact?: boolean;
  className?: string;
  onBack?: () => void;
  backLabel?: string;
};

export function BrandMark({ compact = false, className, onBack, backLabel }: BrandMarkProps) {
  const icon = (
    <>
      <img
        src={`${import.meta.env.BASE_URL}li3d-brand-mark.png`}
        alt=""
        aria-hidden="true"
        className={cn(
          'h-10 w-10 object-contain drop-shadow-[0_0_16px_rgba(124,83,246,0.18)] transition duration-150',
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
    <div className={cn('flex min-w-0 items-center gap-1 rounded-lg p-0.5', className)}>
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          aria-label={backLabel ?? '返回上一页'}
          title={backLabel ?? '返回上一页'}
          className="group relative grid h-11 w-11 shrink-0 place-items-center rounded-lg outline-none transition hover:bg-white/[0.065] focus-visible:bg-white/[0.065] focus-visible:ring-2 focus-visible:ring-white/50 active:scale-[0.94]"
        >
          {icon}
        </button>
      ) : (
        <div className="relative grid h-11 w-11 shrink-0 place-items-center">{icon}</div>
      )}
      <div
        className={cn(
          'li3d-brand-copy min-w-0 select-none px-1.5 py-1 leading-none',
          compact && 'hidden sm:block',
        )}
      >
        <div className="truncate text-[17px] font-semibold tracking-[-0.02em] text-white">Li3D</div>
      </div>
    </div>
  );
}
