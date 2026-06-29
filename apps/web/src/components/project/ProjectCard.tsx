import { Clock3, HardDrive, LockKeyhole } from 'lucide-react';
import { ContextMenu, type ContextMenuItem } from '@/components/common/ContextMenu';
import type { Project } from '@/types/project';
import { useI18nStore, useT } from '@/stores/i18nStore';

type ProjectCardProps = {
  project: Project;
  onOpen: (projectId: string) => void;
  menuItems?: ContextMenuItem[];
};

export function ProjectCard({ project, onOpen, menuItems = [] }: ProjectCardProps) {
  const language = useI18nStore((state) => state.language);
  const t = useT();

  return (
    <article
      className="group overflow-hidden rounded-md border border-white/10 bg-[#303030] text-left transition hover:-translate-y-0.5 hover:border-liclick-pink/50 hover:bg-[#383838]"
    >
      <div className="relative h-52 overflow-hidden bg-[#333]">
        <button type="button" onClick={() => onOpen(project.id)} className="block h-full w-full text-left">
          <LockKeyhole className="absolute left-3 top-3 z-10 h-4 w-4 text-white/72" />
        {project.thumbnail ? (
          <img src={project.thumbnail} alt="" className="h-full w-full object-cover opacity-95 transition group-hover:scale-105" />
        ) : (
          <div className="relative grid h-full place-items-center overflow-hidden bg-[#191b22] text-xs uppercase tracking-[0.16em] text-white/48">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_38%_35%,rgba(149,104,72,0.72),transparent_28%),linear-gradient(135deg,rgba(69,44,33,0.9),rgba(22,23,31,0.96)_58%,rgba(8,9,18,1))]" />
            <div className="absolute left-[18%] top-[18%] h-[62%] w-[58%] rounded-[38%_28%_32%_36%] border border-white/12 bg-[#7a5139]/70 shadow-[inset_0_18px_34px_rgba(255,255,255,0.12),inset_0_-24px_42px_rgba(0,0,0,0.22)]" />
            <span className="relative">Liclick</span>
          </div>
        )}
        </button>
        {menuItems.length > 0 && <ContextMenu items={menuItems} className="absolute right-2 top-2 z-10" />}
      </div>
      <button type="button" onClick={() => onOpen(project.id)} className="block w-full text-left">
        <div className="bg-[#737373] p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 truncate font-semibold text-white">{project.name}</div>
            {project.workspaceMode === 'local-server' && <HardDrive className="h-4 w-4 shrink-0 text-white/72" />}
          </div>
          <div className="mt-2 flex items-center gap-2 text-xs text-white/70">
            <Clock3 className="h-3.5 w-3.5" />
            {t('updated')} {new Date(project.updatedAt).toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US')}
          </div>
          {project.workspaceMode === 'local-server' && (
            <div className="mt-2 text-[11px] uppercase tracking-[0.12em] text-white/64">{t('localProject')}</div>
          )}
        </div>
      </button>
    </article>
  );
}
