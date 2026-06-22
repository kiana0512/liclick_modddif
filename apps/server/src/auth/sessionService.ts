import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { serverConfig } from '../config.js';
import {
  createId,
  ensureDir,
  getAuthFile,
  getUserDir,
  getUserFoldersFile,
  getUserProjectsDir,
  getUserTrashProjectsDir,
  readJsonFile,
  writeJsonFile,
} from '../services/workspaceService.js';
import type { AuthDatabase, AuthSource, AuthUser, UserSession } from './authTypes.js';

const emptyAuthDatabase: AuthDatabase = {
  users: [],
  feishuAccounts: [],
  sessions: [],
};

let writeQueue = Promise.resolve();

export function parseCookies(request: IncomingMessage) {
  const header = request.headers.cookie ?? '';
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        if (index === -1) return [part, ''];
        return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

export function getSessionCookie(request: IncomingMessage) {
  return parseCookies(request)[serverConfig.sessionCookieName];
}

export function hashSessionToken(token: string) {
  return crypto
    .createHmac('sha256', serverConfig.sessionSecret)
    .update(token)
    .digest('hex');
}

export async function readAuthDatabase() {
  const database = await readJsonFile<AuthDatabase>(getAuthFile(), emptyAuthDatabase);
  return {
    users: Array.isArray(database.users) ? database.users : [],
    feishuAccounts: Array.isArray(database.feishuAccounts) ? database.feishuAccounts : [],
    sessions: Array.isArray(database.sessions) ? database.sessions : [],
  };
}

async function updateAuthDatabase(updater: (database: AuthDatabase) => AuthDatabase | Promise<AuthDatabase>) {
  const task = writeQueue.then(async () => {
    const database = await readAuthDatabase();
    const nextDatabase = await updater(database);
    await writeJsonFile(getAuthFile(), nextDatabase);
    return nextDatabase;
  });
  writeQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

export async function ensureUserWorkspace(userId: string) {
  await ensureDir(getUserProjectsDir(userId));
  await ensureDir(getUserTrashProjectsDir(userId));
  await writeJsonFile(getUserFoldersFile(userId), await readJsonFile(getUserFoldersFile(userId), []));
  const settingsFile = path.join(getUserDir(userId), 'user-settings.json');
  await writeJsonFile(
    settingsFile,
    await readJsonFile(settingsFile, {
      createdAt: new Date().toISOString(),
    }),
  );
}

function sessionCookieValue(token: string, maxAgeSeconds: number) {
  const parts = [
    `${encodeURIComponent(serverConfig.sessionCookieName)}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (serverConfig.sessionCookieSecure) parts.push('Secure');
  return parts.join('; ');
}

export function setSessionCookie(response: ServerResponse, token: string) {
  const maxAgeSeconds = Math.max(1, serverConfig.sessionMaxAgeDays) * 24 * 60 * 60;
  response.setHeader('set-cookie', sessionCookieValue(token, maxAgeSeconds));
}

export function clearSessionCookie(response: ServerResponse) {
  response.setHeader('set-cookie', sessionCookieValue('', 0));
}

export async function createSession(
  userId: string,
  source: AuthSource,
  request: IncomingMessage,
  response: ServerResponse,
) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + serverConfig.sessionMaxAgeDays * 24 * 60 * 60 * 1000);
  const session: UserSession = {
    id: createId('session'),
    userId,
    sessionTokenHash: hashSessionToken(token),
    source,
    expiresAt: expiresAt.toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    userAgent: request.headers['user-agent'],
    ipAddress: request.socket.remoteAddress,
  };
  await updateAuthDatabase((database) => ({
    ...database,
    sessions: [...database.sessions.filter((item) => new Date(item.expiresAt).getTime() > now.getTime()), session],
  }));
  setSessionCookie(response, token);
  return session;
}

export async function verifySession(token?: string): Promise<AuthUser | undefined> {
  if (!token) return undefined;
  const database = await readAuthDatabase();
  const tokenHash = hashSessionToken(token);
  const session = database.sessions.find((item) => item.sessionTokenHash === tokenHash);
  if (!session || new Date(session.expiresAt).getTime() <= Date.now()) return undefined;
  const user = database.users.find((item) => item.id === session.userId);
  if (!user || user.status !== 'active') return undefined;
  return user;
}

export async function revokeSession(token?: string) {
  if (!token) return;
  const tokenHash = hashSessionToken(token);
  await updateAuthDatabase((database) => ({
    ...database,
    sessions: database.sessions.filter((session) => session.sessionTokenHash !== tokenHash),
  }));
}

export async function upsertUser(input: {
  id?: string;
  displayName: string;
  email?: string;
  avatarUrl?: string;
  authSource: AuthSource;
}) {
  let savedUser: AuthUser | undefined;
  await updateAuthDatabase((database) => {
    const now = new Date().toISOString();
    const existing = input.email
      ? database.users.find((user) => user.email?.toLowerCase() === input.email?.toLowerCase())
      : input.id
        ? database.users.find((user) => user.id === input.id)
        : undefined;
    const user: AuthUser = existing
      ? {
          ...existing,
          displayName: input.displayName,
          email: input.email ?? existing.email,
          avatarUrl: input.avatarUrl ?? existing.avatarUrl,
          authSource: input.authSource,
          updatedAt: now,
          lastLoginAt: now,
        }
      : {
          id: input.id ?? createId('user'),
          displayName: input.displayName,
          email: input.email,
          avatarUrl: input.avatarUrl,
          role: 'user',
          status: 'active',
          authSource: input.authSource,
          createdAt: now,
          updatedAt: now,
          lastLoginAt: now,
        };
    savedUser = user;
    return {
      ...database,
      users: existing ? database.users.map((item) => (item.id === existing.id ? user : item)) : [...database.users, user],
    };
  });
  await ensureUserWorkspace(savedUser!.id);
  return savedUser!;
}
