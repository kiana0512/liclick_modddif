import type { WorkspaceFolder } from '../types/folder.js';
import { createId, getFoldersFile, readJsonFile, writeJsonFile } from './workspaceService.js';
import { moveProjectsInFolderToRoot } from './projectFileService.js';

let folderWriteQueue = Promise.resolve();

function isWorkspaceFolder(value: unknown): value is WorkspaceFolder {
  if (!value || typeof value !== 'object') return false;
  const folder = value as Partial<WorkspaceFolder>;
  return (
    typeof folder.id === 'string' &&
    typeof folder.name === 'string' &&
    typeof folder.createdAt === 'string' &&
    typeof folder.updatedAt === 'string'
  );
}

function normalizeFolders(value: unknown) {
  if (Array.isArray(value)) {
    return value.filter(isWorkspaceFolder).map((folder, index) => ({
      ...folder,
      order: Number.isFinite(folder.order) ? folder.order : index,
    }));
  }
  if (isWorkspaceFolder(value)) {
    return [{ ...value, order: Number.isFinite(value.order) ? value.order : 0 }];
  }
  if (value && typeof value === 'object' && Array.isArray((value as { folders?: unknown }).folders)) {
    return ((value as { folders: unknown[] }).folders).filter(isWorkspaceFolder).map((folder, index) => ({
      ...folder,
      order: Number.isFinite(folder.order) ? folder.order : index,
    }));
  }
  return [];
}

export async function listFolders() {
  const rawFolders = await readJsonFile<unknown>(getFoldersFile(), []);
  const folders = normalizeFolders(rawFolders);
  if (!Array.isArray(rawFolders) || folders.length !== rawFolders.length) {
    await writeJsonFile(getFoldersFile(), folders);
  }
  return folders;
}

export async function createFolder(name: string) {
  const task = folderWriteQueue.then(async () => {
    const folders = await listFolders();
    const now = new Date().toISOString();
    const folder: WorkspaceFolder = {
      id: createId('folder'),
      name: name.trim() || 'New Folder',
      createdAt: now,
      updatedAt: now,
      order: folders.length,
    };
    await writeJsonFile(getFoldersFile(), [...folders, folder]);
    return folder;
  });
  folderWriteQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

export async function renameFolder(folderId: string, name: string) {
  const task = folderWriteQueue.then(async () => {
    const nextName = name.trim();
    if (!nextName) return undefined;
    const folders = await listFolders();
    const now = new Date().toISOString();
    const folder = folders.find((item) => item.id === folderId);
    if (!folder) return undefined;
    const nextFolders = folders.map((item) =>
      item.id === folderId ? { ...item, name: nextName, updatedAt: now } : item,
    );
    await writeJsonFile(getFoldersFile(), nextFolders);
    return nextFolders.find((item) => item.id === folderId);
  });
  folderWriteQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

export async function deleteFolder(folderId: string) {
  const task = folderWriteQueue.then(async () => {
    const folders = await listFolders();
    const folder = folders.find((item) => item.id === folderId);
    if (!folder) return undefined;
    const movedProjectCount = await moveProjectsInFolderToRoot(folderId);
    await writeJsonFile(
      getFoldersFile(),
      folders
        .filter((item) => item.id !== folderId)
        .map((item, index) => ({ ...item, order: index })),
    );
    return { folder, movedProjectCount };
  });
  folderWriteQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}
