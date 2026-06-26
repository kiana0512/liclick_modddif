import {
  useEffect,
  useMemo,
  useState,
  type DragEventHandler,
  type MouseEventHandler,
  type PointerEventHandler,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Circle, CircleDot, Copy, Download, Eye, EyeOff, Focus, MoreVertical, PaintBucket, Plus, Trash2 } from 'lucide-react';
import { cn } from '@/components/common/cn';
import { useEditorHistoryStore } from '@/stores/editorHistoryStore';
import { useLayerStore } from '@/stores/layerStore';
import { useSceneStore } from '@/stores/sceneStore';
import { useT } from '@/stores/i18nStore';
import type { Layer } from '@/types/layer';
import { downloadImageAsset } from '@/utils/downloadImage';

type MenuState = {
  layerId: string;
  x: number;
  y: number;
};

type RenameState = {
  layerId: string;
  value: string;
};

type VisibilityDrag = {
  visible: boolean;
  touched: Set<string>;
};

const checkerStyle = {
  backgroundColor: '#d6d6d6',
  backgroundImage:
    'linear-gradient(45deg, #9e9e9e 25%, transparent 25%), linear-gradient(-45deg, #9e9e9e 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #9e9e9e 75%), linear-gradient(-45deg, transparent 75%, #9e9e9e 75%)',
  backgroundPosition: '0 0, 0 7px, 7px -7px, -7px 0',
  backgroundSize: '14px 14px',
};

type LayersPanelProps = {
  onLayerDoubleClick?: (layer: Layer) => void;
};

