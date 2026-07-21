import { Box, Flame, Send } from 'lucide-react';
import { cn } from '@/components/common/cn';
import type { WorkflowModule, WorkflowNavigation } from './workflowTypes';

const modules: Array<{
  id: WorkflowModule;
  label: string;
  shortLabel: string;
  icon: typeof Box;
}> = [
  { id: 'texture', label: 'AI 高模贴图', shortLabel: '贴图', icon: Box },
  { id: 'bake', label: 'PBR 烘焙', shortLabel: '烘焙', icon: Flame },
  { id: 'delivery', label: 'DCC 交付', shortLabel: '交付', icon: Send },
];

export function WorkflowModuleSwitcher({
  activeModule,
  onOpenTexture,
  onOpenBake,
  onOpenDelivery,
  compact = false,
}: WorkflowNavigation & { compact?: boolean }) {
  const handlers: Record<WorkflowModule, () => void> = {
    texture: onOpenTexture,
    bake: onOpenBake,
    delivery: onOpenDelivery,
  };

  return (
    <nav
      className="flex items-center gap-1 rounded-lg border border-white/10 bg-black/34 p-1 shadow-[0_10px_30px_rgba(0,0,0,0.24)] backdrop-blur-md"
      aria-label="PBR 工作流模块"
    >
      {modules.map(({ id, label, shortLabel, icon: Icon }) => {
        const active = activeModule === id;
        return (
          <button
            key={id}
            type="button"
            className={cn(
              'flex h-10 items-center gap-2 rounded-md px-4 text-sm font-semibold text-white/62 transition-colors hover:bg-white/8 hover:text-white',
              active &&
                'bg-gradient-to-r from-liclick-pink to-liclick-purple text-white shadow-glow',
            )}
            onClick={handlers[id]}
            aria-current={active ? 'page' : undefined}
            title={label}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            <span className={cn(compact && 'hidden xl:inline')}>{compact ? shortLabel : label}</span>
          </button>
        );
      })}
    </nav>
  );
}
