import { Box, Eye, EyeOff, MoreVertical, Plus } from 'lucide-react';
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
  const updateCurrentProject = useProjectStore((state) => state.updateCurrentProject);
  const captureHistory = useEditorHistoryStore((state) => state.capture);

  function handleSelectObject(objectId: string) {
    selectObject(objectId);
    updateCurrentProject({ objects: useSceneStore.getState().objects, activeObjectId: objectId });
  }

  function handleToggleVisibility(objectId: string) {
    captureHistory();
    toggleObjectVisibility(objectId);
    setProjectObjects(useSceneStore.getState().objects);
  }

  if (objects.length === 0) {
    return (
      <div className="grid min-h-48 place-items-center text-sm font-semibold text-white/48">
        {t('noImportedModel')}
      </div>
    );
  }

  return (
    <div className="min-h-48 overflow-hidden rounded-md border border-white/24">
      {objects.map((object) => {
        const selected = selectedObjectId === object.id;
        return (
          <div
            key={object.id}
            role="button"
            tabIndex={0}
            onClick={() => handleSelectObject(object.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') handleSelectObject(object.id);
            }}
            className={cn(
              'flex h-10 w-full items-center gap-2 border-b border-white/24 bg-black/82 px-2 text-left transition hover:bg-white/[0.06]',
              selected && 'border-liclick-pink bg-liclick-pink/12 text-white shadow-[inset_0_0_0_1px_rgba(255,92,207,0.44)]',
              !object.visible && 'opacity-48',
            )}
          >
            <button
              type="button"
              className="grid h-7 w-7 shrink-0 place-items-center rounded text-white transition hover:bg-white/10"
              onClick={(event) => {
                event.stopPropagation();
                handleToggleVisibility(object.id);
              }}
              title={t('toggleVisibility')}
              aria-label={t('toggleVisibility')}
            >
              {object.visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4 text-white/45" />}
            </button>
            <Box className="h-4 w-4 shrink-0 text-liclick-pink" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-white">{object.name}</div>
            </div>
            <button
              type="button"
              className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-white transition hover:bg-white/18"
              aria-label={t('objectActions')}
              title={t('objectActions')}
              onClick={(event) => event.stopPropagation()}
            >
              <MoreVertical className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function ObjectsPanelActions() {
  const t = useT();
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        className="grid h-7 w-7 place-items-center rounded text-white transition hover:bg-liclick-pink/18 hover:text-liclick-pink"
        title={t('toggleVisibility')}
        aria-label={t('toggleVisibility')}
      >
        <Eye className="h-4 w-4" />
      </button>
      <button
        type="button"
        className="grid h-7 w-7 place-items-center rounded text-white transition hover:bg-liclick-pink/18 hover:text-liclick-pink"
        title={t('importModel')}
        aria-label={t('importModel')}
      >
        <Plus className="h-4 w-4" />
      </button>
    </div>
  );
}
