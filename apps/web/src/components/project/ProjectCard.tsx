import { Clock3 } from 'lucide-react';
import type { Project } from '@/types/project';

type ProjectCardProps = {
  project: Project;
  onOpen: (projectId: string) => void;
};

export function ProjectCard({ project, onOpen }: ProjectCardProps) {
  return (
    <button
      type="button"
      onClick={() => onOpen(project.id)}
      className="group overflow-hidden rounded-lg border border-white/10 bg-white/[0.06] text-left transition hover:-translate-y-0.5 hover:border-liclick-pink/50 hover:bg-white/[0.09]"
    >
      <div className="h-40 overflow-hidden bg-gradient-to-br from-liclick-pink/45 via-liclick-purple/35 to-ink">
        <img
          src={project.thumbnail}
          alt=""
          className="h-full w-full object-cover opacity-80 mix-blend-screen transition group-hover:scale-105"
        />
      </div>
      <div className="p-4">
        <div className="font-semibold text-white">{project.name}</div>
        <div className="mt-2 flex items-center gap-2 text-xs text-white/52">
          <Clock3 className="h-3.5 w-3.5" />
          Updated {new Date(project.updatedAt).toLocaleDateString()}
        </div>
      </div>
    </button>
  );
}
