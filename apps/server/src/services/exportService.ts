import { loadProject } from './projectFileService.js';

export async function exportProjectPackage(userId: string, projectId: string) {
  const loaded = await loadProject(userId, projectId);
  if (!loaded) return undefined;
  return {
    status: 'coming-soon',
    filename: `${loaded.slug}.liclick3d`,
    message: '.liclick3d zip package export is not implemented yet.',
  };
}
