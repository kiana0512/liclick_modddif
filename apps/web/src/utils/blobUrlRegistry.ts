const blobUrlRegistry = new Map<string, Blob>();

export function createRegisteredObjectUrl(blob: Blob) {
  const url = URL.createObjectURL(blob);
  blobUrlRegistry.set(url, blob);
  return url;
}

export function getRegisteredObjectUrlBlob(url?: string) {
  return url ? blobUrlRegistry.get(url) : undefined;
}

export function revokeRegisteredObjectUrl(url?: string) {
  if (!url) return;
  if (!blobUrlRegistry.has(url)) return;
  blobUrlRegistry.delete(url);
  URL.revokeObjectURL(url);
}
