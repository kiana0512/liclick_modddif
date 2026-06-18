import { create } from 'zustand';

type Resolution = '1K' | '2K' | '4K';
export type EnvironmentPreset = 'color' | 'studio' | 'soft' | 'dark';

type SettingsStore = {
  resolution: Resolution;
  exposure: number;
  environmentPreset: EnvironmentPreset;
  setResolution: (resolution: Resolution) => void;
  setExposure: (exposure: number) => void;
  setEnvironmentPreset: (environmentPreset: EnvironmentPreset) => void;
  resetViewportLighting: () => void;
};

export const useSettingsStore = create<SettingsStore>((set) => ({
  resolution: '2K',
  exposure: 1.15,
  environmentPreset: 'studio',
  setResolution: (resolution) => set({ resolution }),
  setExposure: (exposure) => set({ exposure }),
  setEnvironmentPreset: (environmentPreset) => set({ environmentPreset }),
  resetViewportLighting: () => set({ exposure: 1.15, environmentPreset: 'studio' }),
}));
