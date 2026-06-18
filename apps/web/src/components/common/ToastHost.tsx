import { X } from 'lucide-react';
import { cn } from '@/components/common/cn';
import { useToastStore, type ToastTone } from '@/stores/toastStore';

const tones: Record<ToastTone, string> = {
  info: 'border-white/12 bg-[#171a30] text-white',
  success: 'border-emerald-300/20 bg-emerald-500/12 text-emerald-50',
  warning: 'border-amber-300/24 bg-amber-500/14 text-amber-50',
  error: 'border-rose-300/24 bg-rose-500/14 text-rose-50',
};

export function ToastHost() {
  const toasts = useToastStore((state) => state.toasts);
  const dismissToast = useToastStore((state) => state.dismissToast);

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-50 flex w-[min(360px,calc(100vw-32px))] flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={cn('pointer-events-auto rounded-lg border p-3 shadow-glow backdrop-blur', tones[toast.tone])}
        >
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">{toast.title}</div>
              {toast.description && (
                <div className="mt-1 text-xs leading-5 opacity-72">{toast.description}</div>
              )}
            </div>
            <button
              type="button"
              onClick={() => dismissToast(toast.id)}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-md hover:bg-white/10"
              title="Dismiss"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
