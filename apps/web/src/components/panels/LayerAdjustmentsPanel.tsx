import { Download, Flame, ImagePlus, SlidersHorizontal } from 'lucide-react';
import { useMemo, useState } from 'react';
import { applyBakedTextureToObject } from '@/engine/bake/applyBakedTexture';
import { bakeProjectedLayerToTexture } from '@/engine/bake/bakeProjectedLayerToTexture';
import { downloadBaseColorTexture } from '@/engine/bake/downloadTexture';
import type { BakeProjectedLayerResult, UvBakeResolution } from '@/engine/bake/uvBakeTypes';
import { Button } from '@/components/ui/Button';
import { Panel } from '@/components/ui/Panel';
import { useLayerStore } from '@/stores/layerStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSceneStore } from '@/stores/sceneStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToastStore } from '@/stores/toastStore';

const resolutionToBakeSize: Record<'1K' | '2K' | '4K', UvBakeResolution> = {
  '1K': 1024,
  '2K': 2048,
  '4K': 4096,
};

export function LayerAdjustmentsPanel() {
  const [isBaking, setIsBaking] = useState(false);
  const [lastBake, setLastBake] = useState<BakeProjectedLayerResult>();
  const layers = useLayerStore((state) => state.layers);
  const activeProjectedLayerId = useLayerStore((state) => state.activeProjectedLayerId);
  const importedModel = useSceneStore((state) => state.importedModel);
  const setDisplayMode = useSceneStore((state) => state.setDisplayMode);
  const resolution = useSettingsStore((state) => state.resolution);
  const project = useProjectStore((state) => state.getCurrentProject());
  const pushToast = useToastStore((state) => state.pushToast);
  const activeLayer = layers.find((layer) => layer.id === activeProjectedLayerId);

  const activeBakedTexture = useMemo(() => {
    if (!project || !activeLayer) return undefined;
    return project.bakedTextures.find((texture) => texture.id === activeLayer.bakedTextureId);
  }, [activeLayer, project]);

  function getBakeBlocker() {
    if (!importedModel) return 'Please import a model first.';
    if (!activeLayer) return 'Please add a projected layer first.';
    if (activeLayer.type !== 'projected') return 'Only projected layers can be baked in this MVP.';
    if (!importedModel.uvSets.includes('UV0')) return 'This model has no UVs.';
    if (!activeLayer.camera) return 'Projected layer has no capture camera.';
    return undefined;
  }

  async function handleBake() {
    const blocker = getBakeBlocker();
    if (blocker || !importedModel || !activeLayer) {
      pushToast({ tone: 'warning', title: 'Cannot bake yet', description: blocker });
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
      pushToast({ tone: 'warning', title: 'Please import a model first.' });
      return;
    }
    const imageUrl = lastBake?.imageUrl ?? activeBakedTexture?.imageUrl;
    if (!imageUrl) {
      pushToast({ tone: 'warning', title: 'No baked texture yet.' });
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
    const imageUrl = lastBake?.imageUrl ?? activeBakedTexture?.imageUrl;
    if (!imageUrl) {
      pushToast({ tone: 'warning', title: 'No basecolor texture to download.' });
      return;
    }
    downloadBaseColorTexture(imageUrl, project, activeLayer);
  }

  return (
    <Panel title="Layer Adjustments">
      <div className="space-y-3 text-sm text-white/60">
        {['Exposure', 'Contrast', 'Roughness Influence'].map((label) => (
          <label key={label} className="block">
            <div className="mb-1 flex items-center gap-2">
              <SlidersHorizontal className="h-3.5 w-3.5" />
              {label}
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              defaultValue="0.5"
              className="w-full accent-liclick-pink"
            />
          </label>
        ))}

        <div className="rounded-md border border-white/10 bg-white/[0.045] p-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-white/48">
            <Flame className="h-3.5 w-3.5 text-liclick-pink" />
            UV Bake MVP
          </div>
          <div className="space-y-1 text-xs text-white/56">
            <div>Active layer: {activeLayer?.name ?? 'None'}</div>
            <div>Layer type: {activeLayer?.type.toUpperCase() ?? '-'}</div>
            <div>Bake resolution: {resolutionToBakeSize[resolution]}px</div>
            <div>
              Coverage:{' '}
              {lastBake
                ? `${(lastBake.report.coverageRatio * 100).toFixed(2)}%`
                : activeBakedTexture
                  ? `${(activeBakedTexture.coverageRatio * 100).toFixed(2)}%`
                  : 'Not baked'}
            </div>
            {activeLayer?.needsRebake && <div className="text-amber-200">Opacity changed. Re-bake required.</div>}
          </div>
          <div className="mt-3 grid gap-2">
            <Button className="w-full" variant="primary" onClick={handleBake} disabled={isBaking}>
              {isBaking ? 'Baking...' : 'Bake Active Layer'}
            </Button>
            <Button className="w-full" onClick={handleDownload} icon={<Download className="h-4 w-4" />}>
              Download BaseColor
            </Button>
            <Button className="w-full" onClick={handleApplyBakedTexture} icon={<ImagePlus className="h-4 w-4" />}>
              Apply Baked Texture
            </Button>
          </div>
        </div>
      </div>
    </Panel>
  );
}
