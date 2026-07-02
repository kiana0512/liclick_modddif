import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEventHandler,
  type MouseEventHandler,
  type PointerEventHandler,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Copy, Download, Eye, EyeOff, Focus, MoreVertical, PaintBucket, PencilLine, Plus, Scissors, Square, Trash2, WandSparkles } from 'lucide-react';
import { cn } from '@/components/common/cn';
import { fitCameraToImportedModel } from '@/engine/scene/transformActions';
import { useEditorHistoryStore } from '@/stores/editorHistoryStore';
import { useLayerStore } from '@/stores/layerStore';
import { useSceneStore } from '@/stores/sceneStore';
import { useT } from '@/stores/i18nStore';
import { useToastStore } from '@/stores/toastStore';
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

type OpacityDrag = {
  layerId: string;
  startY: number;
  startOpacity: number;
  value: number;
  moved: boolean;
  x: number;
  y: number;
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
  onLayerImageEdit?: (layer: Layer) => void;
  onLayerLocalRepaint?: (layer: Layer) => void;
  onMergeSelectedToUvLayer?: (layerIds: string[]) => void;
  onMergeIntoSelectedBlankUvLayer?: (layerIds: string[], blankUvLayerId: string) => void;
};

export function LayersPanel({
  onLayerDoubleClick,
  onLayerImageEdit,
  onLayerLocalRepaint,
  onMergeSelectedToUvLayer,
  onMergeIntoSelectedBlankUvLayer,
}: LayersPanelProps = {}) {
  const t = useT();
  const layers = useLayerStore((state) => state.layers);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const setLayerVisibility = useLayerStore((state) => state.setLayerVisibility);
  const setOpacity = useLayerStore((state) => state.setOpacity);
  const setBlendMode = useLayerStore((state) => state.setBlendMode);
  const activeProjectedLayerId = useLayerStore((state) => state.activeProjectedLayerId);
  const setActiveLayer = useLayerStore((state) => state.setActiveLayer);
  const deleteLayers = useLayerStore((state) => state.deleteLayers);
  const duplicateLayer = useLayerStore((state) => state.duplicateLayer);
  const renameLayer = useLayerStore((state) => state.renameLayer);
  const moveLayer = useLayerStore((state) => state.moveLayer);
  const reorderLayer = useLayerStore((state) => state.reorderLayer);
  const captureHistory = useEditorHistoryStore((state) => state.capture);
  const [menu, setMenu] = useState<MenuState>();
  const [renameState, setRenameState] = useState<RenameState>();
  const [draggingLayerId, setDraggingLayerId] = useState<string>();
  const [visibilityDrag, setVisibilityDrag] = useState<VisibilityDrag>();
  const [opacityDrag, setOpacityDrag] = useState<OpacityDrag>();
  const [hoveredLayerId, setHoveredLayerId] = useState<string>();
  const [previewLayerId, setPreviewLayerId] = useState<string>();
  const [isShiftPressed, setIsShiftPressed] = useState(false);
  const [selectedLayerIds, setSelectedLayerIds] = useState<string[]>(() =>
    activeProjectedLayerId ? [activeProjectedLayerId] : [],
  );
  const [lastSelectedLayerId, setLastSelectedLayerId] = useState<string | undefined>(activeProjectedLayerId);
  const capturedOpacityDragRef = useRef(false);
  const visibleLayers = useMemo(
    () => layers.filter((layer) => !layer.objectId || layer.objectId === selectedObjectId),
    [layers, selectedObjectId],
  );
  const layerIds = useMemo(() => visibleLayers.map((layer) => layer.id), [visibleLayers]);
  const previewLayer = useMemo(() => {
    const layerId = previewLayerId ?? (isShiftPressed ? hoveredLayerId ?? lastSelectedLayerId ?? activeProjectedLayerId : undefined);
    return visibleLayers.find((layer) => layer.id === layerId && layer.imageUrl);
  }, [activeProjectedLayerId, hoveredLayerId, isShiftPressed, lastSelectedLayerId, previewLayerId, visibleLayers]);

  const describeLayerSelection = useCallback((ids: string[]) => {
    const names = ids.map((id) => layers.find((item) => item.id === id)?.name).filter(Boolean);
    if (names.length === 0) return '图层';
    if (names.length === 1) return names[0];
    return `${names[0]} 等 ${names.length} 个图层`;
  }, [layers]);

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
    if (!opacityDrag) {
      capturedOpacityDragRef.current = false;
      return undefined;
    }

    const continueOpacityDrag = (event: PointerEvent) => {
      setOpacityDrag((current) => {
        if (!current) return current;
        if (!capturedOpacityDragRef.current) {
          captureHistory(`调整图层不透明度：${describeLayerSelection([current.layerId])}`);
          capturedOpacityDragRef.current = true;
        }
        const delta = current.startY - event.clientY;
        const nextOpacity = Math.max(0, Math.min(1, current.startOpacity + delta / 140));
        setOpacity(current.layerId, nextOpacity);
        return {
          ...current,
          value: nextOpacity,
          moved: current.moved || Math.abs(event.clientY - current.startY) > 2,
          x: event.clientX,
          y: event.clientY,
        };
      });
    };
    const stopOpacityDrag = () => setOpacityDrag(undefined);

    window.addEventListener('pointermove', continueOpacityDrag);
    window.addEventListener('pointerup', stopOpacityDrag);
    window.addEventListener('pointercancel', stopOpacityDrag);
    return () => {
      window.removeEventListener('pointermove', continueOpacityDrag);
      window.removeEventListener('pointerup', stopOpacityDrag);
      window.removeEventListener('pointercancel', stopOpacityDrag);
    };
  }, [captureHistory, describeLayerSelection, opacityDrag, setOpacity]);

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

  const deleteSelectedLayers = useCallback((layerIdsToDelete: string[]) => {
    const ids = layerIdsToDelete.filter(
      (id, index) => layerIdsToDelete.indexOf(id) === index && layerIds.includes(id),
    );
    if (ids.length === 0) return;
    captureHistory(`删除图层：${describeLayerSelection(ids)}`);
    deleteLayers(ids);
    setMenu(undefined);
    setSelectedLayerIds([]);
    setLastSelectedLayerId(undefined);
  }, [captureHistory, deleteLayers, describeLayerSelection, layerIds]);

  useEffect(() => {
    const handleDeleteKey = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      if (selectedLayerIds.length === 0) return;
      event.preventDefault();
      deleteSelectedLayers(selectedLayerIds);
    };
    window.addEventListener('keydown', handleDeleteKey);
    return () => window.removeEventListener('keydown', handleDeleteKey);
  }, [deleteSelectedLayers, selectedLayerIds]);

  function commitRename() {
    if (!renameState) return;
    const nextName = renameState.value.trim();
    const layer = layers.find((item) => item.id === renameState.layerId);
    if (!layer || !nextName || nextName === layer.name) {
      setRenameState(undefined);
      return;
    }
    captureHistory(`重命名图层：${layer.name} -> ${nextName}`);
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
    captureHistory(`${nextVisible ? '显示' : '隐藏'}图层：${describeLayerSelection(ids)}`);
    setLayerVisibility(ids, nextVisible);
    setVisibilityDrag({ visible: nextVisible, touched: new Set(ids) });
  }

  function continueVisibilityDrag(layerId: string) {
    if (!visibilityDrag || visibilityDrag.touched.has(layerId)) return;
    visibilityDrag.touched.add(layerId);
    setLayerVisibility([layerId], visibilityDrag.visible);
    setVisibilityDrag({ visible: visibilityDrag.visible, touched: new Set(visibilityDrag.touched) });
  }

  function beginOpacityDrag(layer: Layer, event: React.PointerEvent<HTMLButtonElement>) {
    event.stopPropagation();
    event.preventDefault();
    setActiveLayer(layer.id);
    setOpacityDrag({
      layerId: layer.id,
      startY: event.clientY,
      startOpacity: layer.opacity,
      value: layer.opacity,
      moved: false,
      x: event.clientX,
      y: event.clientY,
    });
  }

  function openLayerMenuAt(layerId: string, x: number, y: number) {
    const menuWidth = 224;
    const menuHeight = Math.min(420, window.innerHeight - 24);
    setMenu({
      layerId,
      x: Math.min(Math.max(8, x), window.innerWidth - menuWidth - 8),
      y: Math.min(Math.max(8, y), window.innerHeight - menuHeight - 8),
    });
  }

  function openLayerMenuFromButton(layerId: string, rect: DOMRect) {
    openLayerMenuAt(layerId, rect.right - 224, rect.bottom + 6);
  }

  function openLayerMenuFromContext(layer: Layer, event: React.MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (!selectedLayerIds.includes(layer.id)) {
      setSelectedLayerIds([layer.id]);
      setActiveLayer(layer.id);
      setLastSelectedLayerId(layer.id);
    }
    openLayerMenuAt(layer.id, event.clientX, event.clientY);
  }

  return (
    <div className="space-y-0">
      <div className="max-h-[min(72vh,820px)] min-h-[260px] overflow-y-auto overflow-x-hidden rounded-md border border-white/28">
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
            onOpacityPointerDown={(event) => beginOpacityDrag(layer, event)}
            onBlendClick={(event) => {
              event.stopPropagation();
              captureHistory(`切换图层混合模式：${layer.name}`);
              setBlendMode(layer.id, layer.blendMode === 'overlay' ? 'normal' : 'overlay');
            }}
            onAdjustClick={(event) => {
              event.stopPropagation();
              setActiveLayer(layer.id);
            }}
            onMenu={(event) => {
              event.stopPropagation();
              openLayerMenuFromButton(layer.id, event.currentTarget.getBoundingClientRect());
            }}
            onContextMenu={(event) => openLayerMenuFromContext(layer, event)}
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
                captureHistory(`移动图层：${describeLayerSelection([draggingLayerId])}`);
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
            selectedLayers={layers.filter((layer) =>
              (selectedLayerIds.includes(menu.layerId) ? selectedLayerIds : [menu.layerId]).includes(layer.id),
            )}
            onClose={() => setMenu(undefined)}
            onView={() => {
              setActiveLayer(menu.layerId);
              setPreviewLayerId(menu.layerId);
            }}
            onMoveUp={() => {
              captureHistory(`上移图层：${describeLayerSelection([menu.layerId])}`);
              moveLayer(menu.layerId, 'up');
            }}
            onMoveDown={() => {
              captureHistory(`下移图层：${describeLayerSelection([menu.layerId])}`);
              moveLayer(menu.layerId, 'down');
            }}
            onDuplicate={() => {
              captureHistory(`复制图层：${describeLayerSelection([menu.layerId])}`);
              duplicateLayer(menu.layerId);
            }}
            onImageEdit={(layer) => onLayerImageEdit?.(layer)}
            onLocalRepaint={(layer) => onLayerLocalRepaint?.(layer)}
            onMergeSelectedToUvLayer={(layerIds) => onMergeSelectedToUvLayer?.(layerIds)}
            onMergeIntoSelectedBlankUvLayer={(layerIds, blankUvLayerId) =>
              onMergeIntoSelectedBlankUvLayer?.(layerIds, blankUvLayerId)
            }
            onDownloadImage={(layer) => {
              void downloadImageAsset(layer.imageUrl, `liclick_layer_${layer.name || layer.id}`);
            }}
            onRename={(layer) => setRenameState({ layerId: layer.id, value: layer.name })}
            onDelete={() => {
              const ids = selectedLayerIds.includes(menu.layerId) ? selectedLayerIds : [menu.layerId];
              deleteSelectedLayers(ids);
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

      {opacityDrag &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[96] rounded-md border border-white/16 bg-black/88 px-2.5 py-1.5 text-xs font-semibold text-white shadow-[0_10px_28px_rgba(0,0,0,0.48)]"
            style={{ left: opacityDrag.x + 12, top: opacityDrag.y - 36 }}
          >
            Layer opacity {Math.round(opacityDrag.value * 100)}%
          </div>,
          document.body,
        )}
    </div>
  );
}

