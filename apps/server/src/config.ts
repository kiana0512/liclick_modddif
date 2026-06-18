import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(serverDir, '..', '..', '..');

export const serverConfig = {
  port: Number(process.env.LICLICK_WORKSPACE_PORT ?? 4517),
  workspaceDir: path.resolve(process.env.LICLICK_WORKSPACE_DIR ?? path.join(repoRoot, 'workspace')),
  publicWorkspaceUrl: process.env.LICLICK_PUBLIC_WORKSPACE_URL,
  repoRoot,
};
