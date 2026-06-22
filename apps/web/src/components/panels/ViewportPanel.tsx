import { useState, type ReactNode } from 'react';
import { Camera, Circle, Monitor, SlidersHorizontal, SunMedium } from 'lucide-react';
import { cn } from '@/components/common/cn';
import { captureCurrentView } from '@/engine/capture/captureCurrentView';
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

const displayOptions: Array<{ value: DisplayMode; label: string }> = [
  { value: 'pbr', label: 'PBR' },
  { value: 'flat', label: 'Fla' },
  { value: 'normal', label: 'Nor' },
  { value: 'wire', label: 'Wir' },
];

const environmentOptions = [
  { value: 'color', label: 'Color' },
  { value: 'studio', label: 'Studio' },
  { value: 'soft', label: 'Soft' },
  { value: 'dark', label: 'Dark' },
] as const;

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
  const pbrEnvironmentIntensity = useSettingsStore((state) => state.pbrEnvironmentIntensity);
  const environmentPreset = useSettingsStore((state) => state.environmentPreset);
  const setExposure = useSettingsStore((state) => state.setExposure);
  const setPbrEnvironmentIntensity = useSettingsStore((state) => state.setPbrEnvironmentIntensity);
  const setEnvironmentPreset = useSettingsStore((state) => state.setEnvironmentPreset);
  const setLastCapture = useGenerationStore((state) => state.setLastCapture);
  const pushToast = useToastStore((state) => state.pushToast);
  const pbrEnvironmentPreset = environmentPreset === 'color' ? 'studio' : environmentPreset;

  async function handleCapture() {
    if (!importedModel) {
      pushToast({ tone: 'warning', title: t('importModelFirst') });
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
      setCaptureStatus(t('ready'));
      pushToast({
        tone: capture.warnings.length > 0 ? 'warning' : 'success',
        title: t('captureCurrentView'),
        description: capture.warnings[0],
      });
    } catch (error) {
      console.error('[Liclick 3D Texture] Capture failed:', error);
      setCaptureStatus(t('captureFailed'));
      pushToast({
        tone: 'error',
        title: t('captureFailed'),
        description: error instanceof Error ? error.message : undefined,
      });
    }
  }

  return (
    <div className="space-y-1">
      <ViewportRow icon={<Camera className="h-4 w-4" />}>
        <div className="grid flex-1 grid-cols-2 gap-2">
          {(['perspective', 'orthographic'] as ProjectionMode[]).map((mode) => (
            <CompactButton
              key={mode}
              active={projectionMode === mode}
              onClick={() => setProjectionMode(mode)}
            >
              {t(mode)}
            </CompactButton>
          ))}
        </div>
      </ViewportRow>

      <ViewportRow icon={<Monitor className="h-4 w-4" />}>
        <div className="grid flex-1 grid-cols-5 gap-1">
          <div className="grid h-7 place-items-center text-xs font-semibold text-white/72">MAT</div>
          {displayOptions.map((option) => (
            <CompactButton
              key={option.value}
              active={displayMode === option.value}
              onClick={() => setDisplayMode(option.value)}
            >
              {option.label}
            </CompactButton>
          ))}
        </div>
      </ViewportRow>

      {displayMode === 'pbr' && (
        <>
          <ViewportRow icon={<Circle className="h-4 w-4" />}>
            <select
              value={pbrEnvironmentPreset}
              onChange={(event) => setEnvironmentPreset(event.target.value as typeof environmentPreset)}
              className="h-7 min-w-0 flex-1 rounded-md border border-white/18 bg-white px-3 text-[13px] text-[#181820] outline-none"
            >
              {environmentOptions
                .filter((option) => option.value !== 'color')
                .map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
            </select>
          </ViewportRow>
          <PbrSlider
            icon={<SunMedium className="h-4 w-4" />}
            value={exposure}
            min={0.7}
            max={1.8}
            step={0.01}
            label={t('exposure')}
            onChange={setExposure}
          />
          <PbrSlider
            icon={<SlidersHorizontal className="h-4 w-4" />}
            value={pbrEnvironmentIntensity}
            min={0.12}
            max={0.72}
            step={0.01}
            label={t('environment')}
            onChange={setPbrEnvironmentIntensity}
          />
        </>
      )}

      <ViewportRow icon={<SlidersHorizontal className="h-4 w-4" />}>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="w-24 truncate text-[13px] font-semibold text-white/76">{t('environment')}</span>
          <select
            value="color"
            onChange={() => undefined}
            aria-label={t('environment')}
            className="h-7 min-w-0 flex-1 rounded-md border border-white/18 bg-white text-center text-[13px] text-[#181820] outline-none"
          >
            <option value="color">Color</option>
          </select>
          <button
            type="button"
            onClick={handleCapture}
            title={captureStatus}
            aria-label={t('captureCurrentView')}
            className="grid h-7 w-7 place-items-center rounded-full border border-white/70 text-white transition hover:bg-white/10"
          >
            <Circle className="h-4 w-4" />
          </button>
        </div>
      </ViewportRow>
    </div>
  );
}

function PbrSlider({
  icon,
  value,
  min,
  max,
  step,
  label,
  onChange,
}: {
  icon: ReactNode;
  value: number;
  min: number;
  max: number;
  step: number;
  label: string;
  onChange: (value: number) => void;
}) {
  return (
    <ViewportRow icon={icon}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="liclick-range liclick-range-compact w-full"
        aria-label={label}
        title={label}
      />
    </ViewportRow>
  );
}

function ViewportRow({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center gap-2">
      <div className="grid h-7 w-6 shrink-0 place-items-center text-white/82">{icon}</div>
      {children}
    </div>
  );
}

function CompactButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'h-7 rounded-md px-2 text-[13px] font-semibold text-white/82 transition hover:bg-white/10',
        active && 'bg-gradient-to-r from-liclick-pink to-liclick-purple text-white shadow-glow hover:brightness-110',
      )}
    >
      {children}
    </button>
  );
}
