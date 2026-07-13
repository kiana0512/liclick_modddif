import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Eraser, Paintbrush, RotateCcw, Square, WandSparkles, X } from 'lucide-react';
import { cn } from '@/components/common/cn';
import { useT } from '@/stores/i18nStore';
import type { MaskBitmap } from '@/types/localRepaint';
import type { ReferenceImage } from '@/types/project';

export type LocalRepaintGenerateInput = {
  prompt: string;
  userMask: MaskBitmap;
  includeBlankArea: boolean;
  limitToBlankAndSelection: boolean;
  preserveUnmaskedArea: boolean;
  selectedReferenceIds: string[];
};

type LocalRepaintDialogProps = {
  mode: 'edit_layer_image' | 'repair_current_view';
  workingImageUrl: string;
  objectMask: MaskBitmap;
  initialUserMask?: MaskBitmap;
  targetName: string;
  references: ReferenceImage[];
  onGenerate: (input: LocalRepaintGenerateInput) => Promise<{ previewUrl: string }>;
  onContentAwareFill?: (input: LocalRepaintGenerateInput) => Promise<{ previewUrl: string }>;
  onAbort?: () => void;
  onAccept: (options: { continueEditing: boolean }) => Promise<void> | void;
  onCancel: () => void;
  status?: 'idle' | 'submitting' | 'preview_ready' | 'cancelled' | 'error';
  previewUrl?: string;
  error?: string;
};

type CanvasPoint = {
  x: number;
  y: number;
};

type CanvasRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

const DEFAULT_LOCAL_REPAINT_BRUSH_SIZE = 16;
const MAX_LOCAL_REPAINT_BRUSH_SIZE = 96;
const STROKE_CLIP_PADDING = 2;

function createScaledIndexMap(sourceSize: number, targetSize: number) {
  const map = new Int32Array(targetSize);
  const maxSourceIndex = Math.max(0, sourceSize - 1);
  for (let index = 0; index < targetSize; index += 1) {
    map[index] = Math.min(maxSourceIndex, Math.floor((index / targetSize) * sourceSize));
  }
  return map;
}

function createMaskBrushPattern(context: CanvasRenderingContext2D) {
  const patternCanvas = document.createElement('canvas');
  patternCanvas.width = 24;
  patternCanvas.height = 24;
  const patternContext = patternCanvas.getContext('2d');
  if (!patternContext) return 'rgba(255, 80, 210, 0.72)';
  patternContext.clearRect(0, 0, patternCanvas.width, patternCanvas.height);
  patternContext.strokeStyle = 'rgba(255, 80, 210, 0.64)';
  patternContext.lineWidth = 6;
  patternContext.lineCap = 'butt';
  patternContext.beginPath();
  for (let offset = -48; offset <= 72; offset += 12) {
    patternContext.moveTo(offset, -18);
    patternContext.lineTo(offset + 48, 30);
  }
  patternContext.stroke();
  return context.createPattern(patternCanvas, 'repeat') ?? 'rgba(255, 80, 210, 0.64)';
}

