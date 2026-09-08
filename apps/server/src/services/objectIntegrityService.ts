import { createHash } from 'node:crypto';
import { MAX_DIRECT_ASSET_BYTES } from '@liclick/contracts';

export class ObjectIntegrityError extends Error {
  constructor(message: string, readonly statusCode: number, readonly code: string) {
    super(message);
    this.name = 'ObjectIntegrityError';
  }
}

type Input = {
  sizeBytes: number;
  mimeType: string;
  sha256: string;
  url: (method: 'HEAD' | 'GET', headers: Record<string, string>) => string;
};

// ALG-ASSET-VERIFY-001 v1.1.0. Limits are per App process, including queued work.
export function createObjectIntegrityVerifier({ concurrency = 4, maxQueued = 16, timeoutMs = 60_000 } = {}) {
  let active = 0;
  const queue: Array<() => void> = [];
  async function acquire(signal: AbortSignal) {
    if (active < concurrency) { active++; return; }
    if (queue.length >= maxQueued) {
      throw new ObjectIntegrityError('Asset verification is busy. Retry later.', 503, 'ASSET_VERIFICATION_BUSY');
    }
    await new Promise<void>((resolve, reject) => {
      const ready = () => { signal.removeEventListener('abort', abort); resolve(); };
      const abort = () => {
        const index = queue.indexOf(ready);
        if (index >= 0) queue.splice(index, 1);
        reject(signal.reason);
      };
      queue.push(ready);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  return async (input: Input) => {
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > MAX_DIRECT_ASSET_BYTES) {
      throw new ObjectIntegrityError('Invalid asset verification size.', 409, 'ASSET_METADATA_MISMATCH');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let acquired = false;
    try {
      await acquire(controller.signal);
      acquired = true;
      controller.signal.throwIfAborted();
      const headers = { 'x-amz-checksum-mode': 'ENABLED' };
      const head = await fetch(input.url('HEAD', headers), {
        method: 'HEAD', headers, signal: controller.signal, redirect: 'error',
      });
      if (head.status !== 200) {
        throw new ObjectIntegrityError('Object storage did not confirm the uploaded asset.', 409, 'ASSET_OBJECT_NOT_READY');
      }
      const matchesMetadata = (response: Response) =>
        response.headers.get('content-length') === String(input.sizeBytes)
        && response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === input.mimeType;
      if (!matchesMetadata(head)) {
        throw new ObjectIntegrityError('Uploaded asset metadata does not match the signed intent.', 409, 'ASSET_METADATA_MISMATCH');
      }
      const checksum = head.headers.get('x-amz-checksum-sha256');
      if (checksum !== null) {
        if (checksum !== Buffer.from(input.sha256, 'hex').toString('base64')) {
          throw new ObjectIntegrityError('Object storage checksum verification failed.', 409, 'ASSET_CHECKSUM_MISMATCH');
        }
        return;
      }
      // ETag is only an object identity guard, never a substitute for SHA-256.
      const etag = head.headers.get('etag');
      const getHeaders: Record<string, string> = { 'accept-encoding': 'identity' };
      if (etag) getHeaders['if-match'] = etag;
      const response = await fetch(input.url('GET', getHeaders), {
        headers: getHeaders, signal: controller.signal, redirect: 'error',
      });
      try {
        if (response.status !== 200 || !response.body) {
          throw new ObjectIntegrityError('Object storage readback failed.', 409, 'ASSET_OBJECT_NOT_READY');
        }
        if (!matchesMetadata(response) || (etag && response.headers.get('etag') !== etag)
          || ![null, 'identity'].includes(response.headers.get('content-encoding'))) {
          throw new ObjectIntegrityError('Readback metadata does not match the uploaded asset.', 409, 'ASSET_METADATA_MISMATCH');
        }
        const reader = response.body.getReader();
        const hash = createHash('sha256');
        let bytes = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > input.sizeBytes) {
              throw new ObjectIntegrityError('Readback exceeds the signed size.', 409, 'ASSET_METADATA_MISMATCH');
            }
            hash.update(chunk.value);
          }
          if (bytes !== input.sizeBytes || hash.digest('hex') !== input.sha256) {
            throw new ObjectIntegrityError('Object storage checksum verification failed.', 409, 'ASSET_CHECKSUM_MISMATCH');
          }
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      } finally {
        await response.body?.cancel().catch(() => undefined);
      }
    } catch (error) {
      if (error instanceof ObjectIntegrityError) throw error;
      throw new ObjectIntegrityError(
        controller.signal.aborted ? 'Asset verification timed out.' : 'Object storage verification read failed.',
        503, controller.signal.aborted ? 'ASSET_VERIFICATION_TIMEOUT' : 'ASSET_VERIFICATION_UNAVAILABLE',
      );
    } finally {
      clearTimeout(timer);
      if (acquired) {
        const next = queue.shift();
        if (next) next(); else active--;
      }
    }
  };
}

export const verifyObjectIntegrity = createObjectIntegrityVerifier();
