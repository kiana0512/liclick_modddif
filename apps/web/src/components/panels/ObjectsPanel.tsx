import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  BarChart3,
  Box,
  Copy,
  Download,
  Eye,
  EyeOff,
  Image,
  LocateFixed,
  MoreVertical,
  Pencil,
  Plus,
  Scissors,
  Trash2,
  UnfoldHorizontal,
} from 'lucide-react';
import * as THREE from 'three';
import { GLTFExporter } from 'three-stdlib';
import { cn } from '@/components/common/cn';
import { Button } from '@/components/ui/Button';
import { downloadBlob, getExportFilename } from '@/engine/export/exportUtils';
import { getBoundingBoxForObject } from '@/engine/scene/boundingBoxUtils';
import { fitCameraToObjectId, transformFromObject } from '@/engine/scene/transformActions';
import { useEditorHistoryStore } from '@/stores/editorHistoryStore';
import { useT } from '@/stores/i18nStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSceneStore } from '@/stores/sceneStore';
import { useToastStore } from '@/stores/toastStore';
import type { ModelLoadResult } from '@/engine/loaders/modelImportTypes';
import type { SceneObject } from '@/types/model';
import type { ReferenceImage } from '@/types/project';
import { createId } from '@/utils/id';

type ObjectMenuState = {
  objectId: string;
  x: number;
  y: number;
  maxHeight: number;
};

type RenameState = {
  objectId: string;
  value: string;
};

type ObjectDialogState =
  | { type: 'statistics'; objectId: string }
  | { type: 'download'; objectId: string }
  | { type: 'simplify'; objectId: string }
  | { type: 'recreateUv'; objectId: string }
  | { type: 'references'; objectId: string };

type ObjectStats = {
  meshes: number;
  vertices: number;
  triangles: number;
  materials: number;
  uvMeshes: number;
  dimensions?: [number, number, number];
};

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(Math.round(value));
}

function getImportedModelForObject(objectId: string) {
  return useSceneStore.getState().importedModels.find((model) => model.objectId === objectId);
}

function countObjectStats(model?: ModelLoadResult): ObjectStats {
  const materialIds = new Set<string>();
  const stats: ObjectStats = {
    meshes: 0,
    vertices: 0,
    triangles: 0,
    materials: 0,
    uvMeshes: 0,
    dimensions: model ? [...model.boundingBox.size] as [number, number, number] : undefined,
  };
  if (!model) return stats;
  model.group.updateMatrixWorld(true);
  const liveBox = getBoundingBoxForObject(model.group);
  stats.dimensions = [...liveBox.size] as [number, number, number];
  model.group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    if (child.userData.liclickPaintOverlay || child.userData.liclickSelectionGlow) return;
    const geometry = child.geometry;
    const position = geometry.getAttribute('position');
    if (!position) return;
    stats.meshes += 1;
    stats.vertices += position.count;
    stats.triangles += geometry.index ? Math.floor(geometry.index.count / 3) : Math.floor(position.count / 3);
    if (geometry.getAttribute('uv')) stats.uvMeshes += 1;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => materialIds.add(material.uuid));
  });
  stats.materials = materialIds.size;
  return stats;
}

function cloneRuntimeModel(
  model: ModelLoadResult,
  object: SceneObject,
  duplicateName: string,
): { result: ModelLoadResult; object: SceneObject } {
  const objectId = createId('object');
  const group = model.group.clone(true);
  group.name = duplicateName;
  group.userData = { ...group.userData, liclickObjectId: objectId };
  group.traverse((child) => {
    child.userData = { ...child.userData, liclickObjectId: objectId };
  });
  group.position.x += Math.max(model.boundingBox.size[0], 0.2) * 0.12;
  group.updateMatrixWorld(true);
  const boundingBox = getBoundingBoxForObject(group);
  const duplicatedObject: SceneObject = {
    ...object,
    id: objectId,
    name: duplicateName,
    transform: transformFromObject(group),
    boundingBox,
    selected: true,
    visible: true,
  };
  const duplicatedResult: ModelLoadResult = {
    ...model,
    objectId,
    name: duplicateName,
    group,
    boundingBox,
  };
  return { result: duplicatedResult, object: duplicatedObject };
}

