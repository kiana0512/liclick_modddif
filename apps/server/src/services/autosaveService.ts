import fs from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceProject } from '../types/project.js';
import { ensureDir, writeJsonFile } from './workspaceService.js';

const maxAutosaves = 5;

export async function writeAutosave(projectDir: string, project: WorkspaceProject) {
  const autosaveDir = path.join(projectDir, 'autosave');
  await ensureDir(autosaveDir);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  await writeJsonFile(path.join(autosaveDir, `autosave-${timestamp}.liclick.json`), project);

  const autosaves = (await fs.readdir(autosaveDir))
    .filter((name) => name.endsWith('.liclick.json'))
    .sort();
  const oldAutosaves = autosaves.slice(0, Math.max(0, autosaves.length - maxAutosaves));
  await Promise.all(oldAutosaves.map((name) => fs.rm(path.join(autosaveDir, name), { force: true })));
}