export function LayersPanel({ onLayerDoubleClick }: LayersPanelProps = {}) {
  const t = useT();
  const layers = useLayerStore((state) => state.layers);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const setLayerVisibility = useLayerStore((state) => state.setLayerVisibility);
  const setOpacity = useLayerStore((state) => state.setOpacity);
  const setBlendMode = useLayerStore((state) => state.setBlendMode);
  const activeProjectedLayerId = useLayerStore((state) => state.activeProjectedLayerId);
  const setActiveLayer = useLayerStore((state) => state.setActiveLayer);
  const deleteLayer = useLayerStore((state) => state.deleteLayer);
  const duplicateLayer = useLayerStore((state) => state.duplicateLayer);
  const renameLayer = useLayerStore((state) => state.renameLayer);
  const moveLayer = useLayerStore((state) => state.moveLayer);
  const reorderLayer = useLayerStore((state) => state.reorderLayer);
  const captureHistory = useEditorHistoryStore((state) => state.capture);
  const [menu, setMenu] = useState<MenuState>();
  const [renameState, setRenameState] = useState<RenameState>();
  const [draggingLayerId, setDraggingLayerId] = useState<string>();
  const [visibilityDrag, setVisibilityDrag] = useState<VisibilityDrag>();
  const [hoveredLayerId, setHoveredLayerId] = useState<string>();
  const [previewLayerId, setPreviewLayerId] = useState<string>();
  const [isShiftPressed, setIsShiftPressed] = useState(false);
  const [selectedLayerIds, setSelectedLayerIds] = useState<string[]>(() =>
    activeProjectedLayerId ? [activeProjectedLayerId] : [],
  );
  const [lastSelectedLayerId, setLastSelectedLayerId] = useState<string | undefined>(activeProjectedLayerId);
  const visibleLayers = useMemo(
    () => layers.filter((layer) => !layer.objectId || layer.objectId === selectedObjectId),
    [layers, selectedObjectId],
  );
  const layerIds = useMemo(() => visibleLayers.map((layer) => layer.id), [visibleLayers]);
  const previewLayer = useMemo(() => {
    const layerId = previewLayerId ?? (isShiftPressed ? hoveredLayerId ?? lastSelectedLayerId ?? activeProjectedLayerId : undefined);
    return visibleLayers.find((layer) => layer.id === layerId && layer.imageUrl);
  }, [activeProjectedLayerId, hoveredLayerId, isShiftPressed, lastSelectedLayerId, previewLayerId, visibleLayers]);

  useEffect(() => {
    setSelectedLayerIds((ids) => ids.filter((id) => layerIds.includes(id)));
  }, [layerIds]);

  useEffect(() => {
    if (!activeProjectedLayerId || visibleLayers.some((layer) => layer.id === activeProjectedLayerId)) return;
    const nextActiveLayer = visibleLayers.find((layer) => layer.type === 'projected');
    if (nextActiveLayer) {
      setActiveLayer(nextActiveLayer.id);
      setSelectedLayerIds([nextActiveLayer.id]);
      setLastSelectedLayerId(nextActiveLayer.id);
    } else {
      setSelectedLayerIds([]);
      setLastSelectedLayerId(undefined);
    }
  }, [activeProjectedLayerId, setActiveLayer, visibleLayers]);

  useEffect(() => {
    if (!activeProjectedLayerId || selectedLayerIds.length > 0) return;
    setSelectedLayerIds([activeProjectedLayerId]);
    setLastSelectedLayerId(activeProjectedLayerId);
  }, [activeProjectedLayerId, selectedLayerIds.length]);

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

  useEffect(() => {
    if (!visibilityDrag) return undefined;
    const stopDrag = () => setVisibilityDrag(undefined);
    const continueFromPointer = (event: PointerEvent) => {
      const element = document.elementFromPoint(event.clientX, event.clientY);
      const trigger = element?.closest<HTMLElement>('[data-layer-visibility-id]');
      const layerId = trigger?.dataset.layerVisibilityId;
      if (!layerId) return;
      setVisibilityDrag((current) => {
        if (!current || current.touched.has(layerId)) return current;
        setLayerVisibility([layerId], current.visible);
        return { visible: current.visible, touched: new Set([...current.touched, layerId]) };
      });
    };
    window.addEventListener('pointermove', continueFromPointer);
    window.addEventListener('pointerup', stopDrag);
    window.addEventListener('pointercancel', stopDrag);
    return () => {
      window.removeEventListener('pointermove', continueFromPointer);
      window.removeEventListener('pointerup', stopDrag);
      window.removeEventListener('pointercancel', stopDrag);
    };
  }, [setLayerVisibility, visibilityDrag]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Shift') setIsShiftPressed(true);
      if (event.key === 'Escape') {
        setPreviewLayerId(undefined);
        setRenameState(undefined);
        setIsShiftPressed(false);
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Shift') setIsShiftPressed(false);
    };
    const handleBlur = () => {
      setPreviewLayerId(undefined);
      setIsShiftPressed(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, []);

  function commitRename() {
    if (!renameState) return;
    const nextName = renameState.value.trim();
    const layer = layers.find((item) => item.id === renameState.layerId);
    if (!layer || !nextName || nextName === layer.name) {
      setRenameState(undefined);
      return;
    }
    captureHistory();
    renameLayer(renameState.layerId, nextName);
    setRenameState(undefined);
  }

  function selectLayer(layerId: string, event: React.MouseEvent<HTMLDivElement>) {
    setActiveLayer(layerId);
    setLastSelectedLayerId(layerId);

    if (event.shiftKey && lastSelectedLayerId) {
      const start = layerIds.indexOf(lastSelectedLayerId);
      const end = layerIds.indexOf(layerId);
      if (start >= 0 && end >= 0) {
        const [from, to] = start < end ? [start, end] : [end, start];
        setSelectedLayerIds(layerIds.slice(from, to + 1));
        return;
      }
    }

    if (event.ctrlKey || event.metaKey) {
      setSelectedLayerIds((ids) =>
        ids.includes(layerId) ? ids.filter((id) => id !== layerId) : [...ids, layerId],
      );
      return;
    }

    setSelectedLayerIds([layerId]);
  }

  function getAffectedLayerIds(layerId: string) {
    return selectedLayerIds.includes(layerId) && selectedLayerIds.length > 1 ? selectedLayerIds : [layerId];
  }

  function beginVisibilityDrag(layer: Layer) {
    const nextVisible = !layer.visible;
    const ids = getAffectedLayerIds(layer.id);
    captureHistory();
    setLayerVisibility(ids, nextVisible);
    setVisibilityDrag({ visible: nextVisible, touched: new Set(ids) });
  }

  function continueVisibilityDrag(layerId: string) {
    if (!visibilityDrag || visibilityDrag.touched.has(layerId)) return;
    visibilityDrag.touched.add(layerId);
    setLayerVisibility([layerId], visibilityDrag.visible);
    setVisibilityDrag({ visible: visibilityDrag.visible, touched: new Set(visibilityDrag.touched) });
  }

  function openLayerMenu(layerId: string, rect: DOMRect) {
    const menuWidth = 224;
    const menuHeight = 300;
    setMenu({
      layerId,
      x: Math.min(Math.max(8, rect.right - menuWidth), window.innerWidth - menuWidth - 8),
      y: Math.min(Math.max(8, rect.bottom + 6), window.innerHeight - menuHeight - 8),
    });
  }

  return (
    <div className="space-y-0">
      <div className="max-h-[430px] overflow-y-auto overflow-x-hidden rounded-md border border-white/28">
        {visibleLayers.map((layer) => (
          <LayerRow
            key={layer.id}
            layer={layer}
            active={layer.id === activeProjectedLayerId}
            selected={selectedLayerIds.includes(layer.id)}
            dragging={draggingLayerId === layer.id}
            onHover={() => setHoveredLayerId(layer.id)}
            onHoverEnd={() => setHoveredLayerId((current) => (current === layer.id ? undefined : current))}
            onSelect={(event) => selectLayer(layer.id, event)}
            onDoubleClick={() => {
              setActiveLayer(layer.id);
              setSelectedLayerIds([layer.id]);
              setLastSelectedLayerId(layer.id);
              onLayerDoubleClick?.(layer);
            }}
            onVisibilityPointerDown={(event) => {
              event.stopPropagation();
              beginVisibilityDrag(layer);
            }}
            onVisibilityPointerEnter={() => continueVisibilityDrag(layer.id)}
            onOpacityClick={(event) => {
              event.stopPropagation();
              captureHistory();
              setOpacity(layer.id, layer.opacity >= 0.99 ? 0.5 : 1);
            }}
            onBlendClick={(event) => {
              event.stopPropagation();
              captureHistory();
              setBlendMode(layer.id, layer.blendMode === 'overlay' ? 'normal' : 'overlay');
            }}
            onAdjustClick={(event) => {
              event.stopPropagation();
              setActiveLayer(layer.id);
            }}
            onMenu={(event) => {
              event.stopPropagation();
              openLayerMenu(layer.id, event.currentTarget.getBoundingClientRect());
            }}
            onDragStart={() => setDraggingLayerId(layer.id)}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (draggingLayerId) {
                const rect = event.currentTarget.getBoundingClientRect();
                const placement = event.clientY > rect.top + rect.height / 2 ? 'after' : 'before';
                captureHistory();
                reorderLayer(draggingLayerId, layer.id, placement);
              }
              setDraggingLayerId(undefined);
            }}
            onDragEnd={() => setDraggingLayerId(undefined)}
          />
        ))}
        {visibleLayers.length === 0 && (
          <div className="min-h-[68px] border-t border-dashed border-white/35" aria-hidden="true" />
        )}
      </div>

      {menu &&
        createPortal(
          <LayerMenu
            x={menu.x}
            y={menu.y}
            layer={layers.find((layer) => layer.id === menu.layerId)}
            onClose={() => setMenu(undefined)}
            onView={() => {
              setActiveLayer(menu.layerId);
              setPreviewLayerId(menu.layerId);
            }}
            onMoveUp={() => {
              captureHistory();
              moveLayer(menu.layerId, 'up');
            }}
            onMoveDown={() => {
              captureHistory();
              moveLayer(menu.layerId, 'down');
            }}
            onDuplicate={() => {
              captureHistory();
              duplicateLayer(menu.layerId);
            }}
            onDownloadImage={(layer) => {
              void downloadImageAsset(layer.imageUrl, `liclick_layer_${layer.name || layer.id}`);
            }}
            onRename={(layer) => setRenameState({ layerId: layer.id, value: layer.name })}
            onDelete={() => {
              captureHistory();
              deleteLayer(menu.layerId);
            }}
          />,
          document.body,
        )}

      {previewLayer &&
        createPortal(
          <button
            type="button"
            className={cn(
              'fixed inset-0 z-[92] grid place-items-center bg-black/34 p-4 backdrop-blur-[1px]',
              previewLayerId ? 'cursor-default' : 'pointer-events-none',
            )}
            onClick={() => setPreviewLayerId(undefined)}
            aria-label={t('view')}
          >
            <img
              src={previewLayer.imageUrl}
              alt=""
              className="max-h-[88vh] max-w-[92vw] rounded-md border border-white/16 bg-[#181818] object-contain shadow-2xl"
              draggable={false}
            />
          </button>,
          document.body,
        )}

      {renameState &&
        createPortal(
          <div className="fixed inset-0 z-[95] grid place-items-center bg-black/48 px-4 backdrop-blur-sm">
            <form
              className="w-full max-w-sm rounded-lg border border-white/16 bg-[#17171f] p-4 shadow-[0_24px_70px_rgba(0,0,0,0.58)]"
              onSubmit={(event) => {
                event.preventDefault();
                commitRename();
              }}
            >
              <div className="mb-3 text-sm font-semibold text-white">{t('renameLayer')}</div>
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

export function LayersPanelActions() {
  const t = useT();
  const addEmptyLayer = useLayerStore((state) => state.addEmptyLayer);
  const captureHistory = useEditorHistoryStore((state) => state.capture);

  function handleAddLayer() {
    captureHistory();
    addEmptyLayer();
  }

  return (
    <div className="flex items-center gap-1">
      <LayerHeaderButton title={t('fitCamera')}>
        <Focus className="h-4 w-4" />
      </LayerHeaderButton>
      <LayerHeaderButton title={t('applyColorAdjustments')}>
        <PaintBucket className="h-4 w-4" />
      </LayerHeaderButton>
      <LayerHeaderButton title={t('addLayer')} onClick={handleAddLayer}>
        <Plus className="h-4 w-4" />
      </LayerHeaderButton>
    </div>
  );
}

function LayerRow({
  layer,
  active,
  selected,
  dragging,
  onSelect,
  onDoubleClick,
  onHover,
  onHoverEnd,
  onVisibilityPointerDown,
  onVisibilityPointerEnter,
  onOpacityClick,
  onBlendClick,
  onAdjustClick,
  onMenu,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  layer: Layer;
  active: boolean;
  selected: boolean;
  dragging: boolean;
  onSelect: MouseEventHandler<HTMLDivElement>;
  onDoubleClick: () => void;
  onHover: () => void;
  onHoverEnd: () => void;
  onVisibilityPointerDown: PointerEventHandler<HTMLButtonElement>;
  onVisibilityPointerEnter: PointerEventHandler<HTMLButtonElement>;
  onOpacityClick: MouseEventHandler<HTMLButtonElement>;
  onBlendClick: MouseEventHandler<HTMLButtonElement>;
  onAdjustClick: MouseEventHandler<HTMLButtonElement>;
  onMenu: MouseEventHandler<HTMLButtonElement>;
  onDragStart: () => void;
  onDragOver: DragEventHandler<HTMLDivElement>;
  onDrop: DragEventHandler<HTMLDivElement>;
  onDragEnd: () => void;
}) {
  const hasAdjustments =
    (layer.adjustments?.hue ?? 0) !== 0 ||
    (layer.adjustments?.saturation ?? 0) !== 0 ||
    (layer.adjustments?.lightness ?? 0) !== 0;

  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onClick={onSelect}
      onDoubleClick={(event) => {
        event.preventDefault();
        onDoubleClick();
      }}
      onPointerEnter={onHover}
      onPointerLeave={onHoverEnd}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(event as unknown as React.MouseEvent<HTMLDivElement>);
        }
      }}
      onDragStart={(event) => {
        event.dataTransfer.setData('application/liclick-layer-id', layer.id);
        event.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={cn(
        'group relative flex h-[58px] cursor-pointer items-center gap-2 border-b border-white/30 bg-black/86 px-2 transition hover:bg-white/[0.06]',
        selected && 'bg-white/[0.22]',
        active && 'after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-[#74a7ff]',
        dragging && 'opacity-45',
      )}
    >
      <button
        type="button"
        onPointerDown={onVisibilityPointerDown}
        onPointerEnter={onVisibilityPointerEnter}
        data-layer-visibility-id={layer.id}
        className="grid h-8 w-8 shrink-0 place-items-center rounded text-white transition hover:bg-white/10"
        title="Toggle visibility"
        aria-label="Toggle visibility"
      >
        {layer.visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4 text-white/45" />}
      </button>
      <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-sm" style={checkerStyle}>
        {layer.imageUrl && <img src={layer.imageUrl} alt="" className="h-full w-full object-cover" draggable={false} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-base font-semibold leading-5 text-white">{layer.name}</div>
        <div className="mt-1 flex items-center gap-3 text-white">
          <SmallLayerToggle
            active={layer.opacity < 0.99}
            label="Layer opacity"
            onClick={onOpacityClick}
            icon={<Circle className="h-3.5 w-3.5 fill-current" />}
          />
          <SmallLayerToggle
            active={layer.blendMode === 'overlay'}
            label="Overlay above other layers"
            onClick={onBlendClick}
            icon={
              <span className="flex items-center">
                <Circle className="h-3 w-3 fill-current" />
                <Circle className="-ml-1.5 h-3 w-3 fill-current" />
              </span>
            }
          />
          <SmallLayerToggle
            active={hasAdjustments}
            label="Has adjustments"
            onClick={onAdjustClick}
            icon={<CircleDot className="h-3.5 w-3.5" />}
          />
        </div>
      </div>
      <button
        type="button"
        onClick={onMenu}
        className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-white transition hover:bg-white/18"
        aria-label="Layer actions"
      >
        <MoreVertical className="h-4 w-4" />
      </button>
    </div>
  );
}

function SmallLayerToggle({
  active,
  label,
  icon,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: ReactNode;
  onClick: MouseEventHandler<HTMLButtonElement>;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className={cn(
        'grid h-5 w-5 place-items-center rounded-full text-white transition hover:bg-white/18',
        active ? 'bg-white/22 text-white' : 'text-white/95',
      )}
    >
      {icon}
    </button>
  );
}

function LayerMenu({
  x,
  y,
  layer,
  onClose,
  onView,
  onMoveUp,
  onMoveDown,
  onDuplicate,
  onDownloadImage,
  onRename,
  onDelete,
}: {
  x: number;
  y: number;
  layer?: Layer;
  onClose: () => void;
  onView: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDuplicate: () => void;
  onDownloadImage: (layer: Layer) => void;
  onRename: (layer: Layer) => void;
  onDelete: () => void;
}) {
  const t = useT();
  if (!layer) return null;

  function run(action: () => void) {
    action();
    onClose();
  }

  return (
    <div
      className="fixed z-[90] w-56 rounded-md border border-white/18 bg-[#1f1f20] p-2 text-sm text-white shadow-[0_18px_50px_rgba(0,0,0,0.45)]"
      style={{ left: x, top: y }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="px-2 pb-2 text-white/86">{t('thisLayer')}</div>
      <div className="mb-1 h-px bg-white/45" />
      <MenuButton onClick={() => run(onView)}>
        {t('view')}
        <span className="ml-auto rounded bg-white/85 px-1 text-xs text-[#202020]">SHIFT</span>
      </MenuButton>
      <MenuButton onClick={() => run(onMoveUp)}>{t('moveLayerUp')}</MenuButton>
      <MenuButton onClick={() => run(onMoveDown)}>{t('moveLayerDown')}</MenuButton>
      <MenuButton onClick={() => run(onDuplicate)} icon={<Copy className="h-4 w-4" />}>
        {t('duplicate')}
      </MenuButton>
      {layer.imageUrl && (
        <MenuButton onClick={() => run(() => onDownloadImage(layer))} icon={<Download className="h-4 w-4" />}>
          {t('downloadImage')}
        </MenuButton>
      )}
      <MenuButton onClick={() => run(() => onRename(layer))}>{t('rename')}</MenuButton>
      <MenuButton onClick={() => run(onDelete)} icon={<Trash2 className="h-4 w-4" />}>
        {t('delete')}
      </MenuButton>
    </div>
  );
}

function MenuButton({
  children,
  icon,
  onClick,
}: {
  children: ReactNode;
  icon?: ReactNode;
  onClick: () => void;
}) {
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

function LayerHeaderButton({
  title,
  children,
  onClick,
}: {
  title: string;
  children: ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="grid h-7 w-7 place-items-center rounded text-white transition hover:bg-white/14"
    >
      {children}
    </button>
  );
}
