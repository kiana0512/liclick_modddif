import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ExternalLink, GripHorizontal, LoaderCircle, RefreshCw, RotateCcw, X } from 'lucide-react';
import { useT } from '@/stores/i18nStore';
import type { PhotoshopSession } from './photoshopBridgeClient';

type PhotoshopEditSessionPanelProps = {
  session: PhotoshopSession;
  busy?: boolean;
  onSync: () => void;
  onApply: () => void;
  onCancel: () => void;
  onLaunch: () => void;
};

type PanelPosition = { x: number; y: number };

const panelPositionStorageKey = 'liclick.photoshop-panel-position.v1';
const panelViewportPadding = 12;

function readStoredPosition(): PanelPosition | undefined {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(panelPositionStorageKey) ?? 'null') as Partial<PanelPosition> | null;
    if (parsed && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
      return { x: Number(parsed.x), y: Number(parsed.y) };
    }
  } catch {
    // A corrupt or unavailable localStorage entry falls back to the default corner.
  }
  return undefined;
}

function clampPanelPosition(position: PanelPosition, width: number, height: number): PanelPosition {
  return {
    x: Math.min(
      Math.max(panelViewportPadding, position.x),
      Math.max(panelViewportPadding, window.innerWidth - width - panelViewportPadding),
    ),
    y: Math.min(
      Math.max(panelViewportPadding, position.y),
      Math.max(panelViewportPadding, window.innerHeight - height - panelViewportPadding),
    ),
  };
}

const statusTone: Record<PhotoshopSession['status'], string> = {
  awaiting_source: 'bg-white/38',
  launching: 'bg-amber-300',
  waiting_for_plugin: 'bg-amber-300',
  opening: 'bg-violet-300',
  ready: 'bg-emerald-300',
  dirty: 'bg-fuchsia-300',
  syncing: 'bg-violet-300',
  synced: 'bg-emerald-300',
  error: 'bg-red-400',
  closed: 'bg-white/38',
};

function isWorking(status: PhotoshopSession['status']) {
  return ['awaiting_source', 'launching', 'waiting_for_plugin', 'opening', 'syncing'].includes(status);
}

