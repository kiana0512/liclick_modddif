export type AutoBakeProgress = {
  title: string;
  detail: string;
  progress: number;
};

export function AutoBakeProgressBar({ progress }: { progress: AutoBakeProgress }) {
  const percentage = Math.round(progress.progress * 100);

  return (
    <div className="fixed left-1/2 top-4 z-[119] w-[min(520px,calc(100vw-32px))] -translate-x-1/2 rounded-md border border-white/16 bg-[#141725]/94 p-3 text-white shadow-[0_18px_58px_rgba(0,0,0,0.48)] backdrop-blur">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold">{progress.title}</div>
          <div className="mt-0.5 truncate text-xs text-white/66">{progress.detail}</div>
        </div>
        <div className="shrink-0 text-xs font-semibold text-white/80">{percentage}%</div>
      </div>
      <div
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/12"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percentage}
      >
        <div
          className="h-full rounded-full bg-gradient-to-r from-[#ff5ccf] to-[#8f5cff] transition-[width] duration-150"
          style={{ width: `${Math.max(3, percentage)}%` }}
        />
      </div>
    </div>
  );
}
