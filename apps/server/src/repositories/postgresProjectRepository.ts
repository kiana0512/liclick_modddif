import { isProjectRevision } from '@liclick/contracts';
import { Pool, type PoolClient } from 'pg';
import type { ProjectSummary, WorkspaceProject } from '../types/project.js';
import {
  createInitialProjectDocument,
  prepareProjectDocumentForSave,
  ProjectSaveConflictError,
  resolveProjectAssetUrl,
  resolveProjectAssets,
  type SaveProjectOptions,
} from '../services/projectFileService.js';
import { createId, slugify } from '../services/workspaceService.js';
import type { ProjectRepository } from './projectRepository.js';

export type ProjectSqlResult<Row extends Record<string, unknown>> = {
  rows: Row[];
  affectedRows: number;
};

export type ProjectSqlConnection = {
  query<Row extends Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<ProjectSqlResult<Row>>;
};

export type ProjectSqlDatabase = ProjectSqlConnection & {
  transaction<T>(operation: (connection: ProjectSqlConnection) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
};

function wrapPgConnection(connection: Pool | PoolClient): ProjectSqlConnection {
  return {
    async query<Row extends Record<string, unknown>>(text: string, params: unknown[] = []) {
      const result = await connection.query(text, params);
      return {
        rows: result.rows as Row[],
        affectedRows: result.rowCount ?? 0,
      };
    },
  };
}

export function createPgProjectSqlDatabase(connectionString: string): ProjectSqlDatabase {
  const pool = new Pool({
    connectionString,
    max: Number(process.env.LICLICK_POSTGRES_POOL_MAX ?? 20),
    idleTimeoutMillis: Number(process.env.LICLICK_POSTGRES_IDLE_TIMEOUT_MS ?? 30_000),
    connectionTimeoutMillis: Number(process.env.LICLICK_POSTGRES_CONNECT_TIMEOUT_MS ?? 5_000),
  });
  const poolConnection = wrapPgConnection(pool);
  return {
    ...poolConnection,
    async transaction<T>(operation: (connection: ProjectSqlConnection) => Promise<T>) {
      const client = await pool.connect();
      const connection = wrapPgConnection(client);
      try {
        await client.query('BEGIN');
        const result = await operation(connection);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

type ProjectDocumentRow = {
  user_id: string;
  project_id: string;
  slug: string;
  document_json: WorkspaceProject;
  revision_id: string;
};

function projectRevision(project: WorkspaceProject) {
  if (!isProjectRevision(project.revision)) {
    throw new Error(`Project ${project.id} is missing its authoritative revision.`);
  }
  return project.revision;
}

function cloudSlug(projectId: string, name: string) {
  const safeId = projectId.replace(/[^a-zA-Z0-9_-]/g, '').slice(-8) || createId('project').slice(-8);
  return `${slugify(name || 'Untitled Project')}-${safeId}`;
}

async function selectProject(
  connection: ProjectSqlConnection,
  userId: string,
  projectId: string,
  forUpdate = false,
) {
  const result = await connection.query<ProjectDocumentRow>(
    `SELECT user_id, project_id, slug, document_json, revision_id
       FROM project_documents
      WHERE user_id = $1 AND project_id = $2 AND deleted_at IS NULL${forUpdate ? ' FOR UPDATE' : ''}`,
    [userId, projectId],
  );
  return result.rows[0];
}

async function insertProject(
  connection: ProjectSqlConnection,
  userId: string,
  slug: string,
  project: WorkspaceProject,
) {
  const revision = projectRevision(project);
  await connection.query(
    `INSERT INTO project_documents (
       user_id, project_id, slug, name, folder_id, document_json,
       revision_id, revision_number, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::timestamptz, $10::timestamptz)`,
    [
      userId,
      project.id,
      slug,
      project.name,
      project.folderId ?? null,
      project,
      revision.id,
      revision.number,
      project.createdAt,
      project.updatedAt,
    ],
  );
  await insertRevision(connection, userId, project);
}

async function insertRevision(
  connection: ProjectSqlConnection,
  userId: string,
  project: WorkspaceProject,
) {
  const revision = projectRevision(project);
  await connection.query(
    `INSERT INTO project_document_revisions (
       user_id, project_id, revision_id, revision_number,
       parent_revision_id, document_json, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)`,
    [
      userId,
      project.id,
      revision.id,
      revision.number,
      revision.parentRevisionId ?? null,
      project,
      revision.savedAt,
    ],
  );
}

async function findCommandReceipt(
  connection: ProjectSqlConnection,
  userId: string,
  projectId: string,
  commandId: string | undefined,
) {
  if (!commandId) return undefined;
  const result = await connection.query<{
    command_sha256: string;
    result_revision_id: string;
  }>(
    `SELECT command_sha256, result_revision_id
       FROM project_command_receipts
      WHERE user_id = $1 AND project_id = $2 AND command_id = $3`,
    [userId, projectId, commandId],
  );
  return result.rows[0];
}

async function insertCommandReceipt(
  connection: ProjectSqlConnection,
  userId: string,
  project: WorkspaceProject,
  options: SaveProjectOptions,
) {
  if (!options.commandId || !options.commandSha256) return;
  const revision = projectRevision(project);
  await connection.query(
    `INSERT INTO project_command_receipts (
       user_id, project_id, command_id, command_sha256,
       result_revision_id, applied_at
     ) VALUES ($1, $2, $3, $4, $5, $6::timestamptz)`,
    [
      userId,
      project.id,
      options.commandId,
      options.commandSha256,
      revision.id,
      revision.savedAt,
    ],
  );
}

function assertCommandReceiptMatches(
  receipt: { command_sha256: string } | undefined,
  options: SaveProjectOptions,
  project: WorkspaceProject,
) {
  if (!receipt) return false;
  if (receipt.command_sha256 !== options.commandSha256) {
    throw new ProjectSaveConflictError(
      'A different project command already used this command id.',
      'PROJECT_COMMAND_ID_REUSE_CONFLICT',
      isProjectRevision(project.revision) ? project.revision : undefined,
    );
  }
  return true;
}

async function updateProjectDocument(
  connection: ProjectSqlConnection,
  userId: string,
  slug: string,
  previousRevisionId: string,
  project: WorkspaceProject,
) {
  const revision = projectRevision(project);
  const result = await connection.query(
    `UPDATE project_documents
        SET name = $4,
            folder_id = $5,
            document_json = $6::jsonb,
            revision_id = $7,
            revision_number = $8,
            updated_at = $9::timestamptz
      WHERE user_id = $1
        AND project_id = $2
        AND slug = $3
        AND revision_id = $10
        AND deleted_at IS NULL`,
    [
      userId,
      project.id,
      slug,
      project.name,
      project.folderId ?? null,
      project,
      revision.id,
      revision.number,
      project.updatedAt,
      previousRevisionId,
    ],
  );
  if (result.affectedRows !== 1) {
    throw new ProjectSaveConflictError(
      'The project changed on another server instance. Reload and retry the save.',
      'PROJECT_REVISION_CONFLICT',
      revision,
    );
  }
  await insertRevision(connection, userId, project);
}

function loadedProject(userId: string, row: ProjectDocumentRow) {
  return {
    project: resolveProjectAssets(userId, row.slug, row.document_json),
    slug: row.slug,
  };
}

export function createPostgresProjectRepository(database: ProjectSqlDatabase): ProjectRepository {
  async function load(userId: string, projectId: string) {
    const row = await selectProject(database, userId, projectId);
    return row ? loadedProject(userId, row) : undefined;
  }

  async function findSlug(userId: string, projectId: string) {
    const row = await selectProject(database, userId, projectId);
    return row?.slug;
  }

  async function save(
    userId: string,
    projectId: string,
    inputProject: WorkspaceProject,
    options: SaveProjectOptions = {},
  ) {
    return database.transaction(async (connection) => {
      const existingRow = await selectProject(connection, userId, projectId, true);
      const slug = existingRow?.slug ?? cloudSlug(projectId, inputProject.name);
      if (existingRow) {
        const receipt = await findCommandReceipt(
          connection,
          userId,
          projectId,
          options.commandId,
        );
        if (assertCommandReceiptMatches(receipt, options, existingRow.document_json)) {
          return loadedProject(userId, existingRow);
        }
      }
      const project = prepareProjectDocumentForSave({
        userId,
        slug,
        projectId,
        inputProject,
        existingProject: existingRow?.document_json,
        options,
        workspaceMode: 'cloud-server',
      });
      if (existingRow) {
        await updateProjectDocument(
          connection,
          userId,
          slug,
          existingRow.revision_id,
          project,
        );
      } else {
        await insertProject(connection, userId, slug, project);
      }
      await insertCommandReceipt(connection, userId, project, options);
      return { project: resolveProjectAssets(userId, slug, project), slug };
    });
  }

  async function update(
    userId: string,
    projectId: string,
    updater: (project: WorkspaceProject) => WorkspaceProject,
    expectedRevisionId?: string,
    command?: { id: string; sha256: string },
  ) {
    return database.transaction(async (connection) => {
      const existingRow = await selectProject(connection, userId, projectId, true);
      if (!existingRow) return undefined;
      const options: SaveProjectOptions = {
        expectedRevisionId,
        revisionSource: 'explicit',
        commandId: command?.id,
        commandSha256: command?.sha256,
      };
      const receipt = await findCommandReceipt(
        connection,
        userId,
        projectId,
        options.commandId,
      );
      if (assertCommandReceiptMatches(receipt, options, existingRow.document_json)) {
        return loadedProject(userId, existingRow);
      }
      const project = prepareProjectDocumentForSave({
        userId,
        slug: existingRow.slug,
        projectId,
        inputProject: updater(existingRow.document_json),
        existingProject: existingRow.document_json,
        options,
        workspaceMode: 'cloud-server',
      });
      await updateProjectDocument(
        connection,
        userId,
        existingRow.slug,
        existingRow.revision_id,
        project,
      );
      await insertCommandReceipt(connection, userId, project, options);
      return { project: resolveProjectAssets(userId, existingRow.slug, project), slug: existingRow.slug };
    });
  }

  return {
    async create(userId, input) {
      const now = new Date().toISOString();
      const id = createId('project');
      const name = input.name?.trim() || 'Untitled Project';
      const slug = cloudSlug(id, name);
      const project = createInitialProjectDocument({
        id,
        name,
        folderId: input.folderId,
        slug,
        now,
        workspaceMode: 'cloud-server',
      });
      await database.transaction((connection) => insertProject(connection, userId, slug, project));
      return { project, slug };
    },
    async delete(userId, projectId) {
      return database.transaction(async (connection) => {
        const row = await selectProject(connection, userId, projectId, true);
        if (!row) return undefined;
        const deletedAt = new Date().toISOString();
        await connection.query(
          `UPDATE project_documents
              SET deleted_at = $3::timestamptz, updated_at = $3::timestamptz
            WHERE user_id = $1 AND project_id = $2 AND deleted_at IS NULL`,
          [userId, projectId, deletedAt],
        );
        return {
          deleted: true as const,
          projectId,
          slug: row.slug,
          trashSlug: `database:${row.slug}:${Date.parse(deletedAt)}`,
        };
      });
    },
    async duplicate(userId, projectId) {
      return database.transaction(async (connection) => {
        const row = await selectProject(connection, userId, projectId, true);
        if (!row) return undefined;
        const id = createId('project');
        const now = new Date().toISOString();
        const name = `${row.document_json.name} Copy`;
        const slug = cloudSlug(id, name);
        const project: WorkspaceProject = {
          ...row.document_json,
          id,
          name,
          createdAt: now,
          updatedAt: now,
          lastSavedAt: now,
          workspaceName: slug,
          workspaceMode: 'cloud-server',
          dirty: false,
          revision: createInitialProjectDocument({ id, name, slug, now }).revision,
          appliedCommands: [],
        };
        await insertProject(connection, userId, slug, project);
        return { project: resolveProjectAssets(userId, slug, project), slug };
      });
    },
    findSlug,
    async list(userId): Promise<ProjectSummary[]> {
      const result = await database.query<{
        slug: string;
        document_json: WorkspaceProject;
      }>(
        `SELECT slug, document_json
           FROM project_documents
          WHERE user_id = $1 AND deleted_at IS NULL
          ORDER BY updated_at DESC`,
        [userId],
      );
      return result.rows.map(({ slug, document_json: project }) => ({
        id: project.id,
        name: project.name,
        folderId: project.folderId ?? null,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        thumbnail: project.thumbnail
          ? resolveProjectAssetUrl(userId, slug, project.thumbnail)
          : '',
        local: false,
        slug,
        status: 'cloud',
        revision: isProjectRevision(project.revision) ? project.revision : undefined,
      }));
    },
    load,
    move(userId, projectId, folderId, expectedRevisionId, command) {
      return update(
        userId,
        projectId,
        (project) => ({ ...project, folderId }),
        expectedRevisionId,
        command,
      );
    },
    async moveFolderProjectsToRoot(userId, folderId) {
      const projects = await this.list(userId);
      const matchingProjects = projects.filter((project) => project.folderId === folderId);
      await Promise.all(
        matchingProjects.map((project) =>
          this.move(userId, project.id, null, project.revision?.id),
        ),
      );
      return matchingProjects.length;
    },
    rename(userId, projectId, name, expectedRevisionId, command) {
      const nextName = name.trim();
      if (!nextName) return Promise.resolve(undefined);
      return update(
        userId,
        projectId,
        (project) => ({ ...project, name: nextName }),
        expectedRevisionId,
        command,
      );
    },
    save,
  };
}
