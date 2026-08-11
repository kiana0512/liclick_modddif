import {
  Check,
  ChevronRight,
  ChevronUp,
  Eraser,
  ImagePlus,
  LoaderCircle,
  MousePointer2,
  Move3D,
  Paintbrush,
  Redo2,
  Rotate3D,
  Scaling,
  Undo2,
  WandSparkles,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/components/common/cn';
import { IconTooltip } from '@/components/common/IconTooltip';
import {
  MAX_PAINT_MASK_BRUSH_SIZE,
  MIN_PAINT_MASK_BRUSH_SIZE,
  useSceneStore,
  type PaintToolMode,
  type TransformMode,
} from '@/stores/sceneStore';
import { useToastStore } from '@/stores/toastStore';
import type { WorkspaceMode } from '@/components/workspace/workspacePanelTypes';

type BottomToolDockProps = {
  mode: WorkspaceMode;
  transformMode: TransformMode;
  paintTool: PaintToolMode;
  onTransformModeChange: (mode: TransformMode) => void;
  onPaintToolChange: (mode: PaintToolMode) => void;
  onLocalImageGeneration: () => void;
  onLocalRepaint: () => void;
  localImageGenerationRunning: boolean;
  canLocalRepaint: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  labels: {
    select: string;
    move: string;
    rotate: string;
    scale: string;
    layers: string;
    eraser: string;
    eraserSize: string;
    eraserHardness: string;
    localRepaint: string;
    inpaintSelect: string;
    inpaintUnselect: string;
    undo: string;
    redo: string;
    brushSize: string;
    brushOpacity: string;
    resetInpaintRegion: string;
    invertInpaintRegion: string;
    selectHelp: string;
    moveHelp: string;
    rotateHelp: string;
    scaleHelp: string;
    layersHelp: string;
    eraserHelp: string;
    localRepaintHelp: string;
    inpaintSelectHelp: string;
    inpaintUnselectHelp: string;
  };
};

const tools: Array<{
  mode: TransformMode;
  icon: typeof MousePointer2;
  labelKey: 'select' | 'move' | 'rotate' | 'scale';
  shortcut: string;
}> = [
  { mode: 'select', icon: MousePointer2, labelKey: 'select', shortcut: 'Q' },
  { mode: 'translate', icon: Move3D, labelKey: 'move', shortcut: 'W' },
  { mode: 'rotate', icon: Rotate3D, labelKey: 'rotate', shortcut: 'E' },
  { mode: 'scale', icon: Scaling, labelKey: 'scale', shortcut: 'R' },
];

export function BottomToolDock({
  mode,
  transformMode,
  paintTool,
  onTransformModeChange,
  onPaintToolChange,
  onLocalImageGeneration,
  onLocalRepaint,
  localImageGenerationRunning,
  canLocalRepaint,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  labels,
}: BottomToolDockProps) {
  const dockRef = useRef<HTMLDivElement>(null);
  const [activeMenu, setActiveMenu] = useState<
    'eraser' | 'inpaint-add' | 'inpaint-subtract' | 'inpaint-apply' | undefined
  >();
  const paintSettings = useSceneStore((state) => state.paintToolSettings);
  const setPaintSettings = useSceneStore((state) => state.setPaintToolSettings);
  const paintMaskSettings = useSceneStore((state) => state.paintMaskSettings);
  const setPaintMaskSettings = useSceneStore((state) => state.setPaintMaskSettings);
  const clearPaintMask = useSceneStore((state) => state.clearPaintMask);
  const invertPaintMask = useSceneStore((state) => state.invertPaintMask);
  const paintMaskHasContent = useSceneStore((state) => state.paintMaskHasContent);
  const paintMaskCapture = useSceneStore((state) => state.paintMaskCapture);
  const pushToast = useToastStore((state) => state.pushToast);
  const baseButton =
    'grid h-11 w-11 shrink-0 place-items-center rounded-md border border-white/10 bg-black/34 text-white/72 transition hover:border-white/22 hover:bg-white/12 hover:text-white focus:outline-none focus:ring-2 focus:ring-liclick-pink/45 disabled:cursor-not-allowed disabled:opacity-42';
  const activeMaskButton =
    'border-[#ff8a68]/70 bg-[#8b4a38] text-white shadow-[0_0_0_1px_rgba(255,138,104,0.26)]';
  const workflowButton =
    'grid h-10 w-10 shrink-0 place-items-center rounded-md border border-transparent bg-transparent text-white/72 transition hover:bg-white/[0.08] hover:text-white focus:outline-none focus:ring-2 focus:ring-liclick-pink/35';
  const activeWorkflowButton =
    'bg-liclick-pink/16 text-white shadow-[inset_0_-2px_0_rgba(236,72,189,0.72)]';
  const lockedWorkflowButton =
    'cursor-not-allowed bg-transparent text-white/20 opacity-35 grayscale hover:bg-transparent hover:text-white/20';
  const runningWorkflowButton =
    'bg-liclick-pink/12 text-liclick-pink shadow-[inset_0_-2px_0_rgba(236,72,189,0.55)]';
  const divider = <div className="mx-1 h-6 w-px shrink-0 bg-white/10" />;
  const isTextureMode = mode === 'texture';
  const isMaskPaintTool = paintTool === 'inpaint-add' || paintTool === 'inpaint-subtract';
  // The live mask is authoritative. Pointer-up intentionally defers its
  // lossless PNG snapshot until step 2 so drawing never blocks on a full-canvas
  // encode; requiring that deferred URL here would permanently lock step 2.
  // The submit path captures and validates the exact mask before the request.
  const hasUsablePaintMask = paintMaskHasContent || Boolean(paintMaskCapture);
  const localRepaintReady = hasUsablePaintMask && canLocalRepaint;
  const inpaintMenuVisible =
    activeMenu === 'inpaint-add' ||
    activeMenu === 'inpaint-subtract' ||
    activeMenu === 'inpaint-apply';

  useEffect(() => {
    if (isTextureMode && paintTool === 'brush') onPaintToolChange('none');
  }, [isTextureMode, onPaintToolChange, paintTool]);

  function toggleMenu(menu: typeof activeMenu) {
    setActiveMenu((current) => (current === menu ? undefined : menu));
  }

  function notifyMaskRequired() {
    pushToast({
      tone: 'warning',
      title: '请先绘制蒙版',
      description: '先用蒙版画笔标记需要处理的区域，再执行局部生图。',
      dedupeKey: 'local-workflow-mask-required',
    });
  }

  function notifyGenerationRequired() {
    pushToast({
      tone: 'warning',
      title: '请先完成局部生图',
      description: '局部生图成功返回结果后，局部重绘画笔才会解锁。',
      dedupeKey: 'local-workflow-generation-required',
    });
  }

  function notifyGenerationInProgress() {
    pushToast({
      tone: 'info',
      title: '局部生图正在处理',
      description: '生成完成后会自动解锁“应用重绘”。',
      dedupeKey: 'local-workflow-generation-running',
    });
  }

  function renderWorkflowStepStatus({
    completed = false,
    running = false,
  }: {
    completed?: boolean;
    running?: boolean;
  }) {
    if (!completed && !running) return null;
    return (
      <span
        className={cn(
          'pointer-events-none absolute -bottom-0.5 -right-0.5 z-10 grid h-3.5 w-3.5 place-items-center rounded-full shadow-sm',
          running ? 'bg-[#3a1736] text-liclick-pink' : 'bg-emerald-400 text-[#06261e]',
        )}
        aria-hidden="true"
      >
        {running ? (
          <LoaderCircle className="h-2.5 w-2.5 animate-spin" />
        ) : (
          <Check className="h-2.5 w-2.5 stroke-[3.2]" />
        )}
      </span>
    );
  }

  useEffect(() => {
    if (!activeMenu) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActiveMenu(undefined);
    };
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!dockRef.current?.contains(event.target as Node)) {
        setActiveMenu(undefined);
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    window.addEventListener('pointerdown', closeOnOutsidePointer, true);
    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('pointerdown', closeOnOutsidePointer, true);
    };
  }, [activeMenu]);

  useEffect(() => {
    setActiveMenu(undefined);
  }, [mode]);

  function renderTransformButton({
    mode: toolMode,
    icon: Icon,
    labelKey,
    shortcut,
  }: (typeof tools)[number]) {
    return (
      <IconTooltip
        key={toolMode}
        label={labels[labelKey]}
        description={labels[`${labelKey}Help` as keyof typeof labels]}
        shortcut={shortcut}
      >
        <button
          type="button"
          className={cn(
            baseButton,
            transformMode === toolMode &&
              'border-liclick-pink/60 bg-gradient-to-r from-liclick-pink to-liclick-purple text-white shadow-glow',
          )}
          onClick={() => {
            onTransformModeChange(toolMode);
            setActiveMenu(undefined);
          }}
          aria-label={labels[labelKey]}
        >
          <Icon className="h-4.5 w-4.5" />
        </button>
      </IconTooltip>
    );
  }

  function renderUndoRedo() {
    return (
      <>
        <IconTooltip label={labels.undo} shortcut="Ctrl Z">
          <button
            type="button"
            className={baseButton}
            disabled={!canUndo}
            onClick={onUndo}
            aria-label={labels.undo}
          >
            <Undo2 className="h-4.5 w-4.5" />
          </button>
        </IconTooltip>
        <IconTooltip label={labels.redo} shortcut="Ctrl Y">
          <button
            type="button"
            className={baseButton}
            disabled={!canRedo}
            onClick={onRedo}
            aria-label={labels.redo}
          >
            <Redo2 className="h-4.5 w-4.5" />
          </button>
        </IconTooltip>
      </>
    );
  }

  return (
    <div
      ref={dockRef}
      data-texture-onboarding="edit-tools"
      className="relative mx-auto flex max-w-[calc(100vw-24px)] items-center gap-1 overflow-visible rounded-lg border border-white/10 bg-[#101225]/92 p-1 shadow-[0_12px_34px_rgba(0,0,0,0.36)] backdrop-blur"
    >
      {!isTextureMode && (
        <>
          {tools.map((tool) => renderTransformButton(tool))}
          {divider}
          {renderUndoRedo()}
        </>
      )}

      {isTextureMode && (
        <>
          <span className="inline-flex">
            {activeMenu === 'eraser' && (
              <div className="absolute bottom-full left-0 z-50 mb-2 w-[284px] max-w-[calc(100vw-24px)] rounded-lg border border-white/16 bg-[#050509] p-2.5 text-white shadow-[0_18px_42px_rgba(0,0,0,0.54)]">
                <label className="grid gap-1.5 text-[13px] font-semibold">
                  <span className="flex items-center justify-between">
                    <span>{labels.eraserSize}</span>
                    <input
                      value={paintSettings.eraserSize.toFixed(1)}
                      onChange={(event) =>
                        setPaintSettings({ eraserSize: Number(event.target.value) || 1 })
                      }
                      className="h-8 w-24 rounded-md border border-white/28 bg-[#111116] px-2 text-right text-sm text-white outline-none focus:border-[#ff8a68]"
                    />
                  </span>
                  <input
                    type="range"
                    min="0.5"
                    max="120"
                    step="0.5"
                    value={paintSettings.eraserSize}
                    onChange={(event) =>
                      setPaintSettings({ eraserSize: Number(event.target.value) })
                    }
                    className="w-full accent-[#ff8a68]"
                  />
                </label>
                <label className="mt-2 grid gap-1.5 text-[13px] font-semibold">
                  <span className="flex items-center justify-between">
                    <span>{labels.eraserHardness}</span>
                    <input
                      value={paintSettings.eraserHardness.toFixed(1)}
                      onChange={(event) =>
                        setPaintSettings({ eraserHardness: Number(event.target.value) || 0 })
                      }
                      className="h-8 w-24 rounded-md border border-white/28 bg-[#111116] px-2 text-right text-sm text-white outline-none focus:border-[#ff8a68]"
                    />
                  </span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="0.5"
                    value={paintSettings.eraserHardness}
                    onChange={(event) =>
                      setPaintSettings({ eraserHardness: Number(event.target.value) })
                    }
                    className="w-full accent-[#ff8a68]"
                  />
                </label>
              </div>
            )}
            <IconTooltip label={labels.eraser} description={labels.eraserHelp} shortcut="E">
              <button
                type="button"
                className={cn(baseButton, paintTool === 'eraser' && activeMaskButton)}
                onClick={() => {
                  onPaintToolChange(paintTool === 'eraser' ? 'none' : 'eraser');
                  toggleMenu('eraser');
                }}
                aria-label={labels.eraser}
              >
                <Eraser className="h-4.5 w-4.5" />
              </button>
            </IconTooltip>
          </span>
          <div className="ml-1 flex items-center gap-1.5">
            <span className="pointer-events-none flex shrink-0 items-center gap-1.5 whitespace-nowrap px-0.5 text-[12px] font-semibold tracking-wide text-white/62">
              <span
                className="h-6 w-px shrink-0 bg-liclick-pink/55 shadow-[0_0_8px_rgba(236,72,189,0.28)]"
                aria-hidden="true"
              />
              局部重绘
            </span>
            <div className="flex items-center rounded-md bg-white/[0.035] p-1">
              <span className="relative inline-flex">
                {inpaintMenuVisible && (
                  <div className="absolute bottom-full left-0 z-50 mb-2 w-[284px] max-w-[calc(100vw-24px)] rounded-lg border border-white/16 bg-[#050509] p-2.5 text-white shadow-[0_18px_42px_rgba(0,0,0,0.54)]">
                    <div className="mb-2 rounded-md bg-white/[0.07] px-2.5 py-2 text-xs font-semibold text-white/78">
                      左键绘制蒙版，右键擦除蒙版
                    </div>
                    <label className="grid gap-1.5 text-[13px] font-semibold">
                      <span className="flex items-center justify-between">
                        <span>{labels.brushSize}</span>
                        <input
                          value={paintMaskSettings.brushSize.toFixed(1)}
                          onChange={(event) =>
                            setPaintMaskSettings({ brushSize: Number(event.target.value) || 1 })
                          }
                          className="h-8 w-24 rounded-md border border-white/28 bg-[#111116] px-2 text-right text-sm text-white outline-none focus:border-[#ff8a68]"
                        />
                      </span>
                      <input
                        type="range"
                        min={MIN_PAINT_MASK_BRUSH_SIZE}
                        max={MAX_PAINT_MASK_BRUSH_SIZE}
                        step="0.1"
                        value={paintMaskSettings.brushSize}
                        onChange={(event) =>
                          setPaintMaskSettings({ brushSize: Number(event.target.value) })
                        }
                        className="w-full accent-[#ff8a68]"
                      />
                    </label>
                    {activeMenu === 'inpaint-apply' && (
                      <div className="mt-2 grid gap-2 border-t border-white/16 pt-2">
                        <label className="grid gap-1.5 text-[13px] font-semibold">
                          <span className="flex items-center justify-between">
                            <span>{labels.brushOpacity}</span>
                            <span className="flex items-center gap-1">
                              <input
                                type="number"
                                min="0"
                                max="100"
                                step="1"
                                value={Math.round(paintMaskSettings.brushOpacity)}
                                onChange={(event) =>
                                  setPaintMaskSettings({ brushOpacity: Number(event.target.value) })
                                }
                                className="h-8 w-20 rounded-md border border-white/28 bg-[#111116] px-2 text-right text-sm text-white outline-none focus:border-[#ff8a68]"
                              />
                              <span className="text-xs text-white/60">%</span>
                            </span>
                          </span>
                          <input
                            type="range"
                            min="0"
                            max="100"
                            step="1"
                            value={paintMaskSettings.brushOpacity}
                            onChange={(event) =>
                              setPaintMaskSettings({ brushOpacity: Number(event.target.value) })
                            }
                            className="w-full accent-[#ff8a68]"
                          />
                        </label>
                      </div>
                    )}
                    <div className="mt-2 grid gap-1.5 border-t border-white/16 pt-2">
                      <button
                        type="button"
                        className="flex h-9 items-center justify-between rounded-md border border-white/16 bg-[#0b0b11] px-2.5 text-left text-[13px] font-semibold text-white transition hover:border-[#ff8a68]/70 hover:text-[#ffb199]"
                        onClick={clearPaintMask}
                      >
                        <span>{labels.resetInpaintRegion}</span>
                        <span className="rounded bg-white/16 px-1.5 py-0.5 text-[10px] text-white/76">
                          CTRL SHIFT D
                        </span>
                      </button>
                      <button
                        type="button"
                        className="flex h-9 items-center justify-between rounded-md border border-white/16 bg-[#0b0b11] px-2.5 text-left text-[13px] font-semibold text-white transition hover:border-[#ff8a68]/70 hover:text-[#ffb199]"
                        onClick={invertPaintMask}
                      >
                        <span>{labels.invertInpaintRegion}</span>
                        <span className="rounded bg-white/16 px-1.5 py-0.5 text-[10px] text-white/76">
                          CTRL I
                        </span>
                      </button>
                    </div>
                  </div>
                )}
                <IconTooltip
                  label="步骤 1 · 绘制蒙版"
                  description="左键绘制蒙版，右键擦除蒙版"
                  shortcut="K"
                >
                  <button
                    type="button"
                    className={cn(workflowButton, isMaskPaintTool && activeWorkflowButton)}
                    onClick={() => {
                      onPaintToolChange(isMaskPaintTool ? 'none' : 'inpaint-add');
                      toggleMenu('inpaint-add');
                    }}
                    aria-label="蒙版绘制：左键绘制，右键擦除"
                  >
                    <span className="relative grid place-items-center">
                      <Paintbrush className="h-4.5 w-4.5" />
                      {isMaskPaintTool && (
                        <ChevronUp className="absolute -right-3 -top-3 h-3.5 w-3.5" />
                      )}
                    </span>
                  </button>
                </IconTooltip>
                {renderWorkflowStepStatus({ completed: hasUsablePaintMask })}
              </span>
              <ChevronRight
                className={cn(
                  'mx-0.5 h-3.5 w-3.5 shrink-0 transition-colors',
                  hasUsablePaintMask ? 'text-liclick-pink/80' : 'text-white/16',
                )}
                aria-hidden="true"
              />
              <span className="relative inline-flex">
                <IconTooltip
                  label="步骤 2 · 局部生图"
                  description="根据当前蒙版生成局部图片；结果会自动加入单视图参考图。"
                >
                  <button
                    type="button"
                    className={cn(
                      workflowButton,
                      localImageGenerationRunning && runningWorkflowButton,
                      !hasUsablePaintMask && lockedWorkflowButton,
                    )}
                    onClick={() => {
                      if (!hasUsablePaintMask) {
                        notifyMaskRequired();
                        return;
                      }
                      if (localImageGenerationRunning) {
                        notifyGenerationInProgress();
                        return;
                      }
                      onLocalImageGeneration();
                      setActiveMenu(undefined);
                    }}
                    aria-label={
                      localImageGenerationRunning
                        ? '局部生图（处理中）'
                        : hasUsablePaintMask
                          ? '局部生图'
                          : '局部生图（需先绘制蒙版）'
                    }
                  >
                    <ImagePlus className="h-4.5 w-4.5" />
                  </button>
                </IconTooltip>
                {renderWorkflowStepStatus({
                  completed: localRepaintReady,
                  running: localImageGenerationRunning,
                })}
              </span>
              <ChevronRight
                className={cn(
                  'mx-0.5 h-3.5 w-3.5 shrink-0 transition-colors',
                  localImageGenerationRunning
                    ? 'animate-pulse text-liclick-pink/65'
                    : localRepaintReady
                      ? 'text-liclick-pink/80'
                      : 'text-white/16',
                )}
                aria-hidden="true"
              />
              <span className="relative inline-flex">
                <IconTooltip
                  label="步骤 3 · 应用重绘"
                  description="使用局部生图结果在当前模型表面进行重绘。"
                  shortcut="I"
                >
                  <button
                    type="button"
                    className={cn(
                      workflowButton,
                      paintTool === 'inpaint-apply' && activeWorkflowButton,
                      (!hasUsablePaintMask || !localRepaintReady || localImageGenerationRunning) &&
                        lockedWorkflowButton,
                    )}
                    onClick={() => {
                      if (!hasUsablePaintMask) {
                        notifyMaskRequired();
                        return;
                      }
                      if (localImageGenerationRunning) {
                        notifyGenerationInProgress();
                        return;
                      }
                      if (!localRepaintReady) {
                        notifyGenerationRequired();
                        return;
                      }
                      if (paintTool === 'inpaint-apply') onPaintToolChange('inpaint-add');
                      else onLocalRepaint();
                      toggleMenu('inpaint-apply');
                    }}
                    aria-label={
                      localImageGenerationRunning
                        ? '应用局部重绘（等待局部生图完成）'
                        : localRepaintReady
                          ? '应用局部重绘'
                          : '应用局部重绘（需先完成局部生图）'
                    }
                  >
                    <span className="relative grid place-items-center">
                      <WandSparkles className="h-4.5 w-4.5" />
                      {paintTool === 'inpaint-apply' && (
                        <ChevronUp className="absolute -right-3 -top-3 h-3.5 w-3.5" />
                      )}
                    </span>
                  </button>
                </IconTooltip>
              </span>
            </div>
          </div>

          <div
            className="mx-1 h-6 w-px shrink-0 bg-liclick-pink/55 shadow-[0_0_8px_rgba(236,72,189,0.28)]"
            aria-hidden="true"
          />
          {renderUndoRedo()}
        </>
      )}
    </div>
  );
}
