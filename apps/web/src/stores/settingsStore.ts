import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

type Resolution = '1K' | '2K' | '4K' | '8K';
export type EnvironmentPreset = 'color' | 'studio' | 'soft' | 'dark';

const DEFAULT_VIEWPORT_LIGHTING = {
  exposure: 1,
  pbrEnvironmentIntensity: 0.42,
  pbrKeyLightIntensity: 1,
  pbrLightAzimuth: 38,
  environmentPreset: 'studio' as const,
};

type SettingsStore = {
  resolution: Resolution;
  exposure: number;
  pbrEnvironmentIntensity: number;
  pbrKeyLightIntensity: number;
  pbrLightAzimuth: number;
  environmentPreset: EnvironmentPreset;
  performanceTestModeEnabled: boolean;
  setResolution: (resolution: Resolution) => void;
  setExposure: (exposure: number) => void;
  setPbrEnvironmentIntensity: (pbrEnvironmentIntensity: number) => void;
  setPbrKeyLightIntensity: (pbrKeyLightIntensity: number) => void;
  setPbrLightAzimuth: (pbrLightAzimuth: number) => void;
  setEnvironmentPreset: (environmentPreset: EnvironmentPreset) => void;
  setPerformanceTestModeEnabled: (performanceTestModeEnabled: boolean) => void;
  resetViewportLighting: () => void;
};

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      resolution: '2K',
      ...DEFAULT_VIEWPORT_LIGHTING,
      performanceTestModeEnabled: false,
      setResolution: (resolution) => set({ resolution }),
      setExposure: (exposure) => set({ exposure }),
      setPbrEnvironmentIntensity: (pbrEnvironmentIntensity) => set({ pbrEnvironmentIntensity }),
      setPbrKeyLightIntensity: (pbrKeyLightIntensity) => set({ pbrKeyLightIntensity }),
      setPbrLightAzimuth: (pbrLightAzimuth) => set({ pbrLightAzimuth }),
      setEnvironmentPreset: (environmentPreset) => set({ environmentPreset }),
      setPerformanceTestModeEnabled: (performanceTestModeEnabled) => set({ performanceTestModeEnabled }),
      resetViewportLighting: () => set(DEFAULT_VIEWPORT_LIGHTING),
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
        performanceTestModeEnabled: state.performanceTestModeEnabled,
      }),
    },
  ),
);
