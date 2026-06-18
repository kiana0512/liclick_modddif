import { Download, Flame, ImagePlus, RotateCcw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { applyBakedTextureToObject } from '@/engine/bake/applyBakedTexture';
import { bakeProjectedLayerToTexture } from '@/engine/bake/bakeProjectedLayerToTexture';
import { downloadBaseColorTexture } from '@/engine/bake/downloadTexture';
import type { BakeProjectedLayerResult, UvBakeResolution } from '@/engine/bake/uvBakeTypes';
import { Button } from '@/components/ui/Button';
import { Panel } from '@/components/ui/Panel';
import { useLayerStore } from '@/stores/layerStore';
import { useT } from '@/stores/i18nStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSceneStore } from '@/stores/sceneStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToastStore } from '@/stores/toastStore';
import type { LayerAdjustments } from '@/types/layer';

const resolutionToBakeSize: Record<'1K' | '2K' | '4K', UvBakeResolution> = {
  '1K': 1024,
  '2K': 2048,
  '4K': 4096,
};

const adjustmentControls: Array<{ key: keyof LayerAdjustments; labelKey: 'hue' | 'saturation' | 'lightness' }> = [
  { key: 'hue', labelKey: 'hue' },
  { key: 'saturation', labelKey: 'saturation' },
  { key: 'lightness', labelKey: 'lightness' },
];

