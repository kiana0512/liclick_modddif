import { create } from 'zustand';

type Resolution = '1K' | '2K' | '4K';

type SettingsStore = {
  resolution: Resolution;
  setResolution: (resolution: Resolution) => void;
};

export const useSettingsStore = create<SettingsStore>((set) => ({
  resolution: '2K',
  setResolution: (resolution) => set({ resolution }),
}));
