import { Camera, Eye, EyeOff, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/components/common/cn';
import { runComingSoonCommand } from '@/features/commandRegistry';
import { Panel } from '@/components/ui/Panel';
import { useLayerStore } from '@/stores/layerStore';
import { useSceneStore } from '@/stores/sceneStore';
import { useToastStore } from '@/stores/toastStore';

export function LayersPanel() {
  const layers = useLayerStore((state) => state.layers);
  const toggleLayer = useLayerStore((state) => state.toggleLayer);
  const setOpacity = useLayerStore((state) => state.setOpacity);
  const activeProjectedLayerId = useLayerStore((state) => state.activeProjectedLayerId);
  const setActiveLayer = useLayerStore((state) => state.setActiveLayer);
  const deleteLayer = useLayerStore((state) => state.deleteLayer);
  const requestCameraRestore = useSceneStore((state) => state.requestCameraRestore);
  const pushToast = useToastStore((state) => state.pushToast);

  return (
    <Panel title="Layers">
      <div className="space-y-2">
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
              <img src={layer.imageUrl} alt="" className="h-12 w-12 rounded object-cover" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-white">{layer.name}</div>
                <div className="text-[11px] uppercase text-white/42">
                  {layer.type} {layer.captureId ? `/${layer.captureId.slice(0, 6)}` : ''}
                </div>
                {layer.isBaked && (
                  <div className="mt-1 inline-flex rounded bg-emerald-400/16 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-100">
                    {layer.needsRebake ? 'Re-bake' : 'Baked'}
                  </div>
                )}
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={layer.opacity}
                  onChange={(event) => setOpacity(layer.id, Number(event.target.value))}
                  className="mt-2 w-full accent-liclick-pink"
                />
              </div>
            </div>
            <div className="mt-2 flex items-center justify-end gap-1">
              <Button
                variant="ghost"
                onClick={(event) => {
                  event.stopPropagation();
                  toggleLayer(layer.id);
                }}
                title="Toggle visibility"
              >
                {layer.visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
              </Button>
              <Button
                variant="ghost"
                title="Rename"
                onClick={(event) => {
                  event.stopPropagation();
                  runComingSoonCommand('renameLayer');
                }}
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                title="Go to camera"
                disabled={!layer.camera}
                onClick={(event) => {
                  event.stopPropagation();
                  if (!layer.camera) return;
                  requestCameraRestore(layer.camera);
                  pushToast({
                    tone: 'info',
                    title: 'Camera restored',
                    description: 'Viewport moved to the projected layer capture camera.',
                  });
                }}
              >
                <Camera className="h-4 w-4" />
              </Button>
              <Button
                variant="danger"
                onClick={(event) => {
                  event.stopPropagation();
                  deleteLayer(layer.id);
                }}
                title="Delete layer"
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
