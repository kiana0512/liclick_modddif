import type { AuthUser } from './authTypes.js';

export function canReadAllPerformanceSessions(user: AuthUser, emails: readonly string[]) {
  return user.status === 'active' && user.authSource === 'feishu-oauth' &&
    Boolean(user.email && emails.includes(user.email.trim().toLowerCase())) &&
    ['maintainer', 'admin', 'owner', 'superadmin'].includes(user.role.toLowerCase());
}
