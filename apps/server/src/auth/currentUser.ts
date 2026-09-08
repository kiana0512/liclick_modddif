import type { AuthUser, PublicAuthUser } from './authTypes.js';
import { serverConfig } from '../config.js';
import { canReadAllPerformanceSessions } from './performanceLabAccess.js';

export function toPublicUser(user: AuthUser): PublicAuthUser {
  return {
    id: user.id,
    displayName: user.displayName,
    email: user.email,
    avatarUrl: user.avatarUrl,
    role: user.role,
    authSource: user.authSource,
    performanceLabAdmin: serverConfig.performanceLabEnabled &&
      canReadAllPerformanceSessions(user, serverConfig.performanceLabMaintainerEmails),
  };
}