export function ObjectsPanel() {
  const t = useT();
  const objects = useSceneStore((state) => state.objects);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const selectObject = useSceneStore((state) => state.selectObject);
  const toggleObjectVisibility = useSceneStore((state) => state.toggleObjectVisibility);
  const renameObject = useSceneStore((state) => state.renameObject);
  const deleteObject = useSceneStore((state) => state.deleteObject);
  const setImportedModel = useSceneStore((state) => state.setImportedModel);
  const currentProject = useProjectStore((state) => state.getCurrentProject());
  const setProjectObjects = useProjectStore((state) => state.setProjectObjects);
  const updateCurrentProject = useProjectStore((state) => state.updateCurrentProject);
  const captureHistory = useEditorHistoryStore((state) => state.capture);
  const pushToast = useToastStore((state) => state.pushToast);
  const [menu, setMenu] = useState<ObjectMenuState>();
  const [renameState, setRenameState] = useState<RenameState>();
  const [dialog, setDialog] = useState<ObjectDialogState>();
  const [deleteCandidateId, setDeleteCandidateId] = useState<string>();

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
    window.requestAnimationFrame(() => fitCameraToObjectId(objectId));
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
    if (!object) return;
    captureHistory(`${t('objectDeleteHistory')}：${object?.name ?? t('model')}`);
    deleteObject(objectId);
    const scene = useSceneStore.getState();
    updateCurrentProject({ objects: scene.objects, activeObjectId: scene.selectedObjectId });
    setDeleteCandidateId(undefined);
  }

  function handleDuplicateObject(objectId: string) {
    const object = objects.find((item) => item.id === objectId);
    const model = getImportedModelForObject(objectId);
    if (!object || !model) {
      pushToast({ tone: 'warning', title: t('objectDuplicateFailed'), description: t('objectRuntimeModelMissing') });
      return;
    }
    captureHistory(`${t('objectDuplicateHistory')}：${object.name}`);
    const duplicated = cloneRuntimeModel(model, object, `${object.name} ${t('copySuffix')}`);
    setImportedModel(duplicated.result, duplicated.object);
    const scene = useSceneStore.getState();
    updateCurrentProject({ objects: scene.objects, activeObjectId: duplicated.object.id });
    window.requestAnimationFrame(() => fitCameraToObjectId(duplicated.object.id));
    pushToast({ tone: 'success', title: t('objectDuplicated'), description: duplicated.object.name });
  }

  async function handleDownloadObject(objectId: string) {
    const project = useProjectStore.getState().getCurrentProject();
    const model = getImportedModelForObject(objectId);
    const object = objects.find((item) => item.id === objectId);
    if (!project || !model || !object) {
      pushToast({ tone: 'warning', title: t('objectDownloadUnavailable'), description: t('objectRuntimeModelMissing') });
      return;
    }
    try {
      const exporter = new GLTFExporter();
      const result = await exporter.parseAsync(model.group.clone(true), { binary: true, onlyVisible: true, embedImages: true });
      const buffer = result instanceof ArrayBuffer ? result : JSON.stringify(result);
      const blob = new Blob([buffer], { type: 'model/gltf-binary' });
      downloadBlob(blob, getExportFilename(project.name, object.name || 'object', 'glb'));
      pushToast({ tone: 'success', title: t('objectDownloadStarted') });
    } catch (error) {
      pushToast({
        tone: 'error',
        title: t('objectDownloadFailed'),
        description: error instanceof Error ? error.message : t('tryAgainLater'),
      });
    }
  }

  function openObjectMenu(objectId: string, rect: DOMRect) {
    const menuWidth = 208;
    const menuHeight = 392;
    const margin = 8;
    const spaceBelow = window.innerHeight - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    const openAbove = spaceBelow < menuHeight && spaceAbove > spaceBelow;
    const availableHeight = Math.max(180, Math.min(menuHeight, openAbove ? spaceAbove - 6 : spaceBelow - 6));
    const y = openAbove ? rect.top - availableHeight - 6 : rect.bottom + 6;
    setMenu({
      objectId,
      x: Math.min(Math.max(margin, rect.right - menuWidth), window.innerWidth - menuWidth - margin),
      y: Math.min(Math.max(margin, y), window.innerHeight - availableHeight - margin),
      maxHeight: availableHeight,
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
            maxHeight={menu.maxHeight}
            object={objects.find((object) => object.id === menu.objectId)}
            onClose={() => setMenu(undefined)}
            onRename={(object) => setRenameState({ objectId: object.id, value: object.name })}
            onDuplicate={() => handleDuplicateObject(menu.objectId)}
            onFocus={() => handleSelectObject(menu.objectId)}
            onDialog={(type) => setDialog({ type, objectId: menu.objectId })}
            onDelete={() => setDeleteCandidateId(menu.objectId)}
          />,
          document.body,
        )}
      {dialog &&
        createPortal(
          <ObjectDialog
            state={dialog}
            object={objects.find((object) => object.id === dialog.objectId)}
            model={getImportedModelForObject(dialog.objectId)}
            references={currentProject?.references ?? []}
            onClose={() => setDialog(undefined)}
            onDownload={() => void handleDownloadObject(dialog.objectId)}
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
      {deleteCandidateId &&
        createPortal(
          <DeleteObjectConfirmDialog
            object={objects.find((object) => object.id === deleteCandidateId)}
            onClose={() => setDeleteCandidateId(undefined)}
            onConfirm={() => handleDeleteObject(deleteCandidateId)}
          />,
          document.body,
        )}
    </div>
  );
}

function DeleteObjectConfirmDialog({
  object,
  onClose,
  onConfirm,
}: {
  object?: SceneObject;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  if (!object) return null;

  return (
    <div
      className="fixed inset-0 z-[98] grid place-items-center bg-black/58 px-4 backdrop-blur-sm"
      onPointerDown={onClose}
    >
      <section
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-object-title"
        aria-describedby="delete-object-description"
        className="w-full max-w-md overflow-hidden rounded-lg border border-white/16 bg-[#17171f] shadow-[0_24px_70px_rgba(0,0,0,0.62)]"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-white/12 px-4 py-4">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-rose-300/20 bg-rose-500/12 text-rose-200">
            <Trash2 className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 id="delete-object-title" className="text-base font-semibold text-white">
              {t('objectDeleteHistory')}
            </h2>
            <div className="truncate text-xs text-white/48">{object.name}</div>
          </div>
        </div>
        <div className="px-4 py-4">
          <p id="delete-object-description" className="text-sm leading-6 text-white/64">
            {t('objectDeleteConfirm').replace('{name}', object.name)}
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button type="button" variant="danger" onClick={onConfirm} autoFocus>
              {t('delete')}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}

export function ObjectsPanelActions({ onImportModelClick }: { onImportModelClick?: () => void }) {
  const t = useT();
  const objects = useSceneStore((state) => state.objects);
  const setAllObjectsVisible = useSceneStore((state) => state.setAllObjectsVisible);
  const arrangeImportedModels = useSceneStore((state) => state.arrangeImportedModels);
  const setProjectObjects = useProjectStore((state) => state.setProjectObjects);
  const captureHistory = useEditorHistoryStore((state) => state.capture);
  const pushToast = useToastStore((state) => state.pushToast);
  const allVisible = objects.length > 0 && objects.every((object) => object.visible);

  function handleToggleAllVisibility() {
    if (objects.length === 0) return;
    captureHistory(allVisible ? '隐藏全部对象' : '显示全部对象');
    setAllObjectsVisible(!allVisible);
    setProjectObjects(useSceneStore.getState().objects);
  }

  function handleArrangeModels() {
    if (objects.length === 0) return;
    captureHistory(t('arrangeModels'));
    arrangeImportedModels();
    setProjectObjects(useSceneStore.getState().objects);
    pushToast({
      tone: 'success',
      title: t('modelsArranged'),
      description: 'Ctrl+Shift+A',
      dedupeKey: 'models-arranged',
    });
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
        onClick={handleArrangeModels}
        disabled={objects.length === 0}
        className="grid h-7 w-7 place-items-center rounded text-white transition hover:bg-liclick-pink/18 hover:text-liclick-pink disabled:cursor-not-allowed disabled:opacity-35"
        title={`${t('arrangeModels')} (Ctrl+Shift+A)`}
        aria-label={`${t('arrangeModels')} (Ctrl+Shift+A)`}
      >
        <UnfoldHorizontal className="h-4 w-4" />
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
  maxHeight,
  object,
  onClose,
  onRename,
  onDuplicate,
  onFocus,
  onDialog,
  onDelete,
}: {
  x: number;
  y: number;
  maxHeight: number;
  object?: SceneObject;
  onClose: () => void;
  onRename: (object: SceneObject) => void;
  onDuplicate: () => void;
  onFocus: () => void;
  onDialog: (type: ObjectDialogState['type']) => void;
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
      style={{ left: x, top: y, maxHeight, overflowY: 'auto' }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="truncate px-2 pb-2 text-white/86">{object.name}</div>
      <div className="mb-1 h-px bg-white/24" />
      <MenuButton onClick={() => run(() => onDialog('statistics'))} icon={<BarChart3 className="h-4 w-4" />}>
        {t('objectMenuStatistics')}
      </MenuButton>
      <MenuButton onClick={() => run(() => onDialog('download'))} icon={<Download className="h-4 w-4" />}>
        {t('objectMenuDownload')}
      </MenuButton>
      <MenuButton onClick={() => run(() => onDialog('simplify'))} icon={<Scissors className="h-4 w-4" />}>
        {t('objectMenuSimplify')}
      </MenuButton>
      <MenuButton onClick={() => run(() => onDialog('recreateUv'))} icon={<UnfoldHorizontal className="h-4 w-4" />}>
        {t('objectMenuRecreateUv')}
      </MenuButton>
      <MenuButton onClick={() => run(() => onDialog('references'))} icon={<Image className="h-4 w-4" />}>
        {t('objectMenuViewReferenceImage')}
      </MenuButton>
      <MenuButton onClick={() => run(onDuplicate)} icon={<Copy className="h-4 w-4" />}>
        {t('duplicate')}
      </MenuButton>
      <MenuButton onClick={() => run(() => onRename(object))} icon={<Pencil className="h-4 w-4" />}>
        {t('rename')}
      </MenuButton>
      <MenuButton onClick={() => run(onFocus)} icon={<LocateFixed className="h-4 w-4" />}>
        {t('objectMenuFocus')}
      </MenuButton>
      <MenuButton onClick={() => run(onDelete)} icon={<Trash2 className="h-4 w-4" />}>
        {t('delete')}
      </MenuButton>
    </div>
  );
}

function ObjectDialog({
  state,
  object,
  model,
  references,
  onClose,
  onDownload,
}: {
  state: ObjectDialogState;
  object?: SceneObject;
  model?: ModelLoadResult;
  references: ReferenceImage[];
  onClose: () => void;
  onDownload: () => void;
}) {
  const t = useT();
  if (!object) return null;
  const stats = countObjectStats(model);
  const title =
    state.type === 'statistics'
      ? t('objectMenuStatistics')
      : state.type === 'download'
        ? t('objectMenuDownload')
        : state.type === 'simplify'
          ? t('objectMenuSimplify')
          : state.type === 'recreateUv'
            ? t('objectMenuRecreateUv')
            : t('objectMenuViewReferenceImage');

  return (
    <div className="fixed inset-0 z-[96] grid place-items-center bg-black/52 px-4 backdrop-blur-sm" onPointerDown={onClose}>
      <section
        className="max-h-[82vh] w-full max-w-xl overflow-hidden rounded-lg border border-white/16 bg-[#17171f] shadow-[0_24px_70px_rgba(0,0,0,0.58)]"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="flex h-12 items-center justify-between border-b border-white/12 px-4">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-white">{title}</div>
            <div className="truncate text-[11px] text-white/48">{object.name}</div>
          </div>
          <button
            type="button"
            className="h-8 rounded-md px-3 text-xs font-semibold text-white/64 hover:bg-white/8"
            onClick={onClose}
          >
            {t('close')}
          </button>
        </div>
        <div className="max-h-[calc(82vh-48px)] overflow-auto p-4">
          {state.type === 'statistics' && <StatisticsDialogBody object={object} stats={stats} />}
          {state.type === 'download' && <DownloadDialogBody onDownload={onDownload} />}
          {state.type === 'simplify' && <SimplifyDialogBody stats={stats} />}
          {state.type === 'recreateUv' && <RecreateUvDialogBody object={object} />}
          {state.type === 'references' && <ReferencesDialogBody references={references} />}
        </div>
      </section>
    </div>
  );
}

function StatisticsDialogBody({ object, stats }: { object: SceneObject; stats: ObjectStats }) {
  const t = useT();
  const dimensions = stats.dimensions?.map((value) => value.toFixed(2)).join(' x ') ?? '-';
  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-2">
        <StatTile label={t('objectMeshes')} value={formatNumber(stats.meshes)} />
        <StatTile label={t('objectTriangles')} value={formatNumber(stats.triangles)} />
        <StatTile label={t('objectVertices')} value={formatNumber(stats.vertices)} />
        <StatTile label={t('objectMaterials')} value={formatNumber(stats.materials)} />
      </div>
      <div className="rounded-md border border-white/12 bg-black/24 p-3 text-xs leading-6 text-white/72">
        <div>{t('format')}: {object.format.toUpperCase()}</div>
        <div>{t('objectUvMeshes')}: {formatNumber(stats.uvMeshes)}</div>
        <div>{t('objectDimensions')}: {dimensions}</div>
        <div className="truncate">{t('objectSource')}: {object.sourcePath ?? t('objectRuntimeSource')}</div>
      </div>
    </div>
  );
}

function DownloadDialogBody({ onDownload }: { onDownload: () => void }) {
  const t = useT();
  return (
    <div className="grid gap-3 text-sm text-white/72">
      <p>{t('objectDownloadHelp')}</p>
      <button
        type="button"
        className="h-9 justify-self-start rounded-md bg-white px-4 text-sm font-semibold text-black hover:bg-white/90"
        onClick={onDownload}
      >
        {t('objectDownloadGlb')}
      </button>
    </div>
  );
}

function SimplifyDialogBody({ stats }: { stats: ObjectStats }) {
  const t = useT();
  return (
    <div className="grid gap-3 text-sm leading-6 text-white/72">
      <p>{t('objectSimplifyHelp')}</p>
      <div className="rounded-md border border-white/12 bg-black/24 p-3 text-xs">
        {t('objectSimplifyBudget')
          .replace('{triangles}', formatNumber(stats.triangles))
          .replace('{vertices}', formatNumber(stats.vertices))}
      </div>
      <button type="button" disabled className="h-9 justify-self-start rounded-md border border-white/18 px-4 text-sm font-semibold text-white/38">
        {t('objectSimplifyComingSoon')}
      </button>
    </div>
  );
}

function RecreateUvDialogBody({ object }: { object: SceneObject }) {
  const t = useT();
  return (
    <div className="grid gap-3 text-sm leading-6 text-white/72">
      <p>{t('objectRecreateUvHelp')}</p>
      <div className="rounded-md border border-white/12 bg-black/24 p-3 text-xs">
        {t('objectUvSets')}: {object.uvSets.length > 0 ? object.uvSets.join(', ') : t('objectUvNoneDetected')}
      </div>
      <button type="button" disabled className="h-9 justify-self-start rounded-md border border-white/18 px-4 text-sm font-semibold text-white/38">
        {t('objectUvServiceMissing')}
      </button>
    </div>
  );
}

function ReferencesDialogBody({ references }: { references: ReferenceImage[] }) {
  const t = useT();
  if (references.length === 0) {
    return <div className="rounded-md border border-white/12 bg-black/24 p-4 text-sm text-white/58">{t('objectNoReferenceImages')}</div>;
  }
  return (
    <div className="grid grid-cols-3 gap-3">
      {references.map((reference) => (
        <div key={reference.id} className="overflow-hidden rounded-md border border-white/14 bg-black/24">
          <div className="aspect-square bg-[#333]">
            <img src={reference.url} alt={reference.name} className="h-full w-full object-contain" />
          </div>
          <div className="truncate px-2 py-1 text-xs font-semibold text-white/72">{reference.name}</div>
        </div>
      ))}
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-white/12 bg-black/24 p-3">
      <div className="text-[11px] font-semibold uppercase tracking-normal text-white/42">{label}</div>
      <div className="mt-1 text-lg font-semibold text-white">{value}</div>
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
