import { useState } from 'react';
import { Camera, RotateCcw, SunMedium } from 'lucide-react';
import { captureCurrentView } from '@/engine/capture/captureCurrentView';
import { Button } from '@/components/ui/Button';
import { Panel } from '@/components/ui/Panel';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { useGenerationStore } from '@/stores/generationStore';
import { useT } from '@/stores/i18nStore';
import { useSceneStore } from '@/stores/sceneStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToastStore } from '@/stores/toastStore';
import type { DisplayMode, ProjectionMode } from '@/types/model';

const resolutionToSize = {
  '1K': 1024,
  '2K': 2048,
  '4K': 4096,
} as const;

export function ViewportPanel() {
  const t = useT();
  const [captureStatus, setCaptureStatus] = useState(t('ready'));
  const displayMode = useSceneStore((state) => state.displayMode);
  const projectionMode = useSceneStore((state) => state.projectionMode);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const importedModel = useSceneStore((state) => state.importedModel);
  const setDisplayMode = useSceneStore((state) => state.setDisplayMode);
  const setProjectionMode = useSceneStore((state) => state.setProjectionMode);
  const resolution = useSettingsStore((state) => state.resolution);
  const exposure = useSettingsStore((state) => state.exposure);
  const environmentPreset = useSettingsStore((state) => state.environmentPreset);
  const setExposure = useSettingsStore((state) => state.setExposure);
  const setEnvironmentPreset = useSettingsStore((state) => state.setEnvironmentPreset);
  const resetViewportLighting = useSettingsStore((state) => state.resetViewportLighting);
  const setLastCapture = useGenerationStore((state) => state.setLastCapture);
  const pushToast = useToastStore((state) => state.pushToast);

  async function handleCapture() {
    if (!importedModel) {
      pushToast({
        tone: 'warning',
        title: t('importModelFirst'),
      });
      return;
    }
    const objectId = selectedObjectId ?? importedModel.objectId;

    try {
      setCaptureStatus(t('capturing'));
      const capture = await captureCurrentView({
        objectId,
        resolution: resolutionToSize[resolution],
      });
      setLastCapture(capture);
      setCaptureStatus(`${capture.width}${t('capturePx')} color / mask / depth / normal`);
      pushToast({
        tone: capture.warnings.length > 0 ? 'warning' : 'success',
        title: 'Capture complete',
        description: capture.warnings[0] ?? 'Current viewport was captured for generation and projection.',
      });
    } catch (error) {
      console.error('[Liclick 3D Texture] Capture failed:', error);
      setCaptureStatus(t('captureFailed'));
      pushToast({
        tone: 'error',
        title: 'Capture failed',
        description: error instanceof Error ? error.message : 'Could not capture the current view.',
      });
    }
  }

  return (
    <Panel title={t('viewport')}>
      <div className="space-y-3">
        <SegmentedControl<DisplayMode>
          value={displayMode}
          options={[
            { value: 'pbr', label: t('pbr') },
            { value: 'flat', label: t('flat') },
            { value: 'normal', label: t('normal') },
            { value: 'wire', label: t('wire') },
          ]}
          onChange={setDisplayMode}
        />
        {displayMode === 'normal' && (
          <div className="rounded-md border border-sky-300/15 bg-sky-500/10 px-3 py-2 text-xs leading-5 text-sky-100/80">
            {t('normalPreviewHelp')}
          </div>
        )}
        <SegmentedControl<ProjectionMode>
          value={projectionMode}
          options={[
            { value: 'perspective', label: t('perspective') },
            { value: 'orthographic', label: t('orthographic') },
          ]}
          onChange={setProjectionMode}
        />
        <Button className="w-full" icon={<Camera className="h-4 w-4" />} onClick={handleCapture}>
          {t('captureCurrentView')}
        </Button>
        <label className="block">
          <div className="mb-1 flex items-center gap-2 text-xs text-white/56">
            <SunMedium className="h-3.5 w-3.5" />
            {t('exposure')}
            <span className="ml-auto text-white/40">{exposure.toFixed(2)}</span>
          </div>
          <input
            type="range"
            min="0.7"
            max="2"
            step="0.01"
            value={exposure}
            onChange={(event) => setExposure(Number(event.target.value))}
            className="w-full accent-liclick-pink"
          />
        </label>
        <SegmentedControl
          value={environmentPreset}
          options={[
            { value: 'color', label: 'Color' },
            { value: 'studio', label: 'Studio' },
            { value: 'soft', label: 'Soft' },
            { value: 'dark', label: 'Dark' },
          ]}
          onChange={setEnvironmentPreset}
        />
        <Button className="w-full" variant="ghost" icon={<RotateCcw className="h-4 w-4" />} onClick={resetViewportLighting}>
          {t('resetViewportLighting')}
        </Button>
        <div className="rounded-md bg-white/[0.045] px-3 py-2 text-xs text-white/48">{captureStatus}</div>
      </div>
    </Panel>
  );
}
