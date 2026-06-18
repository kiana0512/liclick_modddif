import { create } from 'zustand';

export type ToastTone = 'info' | 'success' | 'warning' | 'error';

export type ToastMessage = {
  id: string;
  title: string;
  description?: string;
  tone: ToastTone;
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
    set((state) => ({ toasts: [{ id, ...toast }, ...state.toasts].slice(0, 4) }));
    window.setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) }));
    }, 4600);
  },
  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) })),
}));
