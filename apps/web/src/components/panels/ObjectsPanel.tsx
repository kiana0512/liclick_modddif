import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Box, Check, Eye, EyeOff, MoreVertical, Pencil, Plus, Trash2 } from 'lucide-react';
import { cn } from '@/components/common/cn';
import { useEditorHistoryStore } from '@/stores/editorHistoryStore';
import { useT } from '@/stores/i18nStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSceneStore } from '@/stores/sceneStore';
import type { SceneObject } from '@/types/model';

type ObjectMenuState = {
  objectId: string;
  x: number;
  y: number;
};

type RenameState = {
  objectId: string;
  value: string;
};

export function ObjectsPanel() {
  const t = useT();
  const objects = useSceneStore((state) => state.objects);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const selectObject = useSceneStore((state) => state.selectObject);
  const toggleObjectVisibility = useSceneStore((state) => state.toggleObjectVisibility);
  const renameObject = useSceneStore((state) => state.renameObject);
  const deleteObject = useSceneStore((state) => state.deleteObject);
  const setProjectObjects = useProjectStore((state) => state.setProjectObjects);
  const updateCurrentProject = useProjectStore((state) => state.updateCurrentProject);
  const captureHistory = useEditorHistoryStore((state) => state.capture);
  const [menu, setMenu] = useState<ObjectMenuState>();
  const [renameState, setRenameState] = useState<RenameState>();

  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(undefined);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(undefined);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [menu]);

  function handleSelectObject(objectId: string) {
    selectObject(objectId);
    updateCurrentProject({ objects: useSceneStore.getState().objects, activeObjectId: objectId });
  }

  function handleToggleVisibility(objectId: string) {
    const object = objects.find((item) => item.id === objectId);
    captureHistory(`${object?.visible ? '隐藏' : '显示'}对象：${object?.name ?? '模型'}`);
    toggleObjectVisibility(objectId);
    setProjectObjects(useSceneStore.getState().objects);
  }

  function handleRenameObject() {
    if (!renameState) return;
    const name = renameState.value.trim();
    const object = objects.find((item) => item.id === renameState.objectId);
    if (!object || !name || object.name === name) {
      setRenameState(undefined);
      return;
    }
    captureHistory(`重命名对象：${object.name} -> ${name}`);
    renameObject(renameState.objectId, name);
    setProjectObjects(useSceneStore.getState().objects);
    setRenameState(undefined);
  }

  function handleDeleteObject(objectId: string) {
    const object = objects.find((item) => item.id === objectId);
    captureHistory(`删除对象：${object?.name ?? '模型'}`);
    deleteObject(objectId);
    const scene = useSceneStore.getState();
    updateCurrentProject({ objects: scene.objects, activeObjectId: scene.selectedObjectId });
  }

  function openObjectMenu(objectId: string, rect: DOMRect) {
    const menuWidth = 208;
    const menuHeight = 190;
    setMenu({
      objectId,
      x: Math.min(Math.max(8, rect.right - menuWidth), window.innerWidth - menuWidth - 8),
      y: Math.min(Math.max(8, rect.bottom + 6), window.innerHeight - menuHeight - 8),
    });
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
              onClick={(event) => {
                event.stopPropagation();
                openObjectMenu(object.id, event.currentTarget.getBoundingClientRect());
              }}
            >
              <MoreVertical className="h-4 w-4" />
            </button>
          </div>
        );
      })}
      {menu &&
        createPortal(
          <ObjectMenu
            x={menu.x}
            y={menu.y}
            object={objects.find((object) => object.id === menu.objectId)}
            selected={selectedObjectId === menu.objectId}
            onClose={() => setMenu(undefined)}
            onSelect={() => handleSelectObject(menu.objectId)}
            onToggleVisibility={() => handleToggleVisibility(menu.objectId)}
            onRename={(object) => setRenameState({ objectId: object.id, value: object.name })}
            onDelete={() => handleDeleteObject(menu.objectId)}
          />,
          document.body,
        )}
      {renameState &&
        createPortal(
          <div className="fixed inset-0 z-[95] grid place-items-center bg-black/48 px-4 backdrop-blur-sm">
            <form
              className="w-full max-w-sm rounded-lg border border-white/16 bg-[#17171f] p-4 shadow-[0_24px_70px_rgba(0,0,0,0.58)]"
              onSubmit={(event) => {
                event.preventDefault();
                handleRenameObject();
              }}
            >
              <div className="mb-3 text-sm font-semibold text-white">{t('rename')}</div>
              <input
                autoFocus
                value={renameState.value}
                onChange={(event) => setRenameState({ ...renameState, value: event.target.value })}
                className="h-10 w-full rounded-md border border-white/30 bg-black/38 px-3 text-sm text-white outline-none focus:border-liclick-pink"
              />
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  className="h-9 rounded-md px-3 text-sm font-semibold text-white/68 hover:bg-white/8"
                  onClick={() => setRenameState(undefined)}
                >
                  {t('cancel')}
                </button>
                <button
                  type="submit"
                  className="h-9 rounded-md bg-white px-3 text-sm font-semibold text-black hover:bg-white/90"
                >
                  {t('rename')}
                </button>
              </div>
            </form>
          </div>,
          document.body,
        )}
    </div>
  );
}

