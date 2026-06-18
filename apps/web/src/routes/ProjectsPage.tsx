import { FolderPlus, Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ProjectCard } from '@/components/project/ProjectCard';
import { runComingSoonCommand } from '@/features/commandRegistry';
import { AppShell } from '@/layouts/AppShell';
import { useProjectStore } from '@/stores/projectStore';

type ProjectsPageProps = {
  onOpenProject: (projectId: string) => void;
};

export function ProjectsPage({ onOpenProject }: ProjectsPageProps) {
  const projects = useProjectStore((state) => state.projects);

  return (
    <AppShell>
      <section className="mx-auto max-w-7xl px-8 py-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-normal text-white">Projects</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-white/58">
              Manage Liclick texture studies, imported models, references, captures, and projected
              layer experiments.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              icon={<Plus className="h-4 w-4" />}
              variant="primary"
              onClick={() => runComingSoonCommand('newProject')}
            >
              New Project
            </Button>
            <Button icon={<FolderPlus className="h-4 w-4" />} onClick={() => runComingSoonCommand('newFolder')}>
              New Folder
            </Button>
          </div>
        </div>

        <section className="mt-8">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-white/48">
            Folders
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {['Client concepts', 'Material R&D', 'Export tests', 'Archive'].map((folder) => (
              <button
                type="button"
                key={folder}
                onClick={() => runComingSoonCommand('folderManagement')}
                className="rounded-lg border border-white/10 bg-white/[0.055] px-4 py-3 text-left text-sm text-white/76 hover:bg-white/[0.09]"
              >
                {folder}
              </button>
            ))}
          </div>
        </section>

        <section className="mt-8">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-white/48">
            Project Cards
          </h2>
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {projects.map((project) => (
              <ProjectCard key={project.id} project={project} onOpen={onOpenProject} />
            ))}
          </div>
        </section>
      </section>
    </AppShell>
  );
}
