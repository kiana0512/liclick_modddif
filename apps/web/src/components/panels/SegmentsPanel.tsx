import { CircleSlash, MousePointerClick, Plus, ScanEye } from 'lucide-react';
import type { ReactNode } from 'react';
import { useWorkspaceLayoutStore } from '@/components/workspace/workspaceLayoutStore';
import { useT } from '@/stores/i18nStore';

export function SegmentsPanel() {
  const t = useT();
  const setMode = useWorkspaceLayoutStore((state) => state.setMode);

  return (
    <div className="grid min-h-[360px] place-items-center px-3 py-8 text-center">
      <div className="max-w-[270px]">
        <CircleSlash className="mx-auto h-11 w-11 text-white/58" />
        <p className="mt-5 text-lg font-semibold leading-7 text-white/62">{t('segmentsEmptyHelp')}</p>
        <button
          type="button"
          className="mt-6 h-11 rounded-md bg-gradient-to-r from-liclick-pink to-liclick-purple px-5 text-base font-semibold text-white shadow-glow transition hover:brightness-110"
          onClick={() => setMode('segments')}
        >
          {t('createSegment')}
        </button>
      </div>
    </div>
  );
}

export function SegmentsPanelActions() {
  const t = useT();
  return (
    <div className="flex items-center gap-1">
      <HeaderIconButton title={t('createSegment')}>
        <MousePointerClick className="h-4 w-4" />
      </HeaderIconButton>
      <HeaderIconButton title={t('toggleVisibility')}>
        <ScanEye className="h-4 w-4" />
      </HeaderIconButton>
    </div>
  );
}

export function HeaderIconButton({
  title,
  children,
  onClick,
}: {
  title: string;
  children: ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="grid h-7 w-7 place-items-center rounded text-white transition hover:bg-liclick-pink/18 hover:text-liclick-pink"
    >
      {children}
    </button>
  );
}

export function AddHeaderIconButton({ title, onClick }: { title: string; onClick?: () => void }) {
  return (
    <HeaderIconButton title={title} onClick={onClick}>
      <Plus className="h-4 w-4" />
    </HeaderIconButton>
  );
}
