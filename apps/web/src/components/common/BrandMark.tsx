import { cn } from '@/components/common/cn';

function openHome() {
  const baseUrl = import.meta.env.BASE_URL || '/';
  const homePath = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  if (window.location.pathname !== homePath) {
    window.history.pushState({ name: 'home' }, '', homePath);
  }
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function BrandMark({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-1 rounded-lg p-0.5',
        className,
      )}
    >
      <button
        type="button"
        onClick={() => window.history.back()}
        aria-label="返回上一步"
        title="点击图标返回上一步"
        className="group grid h-11 w-11 shrink-0 place-items-center rounded-lg outline-none transition hover:bg-white/[0.065] focus-visible:ring-2 focus-visible:ring-white/50 active:scale-[0.94]"
      >
        <img
          src={`${import.meta.env.BASE_URL}li3d-brand-mark.png`}
          alt=""
          aria-hidden="true"
          className="h-10 w-10 object-contain drop-shadow-[0_0_16px_rgba(124,83,246,0.18)] transition duration-200 group-hover:-translate-x-0.5 group-hover:drop-shadow-[0_0_20px_rgba(124,83,246,0.42)]"
        />
      </button>

      <button
        type="button"
        onDoubleClick={openHome}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openHome();
          }
        }}
        aria-label="双击返回功能首页"
        title="双击文字返回功能首页"
        className={cn(
          'li3d-brand-copy min-w-0 select-none rounded-md px-1.5 py-1 text-left leading-none outline-none transition hover:bg-white/[0.045] focus-visible:ring-2 focus-visible:ring-white/50 active:bg-white/[0.07]',
          compact && 'hidden sm:block',
        )}
      >
        <div className="truncate text-[17px] font-semibold tracking-[-0.02em] text-white">Li3D</div>
      </button>
    </div>
  );
}
