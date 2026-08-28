export type PaintMaskHistoryAction = 'clear' | 'invert';

type PaintMaskHistoryActionHandler = (action: PaintMaskHistoryAction) => boolean;

let activeHandler: PaintMaskHistoryActionHandler | undefined;

export function registerPaintMaskHistoryActionHandler(handler: PaintMaskHistoryActionHandler) {
  activeHandler = handler;
  return () => {
    if (activeHandler === handler) activeHandler = undefined;
  };
}

export function runPaintMaskHistoryAction(action: PaintMaskHistoryAction) {
  return activeHandler?.(action) ?? false;
}

