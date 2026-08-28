import fs from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceProject } from '../types/project.js';
import { ensureDir, writeJsonFile } from './workspaceService.js';

const maxAutosaves = 5;

type AutosaveQueueState = {
  running: boolean;
  pending?: WorkspaceProject;
};

const autosaveQueues = new Map<string, AutosaveQueueState>();

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

/**
 * The primary project document is already durable before this is called.
 * Archive snapshots run in the background and collapse bursts to the newest
 * document so an autosave cannot hold Ctrl+S open for a second full disk write.
 */
export function queueAutosave(projectDir: string, project: WorkspaceProject) {
  const state = autosaveQueues.get(projectDir) ?? { running: false };
  state.pending = project;
  autosaveQueues.set(projectDir, state);
  if (state.running) return;
  state.running = true;

  void (async () => {
    try {
      while (state.pending) {
        const latest = state.pending;
        state.pending = undefined;
        await writeAutosave(projectDir, latest);
      }
    } catch (error) {
      console.error('[Liclick 3D Texture] Background autosave snapshot failed.', error);
    } finally {
      state.running = false;
      if (state.pending) {
        queueAutosave(projectDir, state.pending);
      } else if (autosaveQueues.get(projectDir) === state) {
        autosaveQueues.delete(projectDir);
      }
    }
  })();
}
