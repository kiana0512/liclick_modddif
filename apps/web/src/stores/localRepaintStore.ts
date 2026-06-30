import { create } from 'zustand';
import type { LocalRepaintRuntime } from '@/types/localRepaint';

type LocalRepaintStore = {
  runtime?: LocalRepaintRuntime;
  visible: boolean;
  activeAbortController?: AbortController;
  openRuntime: (runtime: LocalRepaintRuntime) => void;
  show: () => void;
  hide: () => void;
  updateRuntime: (patch: Partial<LocalRepaintRuntime> | ((runtime: LocalRepaintRuntime) => LocalRepaintRuntime)) => void;
  clearRuntime: () => void;
  setActiveAbortController: (controller?: AbortController) => void;
};

export const useLocalRepaintStore = create<LocalRepaintStore>((set) => ({
  runtime: undefined,
  visible: false,
  activeAbortController: undefined,
  openRuntime: (runtime) => set({ runtime, visible: true, activeAbortController: undefined }),
  show: () => set((state) => ({ visible: Boolean(state.runtime) })),
  hide: () => set({ visible: false }),
  updateRuntime: (patch) =>
    set((state) => {
      if (!state.runtime) return state;
      const runtime = typeof patch === 'function' ? patch(state.runtime) : { ...state.runtime, ...patch };
      return { runtime };
    }),
  clearRuntime: () => set({ runtime: undefined, visible: false, activeAbortController: undefined }),
  setActiveAbortController: (activeAbortController) => set({ activeAbortController }),
}));
