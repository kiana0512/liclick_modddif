import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import {
  ArrowLeft,
  Boxes,
  ChevronDown,
  Download,
  Image,
  Palette,
  PanelLeft,
  PanelRight,
  ScanLine,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/components/common/cn';
import { IconTooltip } from '@/components/common/IconTooltip';
import { WorkspaceDock } from '@/components/workspace/WorkspaceDock';
import { WorkspacePanel } from '@/components/workspace/WorkspacePanel';
import { useWorkspaceLayoutStore } from '@/components/workspace/workspaceLayoutStore';
import type {
  DockSide,
  WorkspaceMode,
  WorkspacePanelDefinition,
} from '@/components/workspace/workspacePanelTypes';
import { useSceneStore } from '@/stores/sceneStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useT } from '@/stores/i18nStore';

type EditorShellProps = {
  projectName: string;
  workspaceLabel?: string;
  onBack: () => void;
  exportMenu: ReactNode;
  bottomToolbar: ReactNode;
  center: ReactNode;
  panels: WorkspacePanelDefinition[];
};

const modeIcons: Record<WorkspaceMode, typeof Palette> = {
  texture: Palette,
  normal: ScanLine,
  segments: Boxes,
  export: Download,
};

function DockDrawer({
  side,
  panels,
  onClose,
}: {
  side: DockSide;
  panels: WorkspacePanelDefinition[];
  onClose: () => void;
}) {
  const mode = useWorkspaceLayoutStore((state) => state.mode);
  const togglePanelCollapsed = useWorkspaceLayoutStore((state) => state.togglePanelCollapsed);
  const visiblePanels = useMemo(
    () =>
      panels
        .filter((panel) => panel.visible && panel.dock === side && (panel.mode === 'all' || panel.mode === mode))
        .sort((a, b) => a.order - b.order),
    [mode, panels, side],
  );

  return (
    <div className="fixed inset-0 z-40 bg-black/52 backdrop-blur-sm lg:hidden">
      <aside
        className={`absolute bottom-0 top-0 w-[min(340px,calc(100vw-28px))] overflow-y-auto border-white/10 bg-[#101225] p-3 ${
          side === 'left' ? 'left-0 border-r' : 'right-0 border-l'
        }`}
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="text-xs font-semibold uppercase tracking-[0.16em] text-white/58">
            {side === 'left' ? 'Left Dock' : 'Right Dock'}
          </div>
          <Button variant="ghost" className="h-8 w-8 px-0" onClick={onClose} title="Close dock">
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="space-y-2">
          {visiblePanels.map((panel) => (
            <WorkspacePanel
              id={panel.id}
              key={panel.id}
              title={panel.title}
              collapsed={panel.collapsed}
              actions={panel.actions}
              onToggleCollapsed={() => togglePanelCollapsed(panel.id)}
            >
              {panel.content}
            </WorkspacePanel>
          ))}
        </div>
      </aside>
    </div>
  );
}

export function EditorShell({
  projectName,
  workspaceLabel,
  onBack,
  exportMenu,
  bottomToolbar,
  center,
  panels,
}: EditorShellProps) {
  const [mobileDock, setMobileDock] = useState<DockSide>();
  const [resolutionMenuOpen, setResolutionMenuOpen] = useState(false);
  const t = useT();
  const mode = useWorkspaceLayoutStore((state) => state.mode);
  const setMode = useWorkspaceLayoutStore((state) => state.setMode);
  const dockDensity = useWorkspaceLayoutStore((state) => state.dockDensity);
  const resolution = useSettingsStore((state) => state.resolution);
  const setResolution = useSettingsStore((state) => state.setResolution);
  const setDisplayMode = useSceneStore((state) => state.setDisplayMode);

  function handleModeChange(nextMode: WorkspaceMode) {
    setMode(nextMode);
    if (nextMode === 'normal') setDisplayMode('normal');
    if (nextMode === 'texture') setDisplayMode('pbr');
  }

  const modeOptions: Array<{ value: WorkspaceMode; label: string }> = [
    { value: 'texture', label: t('texture') },
    { value: 'normal', label: t('normal') },
    { value: 'segments', label: t('segments') },
  ];

  return (
    <main className="relative h-screen min-h-[680px] overflow-hidden bg-ink text-white">
      <header className="pointer-events-none absolute left-3 right-32 top-3 z-30 flex flex-wrap items-start justify-start gap-2">
        <div className="pointer-events-auto flex min-w-0 items-center gap-2 rounded-lg border border-white/10 bg-black/42 px-2 py-1.5 shadow-[0_12px_34px_rgba(0,0,0,0.32)] backdrop-blur-md">
          <Button variant="ghost" className="h-8 w-8 px-0" icon={<ArrowLeft className="h-4 w-4" />} onClick={onBack} />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">Liclick 3D Texture / {projectName}</div>
            <div className="text-[11px] text-white/42">{workspaceLabel ?? 'No workspace'}</div>
          </div>
        </div>
        <div className="pointer-events-auto flex flex-wrap items-center justify-start gap-2 rounded-lg border border-white/10 bg-black/42 p-1.5 shadow-[0_12px_34px_rgba(0,0,0,0.32)] backdrop-blur-md">
          <div className="flex gap-1 lg:hidden">
            <Button
              variant="secondary"
              className="h-8 w-8 px-0"
              onClick={() => setMobileDock('left')}
              title="Open left dock"
            >
              <PanelLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="secondary"
              className="h-8 w-8 px-0"
              onClick={() => setMobileDock('right')}
              title="Open right dock"
            >
              <PanelRight className="h-4 w-4" />
            </Button>
          </div>
          <div className="hidden items-center gap-1 rounded-lg border border-white/10 bg-black/30 p-1 sm:flex">
            {modeOptions.map((option) => {
              const Icon = modeIcons[option.value];
              return (
                <IconTooltip key={option.value} label={option.label} side="bottom">
                  <button
                    type="button"
                    className={cn(
                      'grid h-9 w-9 place-items-center rounded-md text-white/66 transition hover:bg-white/10 hover:text-white',
                      mode === option.value &&
                        'bg-gradient-to-r from-liclick-pink to-liclick-purple text-white shadow-glow',
                    )}
                    onClick={() => handleModeChange(option.value)}
                    aria-label={option.label}
                  >
                    <Icon className="h-4.5 w-4.5" />
                  </button>
                </IconTooltip>
              );
            })}
            {exportMenu}
          </div>
          <div className="relative hidden sm:block">
            <IconTooltip label="Resolution" side="bottom">
              <button
                type="button"
                className="flex h-9 items-center gap-1 rounded-md px-3 text-sm font-semibold text-white/82 transition hover:bg-white/10 hover:text-white"
                onClick={() => setResolutionMenuOpen((open) => !open)}
                aria-label="Resolution"
              >
                {resolution}
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </IconTooltip>
            {resolutionMenuOpen && (
              <>
                <button
                  type="button"
                  className="fixed inset-0 z-40 cursor-default bg-transparent"
                  aria-label="Close resolution menu"
                  onClick={() => setResolutionMenuOpen(false)}
                />
                <div className="absolute left-0 top-full z-50 mt-2 min-w-24 rounded-md border border-white/12 bg-black/92 p-1 text-sm shadow-xl backdrop-blur">
                  {(['1K', '2K', '4K', '8K'] as const).map((item) => (
                    <button
                      key={item}
                      type="button"
                      className={cn(
                        'block w-full rounded px-3 py-2 text-left font-semibold transition hover:bg-white/10',
                        resolution === item ? 'bg-white text-black' : 'text-white/80',
                      )}
                      onClick={() => {
                        setResolution(item);
                        setResolutionMenuOpen(false);
                      }}
                    >
                      {item}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <div className="flex gap-1 sm:hidden">
            <Button
              className="h-8 w-8 px-0"
              icon={<Image className="h-4 w-4" />}
              variant={mode === 'texture' ? 'primary' : 'secondary'}
              onClick={() => handleModeChange('texture')}
              title={t('texture')}
            />
          </div>
        </div>
      </header>

      <section
        className="relative h-full overflow-hidden bg-[#080914]"
        style={
          {
            '--workspace-left-top-offset': '84px',
            '--workspace-right-top-offset': '176px',
            '--workspace-bottom-offset': '16px',
            '--dock-left-width': dockDensity === 'normal' ? '320px' : '300px',
            '--dock-right-width': dockDensity === 'normal' ? '400px' : '360px',
          } as CSSProperties
        }
      >
        {center}
        <WorkspaceDock side="left" panels={panels.filter((panel) => panel.dock === 'left')} />
        <WorkspaceDock side="right" panels={panels.filter((panel) => panel.dock === 'right')} />
        <div className="pointer-events-none absolute bottom-4 left-0 right-0 z-30 flex justify-center px-3">
          <div className="pointer-events-auto">{bottomToolbar}</div>
        </div>
      </section>

      {mobileDock && <DockDrawer side={mobileDock} panels={panels} onClose={() => setMobileDock(undefined)} />}
    </main>
  );
}
