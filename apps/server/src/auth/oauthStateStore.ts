import crypto from 'node:crypto';

const states = new Map<string, number>();
const ttlMs = 10 * 60 * 1000;

export function createOAuthState() {
  const state = crypto.randomBytes(24).toString('base64url');
  states.set(state, Date.now() + ttlMs);
  return state;
}

export function consumeOAuthState(state: string | null) {
  if (!state) return false;
  const expiresAt = states.get(state);
  states.delete(state);
  return Boolean(expiresAt && expiresAt > Date.now());
}
