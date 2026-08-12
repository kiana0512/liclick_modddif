import type { ReactNode } from 'react';
import { BrandMark } from '@/components/common/BrandMark';
import { WorkflowModuleSwitcher } from './WorkflowModuleSwitcher';
import type { WorkflowNavigation } from './workflowTypes';

export function WorkflowShell({
  projectName,
  eyebrow,
  onBack,
  backLabel = '返回项目列表',
  navigation,
  stageToolbar,
  headerActions,
  children,
}: {
  projectName: string;
  eyebrow: string;
  onBack: () => void;
  backLabel?: string;
  navigation: WorkflowNavigation;
  stageToolbar?: ReactNode;
  headerActions?: ReactNode;
  connected?: boolean;
  children: ReactNode;
}) {
  return (
    <main className="relative flex h-screen min-h-[700px] flex-col overflow-hidden bg-[#0d0f1c] font-sans text-white">
      <header className="pointer-events-none absolute left-3 right-3 top-3 z-50 flex flex-col items-start gap-2">
        <div className="flex w-full items-start justify-between gap-3">
          <div className="flex min-w-0 max-w-full items-start gap-2">
            <div className="pointer-events-auto flex min-w-0 items-center gap-2 rounded-lg border border-white/10 bg-black/42 px-2 py-1.5 shadow-[0_12px_34px_rgba(0,0,0,0.32)] backdrop-blur-md">
              <BrandMark
                compact
                className="flex"
                onBack={onBack}
                backLabel={backLabel}
              />
              <div className="min-w-0 border-l border-white/12 pl-2 sm:pl-3">
                <div className="max-w-44 truncate text-sm font-semibold">{projectName}</div>
                <div className="text-[11px] text-white/42">{eyebrow}</div>
              </div>
            </div>
            <div className="pointer-events-auto hidden max-w-[calc(100vw-260px)] overflow-x-auto sm:block">
              <WorkflowModuleSwitcher {...navigation} compact />
            </div>
          </div>
          {headerActions ? <div className="pointer-events-auto shrink-0">{headerActions}</div> : null}
        </div>
        {stageToolbar ? (
          <div className="pointer-events-auto rounded-lg border border-white/10 bg-black/42 p-1.5 shadow-[0_12px_34px_rgba(0,0,0,0.32)] backdrop-blur-md">
            {stageToolbar}
          </div>
        ) : null}
      </header>
      {children}
    </main>
  );
}
