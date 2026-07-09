import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { serverConfig } from '../config.js';

export async function ensureDir(directory: string) {
  await fs.mkdir(directory, { recursive: true });
}

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function writeJsonFile(filePath: string, data: unknown) {
  await ensureDir(path.dirname(filePath));
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fs.rename(temporaryPath, filePath);
}

export function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'untitled-project';
}

export function createId(prefix: string) {
  return `${prefix}-${randomUUID()}`;
}

export function getProjectsDir() {
  return path.join(serverConfig.workspaceDir, 'projects');
}

export function getUsersDir() {
  return path.join(serverConfig.workspaceDir, 'users');
}

export function getUserDir(userId: string) {
  return path.join(getUsersDir(), userId);
}

export function getUserProjectsDir(userId: string) {
  return path.join(getUserDir(userId), 'projects');
}

export function getUserTrashProjectsDir(userId: string) {
  return path.join(getUserDir(userId), 'trash', 'projects');
}

export function getUserProjectDir(userId: string, slug: string) {
  return path.join(getUserProjectsDir(userId), slug);
}

export function getTrashProjectsDir() {
  return path.join(serverConfig.workspaceDir, 'trash', 'projects');
}

export function getProjectDir(slug: string) {
  return path.join(getProjectsDir(), slug);
}

export function getFoldersFile() {
  return path.join(serverConfig.workspaceDir, 'folders.json');
}

export function getUserFoldersFile(userId: string) {
  return path.join(getUserDir(userId), 'folders.json');
}

export function getAuthFile() {
  return path.join(serverConfig.workspaceDir, 'auth.json');
}

export function getRecentProjectsFile() {
  return path.join(serverConfig.workspaceDir, 'recent-projects.json');
}

export function getSettingsFile() {
  return path.join(serverConfig.workspaceDir, 'settings.json');
}

function normalizeArrayFileValue(value: unknown, wrappedKey: string) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const wrappedValue = (value as Record<string, unknown>)[wrappedKey];
    if (Array.isArray(wrappedValue)) return wrappedValue;
    return [value];
  }
  return [];
}

export async function initializeWorkspace() {
  await ensureDir(getProjectsDir());
  await ensureDir(getUsersDir());
  await writeJsonFile(
    getFoldersFile(),
    normalizeArrayFileValue(await readJsonFile<unknown>(getFoldersFile(), []), 'folders'),
  );
  await writeJsonFile(
    getRecentProjectsFile(),
    normalizeArrayFileValue(await readJsonFile<unknown>(getRecentProjectsFile(), []), 'projects'),
  );
  await writeJsonFile(
    getSettingsFile(),
    await readJsonFile(getSettingsFile(), {
      workspaceVersion: '0.6.0',
      createdAt: new Date().toISOString(),
    }),
  );
  await writeJsonFile(
    getAuthFile(),
    await readJsonFile(getAuthFile(), {
      users: [],
      feishuAccounts: [],
      sessions: [],
    }),
  );
}

export function toWorkspaceUrl(relativePath: string) {
  const baseUrl = serverConfig.publicWorkspaceUrl ?? `http://127.0.0.1:${serverConfig.port}`;
  return `${baseUrl.replace(/\/$/, '')}/workspace/${relativePath.replaceAll('\\', '/')}`;
}
