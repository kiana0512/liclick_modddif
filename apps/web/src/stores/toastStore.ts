import { create } from 'zustand';

export type ToastTone = 'info' | 'success' | 'warning' | 'error';

export type ToastMessage = {
  id: string;
  title: string;
  description?: string;
  tone: ToastTone;
  dedupeKey?: string;
};

type ToastStore = {
  toasts: ToastMessage[];
  pushToast: (toast: Omit<ToastMessage, 'id'>) => void;
  dismissToast: (id: string) => void;
};

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  pushToast: (toast) => {
    const id = crypto.randomUUID();
    set((state) => {
      if (
        toast.dedupeKey &&
        state.toasts.some((item) => item.dedupeKey === toast.dedupeKey)
      ) {
        return state;
      }
      return { toasts: [{ id, ...toast }, ...state.toasts].slice(0, 3) };
    });
    window.setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) }));
    }, toast.dedupeKey?.startsWith('coming-soon:') ? 3000 : 4200);
  },
  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) })),
}));
