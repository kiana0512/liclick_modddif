import { X } from 'lucide-react';
import { cn } from '@/components/common/cn';
import { useToastStore, type ToastTone } from '@/stores/toastStore';

const tones: Record<ToastTone, string> = {
  info: 'border-white/14 bg-[#171a30] text-white',
  success: 'border-emerald-300/30 bg-[#12352a] text-emerald-50',
  warning: 'border-amber-300/34 bg-[#3a2a12] text-amber-50',
  error: 'border-rose-300/34 bg-[#3a1420] text-rose-50',
};

export function ToastHost() {
  const toasts = useToastStore((state) => state.toasts);
  const dismissToast = useToastStore((state) => state.dismissToast);

  return (
    <div className="pointer-events-none fixed left-1/2 top-4 z-[120] flex w-[min(420px,calc(100vw-32px))] -translate-x-1/2 flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={cn('pointer-events-auto rounded-md border p-3 shadow-[0_18px_58px_rgba(0,0,0,0.42)]', tones[toast.tone])}
        >
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold">{toast.title}</div>
              {toast.description && (
                <div className="mt-1 text-xs leading-5 opacity-72">{toast.description}</div>
              )}
            </div>
            <button
              type="button"
              onClick={() => dismissToast(toast.id)}
              className="grid h-6 w-6 shrink-0 place-items-center rounded-md hover:bg-white/10"
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
