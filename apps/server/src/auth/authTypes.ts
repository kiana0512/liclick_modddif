export type AuthSource = 'dev-mock' | 'feishu-oauth';

export type AuthUser = {
  id: string;
  displayName: string;
  email?: string;
  avatarUrl?: string;
  role: string;
  status: 'active' | 'disabled';
  authSource: AuthSource;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
};

export type FeishuAccount = {
  id: string;
  userId: string;
  feishuOpenId?: string;
  feishuUnionId?: string;
  feishuUserId?: string;
  tenantKey?: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
  rawProfileJson?: string;
  createdAt: string;
  updatedAt: string;
};

export type UserSession = {
  id: string;
  userId: string;
  sessionTokenHash: string;
  source: AuthSource;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  userAgent?: string;
  ipAddress?: string;
};

export type AuthDatabase = {
  users: AuthUser[];
  feishuAccounts: FeishuAccount[];
  sessions: UserSession[];
};

export type PublicAuthUser = Pick<AuthUser, 'id' | 'displayName' | 'email' | 'avatarUrl' | 'role' | 'authSource'>;
