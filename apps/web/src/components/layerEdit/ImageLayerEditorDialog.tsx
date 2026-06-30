import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
  type WheelEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Brush,
  Check,
  Contrast,
  Copy,
  Crop,
  Eraser,
  Eye,
  EyeOff,
  FlipHorizontal,
  FlipVertical,
  Move,
  PaintBucket,
  Pipette,
  Plus,
  RotateCcw,
  RotateCw,
  Scissors,
  SlidersHorizontal,
  SquareDashedMousePointer,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { cn } from '@/components/common/cn';
import { IconTooltip } from '@/components/common/IconTooltip';
import { useT } from '@/stores/i18nStore';
import type { Layer } from '@/types/layer';

type Tool = 'move' | 'select' | 'brush' | 'eraser' | 'fill' | 'picker';
type EditorBlendMode = 'normal' | 'multiply' | 'screen' | 'overlay';
type ViewMode = 'split' | 'image' | 'mapped';
type PopoverPanel = 'tool' | 'layer' | 'adjust' | undefined;

type EditorLayer = {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  blendMode: EditorBlendMode;
  offsetX: number;
  offsetY: number;
  brightness: number;
  contrast: number;
  saturation: number;
  hue: number;
  base?: boolean;
};

type SelectionRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

type EditorSnapshot = {
  layers: EditorLayer[];
  activeLayerId: string;
  dataUrls: Record<string, string>;
};

type ImageLayerEditorDialogProps = {
  layer: Layer;
  mappedPreviewUrl?: string;
  onRefreshMappedPreview?: (dataUrl: string) => Promise<string | undefined> | string | undefined;
  onApply: (dataUrl: string) => Promise<void> | void;
  onCancel: () => void;
};

const checkerStyle = {
  backgroundColor: '#d6d6d6',
  backgroundImage:
    'linear-gradient(45deg, #8e8e8e 25%, transparent 25%), linear-gradient(-45deg, #8e8e8e 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #8e8e8e 75%), linear-gradient(-45deg, transparent 75%, #8e8e8e 75%)',
  backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0',
  backgroundSize: '20px 20px',
};

function createCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not load layer image.'));
    image.src = url;
  });
}

function createLayerId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function blendOperation(mode: EditorBlendMode): GlobalCompositeOperation {
  if (mode === 'multiply') return 'multiply';
  if (mode === 'screen') return 'screen';
  if (mode === 'overlay') return 'overlay';
  return 'source-over';
}

function createDefaultEditorLayer(input: Omit<EditorLayer, 'brightness' | 'contrast' | 'saturation' | 'hue'>): EditorLayer {
  return {
    ...input,
    brightness: 0,
    contrast: 0,
    saturation: 0,
    hue: 0,
  };
}

function buildLayerFilter(layer: EditorLayer) {
  const brightness = Math.max(0, 1 + layer.brightness / 100);
  const contrast = Math.max(0, 1 + layer.contrast / 100);
  const saturation = Math.max(0, 1 + layer.saturation / 100);
  return `brightness(${brightness}) contrast(${contrast}) saturate(${saturation}) hue-rotate(${layer.hue}deg)`;
}

function normalizeRect(start: { x: number; y: number }, end: { x: number; y: number }, bounds: { width: number; height: number }): SelectionRect {
  const left = Math.max(0, Math.min(bounds.width, Math.min(start.x, end.x)));
  const top = Math.max(0, Math.min(bounds.height, Math.min(start.y, end.y)));
  const right = Math.max(0, Math.min(bounds.width, Math.max(start.x, end.x)));
  const bottom = Math.max(0, Math.min(bounds.height, Math.max(start.y, end.y)));
  return {
    x: Math.round(left),
    y: Math.round(top),
    w: Math.round(right - left),
    h: Math.round(bottom - top),
  };
}

