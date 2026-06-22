import {
  Brush,
  Eraser,
  Layers3,
  Link2,
  MousePointer2,
  Move3D,
  Redo2,
  Rotate3D,
  Scale3D,
  Sparkles,
  Undo2,
} from 'lucide-react';
import { cn } from '@/components/common/cn';
import { IconTooltip } from '@/components/common/IconTooltip';
import type { PaintToolMode, TransformMode } from '@/stores/sceneStore';

type BottomToolDockProps = {
  transformMode: TransformMode;
  paintTool: PaintToolMode;
  onTransformModeChange: (mode: TransformMode) => void;
  onPaintToolChange: (mode: PaintToolMode) => void;
  onOpenLayers: () => void;
  onLocalRepaint: () => void;
  onReferenceLink: () => void;
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
    localRepaint: string;
    referenceLink: string;
    undo: string;
    redo: string;
    selectHelp: string;
    moveHelp: string;
    rotateHelp: string;
    scaleHelp: string;
    layersHelp: string;
    brushHelp: string;
    eraserHelp: string;
    localRepaintHelp: string;
    referenceLinkHelp: string;
  };
};

const tools: Array<{ mode: TransformMode; icon: typeof MousePointer2; labelKey: 'select' | 'move' | 'rotate' | 'scale' }> = [
  { mode: 'select', icon: MousePointer2, labelKey: 'select' },
  { mode: 'translate', icon: Move3D, labelKey: 'move' },
  { mode: 'rotate', icon: Rotate3D, labelKey: 'rotate' },
  { mode: 'scale', icon: Scale3D, labelKey: 'scale' },
];

export function BottomToolDock({
  transformMode,
  paintTool,
  onTransformModeChange,
  onPaintToolChange,
  onOpenLayers,
  onLocalRepaint,
  onReferenceLink,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  labels,
}: BottomToolDockProps) {
  const baseButton =
    'grid h-11 w-11 shrink-0 place-items-center rounded-md border border-white/10 bg-black/34 text-white/72 transition hover:border-white/22 hover:bg-white/12 hover:text-white focus:outline-none focus:ring-2 focus:ring-liclick-pink/45 disabled:cursor-not-allowed disabled:opacity-42';
  const divider = <div className="mx-1 h-6 w-px shrink-0 bg-white/10" />;

  return (
    <div className="mx-auto flex max-w-[calc(100vw-24px)] items-center gap-1 overflow-visible rounded-lg border border-white/10 bg-[#101225]/92 p-1 shadow-[0_12px_34px_rgba(0,0,0,0.36)] backdrop-blur">
      {tools.map(({ mode, icon: Icon, labelKey }) => (
        <IconTooltip
          key={mode}
          label={labels[labelKey]}
          description={labels[`${labelKey}Help` as keyof typeof labels]}
          shortcut={labelKey === 'select' ? 'V' : labelKey === 'move' ? 'W' : labelKey === 'rotate' ? 'E' : 'R'}
        >
          <button
            type="button"
            className={cn(
              baseButton,
              transformMode === mode &&
                'border-liclick-pink/60 bg-gradient-to-r from-liclick-pink to-liclick-purple text-white shadow-glow',
            )}
            onClick={() => onTransformModeChange(mode)}
            aria-label={labels[labelKey]}
          >
            <Icon className="h-4.5 w-4.5" />
          </button>
        </IconTooltip>
      ))}

      {divider}

      <IconTooltip label={labels.layers} description={labels.layersHelp}>
        <button
          type="button"
          className={baseButton}
          onClick={onOpenLayers}
          aria-label={labels.layers}
        >
          <Layers3 className="h-4.5 w-4.5" />
        </button>
      </IconTooltip>
      <IconTooltip label={labels.brush} description={labels.brushHelp} shortcut="P">
        <button
          type="button"
          className={cn(
            baseButton,
            paintTool === 'brush' &&
              'border-[#ff8a68]/70 bg-[#8b4a38] text-white shadow-[0_0_0_1px_rgba(255,138,104,0.26)]',
          )}
          onClick={() => onPaintToolChange(paintTool === 'brush' ? 'none' : 'brush')}
          aria-label={labels.brush}
        >
          <Brush className="h-4.5 w-4.5" />
        </button>
      </IconTooltip>
      <IconTooltip label={labels.eraser} description={labels.eraserHelp} shortcut="E">
        <button
          type="button"
          className={cn(
            baseButton,
            paintTool === 'eraser' &&
              'border-[#ff8a68]/70 bg-[#8b4a38] text-white shadow-[0_0_0_1px_rgba(255,138,104,0.26)]',
          )}
          onClick={() => onPaintToolChange(paintTool === 'eraser' ? 'none' : 'eraser')}
          aria-label={labels.eraser}
        >
          <Eraser className="h-4.5 w-4.5" />
        </button>
      </IconTooltip>
      <IconTooltip label={labels.localRepaint} description={labels.localRepaintHelp} shortcut="K">
        <button type="button" className={baseButton} onClick={onLocalRepaint} aria-label={labels.localRepaint}>
          <Sparkles className="h-4.5 w-4.5" />
        </button>
      </IconTooltip>
      <IconTooltip label={labels.referenceLink} description={labels.referenceLinkHelp} shortcut="I">
        <button type="button" className={baseButton} onClick={onReferenceLink} aria-label={labels.referenceLink}>
          <Link2 className="h-4.5 w-4.5" />
        </button>
      </IconTooltip>

      {divider}

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
    </div>
  );
}
