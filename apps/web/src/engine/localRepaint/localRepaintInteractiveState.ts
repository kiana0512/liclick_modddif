export const LOCAL_REPAINT_INTERACTIVE_STATE_EVENT = 'liclick:local-repaint-interactive-state';

export type LocalRepaintInteractiveStatus = 'preparing' | 'ready' | 'failed';

export type LocalRepaintInteractiveStateDetail = {
  generationId: string;
  targetLayerId?: string;
  status: LocalRepaintInteractiveStatus;
};

export function publishLocalRepaintInteractiveState(detail: LocalRepaintInteractiveStateDetail) {
  window.dispatchEvent(
    new CustomEvent<LocalRepaintInteractiveStateDetail>(LOCAL_REPAINT_INTERACTIVE_STATE_EVENT, {
      detail,
    }),
  );
}