function hexToRgba(hex: string, alpha: number) {
  const normalized = hex.replace('#', '').padEnd(6, '0').slice(0, 6);
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function rgbaToHex(red: number, green: number, blue: number) {
  return `#${[red, green, blue]
    .map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0'))
    .join('')}`;
}

function imageDataMatches(data: Uint8ClampedArray, offset: number, target: [number, number, number, number], tolerance: number) {
  return (
    Math.abs(data[offset] - target[0]) <= tolerance &&
    Math.abs(data[offset + 1] - target[1]) <= tolerance &&
    Math.abs(data[offset + 2] - target[2]) <= tolerance &&
    Math.abs(data[offset + 3] - target[3]) <= tolerance
  );
}

export function ImageLayerEditorDialog({
  layer,
  mappedPreviewUrl,
  onRefreshMappedPreview,
  onApply,
  onCancel,
}: ImageLayerEditorDialogProps) {
  const t = useT();
  const frameRef = useRef<HTMLDivElement>(null);
  const displayCanvasRef = useRef<HTMLCanvasElement>(null);
  const sourceCanvasRef = useRef<HTMLCanvasElement>();
  const layerCanvasesRef = useRef<Record<string, HTMLCanvasElement>>({});
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number }>();
  const movingRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number }>();
  const panDragRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number }>();
  const selectionDraftRef = useRef<{ start: { x: number; y: number } }>();
  const tRef = useRef(t);
  const continuousLayerEditRef = useRef(false);
  const [canvasSize, setCanvasSize] = useState({ width: 1, height: 1 });
  const [paintSurfaceStyle, setPaintSurfaceStyle] = useState({ left: 0, top: 0, width: 1, height: 1 });
  const [viewOffset, setViewOffset] = useState({ x: 0, y: 0 });
  const [tool, setTool] = useState<Tool>('brush');
  const [brushSize, setBrushSize] = useState(28);
  const [brushHardness, setBrushHardness] = useState(0.78);
  const [brushOpacity, setBrushOpacity] = useState(1);
  const [color, setColor] = useState('#ffffff');
  const [zoom, setZoom] = useState(1);
  const [showBefore, setShowBefore] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [isRefreshingMappedPreview, setIsRefreshingMappedPreview] = useState(false);
  const [error, setError] = useState<string>();
  const [editLayers, setEditLayers] = useState<EditorLayer[]>([]);
  const [activeLayerId, setActiveLayerId] = useState('');
  const [selection, setSelection] = useState<SelectionRect>();
  const [undoStack, setUndoStack] = useState<EditorSnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<EditorSnapshot[]>([]);
  const [editRevision, setEditRevision] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>('split');
  const [popoverPanel, setPopoverPanel] = useState<PopoverPanel>('tool');
  const [mappedPreview, setMappedPreview] = useState(mappedPreviewUrl);
  const previewRequestRef = useRef(0);

  const activeLayer = useMemo(
    () => editLayers.find((item) => item.id === activeLayerId) ?? editLayers[0],
    [activeLayerId, editLayers],
  );
  const isUvLayer = layer.type === 'uv';

  useEffect(() => {
    tRef.current = t;
  }, [t]);

  useEffect(() => {
    setMappedPreview(mappedPreviewUrl);
  }, [mappedPreviewUrl]);

  const updatePaintSurfaceLayout = useCallback(() => {
    const frame = frameRef.current;
    if (!frame || canvasSize.width <= 0 || canvasSize.height <= 0) return;
    const rect = frame.getBoundingClientRect();
    const imageAspect = canvasSize.width / canvasSize.height;
    const frameAspect = rect.width / Math.max(rect.height, 1);
    let width = rect.width;
    let height = rect.height;
    let left = 0;
    let top = 0;
    if (frameAspect > imageAspect) {
      height = rect.height;
      width = height * imageAspect;
      left = (rect.width - width) / 2;
    } else {
      width = rect.width;
      height = width / imageAspect;
      top = (rect.height - height) / 2;
    }
    const scaledWidth = width * zoom;
    const scaledHeight = height * zoom;
    setPaintSurfaceStyle({
      left: left + (width - scaledWidth) / 2 + viewOffset.x,
      top: top + (height - scaledHeight) / 2 + viewOffset.y,
      width: scaledWidth,
      height: scaledHeight,
    });
  }, [canvasSize.height, canvasSize.width, viewOffset.x, viewOffset.y, zoom]);

  const renderComposite = useCallback(
    (target?: HTMLCanvasElement, options: { before?: boolean } = {}) => {
      const canvas = target ?? displayCanvasRef.current;
      if (!canvas || canvasSize.width <= 0 || canvasSize.height <= 0) return;
      const context = canvas.getContext('2d');
      if (!context) return;
      canvas.width = canvasSize.width;
      canvas.height = canvasSize.height;
      context.clearRect(0, 0, canvas.width, canvas.height);
      if (options.before) {
        if (sourceCanvasRef.current) context.drawImage(sourceCanvasRef.current, 0, 0);
        return;
      }
      [...editLayers].reverse().forEach((item) => {
        if (!item.visible) return;
        const layerCanvas = layerCanvasesRef.current[item.id];
        if (!layerCanvas) return;
        context.save();
        context.globalAlpha = Math.max(0, Math.min(1, item.opacity));
        context.globalCompositeOperation = blendOperation(item.blendMode);
        context.filter = buildLayerFilter(item);
        context.drawImage(layerCanvas, item.offsetX, item.offsetY);
        context.restore();
      });
    },
    [canvasSize.height, canvasSize.width, editLayers],
  );

  useEffect(() => {
    let cancelled = false;
    void loadImage(layer.imageUrl)
      .then((image) => {
        if (cancelled) return;
        const width = image.naturalWidth || image.width || 1;
        const height = image.naturalHeight || image.height || 1;
        const sourceCanvas = createCanvas(width, height);
        const sourceContext = sourceCanvas.getContext('2d');
        if (!sourceContext) throw new Error('Could not create source canvas.');
        sourceContext.drawImage(image, 0, 0, width, height);
        sourceCanvasRef.current = sourceCanvas;

        const baseId = createLayerId('base');
        const editId = createLayerId('edit');
        const baseCanvas = createCanvas(width, height);
        const baseContext = baseCanvas.getContext('2d');
        if (!baseContext) throw new Error('Could not create edit canvas.');
        baseContext.drawImage(image, 0, 0, width, height);
        layerCanvasesRef.current = {
          [baseId]: baseCanvas,
          [editId]: createCanvas(width, height),
        };
        setCanvasSize({ width, height });
        setEditLayers([
          createDefaultEditorLayer({
            id: editId,
            name: tRef.current('imageEditLayer'),
            visible: true,
            opacity: 1,
            blendMode: 'normal',
            offsetX: 0,
            offsetY: 0,
          }),
          createDefaultEditorLayer({
            id: baseId,
            name: tRef.current('imageEditBaseLayer'),
            visible: true,
            opacity: 1,
            blendMode: 'normal',
            offsetX: 0,
            offsetY: 0,
            base: true,
          }),
        ]);
        setActiveLayerId(baseId);
        setSelection(undefined);
        setUndoStack([]);
        setRedoStack([]);
        setError(undefined);
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : tRef.current('imageEditLoadFailed')));
    return () => {
      cancelled = true;
    };
  }, [layer.imageUrl]);

  useEffect(() => {
    renderComposite(undefined, { before: showBefore });
  }, [renderComposite, showBefore, viewMode]);

  useEffect(() => {
    window.addEventListener('resize', updatePaintSurfaceLayout);
    return () => window.removeEventListener('resize', updatePaintSurfaceLayout);
  }, [updatePaintSurfaceLayout]);

  useEffect(() => {
    updatePaintSurfaceLayout();
  }, [updatePaintSurfaceLayout, viewMode]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (event.key === 'Escape') {
        onCancel();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && key === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && key === 'y') {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  });

  useEffect(() => {
    if (!onRefreshMappedPreview || editLayers.length === 0 || canvasSize.width <= 1 || canvasSize.height <= 1) return undefined;
    const timer = window.setTimeout(() => {
      void refreshMappedPreview();
    }, 420);
    return () => window.clearTimeout(timer);
    // Canvas pixels change outside React state, so editRevision is the explicit invalidation signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editLayers, editRevision, canvasSize.width, canvasSize.height, onRefreshMappedPreview]);

  function takeSnapshot(): EditorSnapshot {
    return {
      layers: editLayers.map((item) => ({ ...item })),
      activeLayerId,
      dataUrls: Object.fromEntries(
        editLayers.map((item) => [item.id, layerCanvasesRef.current[item.id]?.toDataURL('image/png') ?? '']),
      ),
    };
  }

  function pushUndoSnapshot() {
    const snapshot = takeSnapshot();
    setUndoStack((stack) => [...stack.slice(-23), snapshot]);
    setRedoStack([]);
  }

  function bumpEditRevision() {
    setEditRevision((value) => value + 1);
  }

  function beginContinuousLayerEdit() {
    if (continuousLayerEditRef.current) return;
    continuousLayerEditRef.current = true;
    pushUndoSnapshot();
  }

  function endContinuousLayerEdit() {
    if (!continuousLayerEditRef.current) return;
    continuousLayerEditRef.current = false;
    bumpEditRevision();
  }

  async function restoreSnapshot(snapshot: EditorSnapshot) {
    const restoredCanvases: Record<string, HTMLCanvasElement> = {};
    await Promise.all(
      snapshot.layers.map(async (item) => {
        const canvas = createCanvas(canvasSize.width, canvasSize.height);
        const context = canvas.getContext('2d');
        const dataUrl = snapshot.dataUrls[item.id];
        if (context && dataUrl) {
          const image = await loadImage(dataUrl);
          context.drawImage(image, 0, 0);
        }
        restoredCanvases[item.id] = canvas;
      }),
    );
    layerCanvasesRef.current = restoredCanvases;
    setEditLayers(snapshot.layers.map((item) => ({ ...item })));
    setActiveLayerId(snapshot.activeLayerId);
    bumpEditRevision();
  }

  function undo() {
    const snapshot = undoStack.at(-1);
    if (!snapshot) return;
    const current = takeSnapshot();
    setUndoStack((stack) => stack.slice(0, -1));
    setRedoStack((stack) => [current, ...stack].slice(0, 24));
    void restoreSnapshot(snapshot);
  }

  function redo() {
    const snapshot = redoStack[0];
    if (!snapshot) return;
    const current = takeSnapshot();
    setRedoStack((stack) => stack.slice(1));
    setUndoStack((stack) => [...stack.slice(-23), current]);
    void restoreSnapshot(snapshot);
  }

  function getCanvasPoint(event: PointerEvent<HTMLCanvasElement>) {
    const canvas = displayCanvasRef.current;
    if (!canvas) return undefined;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / Math.max(rect.width, 1)) * canvas.width,
      y: ((event.clientY - rect.top) / Math.max(rect.height, 1)) * canvas.height,
    };
  }

  function getActiveCanvasPoint(point: { x: number; y: number }) {
    return {
      x: point.x - (activeLayer?.offsetX ?? 0),
      y: point.y - (activeLayer?.offsetY ?? 0),
    };
  }

  function drawAt(point: { x: number; y: number }) {
    if (!activeLayer) return;
    const canvas = layerCanvasesRef.current[activeLayer.id];
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const previousPoint = lastPointRef.current;
    const localPoint = getActiveCanvasPoint(point);
    const previousLocal = previousPoint ? getActiveCanvasPoint(previousPoint) : undefined;
    const stampBrush = (x: number, y: number) => {
      const radius = brushSize / 2;
      const hardStop = Math.max(0.05, Math.min(1, brushHardness));
      const gradient = context.createRadialGradient(x, y, radius * hardStop, x, y, radius);
      gradient.addColorStop(0, hexToRgba(color, brushOpacity));
      gradient.addColorStop(1, hexToRgba(color, 0));
      context.save();
      context.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
      context.fillStyle = gradient;
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
      context.restore();
    };
    if (previousLocal) {
      const distance = Math.hypot(localPoint.x - previousLocal.x, localPoint.y - previousLocal.y);
      const steps = Math.max(1, Math.ceil(distance / Math.max(1, brushSize * 0.25)));
      for (let step = 0; step <= steps; step += 1) {
        const ratio = step / steps;
        stampBrush(
          previousLocal.x + (localPoint.x - previousLocal.x) * ratio,
          previousLocal.y + (localPoint.y - previousLocal.y) * ratio,
        );
      }
    } else {
      stampBrush(localPoint.x, localPoint.y);
    }
    lastPointRef.current = point;
    renderComposite();
  }

  function floodFill(point: { x: number; y: number }) {
    if (!activeLayer) return;
    const canvas = layerCanvasesRef.current[activeLayer.id];
    const context = canvas?.getContext('2d', { willReadFrequently: true });
    if (!canvas || !context) return;
    const localPoint = getActiveCanvasPoint(point);
    const startX = Math.floor(localPoint.x);
    const startY = Math.floor(localPoint.y);
    if (startX < 0 || startY < 0 || startX >= canvas.width || startY >= canvas.height) return;
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    const startOffset = (startY * canvas.width + startX) * 4;
    const target: [number, number, number, number] = [
      data[startOffset],
      data[startOffset + 1],
      data[startOffset + 2],
      data[startOffset + 3],
    ];
    const fillColor = color.replace('#', '').padEnd(6, '0').slice(0, 6);
    const replacement: [number, number, number, number] = [
      Number.parseInt(fillColor.slice(0, 2), 16),
      Number.parseInt(fillColor.slice(2, 4), 16),
      Number.parseInt(fillColor.slice(4, 6), 16),
      Math.round(brushOpacity * 255),
    ];
    if (
      Math.abs(target[0] - replacement[0]) < 2 &&
      Math.abs(target[1] - replacement[1]) < 2 &&
      Math.abs(target[2] - replacement[2]) < 2 &&
      Math.abs(target[3] - replacement[3]) < 2
    ) {
      return;
    }
    const stack = [[startX, startY]];
    const visited = new Uint8Array(canvas.width * canvas.height);
    while (stack.length > 0) {
      const next = stack.pop();
      if (!next) continue;
      const [x, y] = next;
      if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) continue;
      const index = y * canvas.width + x;
      if (visited[index]) continue;
      visited[index] = 1;
      const offset = index * 4;
      if (!imageDataMatches(data, offset, target, 28)) continue;
      data[offset] = replacement[0];
      data[offset + 1] = replacement[1];
      data[offset + 2] = replacement[2];
      data[offset + 3] = replacement[3];
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    context.putImageData(imageData, 0, 0);
    renderComposite();
    bumpEditRevision();
  }

  function sampleColor(point: { x: number; y: number }) {
    const preview = createCanvas(canvasSize.width, canvasSize.height);
    renderComposite(preview);
    const context = preview.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    const x = Math.max(0, Math.min(preview.width - 1, Math.floor(point.x)));
    const y = Math.max(0, Math.min(preview.height - 1, Math.floor(point.y)));
    const pixel = context.getImageData(x, y, 1, 1).data;
    setColor(rgbaToHex(pixel[0], pixel[1], pixel[2]));
    setTool('brush');
  }

  function getSelectionInActiveLayer() {
    if (!selection || !activeLayer) return undefined;
    const canvas = layerCanvasesRef.current[activeLayer.id];
    if (!canvas) return undefined;
    const x = Math.max(0, Math.min(canvas.width, Math.round(selection.x - activeLayer.offsetX)));
    const y = Math.max(0, Math.min(canvas.height, Math.round(selection.y - activeLayer.offsetY)));
    const right = Math.max(0, Math.min(canvas.width, Math.round(selection.x + selection.w - activeLayer.offsetX)));
    const bottom = Math.max(0, Math.min(canvas.height, Math.round(selection.y + selection.h - activeLayer.offsetY)));
    const rect = { x, y, w: right - x, h: bottom - y };
    return rect.w > 0 && rect.h > 0 ? rect : undefined;
  }

  function fillSelection() {
    if (!activeLayer) return;
    const rect = getSelectionInActiveLayer();
    if (!rect) return;
    const canvas = layerCanvasesRef.current[activeLayer.id];
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    pushUndoSnapshot();
    context.save();
    context.globalAlpha = brushOpacity;
    context.fillStyle = color;
    context.fillRect(rect.x, rect.y, rect.w, rect.h);
    context.restore();
    renderComposite();
    bumpEditRevision();
  }

  function deleteSelection() {
    if (!activeLayer) return;
    const rect = getSelectionInActiveLayer();
    if (!rect) return;
    const canvas = layerCanvasesRef.current[activeLayer.id];
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    pushUndoSnapshot();
    context.clearRect(rect.x, rect.y, rect.w, rect.h);
    renderComposite();
    bumpEditRevision();
  }

  function keepSelectionOnly() {
    if (!activeLayer) return;
    const rect = getSelectionInActiveLayer();
    if (!rect) return;
    const canvas = layerCanvasesRef.current[activeLayer.id];
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    pushUndoSnapshot();
    context.save();
    context.globalCompositeOperation = 'destination-in';
    context.beginPath();
    context.rect(rect.x, rect.y, rect.w, rect.h);
    context.fill();
    context.restore();
    renderComposite();
    bumpEditRevision();
  }

  function updateLayer(layerId: string, patch: Partial<EditorLayer>, capture = true) {
    if (capture) pushUndoSnapshot();
    setEditLayers((items) => items.map((item) => (item.id === layerId ? { ...item, ...patch } : item)));
    bumpEditRevision();
  }

  function addLayer() {
    pushUndoSnapshot();
    const id = createLayerId('edit');
    layerCanvasesRef.current[id] = createCanvas(canvasSize.width, canvasSize.height);
    setEditLayers((items) => [
      createDefaultEditorLayer({
        id,
        name: `${t('imageEditLayer')} ${items.filter((item) => !item.base).length + 1}`,
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        offsetX: 0,
        offsetY: 0,
      }),
      ...items,
    ]);
    setActiveLayerId(id);
    bumpEditRevision();
  }

  function duplicateLayer() {
    if (!activeLayer) return;
    pushUndoSnapshot();
    const source = layerCanvasesRef.current[activeLayer.id];
    const id = createLayerId('edit');
    const canvas = createCanvas(canvasSize.width, canvasSize.height);
    canvas.getContext('2d')?.drawImage(source, 0, 0);
    layerCanvasesRef.current[id] = canvas;
    setEditLayers((items) => {
      const index = items.findIndex((item) => item.id === activeLayer.id);
      const next = [...items];
      next.splice(Math.max(index, 0), 0, {
        ...activeLayer,
        id,
        name: `${activeLayer.name} ${t('copySuffix')}`,
        base: false,
      });
      return next;
    });
    setActiveLayerId(id);
    bumpEditRevision();
  }

  function deleteLayer() {
    if (!activeLayer || activeLayer.base) return;
    pushUndoSnapshot();
    delete layerCanvasesRef.current[activeLayer.id];
    setEditLayers((items) => {
      const next = items.filter((item) => item.id !== activeLayer.id);
      setActiveLayerId(next[0]?.id ?? '');
      return next;
    });
    bumpEditRevision();
  }

  function clearActiveLayer() {
    if (!activeLayer) return;
    pushUndoSnapshot();
    const canvas = layerCanvasesRef.current[activeLayer.id];
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    renderComposite();
    bumpEditRevision();
  }

  function transformActiveLayer(kind: 'rotate-left' | 'rotate-right' | 'flip-x' | 'flip-y') {
    if (!activeLayer) return;
    const canvas = layerCanvasesRef.current[activeLayer.id];
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    pushUndoSnapshot();
    const temp = createCanvas(canvas.width, canvas.height);
    temp.getContext('2d')?.drawImage(canvas, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.save();
    if (kind === 'rotate-left') {
      context.translate(canvas.width / 2, canvas.height / 2);
      context.rotate(-Math.PI / 2);
      context.drawImage(temp, -canvas.width / 2, -canvas.height / 2);
    } else if (kind === 'rotate-right') {
      context.translate(canvas.width / 2, canvas.height / 2);
      context.rotate(Math.PI / 2);
      context.drawImage(temp, -canvas.width / 2, -canvas.height / 2);
    } else if (kind === 'flip-x') {
      context.translate(canvas.width, 0);
      context.scale(-1, 1);
      context.drawImage(temp, 0, 0);
    } else {
      context.translate(0, canvas.height);
      context.scale(1, -1);
      context.drawImage(temp, 0, 0);
    }
    context.restore();
    renderComposite();
    bumpEditRevision();
  }

  function selectTool(nextTool: Tool) {
    setTool(nextTool);
    if (nextTool === 'brush' || nextTool === 'eraser' || nextTool === 'fill' || nextTool === 'select') {
      setPopoverPanel((current) => (current === 'tool' && tool === nextTool ? undefined : 'tool'));
      return;
    }
    setPopoverPanel(undefined);
  }

  function getCompositeDataUrl() {
    const output = createCanvas(canvasSize.width, canvasSize.height);
    renderComposite(output);
    return output.toDataURL('image/png');
  }

  async function refreshMappedPreview() {
    if (!onRefreshMappedPreview) return;
    const requestId = previewRequestRef.current + 1;
    previewRequestRef.current = requestId;
    setIsRefreshingMappedPreview(true);
    setError(undefined);
    try {
      const nextPreview = await onRefreshMappedPreview(getCompositeDataUrl());
      if (previewRequestRef.current === requestId && nextPreview) setMappedPreview(nextPreview);
    } catch (caught) {
      if (previewRequestRef.current === requestId) setError(caught instanceof Error ? caught.message : t('viewportUnavailable'));
    } finally {
      if (previewRequestRef.current === requestId) setIsRefreshingMappedPreview(false);
    }
  }

  async function handleApply() {
    setIsApplying(true);
    setError(undefined);
    try {
      await onApply(getCompositeDataUrl());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('imageEditApplyFailed'));
      setIsApplying(false);
    }
  }

  function handlePointerDown(event: PointerEvent<HTMLCanvasElement>) {
    if (showBefore || !activeLayer) return;
    const point = getCanvasPoint(event);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (event.button === 1 || event.altKey) {
      event.preventDefault();
      panDragRef.current = { x: event.clientX, y: event.clientY, offsetX: viewOffset.x, offsetY: viewOffset.y };
      return;
    }
    if (tool === 'picker') {
      sampleColor(point);
      return;
    }
    if (tool === 'fill') {
      if (selection) fillSelection();
      else {
        pushUndoSnapshot();
        floodFill(point);
      }
      return;
    }
    if (tool === 'select') {
      selectionDraftRef.current = { start: point };
      setSelection({ x: Math.round(point.x), y: Math.round(point.y), w: 0, h: 0 });
      return;
    }
    pushUndoSnapshot();
    if (tool === 'move') {
      movingRef.current = { x: point.x, y: point.y, offsetX: activeLayer.offsetX, offsetY: activeLayer.offsetY };
      return;
    }
    drawingRef.current = true;
    lastPointRef.current = undefined;
    drawAt(point);
  }

  function handlePointerMove(event: PointerEvent<HTMLCanvasElement>) {
    if (showBefore || !activeLayer) return;
    if (panDragRef.current) {
      const origin = panDragRef.current;
      setViewOffset({
        x: origin.offsetX + event.clientX - origin.x,
        y: origin.offsetY + event.clientY - origin.y,
      });
      return;
    }
    const point = getCanvasPoint(event);
    if (!point) return;
    if (movingRef.current && tool === 'move') {
      const origin = movingRef.current;
      const offsetX = origin.offsetX + point.x - origin.x;
      const offsetY = origin.offsetY + point.y - origin.y;
      setEditLayers((items) => items.map((item) => (item.id === activeLayer.id ? { ...item, offsetX, offsetY } : item)));
      return;
    }
    if (selectionDraftRef.current && tool === 'select') {
      setSelection(normalizeRect(selectionDraftRef.current.start, point, canvasSize));
      return;
    }
    if (drawingRef.current && (tool === 'brush' || tool === 'eraser')) drawAt(point);
  }

  function handlePointerEnd(event: PointerEvent<HTMLCanvasElement>) {
    const changedLayerPixels = drawingRef.current || Boolean(movingRef.current);
    drawingRef.current = false;
    movingRef.current = undefined;
    panDragRef.current = undefined;
    selectionDraftRef.current = undefined;
    lastPointRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    renderComposite();
    if (changedLayerPixels) bumpEditRevision();
  }

  function handleCanvasWheel(event: WheelEvent<HTMLDivElement>) {
    if (zoom <= 1 && !event.ctrlKey) return;
    event.preventDefault();
    if (event.ctrlKey) {
      const nextZoom = Math.max(0.35, Math.min(4, zoom - event.deltaY / 500));
      setZoom(nextZoom);
      return;
    }
    setViewOffset((offset) => ({
      x: offset.x - (event.shiftKey ? event.deltaY : event.deltaX),
      y: offset.y - (event.shiftKey ? 0 : event.deltaY),
    }));
  }

  const modeDescription = isUvLayer ? t('imageEditUvHelp') : t('imageEditProjectedHelp');
  const activeSelection = selection && selection.w > 1 && selection.h > 1 ? selection : undefined;
  const selectionStyle = activeSelection
    ? {
        left: paintSurfaceStyle.left + (activeSelection.x / Math.max(1, canvasSize.width)) * paintSurfaceStyle.width,
        top: paintSurfaceStyle.top + (activeSelection.y / Math.max(1, canvasSize.height)) * paintSurfaceStyle.height,
        width: (activeSelection.w / Math.max(1, canvasSize.width)) * paintSurfaceStyle.width,
        height: (activeSelection.h / Math.max(1, canvasSize.height)) * paintSurfaceStyle.height,
      }
    : undefined;

  return createPortal(
    <div className="fixed inset-0 z-[121] grid place-items-center bg-black/62 p-4 text-white backdrop-blur-sm">
      <section className="relative grid h-[94vh] w-full max-w-[min(96vw,1880px)] grid-cols-[52px_minmax(0,1fr)_320px] overflow-hidden rounded-lg border border-white/16 bg-[#10111a] shadow-[0_30px_90px_rgba(0,0,0,0.58)]">
        <nav className="flex flex-col items-center gap-1.5 border-r border-white/12 bg-[#14151f] p-2">
          <ToolButton active={tool === 'move'} label={t('imageEditMoveTool')} onClick={() => selectTool('move')}>
            <Move className="h-4 w-4" />
          </ToolButton>
          <ToolButton active={tool === 'select'} label={t('imageEditSelectTool')} onClick={() => selectTool('select')}>
            <SquareDashedMousePointer className="h-4 w-4" />
          </ToolButton>
          <ToolButton active={tool === 'brush'} label={t('brush')} onClick={() => selectTool('brush')}>
            <Brush className="h-4 w-4" />
          </ToolButton>
          <ToolButton active={tool === 'eraser'} label={t('eraser')} onClick={() => selectTool('eraser')}>
            <Eraser className="h-4 w-4" />
          </ToolButton>
          <ToolButton active={tool === 'fill'} label={t('imageEditFillTool')} onClick={() => selectTool('fill')}>
            <PaintBucket className="h-4 w-4" />
          </ToolButton>
          <ToolButton active={tool === 'picker'} label={t('imageEditPickerTool')} onClick={() => selectTool('picker')}>
            <Pipette className="h-4 w-4" />
          </ToolButton>
          <div className="my-1 h-px w-full bg-white/14" />
          <ToolButton label={t('undo')} disabled={undoStack.length === 0} onClick={undo}>
            <RotateCcw className="h-4 w-4" />
          </ToolButton>
          <ToolButton label={t('redo')} disabled={redoStack.length === 0} onClick={redo}>
            <RotateCw className="h-4 w-4" />
          </ToolButton>
          <ToolButton label={t('imageEditZoomIn')} onClick={() => setZoom((value) => Math.min(4, value + 0.2))}>
            <ZoomIn className="h-4 w-4" />
          </ToolButton>
          <ToolButton label={t('imageEditZoomOut')} onClick={() => setZoom((value) => Math.max(0.35, value - 0.2))}>
            <ZoomOut className="h-4 w-4" />
          </ToolButton>
        </nav>

        {popoverPanel === 'tool' && (
          <div className="absolute left-[60px] top-[62px] z-20 w-[292px] rounded-md border border-white/16 bg-[#20212b] p-3 shadow-[0_18px_42px_rgba(0,0,0,0.48)]">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <SlidersHorizontal className="h-4 w-4" />
                {t('imageEditToolOptions')}
              </div>
              <button type="button" className="grid h-7 w-7 place-items-center rounded hover:bg-white/10" onClick={() => setPopoverPanel(undefined)}>
                <X className="h-4 w-4" />
              </button>
            </div>
            {(tool === 'brush' || tool === 'eraser' || tool === 'fill') && (
              <div className="space-y-3">
                <AdjustmentSlider label={t('brushSize')} value={brushSize} min={1} max={220} suffix="px" onChange={setBrushSize} />
                {(tool === 'brush' || tool === 'eraser') && (
                  <AdjustmentSlider
                    label={t('imageEditBrushHardness')}
                    value={Math.round(brushHardness * 100)}
                    min={5}
                    max={100}
                    suffix="%"
                    onChange={(value) => setBrushHardness(value / 100)}
                  />
                )}
                <AdjustmentSlider
                  label={t('imageEditBrushOpacity')}
                  value={Math.round(brushOpacity * 100)}
                  min={5}
                  max={100}
                  suffix="%"
                  onChange={(value) => setBrushOpacity(value / 100)}
                />
                {tool !== 'eraser' && (
                  <label className="flex items-center justify-between gap-3 text-xs font-semibold text-white/78">
                    <span>{t('brushColor')}</span>
                    <input
                      type="color"
                      value={color}
                      onChange={(event) => setColor(event.target.value)}
                      className="h-8 w-12 rounded border border-white/18 bg-transparent p-0.5"
                    />
                  </label>
                )}
              </div>
            )}
            {tool === 'select' && (
              <div className="grid grid-cols-2 gap-2">
                <ActionButton disabled={!activeSelection} onClick={fillSelection}>
                  <PaintBucket className="h-4 w-4" />
                  {t('imageEditFillSelection')}
                </ActionButton>
                <ActionButton disabled={!activeSelection} onClick={deleteSelection}>
                  <Scissors className="h-4 w-4" />
                  {t('imageEditDeleteSelection')}
                </ActionButton>
                <ActionButton disabled={!activeSelection} onClick={keepSelectionOnly}>
                  <Crop className="h-4 w-4" />
                  {t('imageEditKeepSelection')}
                </ActionButton>
                <ActionButton disabled={!activeSelection} onClick={() => setSelection(undefined)}>
                  <X className="h-4 w-4" />
                  {t('imageEditClearSelection')}
                </ActionButton>
              </div>
            )}
          </div>
        )}

        {popoverPanel === 'adjust' && activeLayer && (
          <div className="absolute right-[332px] top-[112px] z-20 w-[286px] rounded-md border border-white/16 bg-[#20212b] p-3 shadow-[0_18px_42px_rgba(0,0,0,0.48)]">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Contrast className="h-4 w-4" />
                {t('imageEditColorAdjust')}
              </div>
              <button type="button" className="grid h-7 w-7 place-items-center rounded hover:bg-white/10" onClick={() => setPopoverPanel(undefined)}>
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3">
              <AdjustmentSlider
                label={t('lightness')}
                value={activeLayer.brightness}
                min={-100}
                max={100}
                suffix="%"
                onChangeStart={beginContinuousLayerEdit}
                onChangeEnd={endContinuousLayerEdit}
                onChange={(value) => updateLayer(activeLayer.id, { brightness: value }, false)}
              />
              <AdjustmentSlider
                label={t('contrast')}
                value={activeLayer.contrast}
                min={-100}
                max={100}
                suffix="%"
                onChangeStart={beginContinuousLayerEdit}
                onChangeEnd={endContinuousLayerEdit}
                onChange={(value) => updateLayer(activeLayer.id, { contrast: value }, false)}
              />
              <AdjustmentSlider
                label={t('saturation')}
                value={activeLayer.saturation}
                min={-100}
                max={100}
                suffix="%"
                onChangeStart={beginContinuousLayerEdit}
                onChangeEnd={endContinuousLayerEdit}
                onChange={(value) => updateLayer(activeLayer.id, { saturation: value }, false)}
              />
              <AdjustmentSlider
                label={t('hue')}
                value={activeLayer.hue}
                min={-180}
                max={180}
                suffix="deg"
                onChangeStart={beginContinuousLayerEdit}
                onChangeEnd={endContinuousLayerEdit}
                onChange={(value) => updateLayer(activeLayer.id, { hue: value }, false)}
              />
              <button
                type="button"
                className="h-8 w-full rounded-md border border-white/14 text-xs font-semibold text-white/74 hover:bg-white/8"
                onClick={() => updateLayer(activeLayer.id, { brightness: 0, contrast: 0, saturation: 0, hue: 0 })}
              >
                {t('reset')}
              </button>
            </div>
          </div>
        )}

        <main className="flex min-h-0 min-w-0 flex-col bg-[#080912]">
          <header className="flex h-[54px] items-center justify-between border-b border-white/12 px-4">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-[#ff8bdc]">{isUvLayer ? t('imageEditUvMode') : t('imageEditProjectedMode')}</div>
              <h2 className="truncate text-lg font-semibold">{layer.name}</h2>
            </div>
            <div className="flex items-center gap-2 text-xs font-semibold text-white/64">
              <button type="button" className={cn('h-8 rounded-md border border-white/14 px-3 hover:bg-white/8', viewMode === 'split' && 'border-white bg-white text-black')} onClick={() => setViewMode('split')}>
                {t('imageEditSplitView')}
              </button>
              <button type="button" className={cn('h-8 rounded-md border border-white/14 px-3 hover:bg-white/8', viewMode === 'image' && 'border-white bg-white text-black')} onClick={() => setViewMode('image')}>
                {t('imageEditLayerView')}
              </button>
              <button type="button" className={cn('h-8 rounded-md border border-white/14 px-3 hover:bg-white/8', viewMode === 'mapped' && 'border-white bg-white text-black')} onClick={() => setViewMode('mapped')}>
                {t('imageEditMappedView')}
              </button>
              <span>{canvasSize.width} x {canvasSize.height}</span>
              <button
                type="button"
                className={cn('h-8 rounded-md border border-white/14 px-3 hover:bg-white/8', showBefore && 'border-white bg-white text-black')}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => setShowBefore((value) => !value)}
              >
                {showBefore ? t('before') : t('after')}
              </button>
            </div>
          </header>

          <div className="flex h-10 items-center gap-2 border-b border-white/10 bg-[#191a22] px-3 text-xs text-white/72">
            <button
              type="button"
              className="flex h-7 items-center gap-2 rounded border border-white/12 px-2 font-semibold hover:bg-white/8"
              onClick={() => setPopoverPanel((current) => (current === 'tool' ? undefined : 'tool'))}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              {tool === 'brush' ? t('brush') : tool === 'eraser' ? t('eraser') : tool === 'select' ? t('imageEditSelectTool') : tool === 'fill' ? t('imageEditFillTool') : tool === 'picker' ? t('imageEditPickerTool') : t('imageEditMoveTool')}
            </button>
            <span>{t('brushSize')}: {brushSize}px</span>
            <span>{t('imageEditBrushOpacity')}: {Math.round(brushOpacity * 100)}%</span>
            <span className="h-5 w-5 rounded border border-white/24" style={{ backgroundColor: color }} />
          </div>

          <div className={cn('grid min-h-0 flex-1 gap-px bg-white/10', viewMode === 'split' ? 'grid-cols-[minmax(420px,0.9fr)_minmax(520px,1.1fr)]' : 'grid-cols-1')}>
            {viewMode !== 'mapped' && (
              <div
                ref={frameRef}
                className="relative min-h-0 overflow-hidden bg-[#070812]"
                onWheel={handleCanvasWheel}
                onContextMenu={(event) => event.preventDefault()}
              >
                <div className="absolute" style={{ ...paintSurfaceStyle, ...checkerStyle }} />
                {isUvLayer && (
                  <div
                    className="pointer-events-none absolute opacity-35"
                    style={{
                      ...paintSurfaceStyle,
                      backgroundImage:
                        'linear-gradient(rgba(255,255,255,.22) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.22) 1px, transparent 1px)',
                      backgroundSize: `${Math.max(24, paintSurfaceStyle.width / 8)}px ${Math.max(24, paintSurfaceStyle.height / 8)}px`,
                    }}
                  />
                )}
                <canvas
                  ref={displayCanvasRef}
                  className={cn(
                    'absolute cursor-crosshair',
                    tool === 'move' && 'cursor-move',
                    tool === 'select' && 'cursor-cell',
                    showBefore && 'cursor-default',
                  )}
                  style={paintSurfaceStyle}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerEnd}
                  onPointerCancel={handlePointerEnd}
                />
                {selectionStyle && !showBefore && (
                  <div
                    className="pointer-events-none absolute border border-white bg-[#ff62d2]/10 shadow-[0_0_0_1px_rgba(255,98,210,0.9),0_0_0_9999px_rgba(0,0,0,0.08)]"
                    style={selectionStyle}
                  >
                    <div className="absolute inset-0 border border-dashed border-black/80" />
                  </div>
                )}
              </div>
            )}

            {viewMode !== 'image' && (
              <section className="flex min-h-0 flex-col bg-[#0b0c14]">
                <header className="flex h-10 items-center justify-between border-b border-white/10 px-3 text-xs font-semibold text-white/72">
                  <span>{t('imageEditMappedPreview')}</span>
                  <button
                    type="button"
                    disabled={!onRefreshMappedPreview || isRefreshingMappedPreview}
                    className="flex h-7 items-center gap-1.5 rounded border border-white/14 px-2 hover:bg-white/8 disabled:cursor-not-allowed disabled:opacity-40"
                    onClick={() => void refreshMappedPreview()}
                  >
                    <RotateCw className={cn('h-3.5 w-3.5', isRefreshingMappedPreview && 'animate-spin')} />
                    {t('imageEditRefreshMappedPreview')}
                  </button>
                </header>
                <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-2">
                  {mappedPreview ? (
                    <img src={mappedPreview} alt={t('imageEditMappedPreview')} className="h-full w-full object-contain" />
                  ) : (
                    <div className="max-w-xs text-center text-sm leading-6 text-white/54">{t('imageEditNoMappedPreview')}</div>
                  )}
                </div>
              </section>
            )}
          </div>
        </main>

        <aside className="flex min-h-0 flex-col border-l border-white/12 bg-[#151622]">
          <header className="flex items-start justify-between border-b border-white/12 p-4">
            <div>
              <div className="text-xs font-semibold text-white/54">{t('imageEditTitle')}</div>
              <p className="mt-1 max-w-[250px] text-xs leading-5 text-white/62">{modeDescription}</p>
            </div>
            <button type="button" className="grid h-8 w-8 place-items-center rounded hover:bg-white/10" onClick={onCancel}>
              <X className="h-4 w-4" />
            </button>
          </header>

          <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
            <section className="space-y-2">
              <div className="text-sm font-semibold">{t('color')}</div>
              <div className="flex items-center gap-3">
                <input type="color" value={color} onChange={(event) => setColor(event.target.value)} className="h-12 w-16 rounded border border-white/18 bg-transparent p-0.5" />
                <div className="text-xs text-white/58">{color.toUpperCase()}</div>
              </div>
            </section>

            {activeLayer && (
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold">{t('imageEditActiveLayer')}</div>
                  <div className="flex gap-1">
                    <MiniButton label={t('imageEditColorAdjust')} onClick={() => setPopoverPanel((current) => (current === 'adjust' ? undefined : 'adjust'))}>
                      <Contrast className="h-4 w-4" />
                    </MiniButton>
                    <MiniButton label={t('imageEditFlipX')} onClick={() => transformActiveLayer('flip-x')}>
                      <FlipHorizontal className="h-4 w-4" />
                    </MiniButton>
                    <MiniButton label={t('imageEditFlipY')} onClick={() => transformActiveLayer('flip-y')}>
                      <FlipVertical className="h-4 w-4" />
                    </MiniButton>
                    <MiniButton label={t('imageEditRotateLeft')} onClick={() => transformActiveLayer('rotate-left')}>
                      <RotateCcw className="h-4 w-4" />
                    </MiniButton>
                    <MiniButton label={t('imageEditRotateRight')} onClick={() => transformActiveLayer('rotate-right')}>
                      <RotateCw className="h-4 w-4" />
                    </MiniButton>
                  </div>
                </div>
                <label className="grid gap-2 text-xs font-semibold text-white/78">
                  <span className="flex items-center justify-between">
                    {t('imageEditLayerOpacity')}
                    <span>{Math.round(activeLayer.opacity * 100)}%</span>
                  </span>
                  <input
                    className="accent-[#ff62d2]"
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={activeLayer.opacity}
                    onPointerDown={beginContinuousLayerEdit}
                    onPointerUp={endContinuousLayerEdit}
                    onPointerCancel={endContinuousLayerEdit}
                    onChange={(event) => updateLayer(activeLayer.id, { opacity: Number(event.target.value) }, false)}
                  />
                </label>
                <select
                  className="h-9 w-full rounded-md border border-white/16 bg-black/28 px-2 text-sm text-white outline-none"
                  value={activeLayer.blendMode}
                  onChange={(event) => updateLayer(activeLayer.id, { blendMode: event.target.value as EditorBlendMode })}
                >
                  <option value="normal">{t('imageEditBlendNormal')}</option>
                  <option value="multiply">{t('imageEditBlendMultiply')}</option>
                  <option value="screen">{t('imageEditBlendScreen')}</option>
                  <option value="overlay">{t('imageEditBlendOverlay')}</option>
                </select>
              </section>
            )}

            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold">{t('layers')}</div>
                <div className="flex gap-1">
                  <MiniButton label={t('addLayer')} onClick={addLayer}>
                    <Plus className="h-4 w-4" />
                  </MiniButton>
                  <MiniButton label={t('duplicate')} onClick={duplicateLayer} disabled={!activeLayer}>
                    <Copy className="h-4 w-4" />
                  </MiniButton>
                  <MiniButton label={t('clearMask')} onClick={clearActiveLayer} disabled={!activeLayer}>
                    <Eraser className="h-4 w-4" />
                  </MiniButton>
                  <MiniButton label={t('delete')} onClick={deleteLayer} disabled={!activeLayer || activeLayer.base}>
                    <Trash2 className="h-4 w-4" />
                  </MiniButton>
                </div>
              </div>
              <div className="max-h-72 overflow-y-auto rounded-md border border-white/14">
                {editLayers.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className={cn(
                      'flex h-12 w-full items-center gap-2 border-b border-white/10 px-2 text-left text-sm last:border-b-0 hover:bg-white/8',
                      item.id === activeLayerId && 'bg-white/16',
                    )}
                    onClick={() => setActiveLayerId(item.id)}
                  >
                    <span
                      role="button"
                      tabIndex={-1}
                      className="grid h-8 w-8 shrink-0 place-items-center rounded hover:bg-white/10"
                      onClick={(event) => {
                        event.stopPropagation();
                        updateLayer(item.id, { visible: !item.visible });
                      }}
                    >
                      {item.visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4 text-white/45" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-semibold">{item.name}</span>
                    <span className="text-xs text-white/52">{Math.round(item.opacity * 100)}%</span>
                  </button>
                ))}
              </div>
            </section>

            {error && <div className="rounded-md border border-red-400/30 bg-red-500/10 p-2 text-sm text-red-100">{error}</div>}
          </div>

          <footer className="grid gap-2 border-t border-white/12 p-4">
            <button
              type="button"
              disabled={isApplying || Boolean(error && editLayers.length === 0)}
              className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-gradient-to-r from-liclick-pink to-liclick-purple text-sm font-semibold disabled:opacity-50"
              onClick={() => void handleApply()}
            >
              <Check className="h-4 w-4" />
              {isApplying ? t('saving') : t('imageEditApply')}
            </button>
            <button type="button" className="h-9 rounded-md text-sm font-semibold text-white/68 hover:bg-white/8" onClick={onCancel}>
              {t('cancel')}
            </button>
          </footer>
        </aside>
      </section>
    </div>,
    document.body,
  );
}

