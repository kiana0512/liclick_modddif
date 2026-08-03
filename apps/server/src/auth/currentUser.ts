import type { AuthUser, PublicAuthUser } from './authTypes.js';

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