export function PhotoshopEditSessionPanel({
  session,
  busy,
  onSync,
  onApply,
  onCancel,
  onLaunch,
}: PhotoshopEditSessionPanelProps) {
  const t = useT();
  const panelRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    offsetX: number;
    offsetY: number;
    latest: PanelPosition;
  }>();
  const [position, setPosition] = useState<PanelPosition | undefined>(readStoredPosition);
  const working = isWorking(session.status) || busy;
  const canSync = ['ready', 'dirty', 'synced', 'error'].includes(session.status) && !busy;
  const canApply = session.latestRevision > 0 && !busy;

  useEffect(() => {
    const keepInsideViewport = () => {
      const panel = panelRef.current;
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      const next = clampPanelPosition({ x: rect.left, y: rect.top }, rect.width, rect.height);
      panel.style.left = `${next.x}px`;
      panel.style.top = `${next.y}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      setPosition(next);
      window.localStorage.setItem(panelPositionStorageKey, JSON.stringify(next));
    };
    keepInsideViewport();
    window.addEventListener('resize', keepInsideViewport);
    return () => {
      window.removeEventListener('resize', keepInsideViewport);
      document.body.style.userSelect = '';
    };
  }, []);

  function beginDrag(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0 || (event.target as Element).closest('button')) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const latest = { x: rect.left, y: rect.top };
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      latest,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    panel.dataset.dragging = 'true';
    document.body.style.userSelect = 'none';
  }

  function moveDrag(event: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    const panel = panelRef.current;
    if (!drag || !panel || drag.pointerId !== event.pointerId) return;
    const rect = panel.getBoundingClientRect();
    const next = clampPanelPosition(
      { x: event.clientX - drag.offsetX, y: event.clientY - drag.offsetY },
      rect.width,
      rect.height,
    );
    drag.latest = next;
    panel.style.left = `${next.x}px`;
    panel.style.top = `${next.y}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  function endDrag(event: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    const panel = panelRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (panel) delete panel.dataset.dragging;
    document.body.style.userSelect = '';
    setPosition(drag.latest);
    window.localStorage.setItem(panelPositionStorageKey, JSON.stringify(drag.latest));
  }

  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-[115]">
      <section
        ref={panelRef}
        aria-live="polite"
        style={position ? { left: position.x, top: position.y } : { right: 20, bottom: 20 }}
        className="pointer-events-auto fixed w-[360px] max-w-[calc(100vw-24px)] overflow-hidden rounded-2xl border border-white/12 bg-[#12121d]/96 text-white shadow-[0_24px_80px_rgba(0,0,0,.52)] backdrop-blur-xl data-[dragging=true]:shadow-[0_32px_100px_rgba(0,0,0,.68)]"
      >
        <header
          className="flex touch-none cursor-grab items-start justify-between gap-4 border-b border-white/10 px-4 py-4 active:cursor-grabbing"
          onPointerDown={beginDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          title="拖动悬浮窗"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <span className={`h-2.5 w-2.5 rounded-full ${statusTone[session.status]}`} />
              {t('photoshopEditTitle')}
              <GripHorizontal className="h-3.5 w-3.5 text-white/28" />
            </div>
            <p className="mt-1 truncate text-xs text-white/52">{session.layerName}</p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="grid h-8 w-8 place-items-center rounded-lg text-white/60 transition hover:bg-white/10 hover:text-white disabled:opacity-40"
            aria-label={t('cancel')}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-3 px-4 py-4">
          <div className="rounded-xl border border-white/8 bg-white/[0.045] px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-white/50">{t('photoshopBridgeStatus')}</span>
              <span className="flex items-center gap-1.5 text-xs font-medium text-white/86">
                {working ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}
                {t(`photoshopStatus_${session.status}`)}
              </span>
            </div>
            <div className="mt-2 flex items-center justify-between text-xs text-white/50">
              <span>{session.syncMode === 'live' ? t('photoshopLiveSync') : t('photoshopSaveSync')}</span>
              <span>Rev {session.latestRevision}</span>
            </div>
          </div>

          {session.error ? (
            <div className="rounded-xl border border-red-400/28 bg-red-400/10 px-3 py-2.5 text-xs leading-5 text-red-100">
              {session.error}
            </div>
          ) : (
            <p className="text-xs leading-5 text-white/52">{t('photoshopEditHelp')}</p>
          )}

          {session.status === 'waiting_for_plugin' || session.status === 'error' ? (
            <button
              type="button"
              onClick={onLaunch}
              className="flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-white/12 bg-white/[0.06] text-xs font-medium transition hover:bg-white/10"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t('photoshopLaunch')}
            </button>
          ) : null}
        </div>

        <footer className="grid grid-cols-[auto_1fr_1fr] gap-2 border-t border-white/10 bg-black/14 px-4 py-3">
          <button
            type="button"
            onClick={onSync}
            disabled={!canSync}
            className="grid h-9 w-9 place-items-center rounded-lg border border-white/12 text-white/72 transition hover:bg-white/10 hover:text-white disabled:opacity-32"
            title={t('photoshopSyncNow')}
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="flex h-9 items-center justify-center gap-2 rounded-lg border border-white/12 text-xs font-medium text-white/72 transition hover:bg-white/10 hover:text-white disabled:opacity-40"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t('photoshopDiscard')}
          </button>
          <button
            type="button"
            onClick={onApply}
            disabled={!canApply}
            className="flex h-9 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-[#f34fc8] to-[#9158f6] text-xs font-semibold text-white shadow-[0_8px_24px_rgba(164,74,245,.22)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-38"
          >
            <Check className="h-3.5 w-3.5" />
            {t('photoshopApply')}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
