import {
  startTransition,
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
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Download,
  Eraser,
  Eye,
  EyeOff,
  Focus,
  MoreVertical,
  PaintBucket,
  PencilLine,
  Plus,
  Scissors,
  TextCursorInput,
  Trash2,
  Upload,
  WandSparkles,
} from 'lucide-react';
import { cn } from '@/components/common/cn';
import { fitCameraToImportedModel } from '@/engine/scene/transformActions';
import {
  getLiveProjectedCanvasState,
  getLiveProjectedTextureSourceState,
} from '@/engine/projection/liveProjectedCanvasTextureRegistry';
import { isFlattenableUvMergeSource } from '@/engine/layers/mergeUvComposition';
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

function LayerThumbnail({ layer }: { layer: Layer }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const liveSource = getLiveProjectedTextureSourceState(layer.imageUrl)?.source;
  const liveMaskCanvas = layer.maskUrl
    ? getLiveProjectedCanvasState(layer.maskUrl)?.canvas
    : undefined;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !liveSource) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(liveSource, 0, 0, canvas.width, canvas.height);
    if (layer.replacementTargetLayerId && liveMaskCanvas) {
      context.save();
      context.globalCompositeOperation = 'destination-in';
      context.drawImage(liveMaskCanvas, 0, 0, canvas.width, canvas.height);
      context.restore();
    }
  }, [layer.contentRevision, liveSource, liveMaskCanvas, layer.replacementTargetLayerId]);

  if (liveSource) return <canvas ref={canvasRef} width={48} height={48} className="h-full w-full object-cover" />;
  if (!layer.imageUrl) return null;
  const localRepaintMaskStyle =
    layer.replacementTargetLayerId && layer.maskUrl
      ? {
          WebkitMaskImage: `url("${layer.maskUrl}")`,
          maskImage: `url("${layer.maskUrl}")`,
          WebkitMaskSize: '100% 100%',
          maskSize: '100% 100%',
          WebkitMaskRepeat: 'no-repeat',
          maskRepeat: 'no-repeat',
        }
      : undefined;
  return (
    <img
      src={layer.imageUrl}
      alt=""
      loading="lazy"
      decoding="async"
      className="h-full w-full object-cover"
      style={localRepaintMaskStyle}
      draggable={false}
    />
  );
}

function LayerPreviewImage({ layer }: { layer: Layer }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const liveSource = getLiveProjectedTextureSourceState(layer.imageUrl)?.source;
  const liveMaskCanvas = layer.maskUrl
    ? getLiveProjectedCanvasState(layer.maskUrl)?.canvas
    : undefined;
  const maxPreviewDimension = 1600;
  const sourceWidth = liveSource
    ? 'naturalWidth' in liveSource
      ? liveSource.naturalWidth
      : liveSource.width
    : 1;
  const sourceHeight = liveSource
    ? 'naturalHeight' in liveSource
      ? liveSource.naturalHeight
      : liveSource.height
    : 1;
  const scale = liveSource
    ? Math.min(1, maxPreviewDimension / Math.max(sourceWidth, sourceHeight, 1))
    : 1;
  const width = liveSource ? Math.max(1, Math.round(sourceWidth * scale)) : 1;
  const height = liveSource ? Math.max(1, Math.round(sourceHeight * scale)) : 1;
  const isLocalRepaintPreview = Boolean(layer.replacementTargetLayerId);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !liveSource) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(liveSource, 0, 0, canvas.width, canvas.height);
    if (layer.replacementTargetLayerId && liveMaskCanvas) {
      context.save();
      context.globalCompositeOperation = 'destination-in';
      context.drawImage(liveMaskCanvas, 0, 0, canvas.width, canvas.height);
      context.restore();
    }
  }, [
    height,
    layer.contentRevision,
    layer.replacementTargetLayerId,
    liveSource,
    liveMaskCanvas,
    width,
  ]);

  if (liveSource) {
    const preview = (
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        className="block max-h-[88vh] max-w-[92vw] object-contain"
      />
    );
    return isLocalRepaintPreview ? (
      <div
        className="overflow-hidden rounded-md border border-white/30 p-2 shadow-2xl"
        style={checkerStyle}
      >
        {preview}
      </div>
    ) : (
      <div className="overflow-hidden rounded-md border border-white/16 bg-[#181818] shadow-2xl">
        {preview}
      </div>
    );
  }
  const localRepaintMaskStyle =
    layer.replacementTargetLayerId && layer.maskUrl
      ? {
          WebkitMaskImage: `url("${layer.maskUrl}")`,
          maskImage: `url("${layer.maskUrl}")`,
          WebkitMaskSize: '100% 100%',
          maskSize: '100% 100%',
          WebkitMaskRepeat: 'no-repeat',
          maskRepeat: 'no-repeat',
        }
      : undefined;
  const preview = (
    <img
      src={layer.imageUrl}
      alt=""
      className="block max-h-[88vh] max-w-[92vw] object-contain"
      style={localRepaintMaskStyle}
      draggable={false}
    />
  );
  return isLocalRepaintPreview ? (
    <div
      className="overflow-hidden rounded-md border border-white/30 p-2 shadow-2xl"
      style={checkerStyle}
    >
      {preview}
    </div>
  ) : (
    <div className="overflow-hidden rounded-md border border-white/16 bg-[#181818] shadow-2xl">
      {preview}
    </div>
  );
}

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
  onLayerImageReplace?: (layer: Layer, file: File) => void;
  onLayerLocalRepaint?: (layer: Layer) => void;
  onMergeSelectedToUvLayer?: (layerIds: string[]) => void;
  onMergeIntoSelectedBlankUvLayer?: (layerIds: string[], blankUvLayerId: string) => void;
};

