import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ProjectCommand, ProjectCommandKind, ProjectRevision } from '@liclick/contracts';
import {
  projectRepository,
  ProjectSaveConflictError,
} from '../repositories/projectRepository.js';
import type { WorkspaceProject } from '../types/project.js';
import {
  ensureDir,
  getUserProjectDir,
  readJsonFile,
  writeJsonFile,
} from './workspaceService.js';

type ProjectCommandReceipt = {
  schemaVersion: 1;
  commandId: string;
  projectId: string;
  kind: ProjectCommandKind;
  status: 'applied';
  revision: ProjectRevision;
  appliedAt: string;
  actorUserId: string;
  commandSha256: string;
};

const projectCommandTails = new Map<string, Promise<void>>();

async function runSerializedProjectCommand<T>(key: string, operation: () => Promise<T>) {
  const previous = projectCommandTails.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  projectCommandTails.set(key, tail);
  try {
    return await current;
  } finally {
    if (projectCommandTails.get(key) === tail) projectCommandTails.delete(key);
  }
}

function receiptPath(userId: string, slug: string, commandId: string) {
  return path.join(getUserProjectDir(userId, slug), '.commands', `${commandId}.json`);
}

function commandSha256(command: ProjectCommand) {
  return createHash('sha256').update(JSON.stringify(command)).digest('hex');
}

async function writeReceipt(
  userId: string,
  slug: string,
  command: ProjectCommand,
  revision: ProjectRevision,
  sha256: string,
) {
  const filePath = receiptPath(userId, slug, command.id);
  await ensureDir(path.dirname(filePath));
  const receipt: ProjectCommandReceipt = {
    schemaVersion: 1,
    commandId: command.id,
    projectId: command.projectId,
    kind: command.kind,
    status: 'applied',
    revision,
    appliedAt: new Date().toISOString(),
    actorUserId: userId,
    commandSha256: sha256,
  };
  await writeJsonFile(filePath, receipt);
  return receipt;
}

async function commandReplayResult(
  userId: string,
  command: ProjectCommand,
) {
  const result = await projectRepository.load(userId, command.projectId);
  if (!result) return undefined;
  return {
    ...result,
    command: {
      id: command.id,
      kind: command.kind,
      replayed: true,
      revision: result.project.revision,
    },
  };
}

export async function executeProjectCommand(userId: string, command: ProjectCommand) {
  return runSerializedProjectCommand(`${userId}:${command.projectId}`, async () => {
    const sha256 = commandSha256(command);
    const slug = await projectRepository.findSlug(userId, command.projectId);
    if (!slug) return undefined;

    const existingReceipt = await readJsonFile<ProjectCommandReceipt | undefined>(
      receiptPath(userId, slug, command.id),
      undefined,
    );
    if (existingReceipt?.status === 'applied') {
      if (existingReceipt.commandSha256 !== sha256) {
        throw new ProjectSaveConflictError(
          'A different project command already used this command id.',
          'PROJECT_COMMAND_ID_REUSE_CONFLICT',
          existingReceipt.revision,
        );
      }
      return commandReplayResult(userId, command);
    }

    const loaded = await projectRepository.load(userId, command.projectId);
    if (!loaded) return undefined;
    const appliedCommand = loaded.project.appliedCommands?.find(
      (candidate) => candidate.id === command.id,
    );
    if (appliedCommand) {
      if (appliedCommand.sha256 !== sha256) {
        throw new ProjectSaveConflictError(
          'A different project command already used this command id.',
          'PROJECT_COMMAND_ID_REUSE_CONFLICT',
          loaded.project.revision,
        );
      }
      if (loaded.project.revision) {
        await writeReceipt(userId, slug, command, loaded.project.revision, sha256);
      }
      return commandReplayResult(userId, command);
    }

    let result:
      | Awaited<ReturnType<typeof projectRepository.save>>
      | Awaited<ReturnType<typeof projectRepository.rename>>
      | Awaited<ReturnType<typeof projectRepository.move>>;
    if (command.kind === 'replace-project-document') {
      result = await projectRepository.save(
        userId,
        command.projectId,
        command.payload.document as WorkspaceProject,
        {
          commandId: command.id,
          commandSha256: sha256,
          expectedRevisionId: command.expectedRevisionId,
          revisionSource: 'explicit',
        },
      );
    } else if (command.kind === 'rename-project') {
      result = await projectRepository.rename(
        userId,
        command.projectId,
        command.payload.name,
        command.expectedRevisionId,
        { id: command.id, sha256 },
      );
    } else {
      result = await projectRepository.move(
        userId,
        command.projectId,
        command.payload.folderId,
        command.expectedRevisionId,
        { id: command.id, sha256 },
      );
    }
    if (!result?.project.revision) return result;
    await writeReceipt(userId, result.slug, command, result.project.revision, sha256);
    return {
      ...result,
      command: {
        id: command.id,
        kind: command.kind,
        replayed: false,
        revision: result.project.revision,
      },
    };
  });
}
