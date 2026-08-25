/// <reference lib="webworker" />

import {
  bakePbrMapsLocally,
  type LocalPbrBakeInput,
} from '@/engine/bake/localPbrBakeCore';

type LocalPbrBakeWorkerRequest = {
  id: string;
  input: LocalPbrBakeInput;
};

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.onmessage = (event: MessageEvent<LocalPbrBakeWorkerRequest>) => {
  const { id, input } = event.data;
  try {
    const result = bakePbrMapsLocally(input, (progress) => {
      workerScope.postMessage({ id, type: 'progress', progress });
    });
    workerScope.postMessage(
      { id, type: 'result', result },
      Object.values(result.outputs).flatMap((output) => output ? [output.buffer] : []),
    );
  } catch (error) {
    workerScope.postMessage({
      id,
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
