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
    <div className="space-y-0 px-1 pb-0.5">
      <div className="grid h-[64px] grid-rows-[28px_18px] items-center">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 text-[14px] font-semibold text-white/90">{t('projectionStrength')}</div>
          <div className="w-[82px] rounded-md border border-white/44 bg-black/34 px-2 py-1 text-right text-sm font-semibold tabular-nums text-white">
            {Math.round((activeLayer.strength ?? 1) * 100)} %
          </div>
          <button
            type="button"
            className="grid h-7 w-7 place-items-center rounded text-white/82 transition hover:bg-liclick-pink/16 hover:text-liclick-pink"
            onClick={() => {
              captureHistory();
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
          onPointerDown={captureHistory}
          onChange={(event) => setStrength(activeLayer.id, Number(event.target.value) / 100)}
          className="liclick-range w-full"
          aria-label={t('projectionStrength')}
        />
      </div>
      {adjustmentControls.map((control) => {
        const value = activeAdjustments[control.key];
        return (
          <div key={control.key} className="grid h-[64px] grid-rows-[28px_18px] items-center">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1 text-[14px] font-semibold text-white/90">{t(control.labelKey)}</div>
              <div className="w-[82px] rounded-md border border-white/44 bg-black/34 px-2 py-1 text-right text-sm font-semibold tabular-nums text-white">
                {Math.round(value)} %
              </div>
              <button
                type="button"
                className="grid h-7 w-7 place-items-center rounded text-white/82 transition hover:bg-liclick-pink/16 hover:text-liclick-pink"
                onClick={() => {
                  captureHistory();
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
              onPointerDown={captureHistory}
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
