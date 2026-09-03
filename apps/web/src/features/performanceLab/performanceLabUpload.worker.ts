/// <reference lib="webworker" />

import { sha256Hex } from '@/utils/sha256';

export {};

type UploadKind = 'start' | 'chunk' | 'complete';

type EnqueueMessage = {
  type: 'enqueue';
  request: {
    id: string;
    sessionId: string;
    kind: UploadKind;
    url: string;
    body: Record<string, unknown>;
    order: number;
  };
};

type FlushMessage = { type: 'flush' };
type WorkerMessage = EnqueueMessage | FlushMessage;

type StoredRequest = Omit<EnqueueMessage['request'], 'body'> & {
  serializedBody: string;
  attempts: number;
  createdAtUnixMs: number;
};

const databaseName = 'li3d-performance-lab-upload-v1';
const storeName = 'requests';
const maximumRetryDelayMs = 60_000;
let processing = false;
let retryTimer: number | undefined;
let persistChain: Promise<void> = Promise.resolve();

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(storeName)) {
        const store = database.createObjectStore(storeName, { keyPath: 'id' });
        store.createIndex('order', 'order', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open upload queue.'));
  });
}

async function transaction<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
) {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const pending = database.transaction(storeName, mode);
      const request = operation(pending.objectStore(storeName));
      let result: T;
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => reject(request.error ?? new Error('Upload queue operation failed.'));
      pending.oncomplete = () => resolve(result);
      pending.onerror = () => reject(pending.error ?? new Error('Upload queue transaction failed.'));
      pending.onabort = () =>
        reject(pending.error ?? new Error('Upload queue transaction aborted.'));
    });
  } finally {
    database.close();
  }
}

function digestHex(value: string) {
  return sha256Hex(new TextEncoder().encode(value));
}

async function prepareBody(kind: UploadKind, body: Record<string, unknown>) {
  if (kind === 'chunk') {
    const payloadJson = JSON.stringify(body.payload ?? null);
    return { ...body, payloadSha256: await digestHex(payloadJson) };
  }
  if (kind === 'complete') {
    const reportJson = JSON.stringify({
      summary: body.summary ?? null,
      report: body.report ?? null,
    });
    return { ...body, reportSha256: await digestHex(reportJson) };
  }
  return body;
}

async function persistRequest(request: EnqueueMessage['request']) {
  const preparedBody = await prepareBody(request.kind, request.body);
  const stored: StoredRequest = {
    id: request.id,
    sessionId: request.sessionId,
    kind: request.kind,
    url: request.url,
    order: request.order,
    serializedBody: JSON.stringify(preparedBody),
    attempts: 0,
    createdAtUnixMs: Date.now(),
  };
  await transaction('readwrite', (store) => store.put(stored));
}

async function nextRequest() {
  const requests = await transaction<StoredRequest[]>('readonly', (store) =>
    store.index('order').getAll(undefined, 1),
  );
  return requests[0];
}

function removeRequest(id: string) {
  return transaction('readwrite', (store) => store.delete(id));
}

function updateRequest(request: StoredRequest) {
  return transaction('readwrite', (store) => store.put(request));
}

function postStatus(
  request: StoredRequest,
  state: 'uploaded' | 'retrying' | 'rejected',
  detail?: Record<string, unknown>,
) {
  self.postMessage({
    type: 'status',
    requestId: request.id,
    sessionId: request.sessionId,
    kind: request.kind,
    state,
    ...detail,
  });
}

function retryDelay(attempts: number) {
  return Math.min(maximumRetryDelayMs, 1_000 * 2 ** Math.min(attempts, 6)) + Math.random() * 400;
}

async function processQueue() {
  if (processing) return;
  processing = true;
  if (retryTimer !== undefined) {
    self.clearTimeout(retryTimer);
    retryTimer = undefined;
  }
  try {
    while (true) {
      const request = await nextRequest();
      if (!request) return;
      try {
        const response = await fetch(request.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: request.serializedBody,
        });
        const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (!response.ok) {
          const message =
            typeof payload.error === 'string'
              ? payload.error
              : `Performance upload failed: ${response.status}`;
          if ([400, 403, 404, 409, 413, 422].includes(response.status)) {
            await removeRequest(request.id);
            postStatus(request, 'rejected', { status: response.status, error: message });
            continue;
          }
          throw new Error(message);
        }
        await removeRequest(request.id);
        postStatus(request, 'uploaded', { response: payload });
      } catch (error) {
        const attempts = request.attempts + 1;
        await updateRequest({ ...request, attempts });
        const delayMs = retryDelay(attempts);
        postStatus(request, 'retrying', {
          attempts,
          delayMs,
          error: error instanceof Error ? error.message : String(error),
        });
        retryTimer = self.setTimeout(() => void processQueue(), delayMs);
        return;
      }
    }
  } finally {
    processing = false;
  }
}

self.addEventListener('message', (event: MessageEvent<WorkerMessage>) => {
  if (event.data.type === 'enqueue') {
    const request = event.data.request;
    persistChain = persistChain
      .then(() => persistRequest(request))
      .then(() => processQueue())
      .catch((error) => {
        self.postMessage({
          type: 'queue-error',
          requestId: request.id,
          sessionId: request.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    void persistChain;
    return;
  }
  void processQueue();
});

void processQueue();
