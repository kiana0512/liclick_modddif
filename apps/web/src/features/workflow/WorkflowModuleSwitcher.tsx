import { Box, Flame, LoaderCircle, Map } from 'lucide-react';
import { cn } from '@/components/common/cn';
import type { WorkflowModule, WorkflowNavigation } from './workflowTypes';

const modules: Array<{
  id: WorkflowModule;
  label: string;
  shortLabel: string;
  icon: typeof Box;
}> = [
  { id: 'texture', label: '贴图', shortLabel: '贴图', icon: Box },
  { id: 'uv', label: 'UV', shortLabel: 'UV', icon: Map },
  { id: 'bake', label: '烘焙', shortLabel: '烘焙', icon: Flame },
];

export function WorkflowModuleSwitcher({
  activeModule,
  onOpenTexture,
  onOpenRetopology,
  onOpenUv,
  onOpenBake,
  compact = false,
  pendingModule,
}: WorkflowNavigation & { compact?: boolean; pendingModule?: WorkflowModule }) {
  const handlers: Record<WorkflowModule, () => void> = {
    texture: onOpenTexture,
    retopology: onOpenRetopology,
    uv: onOpenUv,
    bake: onOpenBake,
  };

  return (
    <nav
      className="flex items-center gap-1 rounded-lg border border-white/10 bg-black/34 p-1 shadow-[0_10px_30px_rgba(0,0,0,0.24)] backdrop-blur-md"
      aria-label="贴图、UV、烘焙工作流"
    >
      {modules.map(({ id, label, shortLabel, icon: Icon }) => {
        const active = activeModule === id;
        const pending = pendingModule === id;
        return (
          <div key={id} className="flex items-center gap-1">
            <button
              type="button"
              className={cn(
                'flex h-10 items-center gap-2 rounded-md px-3 text-sm font-semibold text-white/62 transition-colors hover:bg-white/8 hover:text-white xl:px-4',
                active &&
                  'bg-gradient-to-r from-liclick-pink to-liclick-purple text-white shadow-glow',
              )}
              onClick={handlers[id]}
              disabled={pending}
              aria-busy={pending || undefined}
              aria-current={active ? 'page' : undefined}
              title={label}
            >
              {pending ? (
                <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Icon className="h-4 w-4" aria-hidden="true" />
              )}
              <span className={cn(compact && 'hidden xl:inline')}>{compact ? shortLabel : label}</span>
            </button>
          </div>
        );
      })}
    </nav>
  );
}