type LayersPanelActionsProps = {
  onContentAwareRepair?: () => void;
};

export function LayersPanelActions({ onContentAwareRepair }: LayersPanelActionsProps = {}) {
  const t = useT();
  const addEmptyLayer = useLayerStore((state) => state.addEmptyLayer);
  const addUvLayer = useLayerStore((state) => state.addUvLayer);
  const importedModel = useSceneStore((state) => state.importedModel);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const captureHistory = useEditorHistoryStore((state) => state.capture);
  const pushToast = useToastStore((state) => state.pushToast);

  function handleAddLayer() {
    captureHistory('创建空图层');
    addEmptyLayer();
  }

  function handleAddBlankUvLayer() {
    captureHistory('创建空 UV 图层');
    addUvLayer({ name: t('blankUvLayer'), imageUrl: '', objectId: selectedObjectId });
  }

  function handleFitCamera() {
    if (!importedModel) {
      pushToast({ tone: 'warning', title: t('importModelFirst') });
      return;
    }
    fitCameraToImportedModel();
  }

  return (
    <div className="flex items-center gap-1.5">
      <LayerHeaderButton title={t('fitCamera')} onClick={handleFitCamera}>
        <Focus className="h-4 w-4" />
      </LayerHeaderButton>
      <LayerHeaderButton
        title={t('contentAwareRepair')}
        onClick={() => {
          if (!onContentAwareRepair) {
            pushToast({
              tone: 'info',
              title: t('localRepaint'),
              description: t('localRepaintToolHelp'),
              dedupeKey: 'layer-content-aware-repair',
            });
            return;
          }
          onContentAwareRepair();
        }}
      >
        <PaintBucket className="h-4 w-4" />
      </LayerHeaderButton>
      <LayerHeaderButton title={t('addLayer')} onClick={handleAddLayer}>
        <Plus className="h-4 w-4" />
      </LayerHeaderButton>
      <LayerHeaderButton title={t('createBlankUvLayer')} onClick={handleAddBlankUvLayer}>
        <Square className="h-4 w-4" />
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
  onOpacityPointerDown,
  onBlendClick,
  onAdjustClick,
  onMenu,
  onContextMenu,
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
  onOpacityPointerDown: PointerEventHandler<HTMLButtonElement>;
  onBlendClick: MouseEventHandler<HTMLButtonElement>;
  onAdjustClick: MouseEventHandler<HTMLButtonElement>;
  onMenu: MouseEventHandler<HTMLButtonElement>;
  onContextMenu: MouseEventHandler<HTMLDivElement>;
  onDragStart: () => void;
  onDragOver: DragEventHandler<HTMLDivElement>;
  onDrop: DragEventHandler<HTMLDivElement>;
  onDragEnd: () => void;
}) {
  const hasAdjustments =
    (layer.adjustments?.hue ?? 0) !== 0 ||
    (layer.adjustments?.saturation ?? 0) !== 0 ||
    (layer.adjustments?.lightness ?? 0) !== 0 ||
    (layer.strength ?? 1) !== 1;
  const modeLabel = layer.blendMode === 'overlay' ? 'Overlay above other layers' : 'Blend with other layers';
  const opacityLabel = `Layer opacity ${Math.round(layer.opacity * 100)}%. Drag up or down to adjust.`;

  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onClick={onSelect}
      onContextMenu={onContextMenu}
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
            active={layer.opacity > 0.01}
            label={opacityLabel}
            onPointerDown={onOpacityPointerDown}
            icon={<LayerOpacityGlyph opacity={layer.opacity} />}
          />
          <SmallLayerToggle
            active={layer.blendMode === 'overlay'}
            label={modeLabel}
            onClick={onBlendClick}
            icon={layer.blendMode === 'overlay' ? <LayerOverlayGlyph /> : <LayerBlendGlyph />}
          />
          <SmallLayerToggle
            active={hasAdjustments}
            label="Layer projection mask"
            onClick={onAdjustClick}
            icon={<LayerMaskGlyph />}
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

function LayerOpacityGlyph({ opacity }: { opacity: number }) {
  const clampedOpacity = Math.max(0, Math.min(1, opacity));
  if (clampedOpacity <= 0.01) {
    return <span className="h-3.5 w-3.5 rounded-full border-2 border-current" />;
  }
  return (
    <span
      className="h-3.5 w-3.5 rounded-full border border-current bg-current"
      style={{ opacity: 0.32 + clampedOpacity * 0.68 }}
    />
  );
}

function LayerBlendGlyph() {
  return (
    <span className="relative h-3.5 w-4">
      <span className="absolute left-0 top-1 h-2.5 w-2.5 rounded-full border-2 border-current" />
      <span className="absolute right-0 top-1 h-2.5 w-2.5 rounded-full border-2 border-current bg-black/40" />
    </span>
  );
}

function LayerOverlayGlyph() {
  return (
    <span className="relative h-3.5 w-4">
      <span className="absolute left-0.5 top-1.5 h-2.5 w-2.5 rounded-[2px] border-2 border-current" />
      <span className="absolute right-0.5 top-0 h-2.5 w-2.5 rounded-[2px] border-2 border-current bg-current/30" />
    </span>
  );
}

function LayerMaskGlyph() {
  return (
    <span className="grid h-3.5 w-3.5 place-items-center rounded-[2px] border border-current">
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
    </span>
  );
}

function SmallLayerToggle({
  active,
  label,
  icon,
  onClick,
  onPointerDown,
}: {
  active: boolean;
  label: string;
  icon: ReactNode;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  onPointerDown?: PointerEventHandler<HTMLButtonElement>;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onPointerDown={onPointerDown}
      title={label}
      aria-label={label}
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
  selectedLayers,
  onClose,
  onView,
  onMoveUp,
  onMoveDown,
  onDuplicate,
  onImageEdit,
  onLocalRepaint,
  onMergeSelectedToUvLayer,
  onMergeIntoSelectedBlankUvLayer,
  onDownloadImage,
  onRename,
  onDelete,
}: {
  x: number;
  y: number;
  layer?: Layer;
  selectedLayers: Layer[];
  onClose: () => void;
  onView: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDuplicate: () => void;
  onImageEdit: (layer: Layer) => void;
  onLocalRepaint: (layer: Layer) => void;
  onMergeSelectedToUvLayer: (layerIds: string[]) => void;
  onMergeIntoSelectedBlankUvLayer: (layerIds: string[], blankUvLayerId: string) => void;
  onDownloadImage: (layer: Layer) => void;
  onRename: (layer: Layer) => void;
  onDelete: () => void;
}) {
  const t = useT();
  if (!layer) return null;
  const selectedProjectedLayers = selectedLayers.filter((item) => item.type === 'projected');
  const selectedBlankUvLayer = selectedLayers.find((item) => item.type === 'uv' && !item.imageUrl);
  const isMulti = selectedLayers.length > 1;

  function run(action: () => void) {
    action();
    onClose();
  }

  return (
    <div
      className="fixed z-[90] max-h-[min(420px,calc(100vh-24px))] w-56 overflow-y-auto rounded-md border border-white/18 bg-[#1f1f20] p-2 text-sm text-white shadow-[0_18px_50px_rgba(0,0,0,0.45)]"
      style={{ left: x, top: y }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="px-2 pb-2 text-white/86">{t('thisLayer')}</div>
      <div className="mb-1 h-px bg-white/45" />
      {isMulti ? (
        <>
          <MenuButton
            onClick={() => run(() => onMergeSelectedToUvLayer(selectedProjectedLayers.map((item) => item.id)))}
            icon={<Scissors className="h-4 w-4" />}
            disabled={selectedProjectedLayers.length === 0}
          >
            {t('mergeSelectedLayersToUvLayer')}
          </MenuButton>
          <MenuButton
            onClick={() =>
              selectedBlankUvLayer &&
              run(() =>
                onMergeIntoSelectedBlankUvLayer(
                  selectedProjectedLayers.map((item) => item.id),
                  selectedBlankUvLayer.id,
                ),
              )
            }
            icon={<Scissors className="h-4 w-4" />}
            disabled={!selectedBlankUvLayer || selectedProjectedLayers.length === 0}
          >
            {t('mergeIntoSelectedBlankUvLayer')}
          </MenuButton>
          <MenuButton onClick={() => run(onDelete)} icon={<Trash2 className="h-4 w-4" />}>
            {t('deleteSelectedLayers')}
          </MenuButton>
        </>
      ) : (
        <>
          <MenuButton onClick={() => run(onView)}>
            {t('view')}
            <span className="ml-auto rounded bg-white/85 px-1 text-xs text-[#202020]">SHIFT</span>
          </MenuButton>
          <MenuButton onClick={() => run(onMoveUp)}>{t('moveLayerUp')}</MenuButton>
          <MenuButton onClick={() => run(onMoveDown)}>{t('moveLayerDown')}</MenuButton>
          {(layer.type === 'projected' || layer.type === 'uv') && (
            <MenuButton
              onClick={() => run(() => onImageEdit(layer))}
              icon={<PencilLine className="h-4 w-4" />}
              disabled={!layer.imageUrl}
            >
              {t('imageEditLayerMenu')}
            </MenuButton>
          )}
          {layer.type === 'projected' && (
            <MenuButton onClick={() => run(() => onLocalRepaint(layer))} icon={<WandSparkles className="h-4 w-4" />}>
              {t('localRepaintEditLayer')}
            </MenuButton>
          )}
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
        </>
      )}
    </div>
  );
}

function MenuButton({
  children,
  icon,
  onClick,
  disabled,
}: {
  children: ReactNode;
  icon?: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-9 w-full items-center gap-2 rounded px-2 text-left font-medium text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
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