export function LayerAdjustmentsPanel() {
  const t = useT();
  const [isBaking, setIsBaking] = useState(false);
  const [lastBake, setLastBake] = useState<BakeProjectedLayerResult>();
  const layers = useLayerStore((state) => state.layers);
  const activeProjectedLayerId = useLayerStore((state) => state.activeProjectedLayerId);
  const setLayerAdjustment = useLayerStore((state) => state.setLayerAdjustment);
  const importedModel = useSceneStore((state) => state.importedModel);
  const setDisplayMode = useSceneStore((state) => state.setDisplayMode);
  const resolution = useSettingsStore((state) => state.resolution);
  const project = useProjectStore((state) => state.getCurrentProject());
  const pushToast = useToastStore((state) => state.pushToast);
  const activeLayer = layers.find((layer) => layer.id === activeProjectedLayerId);
  const activeAdjustments = activeLayer?.adjustments ?? { hue: 0, saturation: 0, lightness: 0 };

  const activeBakedTexture = useMemo(() => {
    if (!project || !activeLayer) return undefined;
    return project.bakedTextures.find((texture) => texture.id === activeLayer.bakedTextureId);
  }, [activeLayer, project]);
  const bakeBlocker = getBakeBlocker();
  const imageUrl = lastBake?.imageUrl ?? activeBakedTexture?.imageUrl;

  function getBakeBlocker() {
    if (!importedModel) return t('importModelFirst');
    if (!activeLayer) return t('addProjectedLayerFirst');
    if (activeLayer.type !== 'projected') return t('onlyProjectedBake');
    if (!importedModel.uvSets.includes('UV0')) return t('noUvBake');
    if (!activeLayer.camera) return t('noCaptureCamera');
    return undefined;
  }

  async function handleBake() {
    if (bakeBlocker || !importedModel || !activeLayer) {
      return;
    }

    try {
      setIsBaking(true);
      const bakeSize = resolutionToBakeSize[resolution];
      if (bakeSize === 4096) {
        pushToast({
          tone: 'warning',
          title: '4K bake is experimental',
          description: 'CPU bake may take a while. Use 1K or 2K for faster iteration.',
        });
      }
      const result = await bakeProjectedLayerToTexture({
        objectId: importedModel.objectId,
        layerId: activeLayer.id,
        resolution: bakeSize,
        opacity: activeLayer.opacity,
        enableBackfaceCulling: true,
        enableDilation: true,
        dilationPixels: 8,
      });
      await applyBakedTextureToObject(importedModel.group, result.imageUrl);
      setDisplayMode('pbr');
      setLastBake(result);
      pushToast({
        tone: 'success',
        title: 'Baked basecolor texture successfully.',
        description: `Coverage ${(result.report.coverageRatio * 100).toFixed(2)}% / ${result.report.durationMs}ms`,
      });
    } catch (error) {
      console.error('[Liclick 3D Texture] Bake failed:', error);
      pushToast({
        tone: 'error',
        title: 'Bake failed',
        description: error instanceof Error ? error.message : 'Could not bake the active projected layer.',
      });
    } finally {
      setIsBaking(false);
    }
  }

  async function handleApplyBakedTexture() {
    if (!importedModel) {
      pushToast({ tone: 'warning', title: t('importModelFirst') });
      return;
    }
    if (!imageUrl) {
      return;
    }

    const result = await applyBakedTextureToObject(importedModel.group, imageUrl);
    setDisplayMode('pbr');
    pushToast({
      tone: result.warnings.length > 0 ? 'warning' : 'success',
      title: 'Baked texture applied',
      description: result.warnings[0] ?? 'BaseColor texture is applied to the imported model.',
    });
  }

  function handleDownload() {
    if (!project || !activeLayer) return;
    if (!imageUrl) {
      return;
    }
    downloadBaseColorTexture(imageUrl, project, activeLayer);
  }

  return (
    <Panel title={t('layerAdjustments')}>
      <div className="space-y-3 text-sm text-white/60">
        {!activeLayer && (
          <div className="grid min-h-28 place-items-center rounded-md bg-black/22 px-4 text-center text-sm text-white/48">
            {t('selectProjectedLayerHelp')}
          </div>
        )}

        {activeLayer &&
          adjustmentControls.map((control) => {
            const value = activeAdjustments[control.key];
            return (
              <label key={control.key} className="block rounded-md bg-black/16 p-1.5">
                <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-white/76">
                  {t(control.labelKey)}
                  <span className="ml-auto rounded-md border border-white/14 bg-black/36 px-2 py-1 text-[11px] tabular-nums text-white/78">
                    {Math.round(value)}%
                  </span>
                  <button
                    type="button"
                    className="grid h-6 w-6 place-items-center rounded text-white/45 transition hover:bg-white/8 hover:text-white"
                    onClick={() => setLayerAdjustment(activeLayer.id, control.key, 0)}
                    title={t('reset')}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </button>
                </div>
                <input
                  type="range"
                  min="-100"
                  max="100"
                  step="1"
                  value={value}
                  onChange={(event) => setLayerAdjustment(activeLayer.id, control.key, Number(event.target.value))}
                  className="w-full accent-[#ff8a68]"
                />
              </label>
            );
          })}

        {activeLayer && (
          <div className="rounded-md border border-white/10 bg-white/[0.045] p-2.5">
            <div className="flex items-center gap-2 text-xs text-white/56">
              <Flame className="h-3.5 w-3.5 text-liclick-pink" />
              <span className="truncate">{activeLayer.name}</span>
              <span className="ml-auto tabular-nums text-white/40">
                {lastBake
                  ? `${Math.round(lastBake.report.coverageRatio * 100)}%`
                  : activeBakedTexture
                    ? `${Math.round(activeBakedTexture.coverageRatio * 100)}%`
                    : resolutionToBakeSize[resolution]}
              </span>
            </div>
            {(activeLayer.needsRebake || bakeBlocker) && (
              <div className="mt-2 truncate text-xs text-amber-200">
                {activeLayer.needsRebake ? t('rebake') : bakeBlocker}
              </div>
            )}
            <div className="mt-2 grid grid-cols-3 gap-2">
              <Button
                className="h-9 px-0"
                variant="primary"
                onClick={handleBake}
                disabled={isBaking || Boolean(bakeBlocker)}
                title={isBaking ? t('baking') : t('bakeActiveLayer')}
                icon={<Flame className="h-4 w-4" />}
              />
              <Button
                className="h-9 px-0"
                onClick={handleDownload}
                disabled={!imageUrl}
                title={t('downloadBaseColor')}
                icon={<Download className="h-4 w-4" />}
              />
              <Button
                className="h-9 px-0"
                onClick={handleApplyBakedTexture}
                disabled={!imageUrl || !importedModel}
                title={t('applyBakedTexture')}
                icon={<ImagePlus className="h-4 w-4" />}
              />
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}
