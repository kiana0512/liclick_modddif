import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const transientReplaceErrorCodes = new Set([
  'UNKNOWN',
  'EPERM',
  'EBUSY',
  'EACCES',
  'EMFILE',
  'ENFILE',
]);

const defaultRetryDelaysMs = [25, 50, 100, 200, 400, 800] as const;

type AtomicFileData = string | Uint8Array;

type AtomicWriteOptions = {
  renameFile?: (source: string, destination: string) => Promise<void>;
  retryDelaysMs?: readonly number[];
};

function isTransientReplaceError(error: unknown) {
  const code = (error as NodeJS.ErrnoException).code;
  return Boolean(code && transientReplaceErrorCodes.has(code));
}

async function delay(milliseconds: number) {
  if (milliseconds <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function writeTemporaryFile(filePath: string, data: AtomicFileData) {
  if (typeof data === 'string') {
    await fs.writeFile(filePath, data, 'utf8');
    return;
  }
  await fs.writeFile(filePath, data);
}

/**
 * Replaces a file atomically while tolerating short-lived Windows file locks.
 * The previous destination is never deleted first, so a failed replacement
 * cannot destroy the last valid copy.
 */
export async function writeFileAtomically(
  filePath: string,
  data: AtomicFileData,
  options: AtomicWriteOptions = {},
) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  const retryDelaysMs = options.retryDelaysMs ?? defaultRetryDelaysMs;
  const renameFile = options.renameFile ?? fs.rename;

  await writeTemporaryFile(temporaryPath, data);
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await renameFile(temporaryPath, filePath);
        return;
      } catch (error) {
        const retryDelay = retryDelaysMs[attempt];
        if (!isTransientReplaceError(error) || retryDelay === undefined) throw error;
        await delay(retryDelay);
      }
    }
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
