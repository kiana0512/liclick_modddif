import type { Project } from '@/types/project';
import type { ProjectSummary } from '@/services/workspaceApiClient';

type BakeEntryProjectDependencies = {
  listProjects: () => Promise<{ projects: ProjectSummary[] }>;
  loadProject: (projectId: string) => Promise<{ project: Project }>;
};

function updatedAtTimestamp(project: ProjectSummary) {
  const timestamp = Date.parse(project.updatedAt);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

export function selectMostRecentProject(projects: readonly ProjectSummary[]) {
  return [...projects].sort((left, right) => {
    const leftUpdatedAt = updatedAtTimestamp(left);
    const rightUpdatedAt = updatedAtTimestamp(right);
    if (leftUpdatedAt !== rightUpdatedAt) return rightUpdatedAt > leftUpdatedAt ? 1 : -1;
    return left.id.localeCompare(right.id);
  })[0];
}

export async function resolveBakeEntryProject(
  currentProject: Project | undefined,
  dependencies: BakeEntryProjectDependencies,
) {
  if (currentProject) return currentProject;

  const { projects } = await dependencies.listProjects();
  const projectSummary = selectMostRecentProject(projects);
  if (!projectSummary) return undefined;

  return (await dependencies.loadProject(projectSummary.id)).project;
}
