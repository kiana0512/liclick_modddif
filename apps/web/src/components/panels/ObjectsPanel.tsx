import { AlertTriangle, Box, Eye, EyeOff, MousePointer2 } from 'lucide-react';
import { Panel } from '@/components/ui/Panel';
import { cn } from '@/components/common/cn';
import { useEditorHistoryStore } from '@/stores/editorHistoryStore';
import { useT } from '@/stores/i18nStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSceneStore } from '@/stores/sceneStore';

export function ObjectsPanel() {
  const t = useT();
  const objects = useSceneStore((state) => state.objects);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const selectObject = useSceneStore((state) => state.selectObject);
  const toggleObjectVisibility = useSceneStore((state) => state.toggleObjectVisibility);
  const setProjectObjects = useProjectStore((state) => state.setProjectObjects);
  const captureHistory = useEditorHistoryStore((state) => state.capture);

  function handleToggleVisibility(objectId: string) {
    captureHistory();
    toggleObjectVisibility(objectId);
    setProjectObjects(useSceneStore.getState().objects);
  }

  return (
    <Panel title={t('objectsPanel')}>
      <div className="space-y-2">
        {objects.length === 0 && (
          <div className="rounded-md border border-dashed border-white/15 p-3 text-sm text-white/48">
            {t('noImportedModel')}
          </div>
        )}
        {objects.map((object) => {
          const selected = selectedObjectId === object.id;
          const hasNoUv = object.uvSets.length === 0;
          return (
          <div
            key={object.id}
            role="button"
            tabIndex={0}
            onClick={() => selectObject(object.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') selectObject(object.id);
            }}
            className={cn(
              'flex w-full items-center gap-2 rounded-md border bg-white/[0.045] px-2.5 py-2 text-left hover:bg-white/[0.08]',
              selected ? 'border-liclick-pink/70 shadow-glow' : 'border-white/8',
              !object.visible && 'opacity-48',
            )}
          >
            <Box className="h-4 w-4 text-liclick-pink" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] text-white">{object.name}</div>
              <div className="text-[11px] uppercase text-white/40">
                {object.format}
                {object.childMeshCount ? ` / ${object.childMeshCount} ${t('mesh')}` : ''}
              </div>
            </div>
            {(hasNoUv || (object.warnings && object.warnings.length > 0)) && (
              <AlertTriangle className="h-4 w-4 text-amber-300" />
            )}
            <button
              type="button"
              className="grid h-7 w-7 place-items-center rounded text-white/45 transition hover:bg-white/10 hover:text-white"
              onClick={(event) => {
                event.stopPropagation();
                handleToggleVisibility(object.id);
              }}
              title={t('toggleVisibility')}
              aria-label={t('toggleVisibility')}
            >
              {object.visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
            </button>
            {selected && <MousePointer2 className="h-4 w-4 text-liclick-orange" />}
          </div>
          );
        })}
      </div>
    </Panel>
  );
}
