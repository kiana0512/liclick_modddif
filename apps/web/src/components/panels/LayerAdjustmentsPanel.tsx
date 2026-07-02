import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { useEditorHistoryStore } from '@/stores/editorHistoryStore';
import { useLayerStore } from '@/stores/layerStore';
import { useSceneStore } from '@/stores/sceneStore';
import { useT } from '@/stores/i18nStore';
import type { LayerAdjustments } from '@/types/layer';

const adjustmentControls: Array<{ key: keyof LayerAdjustments; labelKey: 'hue' | 'saturation' | 'lightness' }> = [
  { key: 'hue', labelKey: 'hue' },
  { key: 'saturation', labelKey: 'saturation' },
  { key: 'lightness', labelKey: 'lightness' },
];

export function LayerAdjustmentsPanel() {
  const t = useT();
  const layers = useLayerStore((state) => state.layers);
  const activeProjectedLayerId = useLayerStore((state) => state.activeProjectedLayerId);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const setLayerAdjustment = useLayerStore((state) => state.setLayerAdjustment);
  const setStrength = useLayerStore((state) => state.setStrength);
  const captureHistory = useEditorHistoryStore((state) => state.capture);
  const activeLayer = layers.find(
    (layer) => layer.id === activeProjectedLayerId && (!layer.objectId || layer.objectId === selectedObjectId),
  );
  const activeAdjustments = activeLayer?.adjustments ?? { hue: 0, saturation: 0, lightness: 0 };

  if (!activeLayer) {
    return <div className="min-h-32" aria-hidden="true" />;
  }

  return (
    <div className="space-y-1 px-0.5 pb-0.5">
      <div className="grid h-[46px] grid-rows-[24px_14px] items-center">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 text-[14px] font-semibold text-white/90">{t('projectionStrength')}</div>
          <PercentNumberInput
            value={Math.round((activeLayer.strength ?? 1) * 100)}
            min={25}
            max={300}
            ariaLabel={t('projectionStrength')}
            onCommit={(value) => {
              captureHistory(`调整投影强度：${activeLayer.name}`);
              setStrength(activeLayer.id, value / 100);
            }}
          />
          <button
            type="button"
            className="grid h-6 w-6 place-items-center rounded text-white/82 transition hover:bg-liclick-pink/16 hover:text-liclick-pink"
            onClick={() => {
              captureHistory(`重置投影强度：${activeLayer.name}`);
              setStrength(activeLayer.id, 1);
            }}
            title={t('reset')}
            aria-label={t('reset')}
          >
            <RotateCcw className="h-4 w-4" />
          </button>
        </div>
        <input
          type="range"
          min="25"
          max="300"
          step="1"
          value={Math.round((activeLayer.strength ?? 1) * 100)}
          onPointerDown={() => captureHistory(`调整投影强度：${activeLayer.name}`)}
          onChange={(event) => setStrength(activeLayer.id, Number(event.target.value) / 100)}
          className="liclick-range w-full"
          aria-label={t('projectionStrength')}
        />
      </div>
      {adjustmentControls.map((control) => {
        const value = activeAdjustments[control.key];
        return (
          <div key={control.key} className="grid h-[46px] grid-rows-[24px_14px] items-center">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1 text-[14px] font-semibold text-white/90">{t(control.labelKey)}</div>
              <PercentNumberInput
                value={Math.round(value)}
                min={-100}
                max={100}
                ariaLabel={t(control.labelKey)}
                onCommit={(nextValue) => {
                  captureHistory(`调整${t(control.labelKey)}：${activeLayer.name}`);
                  setLayerAdjustment(activeLayer.id, control.key, nextValue);
                }}
              />
              <button
                type="button"
                className="grid h-6 w-6 place-items-center rounded text-white/82 transition hover:bg-liclick-pink/16 hover:text-liclick-pink"
                onClick={() => {
                  captureHistory(`重置${t(control.labelKey)}：${activeLayer.name}`);
                  setLayerAdjustment(activeLayer.id, control.key, 0);
                }}
                title={t('reset')}
                aria-label={t('reset')}
              >
                <RotateCcw className="h-4 w-4" />
              </button>
            </div>
            <input
              type="range"
              min="-100"
              max="100"
              step="1"
              value={value}
              onPointerDown={() => captureHistory(`调整${t(control.labelKey)}：${activeLayer.name}`)}
              onChange={(event) => setLayerAdjustment(activeLayer.id, control.key, Number(event.target.value))}
              className="liclick-range w-full"
              aria-label={t(control.labelKey)}
            />
          </div>
        );
      })}
    </div>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function PercentNumberInput({
  value,
  min,
  max,
  ariaLabel,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  ariaLabel: string;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  function commit() {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const nextValue = Math.round(clamp(parsed, min, max));
    setDraft(String(nextValue));
    if (nextValue !== value) onCommit(nextValue);
  }

  return (
    <div className="grid w-[88px] grid-cols-[minmax(0,1fr)_17px] items-center rounded-md border border-white/44 bg-black/34 text-sm font-semibold tabular-nums text-white focus-within:border-liclick-pink">
      <input
        type="number"
        value={draft}
        min={min}
        max={max}
        step={1}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            setDraft(String(value));
            event.currentTarget.blur();
          }
        }}
        aria-label={ariaLabel}
        className="h-7 min-w-0 bg-transparent pl-2 pr-0 text-right text-sm font-semibold tabular-nums text-white outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <span className="pr-2 text-right text-white/88">%</span>
    </div>
  );
}