export function ObjectsPanelActions({ onImportModelClick }: { onImportModelClick?: () => void }) {
  const t = useT();
  const objects = useSceneStore((state) => state.objects);
  const setAllObjectsVisible = useSceneStore((state) => state.setAllObjectsVisible);
  const setProjectObjects = useProjectStore((state) => state.setProjectObjects);
  const captureHistory = useEditorHistoryStore((state) => state.capture);
  const allVisible = objects.length > 0 && objects.every((object) => object.visible);

  function handleToggleAllVisibility() {
    if (objects.length === 0) return;
    captureHistory(allVisible ? '隐藏全部对象' : '显示全部对象');
    setAllObjectsVisible(!allVisible);
    setProjectObjects(useSceneStore.getState().objects);
  }

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={handleToggleAllVisibility}
        disabled={objects.length === 0}
        className="grid h-7 w-7 place-items-center rounded text-white transition hover:bg-liclick-pink/18 hover:text-liclick-pink"
        title={t('toggleVisibility')}
        aria-label={t('toggleVisibility')}
      >
        {allVisible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4 text-white/55" />}
      </button>
      <button
        type="button"
        onClick={onImportModelClick}
        className="grid h-7 w-7 place-items-center rounded text-white transition hover:bg-liclick-pink/18 hover:text-liclick-pink"
        title={t('importModel')}
        aria-label={t('importModel')}
      >
        <Plus className="h-4 w-4" />
      </button>
    </div>
  );
}

function ObjectMenu({
  x,
  y,
  object,
  selected,
  onClose,
  onSelect,
  onToggleVisibility,
  onRename,
  onDelete,
}: {
  x: number;
  y: number;
  object?: SceneObject;
  selected: boolean;
  onClose: () => void;
  onSelect: () => void;
  onToggleVisibility: () => void;
  onRename: (object: SceneObject) => void;
  onDelete: () => void;
}) {
  const t = useT();
  if (!object) return null;

  function run(action: () => void) {
    action();
    onClose();
  }

  return (
    <div
      className="fixed z-[90] w-52 rounded-md border border-white/18 bg-[#1f1f20] p-2 text-sm text-white shadow-[0_18px_50px_rgba(0,0,0,0.45)]"
      style={{ left: x, top: y }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="truncate px-2 pb-2 text-white/86">{object.name}</div>
      <div className="mb-1 h-px bg-white/24" />
      <MenuButton onClick={() => run(onSelect)} icon={selected ? <Check className="h-4 w-4" /> : <Box className="h-4 w-4" />}>
        {t('select')}
      </MenuButton>
      <MenuButton
        onClick={() => run(onToggleVisibility)}
        icon={object.visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
      >
        {t('toggleVisibility')}
      </MenuButton>
      <MenuButton onClick={() => run(() => onRename(object))} icon={<Pencil className="h-4 w-4" />}>
        {t('rename')}
      </MenuButton>
      <MenuButton onClick={() => run(onDelete)} icon={<Trash2 className="h-4 w-4" />}>
        {t('delete')}
      </MenuButton>
    </div>
  );
}

function MenuButton({ children, icon, onClick }: { children: ReactNode; icon?: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-9 w-full items-center gap-2 rounded px-2 text-left font-medium text-white transition hover:bg-white/10"
    >
      {icon}
      {children}
    </button>
  );
}