export function LocalRepaintDialog({
  mode,
  workingImageUrl,
  objectMask,
  initialUserMask,
  targetName,
  references,
  onGenerate,
  onContentAwareFill,
  onAbort,
  onAccept,
  onCancel,
  status = 'idle',
  previewUrl,
  error,
}: LocalRepaintDialogProps) {
  const t = useT();
  const frameRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const logicalMaskCanvasRef = useRef<HTMLCanvasElement>();
  const objectClipCanvasRef = useRef<HTMLCanvasElement>();
  const maskBrushPatternRef = useRef<string | CanvasPattern>();
  const drawingRef = useRef(false);
  const lastPointRef = useRef<CanvasPoint>();
  const initialMaskAppliedRef = useRef(false);
  const [tool, setTool] = useState<'brush' | 'erase'>('brush');
  const [brushSize, setBrushSize] = useState(DEFAULT_LOCAL_REPAINT_BRUSH_SIZE);
  const [prompt, setPrompt] = useState('');
  const [includeBlankArea, setIncludeBlankArea] = useState(true);
  const [limitToBlankAndSelection, setLimitToBlankAndSelection] = useState(true);
  const [preserveUnmaskedArea, setPreserveUnmaskedArea] = useState(true);
  const [selectedReferenceIds, setSelectedReferenceIds] = useState<string[]>([]);
  const [showAfter, setShowAfter] = useState(true);
  const [localError, setLocalError] = useState<string>();
  const [paintSurfaceStyle, setPaintSurfaceStyle] = useState<CSSProperties>({ inset: 0 });
  const isSubmitting = status === 'submitting';

  useEffect(() => {
    initialMaskAppliedRef.current = false;
  }, [initialUserMask]);

  useEffect(() => {
    objectClipCanvasRef.current = undefined;
  }, [objectMask]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onCancel]);

  const updatePaintSurfaceLayout = useCallback(() => {
    const frame = frameRef.current;
    const image = imageRef.current;
    if (!frame || !image || image.naturalWidth === 0 || image.naturalHeight === 0) return;
    const rect = frame.getBoundingClientRect();
    const imageAspect = image.naturalWidth / image.naturalHeight;
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
    setPaintSurfaceStyle({ left, top, width, height });
  }, []);

  useEffect(() => {
    window.addEventListener('resize', updatePaintSurfaceLayout);
    return () => window.removeEventListener('resize', updatePaintSurfaceLayout);
  }, [updatePaintSurfaceLayout]);

  function syncCanvasSize() {
    const image = imageRef.current;
    const canvas = canvasRef.current;
    if (!image || !canvas || image.naturalWidth === 0 || image.naturalHeight === 0) return;
    const resized = canvas.width !== image.naturalWidth || canvas.height !== image.naturalHeight;
    if (resized) {
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const logicalCanvas = getLogicalMaskCanvas(canvas.width, canvas.height);
      logicalCanvas.width = canvas.width;
      logicalCanvas.height = canvas.height;
    }
    if (!initialMaskAppliedRef.current && initialUserMask) {
      drawInitialMask(canvas, initialUserMask);
      initialMaskAppliedRef.current = true;
    }
    updatePaintSurfaceLayout();
  }

  function getLogicalMaskCanvas(width: number, height: number) {
    if (!logicalMaskCanvasRef.current) logicalMaskCanvasRef.current = document.createElement('canvas');
    const canvas = logicalMaskCanvasRef.current;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    return canvas;
  }

  function getMaskBrushPattern(context: CanvasRenderingContext2D) {
    if (!maskBrushPatternRef.current) maskBrushPatternRef.current = createMaskBrushPattern(context);
    return maskBrushPatternRef.current;
  }

  function getObjectClipCanvas(width: number, height: number) {
    if (objectMask.width <= 0 || objectMask.height <= 0) return undefined;
    let clipCanvas = objectClipCanvasRef.current;
    if (clipCanvas?.width === width && clipCanvas.height === height) return clipCanvas;

    clipCanvas = document.createElement('canvas');
    clipCanvas.width = width;
    clipCanvas.height = height;
    const clipContext = clipCanvas.getContext('2d');
    if (!clipContext) return undefined;
    const imageData = clipContext.createImageData(width, height);
    const output = imageData.data;
    const source = objectMask.data;
    const sourceXByTargetX = createScaledIndexMap(objectMask.width, width);
    const sourceYByTargetY = createScaledIndexMap(objectMask.height, height);
    for (let y = 0; y < height; y += 1) {
      const maskRowOffset = sourceYByTargetY[y] * objectMask.width;
      const targetRowOffset = y * width * 4;
      for (let x = 0; x < width; x += 1) {
        const offset = targetRowOffset + x * 4;
        output[offset] = 255;
        output[offset + 1] = 255;
        output[offset + 2] = 255;
        output[offset + 3] = (source[maskRowOffset + sourceXByTargetX[x]] ?? 0) > 8 ? 255 : 0;
      }
    }
    clipContext.putImageData(imageData, 0, 0);
    objectClipCanvasRef.current = clipCanvas;
    return clipCanvas;
  }

  function drawInitialMask(canvas: HTMLCanvasElement, mask: MaskBitmap) {
    const context = canvas.getContext('2d');
    if (!context || mask.width <= 0 || mask.height <= 0) return;
    const logicalCanvas = getLogicalMaskCanvas(canvas.width, canvas.height);
    const logicalContext = logicalCanvas.getContext('2d');
    context.save();
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (logicalContext) logicalContext.clearRect(0, 0, logicalCanvas.width, logicalCanvas.height);
    context.fillStyle = getMaskBrushPattern(context);
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (logicalContext) {
      logicalContext.fillStyle = '#ffffff';
      logicalContext.fillRect(0, 0, logicalCanvas.width, logicalCanvas.height);
    }
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = canvas.width;
    maskCanvas.height = canvas.height;
    const maskContext = maskCanvas.getContext('2d');
    if (!maskContext) {
      context.restore();
      return;
    }
    const imageData = maskContext.createImageData(canvas.width, canvas.height);
    const sourceXByTargetX = createScaledIndexMap(mask.width, canvas.width);
    const sourceYByTargetY = createScaledIndexMap(mask.height, canvas.height);
    for (let y = 0; y < canvas.height; y += 1) {
      const maskRowOffset = sourceYByTargetY[y] * mask.width;
      const targetRowOffset = y * canvas.width * 4;
      for (let x = 0; x < canvas.width; x += 1) {
        const source = mask.data[maskRowOffset + sourceXByTargetX[x]] ?? 0;
        const offset = targetRowOffset + x * 4;
        imageData.data[offset] = 255;
        imageData.data[offset + 1] = 255;
        imageData.data[offset + 2] = 255;
        imageData.data[offset + 3] = source > 8 ? 255 : 0;
      }
    }
    maskContext.putImageData(imageData, 0, 0);
    context.globalCompositeOperation = 'destination-in';
    context.drawImage(maskCanvas, 0, 0);
    context.restore();
    if (logicalContext) {
      logicalContext.globalCompositeOperation = 'destination-in';
      logicalContext.drawImage(maskCanvas, 0, 0);
      logicalContext.globalCompositeOperation = 'source-over';
    }
    clipMaskToObject();
  }

  function getCanvasPoint(event: Pick<PointerEvent<HTMLCanvasElement>, 'clientX' | 'clientY'>) {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  function isPointOnObject(point: CanvasPoint) {
    if (objectMask.width <= 0 || objectMask.height <= 0) return true;
    const maskX = Math.floor((point.x / Math.max(1, canvasRef.current?.width ?? objectMask.width)) * objectMask.width);
    const maskY = Math.floor((point.y / Math.max(1, canvasRef.current?.height ?? objectMask.height)) * objectMask.height);
    if (maskX < 0 || maskY < 0 || maskX >= objectMask.width || maskY >= objectMask.height) return false;
    return (objectMask.data[maskY * objectMask.width + maskX] ?? 0) > 8;
  }

  function clipMaskToObject(bounds?: CanvasRect) {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context || objectMask.width <= 0 || objectMask.height <= 0) return;
    const clipCanvas = getObjectClipCanvas(canvas.width, canvas.height);
    if (!clipCanvas) return;
    const clipBounds = bounds
      ? {
          x: Math.max(0, Math.floor(bounds.x)),
          y: Math.max(0, Math.floor(bounds.y)),
          w: Math.min(canvas.width, Math.ceil(bounds.x + bounds.w)) - Math.max(0, Math.floor(bounds.x)),
          h: Math.min(canvas.height, Math.ceil(bounds.y + bounds.h)) - Math.max(0, Math.floor(bounds.y)),
        }
      : undefined;
    if (clipBounds && (clipBounds.w <= 0 || clipBounds.h <= 0)) return;
    context.save();
    context.globalCompositeOperation = 'destination-in';
    if (clipBounds) {
      context.beginPath();
      context.rect(clipBounds.x, clipBounds.y, clipBounds.w, clipBounds.h);
      context.clip();
    }
    context.drawImage(clipCanvas, 0, 0);
    context.restore();
  }

  function getStrokeBounds(point: CanvasPoint, previousPoint: CanvasPoint | undefined, size: number): CanvasRect {
    const radius = size / 2 + STROKE_CLIP_PADDING;
    const minX = previousPoint ? Math.min(previousPoint.x, point.x) : point.x;
    const minY = previousPoint ? Math.min(previousPoint.y, point.y) : point.y;
    const maxX = previousPoint ? Math.max(previousPoint.x, point.x) : point.x;
    const maxY = previousPoint ? Math.max(previousPoint.y, point.y) : point.y;
    return {
      x: minX - radius,
      y: minY - radius,
      w: maxX - minX + radius * 2,
      h: maxY - minY + radius * 2,
    };
  }

  function paintAt(event: Pick<PointerEvent<HTMLCanvasElement>, 'clientX' | 'clientY'>) {
    const canvas = canvasRef.current;
    const point = getCanvasPoint(event);
    if (!canvas || !point) return;
    if (tool === 'brush' && !isPointOnObject(point)) {
      lastPointRef.current = undefined;
      return;
    }
    const context = canvas.getContext('2d');
    if (!context) return;
    const logicalCanvas = getLogicalMaskCanvas(canvas.width, canvas.height);
    const logicalContext = logicalCanvas.getContext('2d');
    const previousPoint = lastPointRef.current;
    const strokeBounds = getStrokeBounds(point, previousPoint, brushSize);
    const maskBrush = getMaskBrushPattern(context);
    const drawStroke = (targetContext: CanvasRenderingContext2D, fillStyle: string | CanvasPattern) => {
      targetContext.save();
      targetContext.globalCompositeOperation = tool === 'erase' ? 'destination-out' : 'source-over';
      targetContext.strokeStyle = fillStyle;
      targetContext.fillStyle = fillStyle;
      targetContext.lineWidth = brushSize;
      targetContext.lineCap = 'round';
      targetContext.lineJoin = 'round';
      if (previousPoint) {
        targetContext.beginPath();
        targetContext.moveTo(previousPoint.x, previousPoint.y);
        targetContext.lineTo(point.x, point.y);
        targetContext.stroke();
      } else {
        targetContext.beginPath();
        targetContext.arc(point.x, point.y, brushSize / 2, 0, Math.PI * 2);
        targetContext.fill();
      }
      targetContext.restore();
    };
    drawStroke(context, maskBrush);
    if (logicalContext) drawStroke(logicalContext, '#ffffff');
    lastPointRef.current = point;
    if (tool === 'brush') clipMaskToObject(strokeBounds);
  }

  function clearMask() {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    getLogicalMaskCanvas(canvas.width, canvas.height).getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  }

  function readUserMask(): MaskBitmap {
    syncCanvasSize();
    const canvas = canvasRef.current;
    const context = canvas
      ? getLogicalMaskCanvas(canvas.width, canvas.height).getContext('2d')
      : undefined;
    if (!canvas || !context) throw new Error(t('localRepaintMaskMissing'));
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const data = new Uint8ClampedArray(canvas.width * canvas.height);
    const sourceXByTargetX = createScaledIndexMap(objectMask.width, canvas.width);
    const sourceYByTargetY = createScaledIndexMap(objectMask.height, canvas.height);
    for (let y = 0; y < canvas.height; y += 1) {
      const maskRowOffset = sourceYByTargetY[y] * objectMask.width;
      const dataRowOffset = y * canvas.width;
      const imageRowOffset = dataRowOffset * 4;
      for (let x = 0; x < canvas.width; x += 1) {
        const index = dataRowOffset + x;
        const objectAlpha = objectMask.data[maskRowOffset + sourceXByTargetX[x]] ?? 0;
        data[index] = imageData.data[imageRowOffset + x * 4 + 3] > 8 && objectAlpha > 8 ? 255 : 0;
      }
    }
    return { width: canvas.width, height: canvas.height, data };
  }

  async function handleGenerate() {
    setLocalError(undefined);
    try {
      await onGenerate({
        prompt,
        userMask: readUserMask(),
        includeBlankArea,
        limitToBlankAndSelection,
        preserveUnmaskedArea,
        selectedReferenceIds,
      });
      setShowAfter(true);
    } catch (caught) {
      setLocalError(caught instanceof Error ? caught.message : t('localRepaintFailed'));
    }
  }

  async function handleContentAwareFill() {
    if (!onContentAwareFill) return;
    setLocalError(undefined);
    try {
      await onContentAwareFill({
        prompt,
        userMask: readUserMask(),
        includeBlankArea,
        limitToBlankAndSelection,
        preserveUnmaskedArea,
        selectedReferenceIds,
      });
      setShowAfter(true);
    } catch (caught) {
      setLocalError(caught instanceof Error ? caught.message : t('localRepaintFailed'));
    }
  }

  function toggleReference(referenceId: string) {
    setSelectedReferenceIds((ids) =>
      ids.includes(referenceId) ? ids.filter((id) => id !== referenceId) : [...ids, referenceId],
    );
  }

  function paintPointerEventBatch(event: PointerEvent<HTMLCanvasElement>) {
    const nativeEvents = event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent];
    nativeEvents.forEach((nativeEvent) => paintAt(nativeEvent));
  }

  const modeLabel = mode === 'edit_layer_image' ? t('localRepaintModeLayer') : t('localRepaintModeView');
  const displayUrl = previewUrl && showAfter ? previewUrl : workingImageUrl;
  const viewportRepairZoom = mode === 'repair_current_view' ? 1.65 : 1;
  const displayError = error ?? localError;

  return createPortal(
    <div className="fixed inset-0 z-[120] grid place-items-center bg-black/62 p-4 backdrop-blur-sm">
      <section className="grid max-h-[94vh] w-full max-w-[min(92vw,1480px)] grid-cols-[minmax(0,1fr)_320px] overflow-hidden rounded-lg border border-white/16 bg-[#11121c] text-white shadow-[0_30px_90px_rgba(0,0,0,0.58)]">
        <div ref={frameRef} className="relative min-h-[min(760px,88vh)] overflow-hidden bg-[#070811]">
          <img
            ref={imageRef}
            src={displayUrl}
            alt=""
            className="h-full max-h-[94vh] w-full origin-center object-contain"
            style={{ transform: `scale(${viewportRepairZoom})` }}
            draggable={false}
            onLoad={() => {
              syncCanvasSize();
              window.requestAnimationFrame(updatePaintSurfaceLayout);
            }}
          />
          {!previewUrl && (
            <canvas
              ref={canvasRef}
              className={cn('absolute origin-center cursor-crosshair', isSubmitting && 'pointer-events-none opacity-70')}
              style={{ ...paintSurfaceStyle, transform: `scale(${viewportRepairZoom})` }}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                drawingRef.current = true;
                lastPointRef.current = undefined;
                paintPointerEventBatch(event);
              }}
              onPointerMove={(event) => {
                if (drawingRef.current) paintPointerEventBatch(event);
              }}
              onPointerUp={(event) => {
                drawingRef.current = false;
                lastPointRef.current = undefined;
                event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onPointerCancel={() => {
                drawingRef.current = false;
                lastPointRef.current = undefined;
              }}
            />
          )}
          {isSubmitting && (
            <div className="absolute left-1/2 top-4 -translate-x-1/2 rounded-full border border-white/16 bg-black/72 px-4 py-2 text-sm font-semibold text-white shadow-xl">
              {t('generating')}
            </div>
          )}
          {previewUrl && (
            <div className="absolute bottom-3 left-3 flex rounded-md border border-white/16 bg-black/70 p-1 text-xs font-semibold">
              <button
                type="button"
                className={cn('h-8 rounded px-3', !showAfter && 'bg-white text-black')}
                onClick={() => setShowAfter(false)}
              >
                {t('before')}
              </button>
              <button
                type="button"
                className={cn('h-8 rounded px-3', showAfter && 'bg-white text-black')}
                onClick={() => setShowAfter(true)}
              >
                {t('after')}
              </button>
            </div>
          )}
        </div>
        <aside className="flex min-h-[520px] flex-col border-l border-white/12 bg-[#151622]">
          <header className="flex items-start justify-between border-b border-white/12 p-4">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-[#ff8bdc]">{modeLabel}</div>
              <h2 className="mt-1 truncate text-lg font-semibold">{targetName}</h2>
            </div>
            <button type="button" className="grid h-8 w-8 place-items-center rounded hover:bg-white/10" onClick={onCancel}>
              <X className="h-4 w-4" />
            </button>
          </header>
          <div className="flex-1 space-y-4 overflow-y-auto p-4">
            {!previewUrl && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    className={cn('flex h-10 items-center justify-center gap-2 rounded-md border border-white/16', tool === 'brush' && 'border-[#ff62d2] bg-[#7d2d72]')}
                    onClick={() => setTool('brush')}
                  >
                    <Paintbrush className="h-4 w-4" />
                    {t('brush')}
                  </button>
                  <button
                    type="button"
                    className={cn('flex h-10 items-center justify-center gap-2 rounded-md border border-white/16', tool === 'erase' && 'border-[#ff62d2] bg-[#7d2d72]')}
                    onClick={() => setTool('erase')}
                  >
                    <Eraser className="h-4 w-4" />
                    {t('erase')}
                  </button>
                </div>
                <label className="grid gap-2 text-sm font-semibold">
                  <span className="flex items-center justify-between">
                    {t('brushSize')}
                    <span>{brushSize}px</span>
                  </span>
                  <input
                    type="range"
                    min="4"
                    max={MAX_LOCAL_REPAINT_BRUSH_SIZE}
                    value={brushSize}
                    onChange={(event) => setBrushSize(Number(event.target.value))}
                    className="accent-[#ff62d2]"
                  />
                </label>
                <button
                  type="button"
                  className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-white/16 text-sm font-semibold hover:bg-white/8"
                  onClick={clearMask}
                >
                  <RotateCcw className="h-4 w-4" />
                  {t('clearMask')}
                </button>
              </>
            )}
            <label className="flex items-center justify-between gap-3 text-sm font-semibold">
              <span>{t('includeBlankArea')}</span>
              <input
                type="checkbox"
                checked={includeBlankArea}
                onChange={(event) => setIncludeBlankArea(event.target.checked)}
                className="h-4 w-4 accent-[#ff62d2]"
              />
            </label>
            <label className="flex items-center justify-between gap-3 text-sm font-semibold">
              <span>{t('limitToBlankAndSelection')}</span>
              <input
                type="checkbox"
                checked={limitToBlankAndSelection}
                onChange={(event) => setLimitToBlankAndSelection(event.target.checked)}
                className="h-4 w-4 accent-[#ff62d2]"
              />
            </label>
            <label className="flex items-center justify-between gap-3 text-sm font-semibold">
              <span>{t('preserveUnmaskedArea')}</span>
              <input
                type="checkbox"
                checked={preserveUnmaskedArea}
                onChange={(event) => setPreserveUnmaskedArea(event.target.checked)}
                className="h-4 w-4 accent-[#ff62d2]"
              />
            </label>
            <label className="grid gap-2 text-sm font-semibold">
              <span>{t('prompt')}</span>
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                className="min-h-24 resize-none rounded-md border border-white/18 bg-black/32 p-2 text-sm outline-none focus:border-[#ff62d2]"
              />
            </label>
            {references.length > 0 && (
              <div>
                <div className="mb-2 text-sm font-semibold">{t('references')}</div>
                <div className="grid grid-cols-4 gap-2">
                  {references.map((reference) => (
                    <button
                      key={reference.id}
                      type="button"
                      className={cn(
                        'aspect-square overflow-hidden rounded border border-white/14 bg-black/28',
                        selectedReferenceIds.includes(reference.id) && 'border-[#ff62d2] ring-1 ring-[#ff62d2]',
                      )}
                      onClick={() => toggleReference(reference.id)}
                      title={reference.name}
                    >
                      <img src={reference.url} alt="" className="h-full w-full object-cover" />
                    </button>
                  ))}
                </div>
              </div>
            )}
            {displayError && <div className="rounded-md border border-red-400/30 bg-red-500/10 p-2 text-sm text-red-100">{displayError}</div>}
          </div>
          <footer className="grid gap-2 border-t border-white/12 p-4">
            {!previewUrl ? (
              <div className={cn('grid gap-2', isSubmitting && onAbort && 'grid-cols-[minmax(0,1fr)_48px]')}>
                <button
                  type="button"
                  disabled={isSubmitting}
                  className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-gradient-to-r from-liclick-pink to-liclick-purple text-sm font-semibold disabled:opacity-50"
                  onClick={handleGenerate}
                >
                  <WandSparkles className="h-4 w-4" />
                  {isSubmitting ? t('generating') : t('generate')}
                </button>
                {!isSubmitting && onContentAwareFill && (
                  <button
                    type="button"
                    className="flex h-10 w-full items-center justify-center gap-2 rounded-md border border-white/16 bg-white text-sm font-semibold text-black hover:bg-white/90"
                    onClick={handleContentAwareFill}
                  >
                    <WandSparkles className="h-4 w-4" />
                    {t('contentAwareFill')}
                  </button>
                )}
                {isSubmitting && onAbort && (
                  <button
                    type="button"
                    className="grid h-10 place-items-center rounded-md border border-red-300/32 bg-red-500/16 text-red-100 hover:bg-red-500/24"
                    onClick={onAbort}
                    title="终止局部重绘"
                    aria-label="终止局部重绘"
                  >
                    <Square className="h-4 w-4 fill-current" />
                  </button>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  className="h-10 rounded-md border border-white/16 text-sm font-semibold hover:bg-white/8"
                  onClick={() => void onAccept({ continueEditing: true })}
                >
                  {t('acceptAndContinue')}
                </button>
                <button
                  type="button"
                  className="h-10 rounded-md bg-white text-sm font-semibold text-black hover:bg-white/90"
                  onClick={() => void onAccept({ continueEditing: false })}
                >
                  {t('accept')}
                </button>
              </div>
            )}
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
