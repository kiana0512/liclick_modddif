import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Eraser, Paintbrush, RotateCcw, WandSparkles, X } from 'lucide-react';
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
  onAccept: (options: { continueEditing: boolean }) => Promise<void> | void;
  onCancel: () => void;
};

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
  onAccept,
  onCancel,
}: LocalRepaintDialogProps) {
  const t = useT();
  const frameRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const logicalMaskCanvasRef = useRef<HTMLCanvasElement>();
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number }>();
  const initialMaskAppliedRef = useRef(false);
  const [tool, setTool] = useState<'brush' | 'erase'>('brush');
  const [brushSize, setBrushSize] = useState(32);
  const [prompt, setPrompt] = useState('');
  const [includeBlankArea, setIncludeBlankArea] = useState(true);
  const [limitToBlankAndSelection, setLimitToBlankAndSelection] = useState(true);
  const [preserveUnmaskedArea, setPreserveUnmaskedArea] = useState(true);
  const [selectedReferenceIds, setSelectedReferenceIds] = useState<string[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [showAfter, setShowAfter] = useState(true);
  const [status, setStatus] = useState<'idle' | 'submitting' | 'preview_ready' | 'error'>('idle');
  const [error, setError] = useState<string>();
  const [paintSurfaceStyle, setPaintSurfaceStyle] = useState<CSSProperties>({ inset: 0 });

  useEffect(() => {
    initialMaskAppliedRef.current = false;
  }, [initialUserMask]);

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

  function drawInitialMask(canvas: HTMLCanvasElement, mask: MaskBitmap) {
    const context = canvas.getContext('2d');
    if (!context || mask.width <= 0 || mask.height <= 0) return;
    const logicalCanvas = getLogicalMaskCanvas(canvas.width, canvas.height);
    const logicalContext = logicalCanvas.getContext('2d');
    context.save();
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (logicalContext) logicalContext.clearRect(0, 0, logicalCanvas.width, logicalCanvas.height);
    context.fillStyle = createMaskBrushPattern(context);
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
    for (let y = 0; y < canvas.height; y += 1) {
      const maskY = Math.min(mask.height - 1, Math.floor((y / canvas.height) * mask.height));
      for (let x = 0; x < canvas.width; x += 1) {
        const maskX = Math.min(mask.width - 1, Math.floor((x / canvas.width) * mask.width));
        const source = mask.data[maskY * mask.width + maskX] ?? 0;
        const offset = (y * canvas.width + x) * 4;
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

  function getCanvasPoint(event: PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  function isPointOnObject(point: { x: number; y: number }) {
    if (objectMask.width <= 0 || objectMask.height <= 0) return true;
    const maskX = Math.floor((point.x / Math.max(1, canvasRef.current?.width ?? objectMask.width)) * objectMask.width);
    const maskY = Math.floor((point.y / Math.max(1, canvasRef.current?.height ?? objectMask.height)) * objectMask.height);
    if (maskX < 0 || maskY < 0 || maskX >= objectMask.width || maskY >= objectMask.height) return false;
    return (objectMask.data[maskY * objectMask.width + maskX] ?? 0) > 8;
  }

  function clipMaskToObject() {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context || objectMask.width <= 0 || objectMask.height <= 0) return;
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let y = 0; y < canvas.height; y += 1) {
      const maskY = Math.min(objectMask.height - 1, Math.floor((y / canvas.height) * objectMask.height));
      for (let x = 0; x < canvas.width; x += 1) {
        const maskX = Math.min(objectMask.width - 1, Math.floor((x / canvas.width) * objectMask.width));
        if ((objectMask.data[maskY * objectMask.width + maskX] ?? 0) > 8) continue;
        imageData.data[(y * canvas.width + x) * 4 + 3] = 0;
      }
    }
    context.putImageData(imageData, 0, 0);
  }

  function paintAt(event: PointerEvent<HTMLCanvasElement>) {
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
    const maskBrush = createMaskBrushPattern(context);
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
    if (tool === 'brush') clipMaskToObject();
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
    for (let index = 0; index < data.length; index += 1) {
      const x = index % canvas.width;
      const y = Math.floor(index / canvas.width);
      const maskX = Math.min(objectMask.width - 1, Math.floor((x / canvas.width) * objectMask.width));
      const maskY = Math.min(objectMask.height - 1, Math.floor((y / canvas.height) * objectMask.height));
      const objectAlpha = objectMask.data[maskY * objectMask.width + maskX] ?? 0;
      data[index] = imageData.data[index * 4 + 3] > 8 && objectAlpha > 8 ? 255 : 0;
    }
    return { width: canvas.width, height: canvas.height, data };
  }

  async function handleGenerate() {
    setStatus('submitting');
    setError(undefined);
    try {
      const result = await onGenerate({
        prompt,
        userMask: readUserMask(),
        includeBlankArea,
        limitToBlankAndSelection,
        preserveUnmaskedArea,
        selectedReferenceIds,
      });
      setPreviewUrl(result.previewUrl);
      setShowAfter(true);
      setStatus('preview_ready');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('localRepaintFailed'));
      setStatus('error');
    }
  }

  function toggleReference(referenceId: string) {
    setSelectedReferenceIds((ids) =>
      ids.includes(referenceId) ? ids.filter((id) => id !== referenceId) : [...ids, referenceId],
    );
  }

  const modeLabel = mode === 'edit_layer_image' ? t('localRepaintModeLayer') : t('localRepaintModeView');
  const displayUrl = previewUrl && showAfter ? previewUrl : workingImageUrl;
  const viewportRepairZoom = mode === 'repair_current_view' ? 1.65 : 1;

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
              className="absolute origin-center cursor-crosshair"
              style={{ ...paintSurfaceStyle, transform: `scale(${viewportRepairZoom})` }}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                drawingRef.current = true;
                lastPointRef.current = undefined;
                paintAt(event);
              }}
              onPointerMove={(event) => {
                if (drawingRef.current) paintAt(event);
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
                    max="180"
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
            {error && <div className="rounded-md border border-red-400/30 bg-red-500/10 p-2 text-sm text-red-100">{error}</div>}
          </div>
          <footer className="grid gap-2 border-t border-white/12 p-4">
            {!previewUrl ? (
              <button
                type="button"
                disabled={status === 'submitting'}
                className="flex h-10 items-center justify-center gap-2 rounded-md bg-gradient-to-r from-liclick-pink to-liclick-purple text-sm font-semibold disabled:opacity-50"
                onClick={handleGenerate}
              >
                <WandSparkles className="h-4 w-4" />
                {status === 'submitting' ? t('generating') : t('generate')}
              </button>
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