function ToolButton({
  active,
  disabled,
  label,
  children,
  onClick,
}: {
  active?: boolean;
  disabled?: boolean;
  label: string;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <IconTooltip label={label} side="bottom" disabled={disabled}>
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        className={cn(
          'grid h-9 w-9 place-items-center rounded-md border border-transparent text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-35',
          active && 'border-[#ff62d2] bg-[#7d2d72]',
        )}
        aria-label={label}
      >
        {children}
      </button>
    </IconTooltip>
  );
}

function ActionButton({
  disabled,
  children,
  onClick,
}: {
  disabled?: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex h-9 items-center justify-center gap-2 rounded-md border border-white/14 px-2 text-xs font-semibold text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-35"
    >
      {children}
    </button>
  );
}

function AdjustmentSlider({
  label,
  value,
  min,
  max,
  suffix,
  onChangeStart,
  onChangeEnd,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix: string;
  onChangeStart?: () => void;
  onChangeEnd?: () => void;
  onChange: (value: number) => void;
}) {
  return (
    <label className="grid gap-1.5 text-xs font-semibold text-white/72">
      <span className="flex items-center justify-between">
        {label}
        <span>
          {value}
          {suffix}
        </span>
      </span>
      <input
        className="accent-[#ff62d2]"
        type="range"
        min={min}
        max={max}
        value={value}
        onPointerDown={onChangeStart}
        onPointerUp={onChangeEnd}
        onPointerCancel={onChangeEnd}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function MiniButton({
  disabled,
  label,
  children,
  onClick,
}: {
  disabled?: boolean;
  label: string;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <IconTooltip label={label} side="top" disabled={disabled}>
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        className="grid h-8 w-8 place-items-center rounded-md border border-white/14 text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-35"
        aria-label={label}
      >
        {children}
      </button>
    </IconTooltip>
  );
}
