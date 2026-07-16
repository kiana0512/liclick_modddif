import { create } from 'zustand';
import { createId } from '@/utils/id';

export type ToastTone = 'info' | 'success' | 'warning' | 'error';

export type ToastMessage = {
  id: string;
  title: string;
  description?: string;
  tone: ToastTone;
  dedupeKey?: string;
  durationMs?: number;
  persistent?: boolean;
};

type ToastStore = {
  toasts: ToastMessage[];
  pushToast: (toast: Omit<ToastMessage, 'id'>) => void;
  dismissToast: (id: string) => void;
  dismissToastByDedupeKey: (dedupeKey: string) => void;
};

const dismissTimers = new Map<string, number>();

function clearDismissTimer(id: string) {
  const timer = dismissTimers.get(id);
  if (timer !== undefined) window.clearTimeout(timer);
  dismissTimers.delete(id);
}

function defaultDuration(toast: Omit<ToastMessage, 'id'>) {
  if (toast.dedupeKey?.startsWith('coming-soon:')) return 3000;
  if (toast.tone === 'error') return 10_000;
  if (toast.tone === 'warning') return 7000;
  if (toast.tone === 'success') return 4200;
  return 5200;
}

export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],
  pushToast: (toast) => {
    const existing = toast.dedupeKey
      ? get().toasts.find((item) => item.dedupeKey === toast.dedupeKey)
      : undefined;
    const id = existing?.id ?? createId('toast');
    clearDismissTimer(id);
    if (!existing) {
      get()
        .toasts.slice(2)
        .forEach((item) => clearDismissTimer(item.id));
    }
    set((state) => {
      const nextToast = { id, ...toast };
      if (existing) {
        const unchanged =
          existing.title === nextToast.title &&
          existing.description === nextToast.description &&
          existing.tone === nextToast.tone &&
          existing.durationMs === nextToast.durationMs &&
          existing.persistent === nextToast.persistent;
        if (unchanged) return state;
        return {
          toasts: state.toasts.map((item) => (item.id === id ? nextToast : item)),
        };
      }
      return { toasts: [nextToast, ...state.toasts].slice(0, 3) };
    });
    if (toast.persistent) return;
    const timer = window.setTimeout(() => {
      dismissTimers.delete(id);
      set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) }));
    }, toast.durationMs ?? defaultDuration(toast));
    dismissTimers.set(id, timer);
  },
  dismissToast: (id) => {
    clearDismissTimer(id);
    set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) }));
  },
  dismissToastByDedupeKey: (dedupeKey) => {
    get()
      .toasts.filter((item) => item.dedupeKey === dedupeKey)
      .forEach((item) => clearDismissTimer(item.id));
    set((state) => ({
      toasts: state.toasts.filter((item) => item.dedupeKey !== dedupeKey),
    }));
  },
}));
