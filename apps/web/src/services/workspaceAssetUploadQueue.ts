// WORKSPACE-ASSET-UPLOAD-QUEUE/1.0.0: shared by generation and autosave in
// this browser runtime, across projects and upload transports. No retries,
// pixel changes, or Project Command locking; only active asset I/O is bounded.
let active = 0;
const waiting: Array<() => void> = [];

export async function withWorkspaceAssetUpload<T>(task: () => Promise<T>): Promise<T> {
  if (active < 3) active++;
  else await new Promise<void>((resolve) => waiting.push(resolve));
  try {
    return await task();
  } finally {
    const next = waiting.shift();
    if (next) next(); // Transfer the permit directly; a newcomer cannot steal it.
    else active--;
  }
}
