import {
  Brush,
  ChevronUp,
  Eraser,
  Minus,
  MousePointer2,
  Move3D,
  Plus,
  Redo2,
  Rotate3D,
  Scaling,
  Sparkles,
  Undo2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/components/common/cn';
import { IconTooltip } from '@/components/common/IconTooltip';
import { useSceneStore, type PaintToolMode, type TransformMode } from '@/stores/sceneStore';
import type { WorkspaceMode } from '@/components/workspace/workspacePanelTypes';

type BottomToolDockProps = {
  mode: WorkspaceMode;
  transformMode: TransformMode;
  paintTool: PaintToolMode;
  onTransformModeChange: (mode: TransformMode) => void;
  onPaintToolChange: (mode: PaintToolMode) => void;
  onLocalRepaint: () => void;
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
    brush: string;
    eraser: string;
    eraserSize: string;
    eraserHardness: string;
    localRepaint: string;
    inpaintSelect: string;
    inpaintUnselect: string;
    undo: string;
    redo: string;
    brushSize: string;
    brushHardness: string;
    brushColor: string;
    resetInpaintRegion: string;
    invertInpaintRegion: string;
    selectHelp: string;
    moveHelp: string;
    rotateHelp: string;
    scaleHelp: string;
    layersHelp: string;
    brushHelp: string;
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
  { mode: 'select', icon: MousePointer2, labelKey: 'select', shortcut: 'V' },
  { mode: 'translate', icon: Move3D, labelKey: 'move', shortcut: 'W' },
  { mode: 'rotate', icon: Rotate3D, labelKey: 'rotate', shortcut: 'R' },
  { mode: 'scale', icon: Scaling, labelKey: 'scale', shortcut: 'S' },
];
const selectTool = tools[0];

const paintSwatches = ['#ffffff', '#ff6b4a', '#f7c948', '#56d364', '#3dd6ff', '#8b5cf6', '#f35bce', '#111111'];

export function BottomToolDock({
  mode,
  transformMode,
  paintTool,
  onTransformModeChange,
  onPaintToolChange,
  onLocalRepaint,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  labels,
}: BottomToolDockProps) {
  const dockRef = useRef<HTMLDivElement>(null);
  const [activeMenu, setActiveMenu] = useState<
    'brush' | 'eraser' | 'inpaint-add' | 'inpaint-subtract' | 'inpaint-apply' | undefined
  >();
  const paintSettings = useSceneStore((state) => state.paintToolSettings);
  const setPaintSettings = useSceneStore((state) => state.setPaintToolSettings);
  const paintMaskSettings = useSceneStore((state) => state.paintMaskSettings);
  const setPaintMaskSettings = useSceneStore((state) => state.setPaintMaskSettings);
  const clearPaintMask = useSceneStore((state) => state.clearPaintMask);
  const invertPaintMask = useSceneStore((state) => state.invertPaintMask);
  const baseButton =
    'grid h-11 w-11 shrink-0 place-items-center rounded-md border border-white/10 bg-black/34 text-white/72 transition hover:border-white/22 hover:bg-white/12 hover:text-white focus:outline-none focus:ring-2 focus:ring-liclick-pink/45 disabled:cursor-not-allowed disabled:opacity-42';
  const activeMaskButton =
    'border-[#ff8a68]/70 bg-[#8b4a38] text-white shadow-[0_0_0_1px_rgba(255,138,104,0.26)]';
  const divider = <div className="mx-1 h-6 w-px shrink-0 bg-white/10" />;
  const isTextureMode = mode === 'texture';
  const inpaintMenuVisible =
    activeMenu === 'inpaint-add' || activeMenu === 'inpaint-subtract' || activeMenu === 'inpaint-apply';

  function toggleMenu(menu: typeof activeMenu) {
    setActiveMenu((current) => (current === menu ? undefined : menu));
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
          <button type="button" className={baseButton} disabled={!canUndo} onClick={onUndo} aria-label={labels.undo}>
            <Undo2 className="h-4.5 w-4.5" />
          </button>
        </IconTooltip>
        <IconTooltip label={labels.redo} shortcut="Ctrl Y">
          <button type="button" className={baseButton} disabled={!canRedo} onClick={onRedo} aria-label={labels.redo}>
            <Redo2 className="h-4.5 w-4.5" />
          </button>
        </IconTooltip>
      </>
    );
  }

  return (
    <div
      ref={dockRef}
      className="mx-auto flex max-w-[calc(100vw-24px)] items-center gap-1 overflow-visible rounded-lg border border-white/10 bg-[#101225]/92 p-1 shadow-[0_12px_34px_rgba(0,0,0,0.36)] backdrop-blur"
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
          {selectTool && renderTransformButton(selectTool)}
          {divider}

          <span className="relative inline-flex">
        {activeMenu === 'brush' && (
          <div className="absolute bottom-full left-1/2 z-50 mb-2 w-[300px] -translate-x-1/2 rounded-lg border border-white/16 bg-[#050509] p-2.5 text-white shadow-[0_18px_42px_rgba(0,0,0,0.54)]">
            <label className="grid gap-1.5 text-[13px] font-semibold">
              <span className="flex items-center justify-between">
                <span>{labels.brushSize}</span>
                <input
                  value={paintSettings.brushSize.toFixed(1)}
                  onChange={(event) =>
                    setPaintSettings({ brushSize: Number(event.target.value) || 1 })
                  }
                  className="h-8 w-24 rounded-md border border-white/28 bg-[#111116] px-2 text-right text-sm text-white outline-none focus:border-[#ff8a68]"
                />
              </span>
              <input
                type="range"
                min="0.5"
                max="80"
                step="0.1"
                value={paintSettings.brushSize}
                onChange={(event) =>
                  setPaintSettings({ brushSize: Number(event.target.value) })
                }
                className="w-full accent-[#ff8a68]"
              />
            </label>
            <label className="mt-2 grid gap-1.5 text-[13px] font-semibold">
              <span className="flex items-center justify-between">
                <span>{labels.brushHardness}</span>
                <input
                  value={paintSettings.brushHardness.toFixed(1)}
                  onChange={(event) =>
                    setPaintSettings({ brushHardness: Number(event.target.value) || 0 })
                  }
                  className="h-8 w-24 rounded-md border border-white/28 bg-[#111116] px-2 text-right text-sm text-white outline-none focus:border-[#ff8a68]"
                />
              </span>
              <input
                type="range"
                min="0"
                max="100"
                step="0.5"
                value={paintSettings.brushHardness}
                onChange={(event) =>
                  setPaintSettings({ brushHardness: Number(event.target.value) })
                }
                className="w-full accent-[#ff8a68]"
              />
            </label>
            <label className="mt-2 grid gap-1.5 text-[13px] font-semibold">
              <span>{labels.brushColor}</span>
              <div className="grid grid-cols-[1fr_88px] items-center gap-2">
                <div className="flex gap-1.5">
                  {paintSwatches.map((swatch) => (
                    <button
                      key={swatch}
                      type="button"
                      className={cn(
                        'h-6 w-6 rounded-full border border-white/24 shadow-[0_0_0_1px_rgba(0,0,0,0.36)] transition hover:scale-105',
                        paintSettings.color.toLowerCase() === swatch && 'ring-2 ring-white',
                      )}
                      style={{ backgroundColor: swatch }}
                      onClick={() => setPaintSettings({ color: swatch })}
                      aria-label={swatch}
                    />
                  ))}
                </div>
                <input
                  value={paintSettings.color}
                  onChange={(event) => setPaintSettings({ color: event.target.value })}
                  className="h-8 rounded-md border border-white/28 bg-[#111116] px-2 text-right text-sm text-white outline-none focus:border-[#ff8a68]"
                />
              </div>
            </label>
          </div>
        )}
        <IconTooltip label={labels.brush} description={labels.brushHelp} shortcut="P">
          <button
            type="button"
            className={cn(baseButton, paintTool === 'brush' && activeMaskButton)}
            onClick={() => {
              onPaintToolChange(paintTool === 'brush' ? 'none' : 'brush');
              toggleMenu('brush');
            }}
            aria-label={labels.brush}
          >
            <Brush className="h-4.5 w-4.5" />
          </button>
        </IconTooltip>
          </span>
          <span className="relative inline-flex">
        {activeMenu === 'eraser' && (
          <div className="absolute bottom-full left-1/2 z-50 mb-2 w-[284px] -translate-x-1/2 rounded-lg border border-white/16 bg-[#050509] p-2.5 text-white shadow-[0_18px_42px_rgba(0,0,0,0.54)]">
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
          <span className="relative inline-flex">
        {inpaintMenuVisible && (
          <div className="absolute bottom-full left-1/2 z-50 mb-2 w-[284px] -translate-x-1/2 rounded-lg border border-white/16 bg-[#050509] p-2.5 text-white shadow-[0_18px_42px_rgba(0,0,0,0.54)]">
            <label className="grid gap-1.5 text-[13px] font-semibold">
              <span className="flex items-center justify-between">
                <span>{labels.brushSize}</span>
                <input
                  value={paintMaskSettings.brushSize.toFixed(1)}
                  onChange={(event) => setPaintMaskSettings({ brushSize: Number(event.target.value) || 1 })}
                  className="h-8 w-24 rounded-md border border-white/28 bg-[#111116] px-2 text-right text-sm text-white outline-none focus:border-[#ff8a68]"
                />
              </span>
              <input
                type="range"
                min="1"
                max="180"
                step="0.5"
                value={paintMaskSettings.brushSize}
                onChange={(event) => setPaintMaskSettings({ brushSize: Number(event.target.value) })}
                className="w-full accent-[#ff8a68]"
              />
            </label>
            <label className="mt-2 grid gap-1.5 text-[13px] font-semibold">
              <span className="flex items-center justify-between">
                <span>{labels.brushHardness}</span>
                <input
                  value={paintMaskSettings.brushHardness.toFixed(1)}
                  onChange={(event) => setPaintMaskSettings({ brushHardness: Number(event.target.value) || 0 })}
                  className="h-8 w-24 rounded-md border border-white/28 bg-[#111116] px-2 text-right text-sm text-white outline-none focus:border-[#ff8a68]"
                />
              </span>
              <input
                type="range"
                min="0"
                max="100"
                step="0.5"
                value={paintMaskSettings.brushHardness}
                onChange={(event) => setPaintMaskSettings({ brushHardness: Number(event.target.value) })}
                className="w-full accent-[#ff8a68]"
              />
            </label>
            <div className="mt-2 grid gap-1.5 border-t border-white/16 pt-2">
              <button
                type="button"
                className="flex h-9 items-center justify-between rounded-md border border-white/16 bg-[#0b0b11] px-2.5 text-left text-[13px] font-semibold text-white transition hover:border-[#ff8a68]/70 hover:text-[#ffb199]"
                onClick={clearPaintMask}
              >
                <span>{labels.resetInpaintRegion}</span>
                <span className="rounded bg-white/16 px-1.5 py-0.5 text-[10px] text-white/76">CTRL D</span>
              </button>
              <button
                type="button"
                className="flex h-9 items-center justify-between rounded-md border border-white/16 bg-[#0b0b11] px-2.5 text-left text-[13px] font-semibold text-white transition hover:border-[#ff8a68]/70 hover:text-[#ffb199]"
                onClick={invertPaintMask}
              >
                <span>{labels.invertInpaintRegion}</span>
                <span className="rounded bg-white/16 px-1.5 py-0.5 text-[10px] text-white/76">CTRL I</span>
              </button>
            </div>
          </div>
        )}
        <IconTooltip
          label={labels.inpaintSelect}
          description={labels.inpaintSelectHelp}
          shortcut="K"
        >
          <button
            type="button"
            className={cn(baseButton, paintTool === 'inpaint-add' && activeMaskButton)}
            onClick={() => {
              onPaintToolChange(paintTool === 'inpaint-add' ? 'none' : 'inpaint-add');
              toggleMenu('inpaint-add');
            }}
            aria-label={labels.inpaintSelect}
          >
            <span className="relative grid place-items-center">
              <Sparkles className="h-4.5 w-4.5" />
              <Plus className="absolute -left-2 -top-2 h-3.5 w-3.5 stroke-[3]" />
              {paintTool === 'inpaint-add' && <ChevronUp className="absolute -right-3 -top-3 h-3.5 w-3.5" />}
            </span>
          </button>
        </IconTooltip>
          </span>
          <IconTooltip
        label={labels.inpaintUnselect}
        description={labels.inpaintUnselectHelp}
        shortcut="O"
          >
        <button
          type="button"
          className={cn(baseButton, paintTool === 'inpaint-subtract' && activeMaskButton)}
            onClick={() => {
              onPaintToolChange(paintTool === 'inpaint-subtract' ? 'none' : 'inpaint-subtract');
            toggleMenu('inpaint-subtract');
          }}
          aria-label={labels.inpaintUnselect}
        >
          <span className="relative grid place-items-center">
            <Sparkles className="h-4.5 w-4.5" />
            <Minus className="absolute -left-2 -top-2 h-3.5 w-3.5 stroke-[3]" />
            {paintTool === 'inpaint-subtract' && <ChevronUp className="absolute -right-3 -top-3 h-3.5 w-3.5" />}
          </span>
        </button>
          </IconTooltip>
          <span className="relative inline-flex">
        <IconTooltip
          label={labels.localRepaint}
          description={labels.localRepaintHelp}
          shortcut="I"
        >
          <button
            type="button"
            className={cn(baseButton, paintTool === 'inpaint-apply' && activeMaskButton)}
            onClick={() => {
              onLocalRepaint();
              toggleMenu('inpaint-apply');
            }}
            aria-label={labels.localRepaint}
          >
            <span className="relative grid place-items-center">
              <Sparkles className="h-4.5 w-4.5" />
              {paintTool === 'inpaint-apply' && <ChevronUp className="absolute -right-3 -top-3 h-3.5 w-3.5" />}
            </span>
          </button>
        </IconTooltip>
          </span>

          {divider}
          {renderUndoRedo()}
        </>
      )}
    </div>
  );
}
