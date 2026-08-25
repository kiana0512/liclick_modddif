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
import {
  createPostgresProjectRepository,
  getSharedPgProjectSqlDatabase,
} from './postgresProjectRepository.js';

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

function selectProjectRepository(): ProjectRepository {
  if (process.env.LICLICK_PROJECT_REPOSITORY !== 'postgres') {
    return fileProjectRepository;
  }
  const connectionString = process.env.LICLICK_CLOUD_DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error(
      'LICLICK_PROJECT_REPOSITORY=postgres requires LICLICK_CLOUD_DATABASE_URL; refusing to fall back to local files.',
    );
  }
  return createPostgresProjectRepository(getSharedPgProjectSqlDatabase(connectionString));
}

// Adapter selection remains centralized so every route and domain service has
// identical behavior. Production can opt in to PostgreSQL explicitly, while
// local file workspaces remain available for isolated development.
export const projectRepository: ProjectRepository = selectProjectRepository();

export { ProjectSaveConflictError };
