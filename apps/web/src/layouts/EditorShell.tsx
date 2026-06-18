import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import {
  ArrowLeft,
  Archive,
  Boxes,
  Download,
  FileDown,
  FileUp,
  FolderOpen,
  Image,
  Palette,
  PanelLeft,
  PanelRight,
  RotateCcw,
  Save,
  ScanLine,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/components/common/cn';
import { IconTooltip } from '@/components/common/IconTooltip';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
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
  onImportModel: () => void;
  onSaveProject: () => void;
  onExportProjectPackage: () => void;
  onLoadProject: () => void;
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
  onImportModel,
  onSaveProject,
  onExportProjectPackage,
  onLoadProject,
  exportMenu,
  bottomToolbar,
  center,
  panels,
}: EditorShellProps) {
  const [mobileDock, setMobileDock] = useState<DockSide>();
  const t = useT();
  const mode = useWorkspaceLayoutStore((state) => state.mode);
  const setMode = useWorkspaceLayoutStore((state) => state.setMode);
  const resetWorkspaceLayout = useWorkspaceLayoutStore((state) => state.resetWorkspaceLayout);
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
    { value: 'export', label: t('export') },
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
                <IconTooltip key={option.value} label={option.label}>
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
          </div>
          <SegmentedControl
            value={resolution}
            options={[
              { value: '1K', label: '1K' },
              { value: '2K', label: '2K' },
              { value: '4K', label: '4K' },
            ]}
            onChange={setResolution}
            className="w-32"
          />
          <div className="hidden items-center gap-1 rounded-lg border border-white/10 bg-black/30 p-1 sm:flex">
            <IconTooltip label={t('resetLayout')}>
              <Button className="h-9 w-9 px-0" variant="ghost" onClick={resetWorkspaceLayout} aria-label={t('resetLayout')}>
                <RotateCcw className="h-4 w-4" />
              </Button>
            </IconTooltip>
            <IconTooltip label={t('importModel')}>
              <Button className="h-9 w-9 px-0" icon={<FileUp className="h-4 w-4" />} onClick={onImportModel} aria-label={t('importModel')} />
            </IconTooltip>
            <IconTooltip label={t('save')}>
              <Button className="h-9 w-9 px-0" icon={<Save className="h-4 w-4" />} onClick={onSaveProject} aria-label={t('save')} />
            </IconTooltip>
            <IconTooltip label={t('projectPackage')}>
              <Button
                className="h-9 w-9 px-0"
                icon={<Archive className="h-4 w-4" />}
                onClick={onExportProjectPackage}
                aria-label={t('projectPackage')}
              />
            </IconTooltip>
            <IconTooltip label={t('projects')}>
              <Button className="h-9 w-9 px-0" icon={<FolderOpen className="h-4 w-4" />} onClick={onLoadProject} aria-label={t('projects')} />
            </IconTooltip>
          </div>
          {exportMenu}
          <div className="flex gap-1 sm:hidden">
            <Button
              className="h-8 w-8 px-0"
              icon={<Image className="h-4 w-4" />}
              variant={mode === 'texture' ? 'primary' : 'secondary'}
              onClick={() => handleModeChange('texture')}
              title={t('texture')}
            />
            <Button className="h-8 w-8 px-0" icon={<FileUp className="h-4 w-4" />} onClick={onImportModel} title="Import Model" />
            <Button className="h-8 w-8 px-0" icon={<Save className="h-4 w-4" />} onClick={onSaveProject} title="Save" />
            <Button className="h-8 w-8 px-0" icon={<FileDown className="h-4 w-4" />} onClick={onLoadProject} title="Load" />
            <Button
              className="h-8 w-8 px-0"
              icon={<Download className="h-4 w-4" />}
              variant={mode === 'export' ? 'primary' : 'secondary'}
              onClick={() => setMode('export')}
              title={t('export')}
            />
          </div>
        </div>
      </header>

      <section
        className="relative h-full overflow-hidden bg-[#080914]"
        style={
          {
            '--workspace-top-offset': '176px',
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
