import type { PaintToolMode } from '@/stores/sceneStore';

// UI-only guidance: success can precede GPU readiness and task unlock.
// Keep the next step pending; the button's existing readiness gate controls
// when it becomes visible. This never activates tools or changes task state.
export type RepaintGuideSnapshot = {
  running: boolean;
  successKey: number;
  paintTool: PaintToolMode;
};
export type RepaintGuideState = RepaintGuideSnapshot & {
  step: 'none' | 'generate' | 'repaint';
};
const isMaskTool = (tool: PaintToolMode) => tool === 'inpaint-add' || tool === 'inpaint-subtract';

export function reconcileRepaintWorkflowGuide(
  previous: RepaintGuideState,
  current: RepaintGuideSnapshot,
): RepaintGuideState {
  let step = previous.step;
  if (current.successKey !== previous.successKey) {
    step = current.paintTool === 'inpaint-apply' ? 'none' : 'repaint';
  } else if (current.running && !previous.running) {
    // Also covers generation started from the side panel, not just the dock.
    step = 'none';
  } else if (current.paintTool === 'inpaint-apply' && previous.paintTool !== 'inpaint-apply') {
    step = 'none';
  } else if (!current.running && isMaskTool(current.paintTool) &&
    !isMaskTool(previous.paintTool) && step !== 'repaint') {
    // A restored mask tool must not overwrite the pending success guidance.
    step = 'generate';
  }
  return { ...current, step };
}
