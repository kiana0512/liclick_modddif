import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { loadProject } from '@/services/workspaceApiClient';
import { useProjectStore } from '@/stores/projectStore';

export function useWorkflowProject(projectId?: string) {
  const cachedProject = useProjectStore((state) =>
    projectId ? state.projects.find((project) => project.id === projectId) : undefined,
  );
  const replaceCurrentProject = useProjectStore((state) => state.replaceCurrentProject);

  const query = useQuery({
    queryKey: ['workflow-project', projectId],
    queryFn: async () => {
      if (!projectId) throw new Error('Project id is required.');
      return (await loadProject(projectId)).project;
    },
    enabled: Boolean(projectId) && !cachedProject,
    initialData: cachedProject,
    retry: 1,
    staleTime: 30_000,
  });

  useEffect(() => {
    // The workflow can receive a newer in-memory scene while a stale server
    // snapshot is still held by React Query. Only seed the store when the
    // project is genuinely absent; otherwise the two snapshots can replace
    // each other forever and trigger "Maximum update depth exceeded".
    if (query.data && !cachedProject) replaceCurrentProject(query.data);
  }, [cachedProject, query.data, replaceCurrentProject]);

  return {
    project: cachedProject ?? query.data,
    isLoading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : undefined,
    retry: query.refetch,
  };
}
