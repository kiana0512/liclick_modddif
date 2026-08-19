import {
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
import { useLayerStore } from '@/stores/layerStore';
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
  localImageGenerationSuccessKey: number;
  canLocalRepaint: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  interactionLocked?: boolean;
  onInteractionLocked?: () => void;
  labels: {
    select: string;
    move: string;
    rotate: string;
    scale: string;
    layers: string;
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
  localImageGenerationSuccessKey,
  canLocalRepaint,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  interactionLocked = false,
  onInteractionLocked,
  labels,
}: BottomToolDockProps) {
  const dockRef = useRef<HTMLDivElement>(null);
  const [activeMenu, setActiveMenu] = useState<
    'eraser' | 'inpaint-add' | 'inpaint-subtract' | 'inpaint-apply' | undefined
  >();
  const [generationGuideActive, setGenerationGuideActive] = useState(false);
  const [repaintGuideActive, setRepaintGuideActive] = useState(false);
  const previousGenerationSuccessKeyRef = useRef(localImageGenerationSuccessKey);
  const previousApplyToolSelectedRef = useRef(paintTool === 'inpaint-apply');
  const previousMaskToolSelectedRef = useRef(
    paintTool === 'inpaint-add' || paintTool === 'inpaint-subtract',
  );
  const paintMaskSettings = useSceneStore((state) => state.paintMaskSettings);
  const setPaintMaskSettings = useSceneStore((state) => state.setPaintMaskSettings);
  const localRepaintBrushSettings = useSceneStore((state) => state.localRepaintBrushSettings);
  const setLocalRepaintBrushSettings = useSceneStore((state) => state.setLocalRepaintBrushSettings);
  const paintToolSettings = useSceneStore((state) => state.paintToolSettings);
  const setPaintToolSettings = useSceneStore((state) => state.setPaintToolSettings);
  const clearPaintMask = useSceneStore((state) => state.clearPaintMask);
  const invertPaintMask = useSceneStore((state) => state.invertPaintMask);
  const activeProjectedLayer = useLayerStore((state) =>
    state.layers.find((layer) => layer.id === state.activeProjectedLayerId),
  );
  const pushToast = useToastStore((state) => state.pushToast);
  const baseButton =
    'grid h-11 w-11 shrink-0 place-items-center rounded-md border border-white/10 bg-black/34 text-white/72 transition hover:border-white/22 hover:bg-white/12 hover:text-white focus:outline-none focus:ring-2 focus:ring-liclick-pink/45 disabled:cursor-not-allowed disabled:opacity-42';
  const workflowButton =
    'grid h-10 w-10 shrink-0 place-items-center rounded-md border border-transparent bg-transparent text-white/72 transition hover:bg-white/[0.08] hover:text-white focus:outline-none focus:ring-2 focus:ring-liclick-pink/35';
  const activeWorkflowButton =
    'bg-liclick-pink/16 text-white shadow-[inset_0_-2px_0_rgba(236,72,189,0.72)]';
  const lockedWorkflowButton =
    'cursor-not-allowed bg-transparent text-white/20 opacity-35 grayscale hover:bg-transparent hover:text-white/20';
  const runningWorkflowButton =
    'bg-liclick-pink/12 text-liclick-pink shadow-[inset_0_-2px_0_rgba(236,72,189,0.55)]';
  const guideWorkflowButton =
    'animate-pulse border-liclick-pink/70 bg-liclick-pink/20 text-white shadow-[0_0_14px_rgba(236,72,189,0.62),inset_0_-2px_0_rgba(236,72,189,0.8)]';
  const divider = <div className="mx-1 h-6 w-px shrink-0 bg-white/10" />;
  const isTextureMode = mode === 'texture';
  const isMaskPaintTool = paintTool === 'inpaint-add' || paintTool === 'inpaint-subtract';
  const localRepaintReady = canLocalRepaint;
  const canEraseSelectedLayer = Boolean(
    activeProjectedLayer?.visible &&
    activeProjectedLayer.imageUrl &&
    (activeProjectedLayer.role === 'local-repaint-overlay' ||
      (activeProjectedLayer.type === 'projected' && activeProjectedLayer.camera)),
  );
  const inpaintMenuVisible =
    activeMenu === 'inpaint-add' ||
    activeMenu === 'inpaint-subtract' ||
    activeMenu === 'inpaint-apply';

  useEffect(() => {
    if (isTextureMode && paintTool === 'brush') onPaintToolChange('none');
  }, [isTextureMode, onPaintToolChange, paintTool]);

  useEffect(() => {
    if (paintTool !== 'eraser' || canEraseSelectedLayer) return;
    onPaintToolChange('none');
    setActiveMenu(undefined);
  }, [canEraseSelectedLayer, onPaintToolChange, paintTool]);

  useEffect(() => {
    if (localImageGenerationRunning) {
      setRepaintGuideActive(false);
    } else if (
      previousGenerationSuccessKeyRef.current !== localImageGenerationSuccessKey &&
      localRepaintReady
    ) {
      setRepaintGuideActive(true);
    }
    previousGenerationSuccessKeyRef.current = localImageGenerationSuccessKey;
  }, [localImageGenerationRunning, localImageGenerationSuccessKey, localRepaintReady]);

  useEffect(() => {
    const applyToolSelected = paintTool === 'inpaint-apply';
    if (!previousApplyToolSelectedRef.current && applyToolSelected) {
      // The generation keeps its own archived mask. Once its apply brush is
      // actually ready, discard the transient selection drawn for generation.
      clearPaintMask();
      setRepaintGuideActive(false);
    }
    previousApplyToolSelectedRef.current = applyToolSelected;
  }, [clearPaintMask, paintTool]);

  useEffect(() => {
    if (!previousMaskToolSelectedRef.current && isMaskPaintTool) {
      setGenerationGuideActive(true);
      setRepaintGuideActive(false);
    }
    previousMaskToolSelectedRef.current = isMaskPaintTool;
  }, [isMaskPaintTool]);

  function toggleMenu(menu: typeof activeMenu) {
    setActiveMenu((current) => (current === menu ? undefined : menu));
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

  function notifyProjectedLayerRequired() {
    pushToast({
      tone: 'info',
      title: '请先选择投影或局部重绘图层',
      description: '请选择普通投影或局部重绘结果；合并 UV 和其他图层不能擦除。',
      dedupeKey: 'projected-layer-eraser-selection-required',
    });
  }

  function renderWorkflowRunningStatus(running: boolean) {
    if (!running) return null;
    return (
      <span
        className="pointer-events-none absolute -bottom-0.5 -right-0.5 z-10 grid h-3.5 w-3.5 place-items-center rounded-full bg-[#3a1736] text-liclick-pink shadow-sm"
        aria-hidden="true"
      >
        <LoaderCircle className="h-2.5 w-2.5 animate-spin" />
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
      onPointerDownCapture={(event) => {
        if (!interactionLocked) return;
        const target = event.target as HTMLElement;
        if (!target.closest('button, input, select, textarea')) return;
        event.preventDefault();
        event.stopPropagation();
        onInteractionLocked?.();
      }}
      onClickCapture={(event) => {
        if (!interactionLocked) return;
        const target = event.target as HTMLElement;
        if (!target.closest('button, input, select, textarea')) return;
        event.preventDefault();
        event.stopPropagation();
        onInteractionLocked?.();
      }}
      data-texture-onboarding="edit-tools"
      data-onboarding-complete={
        paintTool === 'eraser' ||
        paintTool === 'inpaint-add' ||
        paintTool === 'inpaint-subtract' ||
        paintTool === 'inpaint-apply'
          ? 'true'
          : 'false'
      }
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
          <span className="relative inline-flex">
            {activeMenu === 'eraser' && paintTool === 'eraser' && (
              <div className="absolute bottom-full left-0 z-50 mb-2 w-[248px] rounded-lg border border-white/16 bg-[#050509] p-2.5 text-white shadow-[0_18px_42px_rgba(0,0,0,0.54)]">
                <div className="mb-2 rounded-md bg-white/[0.07] px-2.5 py-2 text-xs font-semibold text-white/78">
                  橡皮擦参数
                </div>
                <label className="grid gap-1.5 text-[13px] font-semibold">
                  <span className="flex items-center justify-between">
                    <span>{labels.brushSize}</span>
                    <input
                      type="number"
                      min="1"
                      max="256"
                      step="1"
                      value={Math.round(paintToolSettings.eraserSize)}
                      onChange={(event) =>
                        setPaintToolSettings({ eraserSize: Number(event.target.value) })
                      }
                      className="h-8 w-24 rounded-md border border-white/28 bg-[#111116] px-2 text-right text-sm text-white outline-none focus:border-[#6f93ff]"
                    />
                  </span>
                  <input
                    type="range"
                    min="1"
                    max="256"
                    step="1"
                    value={paintToolSettings.eraserSize}
                    onChange={(event) =>
                      setPaintToolSettings({ eraserSize: Number(event.target.value) })
                    }
                    className="w-full accent-[#6f93ff]"
                  />
                </label>
              </div>
            )}
            <IconTooltip
              label="投影图层橡皮擦"
              description="可擦普通投影和局部重绘结果；合并 UV 与其他图层不会被修改。使用 [ / ] 调整画笔大小。"
            >
              <button
                type="button"
                className={cn(
                  baseButton,
                  paintTool === 'eraser' &&
                    'border-[#6f93ff] bg-[#4568db]/18 text-white shadow-[0_0_0_1px_rgba(111,147,255,0.55),0_0_16px_rgba(69,104,219,0.24)]',
                )}
                onClick={() => {
                  if (paintTool === 'eraser') {
                    onPaintToolChange('none');
                    setActiveMenu(undefined);
                    return;
                  }
                  if (!canEraseSelectedLayer) {
                    notifyProjectedLayerRequired();
                    return;
                  }
                  onPaintToolChange('eraser');
                  setActiveMenu('eraser');
                }}
                aria-pressed={paintTool === 'eraser'}
                aria-label="投影图层橡皮擦"
              >
                <span className="relative grid place-items-center">
                  <Eraser className="h-5 w-5" />
                  {paintTool === 'eraser' && (
                    <ChevronUp className="absolute -right-3 -top-3 h-3.5 w-3.5" />
                  )}
                </span>
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
                      {activeMenu === 'inpaint-apply'
                        ? '局部重绘画笔参数 · 左键绘制，右键擦除'
                        : '蒙版画笔参数 · 左键绘制，右键擦除'}
                    </div>
                    <label className="grid gap-1.5 text-[13px] font-semibold">
                      <span className="flex items-center justify-between">
                        <span>{labels.brushSize}</span>
                        <input
                          value={
                            activeMenu === 'inpaint-apply'
                              ? localRepaintBrushSettings.brushSize.toFixed(1)
                              : paintMaskSettings.brushSize.toFixed(1)
                          }
                          onChange={(event) => {
                            const brushSize = Number(event.target.value) || 1;
                            if (activeMenu === 'inpaint-apply') {
                              setLocalRepaintBrushSettings({ brushSize });
                            } else {
                              setPaintMaskSettings({ brushSize });
                            }
                          }}
                          className="h-8 w-24 rounded-md border border-white/28 bg-[#111116] px-2 text-right text-sm text-white outline-none focus:border-[#ff8a68]"
                        />
                      </span>
                      <input
                        type="range"
                        min={MIN_PAINT_MASK_BRUSH_SIZE}
                        max={MAX_PAINT_MASK_BRUSH_SIZE}
                        step="0.1"
                        value={
                          activeMenu === 'inpaint-apply'
                            ? localRepaintBrushSettings.brushSize
                            : paintMaskSettings.brushSize
                        }
                        onChange={(event) => {
                          const brushSize = Number(event.target.value);
                          if (activeMenu === 'inpaint-apply') {
                            setLocalRepaintBrushSettings({ brushSize });
                          } else {
                            setPaintMaskSettings({ brushSize });
                          }
                        }}
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
                                value={Math.round(localRepaintBrushSettings.brushOpacity)}
                                onChange={(event) =>
                                  setLocalRepaintBrushSettings({
                                    brushOpacity: Number(event.target.value),
                                  })
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
                            value={localRepaintBrushSettings.brushOpacity}
                            onChange={(event) =>
                              setLocalRepaintBrushSettings({
                                brushOpacity: Number(event.target.value),
                              })
                            }
                            className="w-full accent-[#ff8a68]"
                          />
                        </label>
                      </div>
                    )}
                    {activeMenu !== 'inpaint-apply' && (
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
                    )}
                  </div>
                )}
                <IconTooltip label="步骤 1 · 绘制蒙版" shortcut="K">
                  <button
                    type="button"
                    className={cn(workflowButton, isMaskPaintTool && activeWorkflowButton)}
                    onClick={() => {
                      const willSelectMaskTool = !isMaskPaintTool;
                      onPaintToolChange(willSelectMaskTool ? 'inpaint-add' : 'none');
                      if (willSelectMaskTool) {
                        setGenerationGuideActive(true);
                        setRepaintGuideActive(false);
                      }
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
              </span>
              <ChevronRight
                className="mx-0.5 h-3.5 w-3.5 shrink-0 text-white/16 transition-colors"
                aria-hidden="true"
              />
              <span className="relative inline-flex">
                <IconTooltip
                  label="步骤 2 · 局部生图"
                  description="蒙版可选；未绘制时按全图范围生成，运行期间不可重复提交。"
                >
                  <button
                    type="button"
                    className={cn(
                      workflowButton,
                      generationGuideActive && !localImageGenerationRunning && guideWorkflowButton,
                      localImageGenerationRunning && runningWorkflowButton,
                    )}
                    onClick={() => {
                      if (localImageGenerationRunning) {
                        notifyGenerationInProgress();
                        return;
                      }
                      setGenerationGuideActive(false);
                      setRepaintGuideActive(false);
                      onLocalImageGeneration();
                      setActiveMenu(undefined);
                    }}
                    aria-label={localImageGenerationRunning ? '局部生图（处理中）' : '局部生图'}
                  >
                    <ImagePlus className="h-4.5 w-4.5" />
                  </button>
                </IconTooltip>
                {renderWorkflowRunningStatus(localImageGenerationRunning)}
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
                  description="使用局部生图结果在当前模型表面重绘：左键涂上，右键擦除。"
                  shortcut="I"
                >
                  <button
                    type="button"
                    className={cn(
                      workflowButton,
                      paintTool === 'inpaint-apply' && activeWorkflowButton,
                      repaintGuideActive &&
                        localRepaintReady &&
                        !localImageGenerationRunning &&
                        paintTool !== 'inpaint-apply' &&
                        guideWorkflowButton,
                      (!localRepaintReady || localImageGenerationRunning) && lockedWorkflowButton,
                    )}
                    onClick={() => {
                      if (localImageGenerationRunning) {
                        notifyGenerationInProgress();
                        return;
                      }
                      if (!localRepaintReady) {
                        notifyGenerationRequired();
                        return;
                      }
                      setRepaintGuideActive(false);
                      if (paintTool === 'inpaint-apply') {
                        toggleMenu('inpaint-apply');
                        return;
                      } else {
                        onLocalRepaint();
                      }
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
