import { useState, type ReactNode } from 'react';
import { ArrowLeft, Boxes, ChevronDown, Download, Globe2, Palette, ScanLine } from 'lucide-react';
import { BrandMark } from '@/components/common/BrandMark';
import { cn } from '@/components/common/cn';
import { IconTooltip } from '@/components/common/IconTooltip';
import { Button } from '@/components/ui/Button';
import { useWorkspaceLayoutStore } from '@/components/workspace/workspaceLayoutStore';
import type { WorkspaceMode } from '@/components/workspace/workspacePanelTypes';
import { useSceneStore } from '@/stores/sceneStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { WorkflowModuleSwitcher } from './WorkflowModuleSwitcher';
import type { WorkflowNavigation } from './workflowTypes';

const modeIcons: Record<Exclude<WorkspaceMode, 'export'>, typeof Palette> = {
  scene: Globe2,
  texture: Palette,
  normal: ScanLine,
  segments: Boxes,
};

const modeOptions: Array<{ value: Exclude<WorkspaceMode, 'export'>; label: string }> = [
  { value: 'scene', label: '场景' },
  { value: 'texture', label: '贴图' },
  { value: 'normal', label: '法线' },
  { value: 'segments', label: '分段' },
];

export function WorkflowShell({
  projectName,
  eyebrow,
  onBack,
  backLabel = '返回项目列表',
  navigation,
  children,
}: {
  projectName: string;
  eyebrow: string;
  onBack: () => void;
  backLabel?: string;
  navigation: WorkflowNavigation;
  connected?: boolean;
  children: ReactNode;
}) {
  const [resolutionMenuOpen, setResolutionMenuOpen] = useState(false);
  const mode = useWorkspaceLayoutStore((state) => state.mode);
  const setMode = useWorkspaceLayoutStore((state) => state.setMode);
  const resolution = useSettingsStore((state) => state.resolution);
  const setResolution = useSettingsStore((state) => state.setResolution);
  const setDisplayMode = useSceneStore((state) => state.setDisplayMode);

  function handleModeChange(nextMode: Exclude<WorkspaceMode, 'export'>) {
    setMode(nextMode);
    if (nextMode === 'normal') setDisplayMode('normal');
    if (nextMode === 'scene' || nextMode === 'texture') setDisplayMode('flat');
  }

  return (
    <main className="relative flex h-screen min-h-[700px] flex-col overflow-hidden bg-[#0d0f1c] font-sans text-white">
      <header className="pointer-events-none absolute left-3 right-32 top-3 z-50 flex flex-wrap items-start justify-start gap-2">
        <div className="pointer-events-auto flex min-w-0 items-center gap-2 rounded-lg border border-white/10 bg-black/42 px-2 py-1.5 shadow-[0_12px_34px_rgba(0,0,0,0.32)] backdrop-blur-md">
          <Button
            variant="ghost"
            className="h-8 w-8 px-0"
            icon={<ArrowLeft className="h-4 w-4" />}
            onClick={onBack}
            aria-label={backLabel}
          />
          <BrandMark compact className="hidden sm:flex" />
          <div className="min-w-0 border-l border-white/12 pl-2 sm:pl-3">
            <div className="truncate text-sm font-semibold">{projectName}</div>
            <div className="text-[11px] text-white/42">{eyebrow}</div>
          </div>
        </div>

        <div className="pointer-events-auto hidden md:block">
          <WorkflowModuleSwitcher {...navigation} compact />
        </div>

        <div className="pointer-events-auto flex flex-wrap items-center justify-start gap-2 rounded-lg border border-white/10 bg-black/42 p-1.5 shadow-[0_12px_34px_rgba(0,0,0,0.32)] backdrop-blur-md">
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
            <IconTooltip label="导出" side="bottom">
              <button
                type="button"
                className="grid h-9 w-9 place-items-center rounded-md text-white/66 transition hover:bg-white/10 hover:text-white"
                aria-label="导出"
              >
                <Download className="h-4.5 w-4.5" />
              </button>
            </IconTooltip>
          </div>

          <div className="relative hidden sm:block">
            <IconTooltip label="分辨率" side="bottom">
              <button
                type="button"
                className="flex h-9 items-center gap-1 rounded-md px-3 text-sm font-semibold text-white/82 transition hover:bg-white/10 hover:text-white"
                onClick={() => setResolutionMenuOpen((open) => !open)}
                aria-label="分辨率"
              >
                {resolution}
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </IconTooltip>
            {resolutionMenuOpen ? (
              <>
                <button
                  type="button"
                  className="fixed inset-0 z-40 cursor-default bg-transparent"
                  aria-label="关闭分辨率菜单"
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
            ) : null}
          </div>
        </div>
      </header>
      {children}
    </main>
  );
}
