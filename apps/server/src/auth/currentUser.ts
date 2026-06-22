import type { IncomingMessage } from 'node:http';
import type { AuthUser, PublicAuthUser } from './authTypes.js';

const currentUsers = new WeakMap<IncomingMessage, AuthUser>();

export function setCurrentUser(request: IncomingMessage, user: AuthUser) {
  currentUsers.set(request, user);
}

export function getCurrentUser(request: IncomingMessage) {
  return currentUsers.get(request);
}

export function toPublicUser(user: AuthUser): PublicAuthUser {
  return {
    id: user.id,
    displayName: user.displayName,
    email: user.email,
    avatarUrl: user.avatarUrl,
    role: user.role,
    authSource: user.authSource,
  };
}