export function LayersPanel({
  onLayerDoubleClick,
  onLayerImageEdit,
  onLayerImageReplace,
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
  const updateLayer = useLayerStore((state) => state.updateLayer);
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
  const replaceImageInputRef = useRef<HTMLInputElement>(null);
  const replaceImageLayerIdRef = useRef<string>();
  const opacityDragFrameRef = useRef<number>();
  const pendingOpacityDragRef = useRef<{
    layerId: string;
    value: number;
    moved: boolean;
    x: number;
    y: number;
  }>();
  const visibleLayers = useMemo(
    () =>
      layers.filter(
        (layer) =>
          (!layer.objectId || layer.objectId === selectedObjectId) &&
          // This UV row is an implementation target for the renderer. The
          // actual local repaint result is the visible projected row above it;
          // exposing both made one user operation look like multiple layers.
          layer.role !== 'local-repaint-draft',
      ),
    [layers, selectedObjectId],
  );
  const layerIds = useMemo(() => visibleLayers.map((layer) => layer.id), [visibleLayers]);
  const layerIdSet = useMemo(() => new Set(layerIds), [layerIds]);
  const selectedLayerIdSet = useMemo(() => new Set(selectedLayerIds), [selectedLayerIds]);
  const layerById = useMemo(() => new Map(layers.map((layer) => [layer.id, layer])), [layers]);
  const previewLayer = useMemo(() => {
    const layerId = previewLayerId ?? (isShiftPressed ? hoveredLayerId ?? lastSelectedLayerId ?? activeProjectedLayerId : undefined);
    return visibleLayers.find((layer) => layer.id === layerId && layer.imageUrl);
  }, [activeProjectedLayerId, hoveredLayerId, isShiftPressed, lastSelectedLayerId, previewLayerId, visibleLayers]);
  const describeLayerSelection = useCallback((ids: string[]) => {
    const names = ids.map((id) => layerById.get(id)?.name).filter(Boolean);
    if (names.length === 0) return '图层';
    if (names.length === 1) return names[0];
    return `${names[0]} 等 ${names.length} 个图层`;
  }, [layerById]);

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
    if (
      !activeProjectedLayerId ||
      !layerIdSet.has(activeProjectedLayerId) ||
      selectedLayerIds.includes(activeProjectedLayerId)
    )
      return;
    setSelectedLayerIds([activeProjectedLayerId]);
    setLastSelectedLayerId(activeProjectedLayerId);
  }, [activeProjectedLayerId, layerIdSet, selectedLayerIds]);

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
      if (opacityDragFrameRef.current) {
        window.cancelAnimationFrame(opacityDragFrameRef.current);
        opacityDragFrameRef.current = undefined;
      }
      pendingOpacityDragRef.current = undefined;
      return undefined;
    }

    const flushOpacityDrag = () => {
      const pending = pendingOpacityDragRef.current;
      pendingOpacityDragRef.current = undefined;
      opacityDragFrameRef.current = undefined;
      if (!pending) return;
      setOpacity(pending.layerId, pending.value);
      setOpacityDrag((current) =>
        current && current.layerId === pending.layerId
          ? {
              ...current,
              value: pending.value,
              moved: current.moved || pending.moved,
              x: pending.x,
              y: pending.y,
            }
          : current,
      );
    };

    const continueOpacityDrag = (event: PointerEvent) => {
      setOpacityDrag((current) => {
        if (!current) return current;
        if (!capturedOpacityDragRef.current) {
          captureHistory(`调整图层不透明度：${describeLayerSelection([current.layerId])}`);
          capturedOpacityDragRef.current = true;
        }
        const delta = current.startY - event.clientY;
        const nextOpacity = Math.max(0, Math.min(1, current.startOpacity + delta / 140));
        pendingOpacityDragRef.current = {
          layerId: current.layerId,
          value: nextOpacity,
          moved: Math.abs(event.clientY - current.startY) > 2,
          x: event.clientX,
          y: event.clientY,
        };
        if (!opacityDragFrameRef.current) {
          opacityDragFrameRef.current = window.requestAnimationFrame(flushOpacityDrag);
        }
        return current;
      });
    };
    const stopOpacityDrag = () => {
      if (opacityDragFrameRef.current) {
        window.cancelAnimationFrame(opacityDragFrameRef.current);
        opacityDragFrameRef.current = undefined;
      }
      const pending = pendingOpacityDragRef.current;
      pendingOpacityDragRef.current = undefined;
      if (pending) setOpacity(pending.layerId, pending.value);
      setOpacityDrag(undefined);
    };

    window.addEventListener('pointermove', continueOpacityDrag);
    window.addEventListener('pointerup', stopOpacityDrag);
    window.addEventListener('pointercancel', stopOpacityDrag);
    return () => {
      window.removeEventListener('pointermove', continueOpacityDrag);
      window.removeEventListener('pointerup', stopOpacityDrag);
      window.removeEventListener('pointercancel', stopOpacityDrag);
      if (opacityDragFrameRef.current) {
        window.cancelAnimationFrame(opacityDragFrameRef.current);
        opacityDragFrameRef.current = undefined;
      }
      pendingOpacityDragRef.current = undefined;
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
      (id, index) => layerIdsToDelete.indexOf(id) === index && layerIdSet.has(id),
    );
    if (ids.length === 0) return;
    captureHistory(`删除图层：${describeLayerSelection(ids)}`);
    const sceneState = useSceneStore.getState();
    const latestLayers = useLayerStore.getState().layers;
    const deletesLocalRepaint = ids.some((id) =>
      latestLayers.some((layer) => layer.id === id && Boolean(layer.replacementTargetLayerId)),
    );
    if (deletesLocalRepaint) {
      // Hide the renderer inputs synchronously so the very next frame reflects
      // deletion. Row removal and resource disposal can reconcile one frame
      // later without blocking camera input or rebuilding the 14-layer stack.
      setLayerVisibility(ids, false);
      // The local-repaint row has a renderer-only twin backed by a live canvas.
      // Deleting the persisted row must also end that live session, otherwise
      // SurfacePaintOverlay republishes the orphaned projection after deletion.
      sceneState.setLocalRepaintPreviewLayer(undefined);
      sceneState.setLocalRepaintProjectionSource(undefined);
      sceneState.setPaintTool('none');
      sceneState.clearPaintMask();
      setMenu(undefined);
      setSelectedLayerIds([]);
      setLastSelectedLayerId(undefined);
      window.requestAnimationFrame(() => {
        startTransition(() => deleteLayers(ids));
      });
      return;
    }
    deleteLayers(ids);
    setMenu(undefined);
    setSelectedLayerIds([]);
    setLastSelectedLayerId(undefined);
  }, [captureHistory, deleteLayers, describeLayerSelection, layerIdSet, setLayerVisibility]);

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
    return selectedLayerIdSet.has(layerId) && selectedLayerIds.length > 1 ? selectedLayerIds : [layerId];
  }

  function beginVisibilityDrag(layer: Layer) {
    const nextVisible = !layer.visible;
    const ids = getAffectedLayerIds(layer.id);
    // The renderer's Zustand subscriber applies the visibility uniform
    // synchronously. React can reconcile the large layer/editor tree at
    // transition priority so pointer-driven viewport frames stay responsive.
    startTransition(() => setLayerVisibility(ids, nextVisible));
    setVisibilityDrag({ visible: nextVisible, touched: new Set(ids) });
  }

  function continueVisibilityDrag(layerId: string) {
    if (!visibilityDrag || visibilityDrag.touched.has(layerId)) return;
    visibilityDrag.touched.add(layerId);
    startTransition(() => setLayerVisibility([layerId], visibilityDrag.visible));
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
    if (!selectedLayerIdSet.has(layer.id)) {
      setSelectedLayerIds([layer.id]);
      setActiveLayer(layer.id);
      setLastSelectedLayerId(layer.id);
    }
    openLayerMenuAt(layer.id, event.clientX, event.clientY);
  }

  function beginReplaceLayerImage(layer: Layer) {
    replaceImageLayerIdRef.current = layer.id;
    replaceImageInputRef.current?.click();
  }

  return (
    <div className="space-y-0">
      <input
        ref={replaceImageInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          const layerId = replaceImageLayerIdRef.current;
          event.currentTarget.value = '';
          replaceImageLayerIdRef.current = undefined;
          if (!file || !layerId) return;
          const layer = layerById.get(layerId);
          if (layer) onLayerImageReplace?.(layer, file);
        }}
      />
      <div className="max-h-[min(72vh,820px)] min-h-[260px] overflow-y-auto overflow-x-hidden rounded-md border border-white/28">
        {visibleLayers.map((layer) => (
          <LayerRow
            key={layer.id}
            layer={layer}
            active={layer.id === activeProjectedLayerId}
            selected={selectedLayerIdSet.has(layer.id)}
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
              if (event.button !== 0) return;
              event.stopPropagation();
              event.preventDefault();
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
            layer={layerById.get(menu.layerId)}
            selectedLayers={layers.filter((layer) =>
              (selectedLayerIdSet.has(menu.layerId) ? selectedLayerIdSet : new Set([menu.layerId])).has(layer.id),
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
            onClearMask={(layer) => {
              captureHistory(`清空图层蒙版：${layer.name}`);
              updateLayer(layer.id, {
                maskUrl: undefined,
                maskSpace: undefined,
                contentRevision: (layer.contentRevision ?? 0) + 1,
                isBaked: false,
                needsRebake: layer.type === 'projected',
              });
            }}
            onImageEdit={(layer) => onLayerImageEdit?.(layer)}
            onImageReplace={beginReplaceLayerImage}
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
            <LayerPreviewImage layer={previewLayer} />
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
  onMergeVisibleProjectedToUvLayer?: (layerIds: string[]) => void;
};

export function LayersPanelActions({ onContentAwareRepair, onMergeVisibleProjectedToUvLayer }: LayersPanelActionsProps = {}) {
  const t = useT();
  const layers = useLayerStore((state) => state.layers);
  const addEmptyLayer = useLayerStore((state) => state.addEmptyLayer);
  const importedModel = useSceneStore((state) => state.importedModel);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const captureHistory = useEditorHistoryStore((state) => state.capture);
  const pushToast = useToastStore((state) => state.pushToast);

  function handleAddLayer() {
    captureHistory('创建空图层');
    addEmptyLayer();
  }

  function handleFitCamera() {
    if (!importedModel) {
      pushToast({ tone: 'warning', title: t('importModelFirst') });
      return;
    }
    fitCameraToImportedModel();
  }

  const visibleProjectedLayerIds = layers
    .filter(
      (layer) =>
        layer.type === 'projected' &&
        layer.visible &&
        layer.imageUrl &&
        (!layer.objectId || layer.objectId === selectedObjectId),
    )
    .map((layer) => layer.id);

  return (
    <div className="flex items-center gap-1.5">
      <LayerHeaderButton title={`${t('fitCamera')} (F)`} onClick={handleFitCamera}>
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
      <LayerHeaderButton title={`${t('addLayer')} (Ctrl+Shift+N)`} onClick={handleAddLayer}>
        <Plus className="h-4 w-4" />
      </LayerHeaderButton>
      <LayerHeaderButton
        title={t('mergeVisibleProjectedLayersToUvLayer')}
        disabled={visibleProjectedLayerIds.length < 1 || !onMergeVisibleProjectedToUvLayer}
        onClick={() => onMergeVisibleProjectedToUvLayer?.(visibleProjectedLayerIds)}
      >
        <Scissors className="h-4 w-4" />
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
  const hasMask = Boolean(layer.maskUrl);
  const modeLabel = layer.blendMode === 'overlay' ? 'Overlay above other layers' : 'Blend with other layers';
  const opacityLabel = `Layer opacity ${Math.round(layer.opacity * 100)}%. Drag up or down to adjust.`;

  return (
    <div
      role="button"
      data-layer-id={layer.id}
      data-layer-type={layer.type}
      data-layer-role={layer.role ?? ''}
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
        'group relative flex h-[58px] cursor-pointer items-center gap-2 border-b border-white/30 bg-black/86 px-2 transition [contain-intrinsic-size:58px] [content-visibility:auto] hover:bg-white/[0.06]',
        selected && 'bg-white/[0.22]',
        active && 'after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-[#74a7ff]',
        dragging && 'opacity-45',
      )}
    >
      <button
        type="button"
        onPointerDown={onVisibilityPointerDown}
        onPointerEnter={onVisibilityPointerEnter}
        onClick={(event) => {
          // pointerdown owns the visibility gesture. Do not let the following
          // click select the row and reactivate the layer that was just hidden.
          event.stopPropagation();
          event.preventDefault();
        }}
        data-layer-visibility-id={layer.id}
        className="grid h-8 w-8 shrink-0 place-items-center rounded text-white transition hover:bg-white/10"
        title="Toggle visibility"
        aria-label="Toggle visibility"
      >
        {layer.visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4 text-white/45" />}
      </button>
      <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-sm" style={checkerStyle}>
        <LayerThumbnail layer={layer} />
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
          {hasMask ? (
            <SmallLayerToggle
              active
              label="Has mask"
              onClick={onAdjustClick}
              icon={<LayerMaskGlyph />}
            />
          ) : null}
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
  onClearMask,
  onImageEdit,
  onImageReplace,
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
  onClearMask: (layer: Layer) => void;
  onImageEdit: (layer: Layer) => void;
  onImageReplace: (layer: Layer) => void;
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
  const selectedMergeSourceLayers = selectedLayers.filter(
    (item) => item.type === 'projected' || isFlattenableUvMergeSource(item),
  );
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
            onClick={() =>
              run(() => onMergeSelectedToUvLayer(selectedMergeSourceLayers.map((item) => item.id)))
            }
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
                  selectedMergeSourceLayers.map((item) => item.id),
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
          <MenuButton onClick={() => run(onView)} icon={<Eye className="h-4 w-4" />}>
            {t('view')}
            <span className="ml-auto rounded bg-white/85 px-1 text-xs text-[#202020]">SHIFT</span>
          </MenuButton>
          <MenuButton onClick={() => run(onMoveUp)} icon={<ArrowUp className="h-4 w-4" />}>
            {t('moveLayerUp')}
          </MenuButton>
          <MenuButton onClick={() => run(onMoveDown)} icon={<ArrowDown className="h-4 w-4" />}>
            {t('moveLayerDown')}
          </MenuButton>
          {layer.maskUrl ? (
            <MenuButton onClick={() => run(() => onClearMask(layer))} icon={<Eraser className="h-4 w-4" />}>
              {t('clearMask')}
            </MenuButton>
          ) : null}
          {(layer.type === 'projected' || layer.type === 'uv') && (
            <>
              <MenuButton
                onClick={() => run(() => onImageEdit(layer))}
                icon={<PencilLine className="h-4 w-4" />}
                disabled={!layer.imageUrl}
              >
                {t('imageEditLayerMenu')}
              </MenuButton>
              <MenuButton
                onClick={() => run(() => onImageReplace(layer))}
                icon={<Upload className="h-4 w-4" />}
                disabled={!layer.imageUrl}
              >
                {t('replaceLayerImage')}
              </MenuButton>
            </>
          )}
          {layer.type === 'projected' && (
            <MenuButton onClick={() => run(() => onLocalRepaint(layer))} icon={<WandSparkles className="h-4 w-4" />}>
              {t('localRepaintEditLayer')}
            </MenuButton>
          )}
          <MenuButton onClick={() => run(onDuplicate)} icon={<Copy className="h-4 w-4" />}>
            {t('duplicate')}
            <span className="ml-auto rounded bg-white/85 px-1 text-xs text-[#202020]">CTRL D</span>
          </MenuButton>
          {layer.imageUrl && (
            <MenuButton onClick={() => run(() => onDownloadImage(layer))} icon={<Download className="h-4 w-4" />}>
              {t('downloadImage')}
            </MenuButton>
          )}
          <MenuButton onClick={() => run(() => onRename(layer))} icon={<TextCursorInput className="h-4 w-4" />}>
            {t('rename')}
          </MenuButton>
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
  disabled,
}: {
  title: string;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className="grid h-7 w-7 place-items-center rounded text-white transition hover:bg-white/14 disabled:cursor-not-allowed disabled:opacity-35"
    >
      {children}
    </button>
  );
}
