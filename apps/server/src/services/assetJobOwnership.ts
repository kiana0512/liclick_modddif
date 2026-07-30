import path from 'node:path';
import { serverConfig } from '../config.js';
import { readJsonFile, writeJsonFile } from './workspaceService.js';

type AssetJobOwner = {
  userId: string;
  createdAt: string;
};

type AssetJobOwnershipDatabase = {
  jobs: Record<string, AssetJobOwner>;
};

const ownershipFile = path.join(
  serverConfig.workspaceDir,
  'config',
  'asset-processing-jobs.json',
);
let cachedDatabase: AssetJobOwnershipDatabase | undefined;
let writeQueue = Promise.resolve();

async function readOwnershipDatabase() {
  if (!cachedDatabase) {
    const database = await readJsonFile<AssetJobOwnershipDatabase>(ownershipFile, { jobs: {} });
    cachedDatabase = {
      jobs: database.jobs && typeof database.jobs === 'object' ? database.jobs : {},
    };
  }
  return cachedDatabase;
}

export async function registerAssetJobOwner(jobId: string, userId: string) {
  const normalizedJobId = jobId.trim();
  if (!normalizedJobId) throw new Error('Asset service did not return a job id.');

  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    const database = await readOwnershipDatabase();
    const current = database.jobs[normalizedJobId];
    if (current && current.userId !== userId) {
      throw new Error('Asset job is already registered to another user.');
    }
    const nextDatabase: AssetJobOwnershipDatabase = {
      jobs: {
        ...database.jobs,
        [normalizedJobId]: current ?? {
          userId,
          createdAt: new Date().toISOString(),
        },
      },
    };
    await writeJsonFile(ownershipFile, nextDatabase);
    cachedDatabase = nextDatabase;
  });

  await writeQueue;
}

export async function userOwnsAssetJob(jobId: string, userId: string) {
  const database = await readOwnershipDatabase();
  return database.jobs[jobId]?.userId === userId;
}
