import { useEffect, useState, type ReactNode } from 'react';
import { Camera, Circle, Monitor, SlidersHorizontal, SunMedium } from 'lucide-react';
import { cn } from '@/components/common/cn';
import { IconTooltip } from '@/components/common/IconTooltip';
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
  '8K': 8192,
} as const;

const displayOptions: Array<{ value: DisplayMode; labelKey: 'pbr' | 'flatShort' | 'normalShort' | 'wireShort' }> = [
  { value: 'pbr', labelKey: 'pbr' },
  { value: 'flat', labelKey: 'flatShort' },
  { value: 'normal', labelKey: 'normalShort' },
  { value: 'wire', labelKey: 'wireShort' },
];

const environmentOptions = [
  { value: 'color', labelKey: 'color' },
  { value: 'studio', labelKey: 'studioEnvironment' },
  { value: 'soft', labelKey: 'softEnvironment' },
  { value: 'dark', labelKey: 'darkEnvironment' },
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
  const pbrKeyLightIntensity = useSettingsStore((state) => state.pbrKeyLightIntensity);
  const pbrLightAzimuth = useSettingsStore((state) => state.pbrLightAzimuth);
  const environmentPreset = useSettingsStore((state) => state.environmentPreset);
  const setExposure = useSettingsStore((state) => state.setExposure);
  const setPbrEnvironmentIntensity = useSettingsStore((state) => state.setPbrEnvironmentIntensity);
  const setPbrKeyLightIntensity = useSettingsStore((state) => state.setPbrKeyLightIntensity);
  const setPbrLightAzimuth = useSettingsStore((state) => state.setPbrLightAzimuth);
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
      <ViewportRow icon={<Camera className="h-4 w-4" />} tooltipLabel={t('captureCurrentView')}>
        <div className="grid flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_28px] gap-2">
          {(['perspective', 'orthographic'] as ProjectionMode[]).map((mode) => (
            <CompactButton
              key={mode}
              active={projectionMode === mode}
              onClick={() => setProjectionMode(mode)}
            >
              {t(mode)}
            </CompactButton>
          ))}
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

      <ViewportRow icon={<Monitor className="h-4 w-4" />} tooltipLabel={t('view')}>
        <div className="grid flex-1 grid-cols-4 gap-1">
          {displayOptions.map((option) => (
            <CompactButton
              key={option.value}
              active={displayMode === option.value}
              onClick={() => setDisplayMode(option.value)}
            >
              {t(option.labelKey)}
            </CompactButton>
          ))}
        </div>
      </ViewportRow>

      {displayMode === 'pbr' && (
        <>
          <ViewportRow icon={<Circle className="h-4 w-4" />} tooltipLabel={t('environment')}>
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <select
                value={pbrEnvironmentPreset}
                onChange={(event) => setEnvironmentPreset(event.target.value as typeof environmentPreset)}
                aria-label={t('environment')}
                className="h-7 min-w-0 flex-1 rounded-md border border-white/18 bg-white px-3 text-[13px] text-[#181820] outline-none"
              >
                {environmentOptions
                  .filter((option) => option.value !== 'color')
                  .map((option) => (
                    <option key={option.value} value={option.value}>
                      {t(option.labelKey)}
                    </option>
                  ))}
              </select>
            </div>
          </ViewportRow>
          <PbrSlider
            icon={<SunMedium className="h-4 w-4" />}
            value={exposure}
            min={0.7}
            max={1.8}
            step={0.01}
            label={t('exposure')}
            inputValue={exposure}
            inputMin={0.7}
            inputMax={1.8}
            inputStep={0.01}
            inputSuffix="x"
            onChange={setExposure}
          />
          <PbrSlider
            icon={<SlidersHorizontal className="h-4 w-4" />}
            value={pbrEnvironmentIntensity}
            min={0}
            max={1.2}
            step={0.01}
            label={t('environment')}
            inputValue={pbrEnvironmentIntensity * 100}
            inputMin={0}
            inputMax={120}
            inputStep={1}
            inputSuffix="%"
            onInputCommit={(value) => setPbrEnvironmentIntensity(value / 100)}
            onChange={setPbrEnvironmentIntensity}
          />
          <PbrSlider
            icon={<SunMedium className="h-4 w-4" />}
            value={pbrKeyLightIntensity}
            min={0}
            max={2.4}
            step={0.01}
            label={t('lightIntensity')}
            inputValue={pbrKeyLightIntensity * 100}
            inputMin={0}
            inputMax={240}
            inputStep={1}
            inputSuffix="%"
            onInputCommit={(value) => setPbrKeyLightIntensity(value / 100)}
            onChange={setPbrKeyLightIntensity}
          />
          <PbrSlider
            icon={<SlidersHorizontal className="h-4 w-4" />}
            value={pbrLightAzimuth}
            min={-180}
            max={180}
            step={1}
            label={t('lightDirection')}
            inputValue={pbrLightAzimuth}
            inputMin={-180}
            inputMax={180}
            inputStep={1}
            inputSuffix="°"
            onChange={setPbrLightAzimuth}
          />
        </>
      )}
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
  inputValue,
  inputMin,
  inputMax,
  inputStep,
  inputSuffix,
  onInputCommit,
  onChange,
}: {
  icon: ReactNode;
  value: number;
  min: number;
  max: number;
  step: number;
  label: string;
  inputValue: number;
  inputMin: number;
  inputMax: number;
  inputStep: number;
  inputSuffix: string;
  onInputCommit?: (value: number) => void;
  onChange: (value: number) => void;
}) {
  return (
    <ViewportRow icon={icon} tooltipLabel={label}>
      <div className="grid min-w-0 flex-1 grid-cols-[minmax(132px,1fr)_78px] items-center gap-2">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className="liclick-range liclick-range-compact w-full"
          aria-label={label}
        />
        <NumberValueInput
          value={inputValue}
          min={inputMin}
          max={inputMax}
          step={inputStep}
          suffix={inputSuffix}
          ariaLabel={label}
          onCommit={onInputCommit ?? onChange}
        />
      </div>
    </ViewportRow>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function formatDraftValue(value: number, step: number) {
  if (step < 1) return Number(value.toFixed(2)).toString();
  return Math.round(value).toString();
}

function NumberValueInput({
  value,
  min,
  max,
  step,
  suffix,
  ariaLabel,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  ariaLabel: string;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(formatDraftValue(value, step));

  useEffect(() => {
    setDraft(formatDraftValue(value, step));
  }, [step, value]);

  function commit() {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(formatDraftValue(value, step));
      return;
    }
    const precision = step < 1 ? 2 : 0;
    const nextValue = Number(clamp(parsed, min, max).toFixed(precision));
    setDraft(formatDraftValue(nextValue, step));
    if (nextValue !== value) onCommit(nextValue);
  }

  return (
    <div className="grid h-8 min-w-0 grid-cols-[minmax(0,1fr)_18px] items-center rounded-md border border-white/28 bg-black/24 text-[12px] font-semibold tabular-nums text-white/88 focus-within:border-liclick-pink">
      <input
        type="number"
        value={draft}
        min={min}
        max={max}
        step={step}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            setDraft(formatDraftValue(value, step));
            event.currentTarget.blur();
          }
        }}
        aria-label={ariaLabel}
        className="h-full min-w-0 bg-transparent pl-1 pr-0 text-right text-[12px] font-semibold tabular-nums text-white outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <span className="pr-1.5 text-right text-white/80">{suffix}</span>
    </div>
  );
}

function ViewportRow({ icon, tooltipLabel, children }: { icon: ReactNode; tooltipLabel?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center gap-2">
      <div className="grid h-7 w-5 shrink-0 place-items-center text-white/82">
        {tooltipLabel ? (
          <IconTooltip label={tooltipLabel} side="top">
            <span className="grid h-6 w-5 place-items-center">{icon}</span>
          </IconTooltip>
        ) : (
          icon
        )}
      </div>
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
