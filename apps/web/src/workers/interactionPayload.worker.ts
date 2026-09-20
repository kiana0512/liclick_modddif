type Request =
  | { type: 'parse'; bytes: ArrayBuffer }
  | { type: 'data-url'; blob: Blob }
  | { type: 'release' };

let result: unknown;
self.onmessage = ({ data }: MessageEvent<Request>) => {
  if (data.type === 'release') {
    self.postMessage({ type: 'result', result });
    return;
  }
  try {
    result =
      data.type === 'parse'
        ? JSON.parse(new TextDecoder().decode(data.bytes))
        : new FileReaderSync().readAsDataURL(data.blob);
    self.postMessage({ type: 'ready' });
  } catch {
    self.postMessage({ type: 'error' });
  }
};

export {};
