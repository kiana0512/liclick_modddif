/** Explicit, per-page personal compute opt-in; never persisted into a project. */
export const personalRepaintEnabled = import.meta.env.VITE_PERSONAL_REPAINT_ENABLED === 'true' && typeof window !== 'undefined' &&
  new URLSearchParams(window.location?.search ?? '').get('personalRepaint') === '1';
