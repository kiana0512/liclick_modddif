import { Box, Eye, MousePointer2 } from 'lucide-react';
import { Panel } from '@/components/ui/Panel';
import { useSceneStore } from '@/stores/sceneStore';

export function ObjectsPanel() {
  const objects = useSceneStore((state) => state.objects);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const selectObject = useSceneStore((state) => state.selectObject);

  return (
    <Panel title="Objects">
      <div className="space-y-2">
        {objects.length === 0 && (
          <div className="rounded-md border border-dashed border-white/15 p-3 text-sm text-white/48">
            No imported model yet.
          </div>
        )}
        {objects.map((object) => (
          <button
            key={object.id}
            type="button"
            onClick={() => selectObject(object.id)}
            className="flex w-full items-center gap-3 rounded-md border border-white/8 bg-white/[0.045] px-3 py-2 text-left hover:bg-white/[0.08]"
          >
            <Box className="h-4 w-4 text-liclick-pink" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-white">{object.name}</div>
              <div className="text-[11px] uppercase text-white/40">{object.format}</div>
            </div>
            {object.visible && <Eye className="h-4 w-4 text-white/45" />}
            {selectedObjectId === object.id && <MousePointer2 className="h-4 w-4 text-liclick-orange" />}
          </button>
        ))}
      </div>
    </Panel>
  );
}
