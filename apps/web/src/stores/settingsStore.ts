import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

type Resolution = '1K' | '2K' | '4K' | '8K';
export type EnvironmentPreset = 'color' | 'studio' | 'soft' | 'dark';

type SettingsStore = {
  resolution: Resolution;
  exposure: number;
  pbrEnvironmentIntensity: number;
  pbrKeyLightIntensity: number;
  pbrLightAzimuth: number;
  environmentPreset: EnvironmentPreset;
  autoUvBakeEnabled: boolean;
  setResolution: (resolution: Resolution) => void;
  setExposure: (exposure: number) => void;
  setPbrEnvironmentIntensity: (pbrEnvironmentIntensity: number) => void;
  setPbrKeyLightIntensity: (pbrKeyLightIntensity: number) => void;
  setPbrLightAzimuth: (pbrLightAzimuth: number) => void;
  setEnvironmentPreset: (environmentPreset: EnvironmentPreset) => void;
  setAutoUvBakeEnabled: (autoUvBakeEnabled: boolean) => void;
  resetViewportLighting: () => void;
};

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      resolution: '2K',
      exposure: 1,
      pbrEnvironmentIntensity: 0.42,
      pbrKeyLightIntensity: 1,
      pbrLightAzimuth: 38,
      environmentPreset: 'studio',
      autoUvBakeEnabled: false,
      setResolution: (resolution) => set({ resolution }),
      setExposure: (exposure) => set({ exposure }),
      setPbrEnvironmentIntensity: (pbrEnvironmentIntensity) => set({ pbrEnvironmentIntensity }),
      setPbrKeyLightIntensity: (pbrKeyLightIntensity) => set({ pbrKeyLightIntensity }),
      setPbrLightAzimuth: (pbrLightAzimuth) => set({ pbrLightAzimuth }),
      setEnvironmentPreset: (environmentPreset) => set({ environmentPreset }),
      setAutoUvBakeEnabled: (autoUvBakeEnabled) => set({ autoUvBakeEnabled }),
      resetViewportLighting: () =>
        set({ exposure: 1, pbrEnvironmentIntensity: 0.42, pbrKeyLightIntensity: 1, pbrLightAzimuth: 38, environmentPreset: 'studio' }),
    }),
    {
      name: 'liclick-render-settings-v1',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        resolution: state.resolution,
        exposure: state.exposure,
        pbrEnvironmentIntensity: state.pbrEnvironmentIntensity,
        pbrKeyLightIntensity: state.pbrKeyLightIntensity,
        pbrLightAzimuth: state.pbrLightAzimuth,
        environmentPreset: state.environmentPreset,
        autoUvBakeEnabled: state.autoUvBakeEnabled,
      }),
    },
  ),
);
