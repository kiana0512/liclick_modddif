import { cn } from '@/components/common/cn';

export function BrandMark({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <div className={cn('flex min-w-0 items-center gap-2.5', className)}>
      <img
        src={`${import.meta.env.BASE_URL}li3d-brand-mark.png`}
        alt=""
        aria-hidden="true"
        className="h-10 w-10 shrink-0 object-contain drop-shadow-[0_0_16px_rgba(124,83,246,0.18)]"
      />
      <div className={cn('li3d-brand-copy min-w-0 leading-none', compact && 'hidden sm:block')}>
        <div className="truncate text-[15px] font-semibold tracking-[-0.02em] text-white">LIclick 3D Texture</div>
        <div className="mt-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/38">LI3D</div>
      </div>
    </div>
  );
}
