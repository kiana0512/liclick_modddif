import { Camera, Eye, EyeOff, Image, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/components/common/cn';
import { Panel } from '@/components/ui/Panel';
import { useEditorHistoryStore } from '@/stores/editorHistoryStore';
import { useT } from '@/stores/i18nStore';
import { useLayerStore } from '@/stores/layerStore';
import { useSceneStore } from '@/stores/sceneStore';
import { useToastStore } from '@/stores/toastStore';

export function LayersPanel() {
  const t = useT();
  const layers = useLayerStore((state) => state.layers);
  const toggleLayer = useLayerStore((state) => state.toggleLayer);
  const setOpacity = useLayerStore((state) => state.setOpacity);
  const activeProjectedLayerId = useLayerStore((state) => state.activeProjectedLayerId);
  const setActiveLayer = useLayerStore((state) => state.setActiveLayer);
  const deleteLayer = useLayerStore((state) => state.deleteLayer);
  const captureHistory = useEditorHistoryStore((state) => state.capture);
  const requestCameraRestore = useSceneStore((state) => state.requestCameraRestore);
  const pushToast = useToastStore((state) => state.pushToast);

  return (
    <Panel title={t('layers')}>
      <div className="space-y-2">
        <div className="rounded-md border border-white/8 bg-white/[0.035] p-2">
          <div className="flex items-center gap-2">
            <div className="grid h-11 w-11 place-items-center rounded bg-gradient-to-br from-[#384458] to-[#202234] text-white/52">
              <Image className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-white">{t('baseLayer')}</div>
              <div className="text-[11px] uppercase text-white/38">{t('viewportMaterial')}</div>
            </div>
            <Eye className="h-4 w-4 text-white/42" />
          </div>
        </div>
        {layers.length === 0 && (
          <div className="rounded-md border border-dashed border-white/12 px-3 py-2 text-xs leading-5 text-white/44">
            {t('noProjectedLayers')}
          </div>
        )}
        {layers.map((layer) => (
          <div
            key={layer.id}
            role="button"
            tabIndex={0}
            onClick={() => setActiveLayer(layer.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') setActiveLayer(layer.id);
            }}
            className={cn(
              'rounded-md border bg-white/[0.045] p-2 transition hover:bg-white/[0.075]',
              activeProjectedLayerId === layer.id ? 'border-liclick-pink/70 shadow-glow' : 'border-white/10',
            )}
          >
            <div className="flex gap-2">
              <img src={layer.imageUrl} alt="" className="h-11 w-11 rounded object-cover" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium text-white">{layer.name}</div>
                <div className="text-[11px] uppercase text-white/42">
                  {layer.type} {layer.captureId ? `/${layer.captureId.slice(0, 6)}` : ''}
                </div>
                {layer.isBaked && (
                  <div className="mt-1 inline-flex rounded bg-emerald-400/16 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-100">
                    {layer.needsRebake ? t('rebake') : t('baked')}
                  </div>
                )}
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={layer.opacity}
                  onPointerDown={() => captureHistory()}
                  onChange={(event) => setOpacity(layer.id, Number(event.target.value))}
                  className="mt-2 w-full accent-liclick-pink"
                />
              </div>
            </div>
            <div className="mt-1.5 flex items-center justify-end gap-1">
              <Button
                variant="ghost"
                className="h-7 w-7 px-0"
                onClick={(event) => {
                  event.stopPropagation();
                  captureHistory();
                  toggleLayer(layer.id);
                }}
                title={t('toggleVisibility')}
              >
                {layer.visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
              </Button>
              <Button
                variant="ghost"
                className="h-7 w-7 px-0"
                title={t('goToCamera')}
                disabled={!layer.camera}
                onClick={(event) => {
                  event.stopPropagation();
                  if (!layer.camera) return;
                  requestCameraRestore(layer.camera);
                  pushToast({
                    tone: 'info',
                    title: t('goToCamera'),
                  });
                }}
              >
                <Camera className="h-4 w-4" />
              </Button>
              <Button
                variant="danger"
                className="h-7 w-7 px-0"
                onClick={(event) => {
                  event.stopPropagation();
                  captureHistory();
                  deleteLayer(layer.id);
                }}
                title={t('deleteLayer')}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}
