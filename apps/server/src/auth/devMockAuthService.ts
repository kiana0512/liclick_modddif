import type { IncomingMessage, ServerResponse } from 'node:http';
import { createSession, upsertUser } from './sessionService.js';

export async function loginDevUser(
  input: { displayName?: string; email?: string },
  request: IncomingMessage,
  response: ServerResponse,
) {
  const displayName = input.displayName?.trim() || 'Liclick Dev User';
  const email = input.email?.trim() || 'dev@liclick.local';
  const user = await upsertUser({
    displayName,
    email,
    authSource: 'dev-mock',
  });
  await createSession(user.id, 'dev-mock', request, response);
  return user;
}
