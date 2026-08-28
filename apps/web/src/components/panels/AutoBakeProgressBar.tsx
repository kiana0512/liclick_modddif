export type AutoBakeProgress = {
  title: string;
  detail: string;
  progress: number;
  indeterminate?: boolean;
};

export function AutoBakeProgressBar({
  progress,
  onCancel,
  cancelling = false,
}: {
  progress: AutoBakeProgress;
  onCancel?: () => void;
  cancelling?: boolean;
}) {
  const percentage = Math.round(Math.min(1, Math.max(0, progress.progress)) * 100);

  return (
    <div
      className="fixed left-1/2 top-4 z-[119] w-[min(520px,calc(100vw-32px))] -translate-x-1/2 rounded-md border border-white/16 bg-[#141725]/94 p-3 text-white shadow-[0_18px_58px_rgba(0,0,0,0.48)] backdrop-blur"
      aria-live="polite"
      aria-atomic="true"
      aria-busy={progress.indeterminate}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold">{progress.title}</div>
          <div className="mt-0.5 truncate text-xs text-white/66">{progress.detail}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="text-xs font-semibold text-white/80">
            {progress.indeterminate ? '…' : `${percentage}%`}
          </div>
          {onCancel ? (
            <button
              type="button"
              className="h-7 rounded border border-red-300/32 bg-red-500/16 px-3 text-xs font-semibold text-red-100 transition-colors hover:bg-red-500/24 disabled:cursor-wait disabled:opacity-60"
              onClick={onCancel}
              disabled={cancelling}
              aria-label="中断当前任务"
            >
              {cancelling ? '中断中…' : '中断'}
            </button>
          ) : null}
        </div>
      </div>
      <div
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/12"
        role="progressbar"
        aria-label={progress.title}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.indeterminate ? undefined : percentage}
        aria-valuetext={progress.detail}
      >
        <div
          className={`h-full rounded-full bg-gradient-to-r from-[#ff5ccf] to-[#8f5cff] transition-[width] duration-150 ${
            progress.indeterminate ? 'animate-pulse' : ''
          }`}
          style={{ width: `${Math.max(3, percentage)}%` }}
        />
      </div>
    </div>
  );
}
