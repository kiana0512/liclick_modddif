import { createReadStream } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { pipeline } from 'node:stream';

/** The caller has already checked ownership, path containment and HTTP headers. */
export function streamFileResponse(filePath: string, response: ServerResponse) {
  // Plain pipe leaves a paused file stream open if a client disconnects. On
  // Windows that handle can prevent the project directory moving to trash.
  // pipeline closes both sides on abort/read failure and preserves backpressure.
  pipeline(createReadStream(filePath), response, () => {
    // Errors already destroy the HTTP response; client cancellation is normal.
  });
}
