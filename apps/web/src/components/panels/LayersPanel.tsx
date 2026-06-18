import { Camera, Eye, EyeOff, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Panel } from '@/components/ui/Panel';
import { useLayerStore } from '@/stores/layerStore';

export function LayersPanel() {
  const layers = useLayerStore((state) => state.layers);
  const toggleLayer = useLayerStore((state) => state.toggleLayer);
  const setOpacity = useLayerStore((state) => state.setOpacity);
  const deleteLayer = useLayerStore((state) => state.deleteLayer);

  return (
    <Panel title="Layers">
      <div className="space-y-2">
        {layers.map((layer) => (
          <div key={layer.id} className="rounded-md border border-white/10 bg-white/[0.045] p-2">
            <div className="flex gap-2">
              <img src={layer.imageUrl} alt="" className="h-12 w-12 rounded object-cover" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-white">{layer.name}</div>
                <div className="text-[11px] uppercase text-white/42">{layer.type}</div>
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
              <Button variant="ghost" onClick={() => toggleLayer(layer.id)} title="Toggle visibility">
                {layer.visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
              </Button>
              <Button variant="ghost" title="Rename">
                <Pencil className="h-4 w-4" />
              </Button>
              <Button variant="ghost" title="Go to camera">
                <Camera className="h-4 w-4" />
              </Button>
              <Button variant="danger" onClick={() => deleteLayer(layer.id)} title="Delete layer">
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}
