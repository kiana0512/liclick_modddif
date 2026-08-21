import {
  createProject,
  deleteProject,
  duplicateProject,
  findProjectSlug,
  listProjects,
  loadProject,
  moveProject,
  moveProjectsInFolderToRoot,
  ProjectSaveConflictError,
  renameProject,
  saveProject,
} from '../services/projectFileService.js';

/**
 * The authoritative project persistence port used by routes and domain
 * services. The current adapter is file-backed; a PostgreSQL implementation
 * must satisfy this same contract instead of creating parallel API behavior.
 */
export type ProjectRepository = {
  create: typeof createProject;
  delete: typeof deleteProject;
  duplicate: typeof duplicateProject;
  findSlug: typeof findProjectSlug;
  list: typeof listProjects;
  load: typeof loadProject;
  move: typeof moveProject;
  moveFolderProjectsToRoot: typeof moveProjectsInFolderToRoot;
  rename: typeof renameProject;
  save: typeof saveProject;
};

export const fileProjectRepository: ProjectRepository = {
  create: createProject,
  delete: deleteProject,
  duplicate: duplicateProject,
  findSlug: findProjectSlug,
  list: listProjects,
  load: loadProject,
  move: moveProject,
  moveFolderProjectsToRoot: moveProjectsInFolderToRoot,
  rename: renameProject,
  save: saveProject,
};

// The adapter selection stays centralized here. During the migration this is
// deliberately the file adapter for both runtime modes; Cloud may switch only
// after the PostgreSQL parity suite passes.
export const projectRepository: ProjectRepository = fileProjectRepository;

export { ProjectSaveConflictError };
