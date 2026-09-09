import { createReadStream } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { pipeline } from 'node:stream';

/** The caller has already checked ownership, path containment and HTTP headers. */
export function streamFileResponse(filePath: string, response: ServerResponse) {
  if (response.destroyed || response.writableEnded) return;
  // Plain pipe leaves a paused file stream open if a client disconnects. On
  // Windows that handle can prevent the project directory moving to trash.
  // pipeline closes both sides on abort/read failure and preserves backpressure.
  const source = createReadStream(filePath);
  try {
    pipeline(source, response, () => {
      // Errors already destroy the HTTP response; client cancellation is normal.
    });
  } catch (error) {
    // pipeline can throw synchronously if its destination has already closed.
    source.destroy();
    if (response.destroyed || response.writableEnded) return;
    throw error;
  }
}
